import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { AWAKE_SCRIPT, awakeCommand, createAwake, type SpawnFn } from '../src/awake.ts'
import { statusChanged } from '../src/cli/status.ts'
import { parseProcNetDev, RateMeter, startUploadMeter, uploadLimitCheck, WINDOWS_SAMPLER_SCRIPT } from '../src/upload.ts'

/** A fake child process: records kill/stdin end, can be made to exit or fail. */
class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid: number | undefined = 1234
  killed = false
  stdinEnded = false
  constructor() {
    super()
    this.stdin.on('finish', () => (this.stdinEnded = true))
  }
  kill() {
    this.killed = true
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }
}

function fakeSpawn() {
  const children: FakeChild[] = []
  const calls: { file: string; args: readonly string[] }[] = []
  const spawn: SpawnFn = (file, args) => {
    calls.push({ file, args })
    const c = new FakeChild()
    children.push(c)
    return c as unknown as ChildProcess
  }
  return { spawn, children, calls }
}

test('awakeCommand: PowerShell with SetThreadExecutionState on Windows, systemd-inhibit on Linux', () => {
  const [file, args] = awakeCommand('win32', { SystemRoot: 'C:\\WINDOWS' })!
  assert.equal(file, 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  const encoded = args[args.indexOf('-EncodedCommand') + 1]!
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), AWAKE_SCRIPT)
  assert.match(AWAKE_SCRIPT, /SetThreadExecutionState\(\[uint32\]2147483649\)/) // 0x80000000 | 0x1
  assert.deepEqual(awakeCommand('linux')?.[0], 'systemd-inhibit')
  assert.equal(awakeCommand('darwin'), null)
})

test('createAwake: starts when someone is online, stops after the grace period, once', async () => {
  const f = fakeSpawn()
  const logs: string[] = []
  let now = 0
  const awake = createAwake({ log: (l) => logs.push(l), platform: 'win32', env: {}, spawn: f.spawn, graceMs: 60_000, now: () => now })

  awake.update(0)
  assert.equal(f.calls.length, 0) // idle server: the PC may sleep
  awake.update(2)
  awake.update(3)
  assert.equal(f.calls.length, 1)
  assert.equal(awake.active, true)

  now = 10_000
  awake.update(3) // last tick with someone online
  now = 13_000
  awake.update(0) // everyone left: grace period starts
  now = 69_000
  awake.update(0)
  assert.equal(awake.active, true)
  now = 70_000
  awake.update(0)
  assert.equal(awake.active, false)
  assert.equal(f.children[0]!.killed, true)
  await new Promise((r) => setImmediate(r)) // its exit is expected: not a failure
  assert.equal(f.children[0]!.stdinEnded, true)

  now = 80_000
  awake.update(1) // someone back
  assert.equal(f.calls.length, 2)
  awake.stop()
  assert.equal(f.children[1]!.killed, true)
  awake.update(5) // stopped for good (shutdown)
  assert.equal(f.calls.length, 2)
  assert.deepEqual(logs, [
    'Friends are connected: keeping this PC awake.',
    'Everyone left: this PC may sleep again.',
    'Friends are connected: keeping this PC awake.',
  ])
})

test('createAwake: PowerShell missing → logs once and carries on', () => {
  const logs: string[] = []
  const spawn: SpawnFn = () => {
    const c = new FakeChild()
    c.pid = undefined
    queueMicrotask(() => c.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })))
    return c as unknown as ChildProcess
  }
  const awake = createAwake({ log: (l) => logs.push(l), platform: 'win32', env: {}, spawn })
  awake.update(1)
  return new Promise<void>((resolve) =>
    setImmediate(() => {
      awake.update(1)
      awake.update(1)
      assert.equal(logs.filter((l) => /Couldn't ask Windows to stay awake.*\(powershell\.exe not found\)/.test(l)).length, 1)
      assert.equal(awake.active, false)
      resolve()
    }),
  )
})

