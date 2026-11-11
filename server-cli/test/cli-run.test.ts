// End-to-end-ish tests of the CLI glue: commands against a temp data folder, prepareStart, and
// `status` against the real server started in-process with the CLI's config.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { start } from '../../server/src/server.ts'
import { openDb } from '../../server/src/db.ts'
import { parseArgs } from '../src/cli/commands.ts'
import { createDefaultConfig, loadCliConfig, saveCliConfig, toServerConfig } from '../src/cli/config.ts'
import { acquireInstance, readLock } from '../src/cli/instance.ts'
import type { NetworkProbe } from '../src/cli/invite.ts'
import { EXIT_NOT_RUNNING, prepareStart, runCommand, type CliDeps } from '../src/cli/run.ts'
import { getStatus, formatStatus } from '../src/cli/status.ts'

function streams() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', (c: Buffer) => (out += c.toString()))
  stderr.on('data', (c: Buffer) => (err += c.toString()))
  return { stdout, stderr, out: () => out, err: () => err }
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-cli-run-'))
  const s = streams()
  const deps: CliDeps = { version: '0.5.0-test', stdout: s.stdout, stderr: s.stderr, env: {}, platform: 'linux', stdin: new PassThrough() }
  const run = (...argv: string[]) => runCommand(parseArgs(['--data', dir, ...argv]), deps)
  return { dir, s, deps, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })

test('help, version, usage errors, autostart/update from source', async () => {
  const t = setup()
  try {
    assert.equal(await t.run('--help'), 0)
    assert.match(t.s.out(), /Usage: nexo-server/)
    assert.equal(await t.run('--version'), 0)
    assert.match(t.s.out(), /nexo-server 0\.5\.0-test/)
    assert.equal(await t.run('bogus'), 2)
    assert.match(t.s.err(), /Unknown command "bogus"[\s\S]*Usage:/)
    // From source (not the packaged exe), autostart on and update explain instead of acting.
    assert.equal(await t.run('autostart', 'on'), 1)
    assert.match(t.s.err(), /"autostart on" needs the downloaded nexo-server/)
    assert.equal(await t.run('update'), 1)
    assert.match(t.s.err(), /"update" only works in the downloaded nexo-server/)
  } finally {
    t.cleanup()
  }
})

test('setup via flags, then invite (with and without a probe)', async () => {
  const t = setup()
  try {
    assert.equal(await t.run('invite'), 1)
    assert.match(t.s.err(), /No server is set up/)
    // non-TTY setup without flags explains itself
    assert.equal(await t.run('setup'), 1)
    assert.match(t.s.err(), /not an interactive console/)

    assert.equal(await t.run('setup', '--name', 'The Lounge', '--password', 'moss-tiger-41'), 0)
    const saved = loadCliConfig(t.dir)!
    assert.equal(saved.serverName, 'The Lounge')

    assert.equal(await t.run('invite', '--ascii'), 0)
    assert.match(t.s.out(), /\| Server: {3}http:\/\/localhost:3001/)
    assert.match(t.s.out(), /\| Password: moss-tiger-41/)
    assert.match(t.s.out(), /not running right now/)
    assert.ok(!t.s.out().includes(saved.livekit.apiSecret))

    const probe: NetworkProbe = { lan: ['192.168.1.20'], tailscale: null, stunIp: null, gateway: { found: false, externalIp: null }, reachability: 'unknown', notes: ['No UPnP.'] }
    const s2 = streams()
    const code = await runCommand(parseArgs(['--data', t.dir, 'invite', '--ascii']), { ...t.deps, stdout: s2.stdout, probeNetwork: async () => probe })
    assert.equal(code, 0)
    assert.match(s2.out(), /Server: {3}http:\/\/192\.168\.1\.20:3001/)
    assert.match(s2.out(), /No UPnP\./)

    const s3 = streams()
    await runCommand(parseArgs(['--data', t.dir, 'invite']), { ...t.deps, stdout: s3.stdout, probeNetwork: async () => { throw new Error('offline') } })
    assert.match(s3.out(), /Could not check the network \(offline\)/)
  } finally {
    t.cleanup()
  }
})