test('createAwake: a helper that keeps failing is given up after maxFailures', async () => {
  const f = fakeSpawn()
  const logs: string[] = []
  const awake = createAwake({ log: (l) => logs.push(l), platform: 'win32', env: {}, spawn: f.spawn, maxFailures: 2 })
  for (let i = 0; i < 4; i++) {
    awake.update(1)
    const c = f.children.at(-1)!
    if (!c.listenerCount('exit')) break
    c.stderr.write('Add-Type : compilation failed\n')
    await new Promise((r) => setImmediate(r))
    c.emit('exit', 1, null)
  }
  assert.equal(f.calls.length, 2)
  assert.ok(logs.some((l) => /Couldn't ask Windows to stay awake.*\(Add-Type : compilation failed\)/.test(l)), logs.join('\n'))
})

// ---------- upload ----------

const PROC_NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999999    1000    0    0    0     0          0         0  9999999    1000    0    0    0     0       0          0
  eth0: 123456789  98765    0    0    0     0          0         0  5000000    4321    0    0    0     0       0          0
tailscale0:  1000  10    0    0    0     0          0         0  2000    20    0    0    0     0       0          0
`

test('parseProcNetDev: transmit bytes per interface, loopback excluded', () => {
  assert.deepEqual([...parseProcNetDev(PROC_NET_DEV)], [['eth0', 5000000], ['tailscale0', 2000]])
  assert.equal(parseProcNetDev('garbage').size, 0)
})

test('RateMeter: busiest adapter, counter resets and new adapters skipped', () => {
  const m = new RateMeter()
  const c = (o: Record<string, number>) => new Map(Object.entries(o))
  assert.equal(m.push(c({ eth0: 1_000_000, ts0: 0 }), 0), undefined) // first sample
  // 2 s: eth0 +5 MB (20 Mbit/s), tunnel +4.5 MB (same traffic, inside the tunnel): not summed.
  assert.equal(m.push(c({ eth0: 6_000_000, ts0: 4_500_000 }), 2000), 20)
  // eth0 reset (driver reload), new adapter: skipped; ts0 +1 MB in 1 s = 8 Mbit/s.
  assert.equal(m.push(c({ eth0: 10, ts0: 5_500_000, wifi: 99 }), 3000), 8)
  // Nothing comparable (only resets): unknown.
  assert.equal(m.push(c({ eth0: 5, ts0: 1 }), 4000), undefined)
  // No time passed: unknown.
  assert.equal(m.push(c({ eth0: 6, ts0: 2 }), 4000), undefined)
  // Idle: 0.
  assert.equal(m.push(c({ eth0: 6, ts0: 2 }), 5000), 0)
})

test('startUploadMeter (Linux): reads /proc/net/dev each call', () => {
  let tx = 0
  let now = 0
  const meter = startUploadMeter({
    log: () => {},
    platform: 'linux',
    now: () => now,
    readProcNetDev: () => PROC_NET_DEV.replace('5000000', String(tx)),
  })
  assert.equal(meter.mbps(), undefined)
  tx = 3_750_000
  now = 3000
  assert.equal(meter.mbps(), 10)
})

test('startUploadMeter (Windows): parses the PowerShell sampler, drops stale values, kills it on stop', async () => {
  const f = fakeSpawn()
  let now = 0
  const logs: string[] = []
  const meter = startUploadMeter({ log: (l) => logs.push(l), platform: 'win32', env: {}, spawn: f.spawn, now: () => now })
  const encoded = f.calls[0]!.args.at(-1)!
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), WINDOWS_SAMPLER_SCRIPT)
  const out = f.children[0]!.stdout
  const flush = () => new Promise((r) => setImmediate(r))
  out.write('S {A-1} 1000\r\nS {B-2} 50\r\nE\r\n')
  await flush()
  assert.equal(meter.mbps(), undefined)
  now = 2000
  out.write('S {A-1} 2501000\r\nS {B-2} 60\r\nE\r\n')
  await flush()
  assert.equal(meter.mbps(), 10)
  now = 13_000 // sampler went quiet: don't show an old value
  assert.equal(meter.mbps(), undefined)
  meter.stop()
  assert.equal(f.children[0]!.killed, true)
  await flush()
  assert.deepEqual(logs, []) // stopping isn't reported as a failure
})

test('uploadLimitCheck: warns over 80%, clears under 60%, no limit = never', () => {
  const s = { warned: false }
  assert.equal(uploadLimitCheck(s, 20, 30), null)
  assert.equal(uploadLimitCheck(s, 25, 30), 'warn')
  assert.equal(uploadLimitCheck(s, 29, 30), null)
  assert.equal(uploadLimitCheck(s, 20, 30), null) // 67%: hysteresis
  assert.equal(uploadLimitCheck(s, 17, 30), 'ok')
  assert.equal(uploadLimitCheck({ warned: false }, 1000, undefined), null)
  assert.equal(uploadLimitCheck({ warned: false }, undefined, 30), null)
})

test('statusChanged: counts always, upload only on real moves', () => {
  const base = { online: 2, inVoice: 1, streaming: 0 }
  assert.equal(statusChanged(null, base), true)
  assert.equal(statusChanged(base, { ...base }), false)
  assert.equal(statusChanged(base, { ...base, streaming: 1 }), true)
  assert.equal(statusChanged(base, { ...base, uploadMbps: 0.2 }), true) // upload appeared
  assert.equal(statusChanged({ ...base, uploadMbps: 0.2 }, { ...base, uploadMbps: 0.9 }), false) // < 1 Mbit/s
  assert.equal(statusChanged({ ...base, uploadMbps: 8 }, { ...base, uploadMbps: 9.5 }), false) // < 25%
  assert.equal(statusChanged({ ...base, uploadMbps: 8 }, { ...base, uploadMbps: 10.1 }), true)
  assert.equal(statusChanged({ ...base, uploadMbps: 8 }, { ...base }), true)
})