test('backup and rename-user commands', async () => {
  const t = setup()
  try {
    const db = openDb(t.dir)
    db.users.create('Alice', '#3ee6b0', 'h')
    db.users.create('Bob', '#3ee6b0', 'h2')
    db.close()
    assert.equal(await t.run('backup'), 0)
    assert.match(t.s.out(), /Database saved to .*backups/)
    assert.equal(await t.run('rename-user', 'alice', 'Alice-old'), 0)
    assert.match(t.s.out(), /Renamed "Alice" to "Alice-old"/)
    assert.equal(await t.run('rename-user', 'nobody', 'xx'), 1)
    assert.match(t.s.err(), /No user named "nobody"/)
    assert.equal(await t.run('owner', 'bob'), 0)
    assert.match(t.s.out(), /"Bob" is now the owner\. "Alice-old" is now an admin\./)
    assert.equal(await t.run('owner', 'Bob'), 1)
    assert.match(t.s.err(), /"Bob" is already the owner/)
  } finally {
    t.cleanup()
  }
})

test('prepareStart: first run with flags, lock taken, second start sees it', async () => {
  const t = setup()
  try {
    const cmd = parseArgs(['--data', t.dir, '--name', 'Box', '--no-password'])
    assert.equal(cmd.kind, 'start')
    if (cmd.kind !== 'start') return
    const r = await prepareStart(cmd, { ...t.deps, env: { PORT: '4001' } })
    assert.equal(r.kind, 'ready')
    if (r.kind !== 'ready') return
    assert.equal(r.saved.serverName, 'Box')
    assert.equal(r.saved.ports.http, 3001)
    assert.equal(r.config.ports.http, 4001) // env override applied
    assert.deepEqual(r.overriddenBy, ['PORT'])
    assert.equal(readLock(t.dir)?.pid, process.pid)
    r.logger.info(`secret ${r.config.livekit.apiSecret}`)
    assert.ok(!t.s.out().includes(r.config.livekit.apiSecret))

    // another process holding the lock: prints "already running" + invite, no setup
    r.lock.release()
    acquireInstance(t.dir, { version: '0.5.0-test', ports: r.config.ports, pid: 999999, isAlive: () => true })
    const s2 = streams()
    const again = await prepareStart(cmd, { ...t.deps, stdout: s2.stdout, isAlive: () => true })
    assert.equal(again.kind, 'already-running')
    assert.match(s2.out(), /already running .*PID 999999/)
    assert.match(s2.out(), /Server: {3}http:\/\/localhost:4001/)
  } finally {
    t.cleanup()
  }
})

test('prepareStart: no config and no console → exit 1 with how-to', async () => {
  const t = setup()
  try {
    const cmd = parseArgs(['--data', t.dir])
    if (cmd.kind !== 'start') throw new Error('expected start')
    const r = await prepareStart(cmd, t.deps)
    assert.deepEqual(r, { kind: 'exit', code: 1 })
    assert.match(t.s.err(), /nexo-server setup --name/)
  } finally {
    t.cleanup()
  }
})

test('status: not running, then the real server started from the CLI config', async () => {
  const t = setup()
  try {
    assert.equal(await t.run('status'), EXIT_NOT_RUNNING)
    assert.match(t.s.out(), /not running/)

    const port = await freePort()
    const cfg = { ...createDefaultConfig({ serverName: 'Status Test' }), ports: { http: port, livekit: 7880, livekitTcp: 7881, livekitUdp: 7882 } }
    saveCliConfig(t.dir, cfg)
    const server = await start({ ...toServerConfig(cfg, t.dir, {}), host: '127.0.0.1', log: false })
    const held = acquireInstance(t.dir, { version: '0.5.0-test', ports: cfg.ports })
    assert.ok(held.ok)
    try {
      if (held.ok) held.lock.update({ stats: { online: 3, inVoice: 2, streaming: 1, updatedAt: new Date().toISOString() } })
      const report = await getStatus(t.dir)
      assert.equal(report.running, true)
      if (report.running) assert.deepEqual(report.health, { ok: true, name: 'Status Test' })
      const lines = formatStatus(report, { dataDir: t.dir, version: '0.5.0-test' }).join('\n')
      assert.match(lines, /running \(PID \d+, up 0 min\)/)
      assert.match(lines, new RegExp(`✓ Server answering on port ${port} \\("Status Test"\\)`))
      assert.match(lines, /3 online · 2 in voice · 1 streaming/)
    } finally {
      await server.close()
    }
    // lock still there but nothing answering
    const down = await getStatus(t.dir, { timeoutMs: 500 })
    assert.equal(down.running, true)
    if (down.running) assert.equal(down.health.ok, false)
    if (held.ok) held.lock.release()
    const stale = await getStatus(t.dir)
    assert.deepEqual(stale, { running: false })
  } finally {
    t.cleanup()
  }
})
