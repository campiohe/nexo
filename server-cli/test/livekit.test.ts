// Unit tests for src/livekit.ts: the generated LiveKit config and the supervisor (with a fake LiveKit binary).
// Run with `npm test -w server-cli`.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { liveKitYaml, superviseLiveKit, type LiveKitYamlOptions } from '../src/livekit.ts'

const REPO_YAML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../livekit.yaml')

const base: LiveKitYamlOptions = {
  apiKey: 'APIkey123',
  apiSecret: 'a-secret-that-is-at-least-32-characters-long',
  bindAddresses: ['0.0.0.0'],
  port: 7880,
  tcpPort: 7881,
  udpPort: 7882,
  useExternalIp: false,
}

/** Flattens the simple `key: value` maps of a LiveKit YAML into { 'rtc.tcp_port': '7881', … } (lists skipped). */
function flatten(yaml: string): Record<string, string> {
  const out: Record<string, string> = {}
  const stack: string[] = []
  for (const raw of yaml.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '')
    if (!line.trim() || line.trim().startsWith('- ')) continue
    const indent = line.length - line.trimStart().length
    const m = line.trim().match(/^("[^"]*"|[^:]+):\s*(.*)$/)
    if (!m) continue
    stack.length = indent / 2
    const key = [...stack, m[1]!].join('.')
    if (m[2] === '') stack.push(m[1]!)
    else out[key] = m[2]!
  }
  return out
}

describe('liveKitYaml', () => {
  test('defaults mirror the repo livekit.yaml (ports, rtc, room, logging)', () => {
    const repo = flatten(readFileSync(REPO_YAML, 'utf8'))
    const ours = flatten(liveKitYaml(base))
    assert.ok(Object.keys(repo).length >= 8, 'repo livekit.yaml parsed')
    for (const [key, value] of Object.entries(repo)) assert.equal(ours[key], value, key)
    assert.match(readFileSync(REPO_YAML, 'utf8'), /bind_addresses:\n\s+- 0\.0\.0\.0/)
    assert.match(liveKitYaml(base), /bind_addresses:\n {2}- "0\.0\.0\.0"\n/)
  })

  test('keys go in the keys: map, quoted', () => {
    const yaml = liveKitYaml({ ...base, apiKey: 'k: #1', apiSecret: 's"ecret: with # stuff and 32+ chars......' })
    assert.match(yaml, /\nkeys:\n {2}"k: #1": "s\\"ecret: with # stuff and 32\+ chars\.{6}"\n$/)
    assert.doesNotMatch(yaml, /LIVEKIT_KEYS|\$/)
  })

  test('all interfaces: no IP restriction, no loopback candidates', () => {
    const yaml = liveKitYaml(base)
    assert.doesNotMatch(yaml, /ips:|enable_loopback_candidate|node_ip/)
  })

  test('node IP and external IP', () => {
    const yaml = liveKitYaml({ ...base, nodeIp: '100.64.1.2', useExternalIp: true, advertiseInternalIp: false })
    const flat = flatten(yaml)
    assert.equal(flat['rtc.node_ip'], '"100.64.1.2"')
    assert.equal(flat['rtc.use_external_ip'], 'true')
    assert.equal(flat['rtc.advertise_internal_ip'], 'false')
  })

  test('loopback-only: media restricted to 127.0.0.1, loopback candidates on, ICE/TCP off', () => {
    const yaml = liveKitYaml({ ...base, bindAddresses: ['127.0.0.1'], tcpPort: 0 })
    assert.match(yaml, /bind_addresses:\n {2}- "127\.0\.0\.1"\n/)
    assert.match(yaml, /\n {2}tcp_port: 0\n/)
    assert.match(yaml, /\n {2}ips:\n {4}includes:\n {6}- "127\.0\.0\.1\/32"\n {2}enable_loopback_candidate: true\n/)
  })

  test('specific LAN + IPv6 addresses: CIDRs per family, no loopback candidates', () => {
    const yaml = liveKitYaml({ ...base, bindAddresses: ['192.168.1.10', 'fd7a::1'] })
    assert.match(yaml, /- "192\.168\.1\.10\/32"\n {6}- "fd7a::1\/128"\n/)
    assert.doesNotMatch(yaml, /enable_loopback_candidate/)
  })

  test('rejects bad input', () => {
    assert.throws(() => liveKitYaml({ ...base, bindAddresses: [] }), /bindAddresses/)
    assert.throws(() => liveKitYaml({ ...base, port: 0 }), /port/)
    assert.throws(() => liveKitYaml({ ...base, udpPort: 70000 }), /udpPort/)
    assert.throws(() => liveKitYaml({ ...base, apiSecret: 'a\nb: c' }), /key\/secret/)
    assert.throws(() => liveKitYaml({ ...base, bindAddresses: ['localhost'] }), /not an IP/)
  })
})

// ---------- supervisor (fake LiveKit: a node script that listens on the config's port) ----------

const tmp = mkdtempSync(path.join(tmpdir(), 'nexo-livekit-test-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

/** Writes an executable fake livekit-server. `behavior` runs with `port` and `config` in scope. */
function fakeBinary(name: string, behavior: string): string {
  const file = path.join(tmp, name)
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs'), net = require('node:net')
const config = process.argv[process.argv.indexOf('--config') + 1]
const port = Number(fs.readFileSync(config, 'utf8').match(/^port: (\\d+)/m)[1])
${behavior}
`,
  )
  chmodSync(file, 0o755)
  writeFileSync(path.join(tmp, 'package.json'), '{"type":"commonjs"}')
  return file
}

async function freePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address() as { port: number }
  await new Promise((r) => srv.close(r))
  return port
}

async function configFor(port: number): Promise<string> {
  const file = path.join(tmp, `livekit-${port}.yaml`)
  writeFileSync(file, liveKitYaml({ ...base, bindAddresses: ['127.0.0.1'], tcpPort: 0, port }))
  return file
}

const LISTEN = `console.log('starting LiveKit server'); console.error('2026-01-01T00:00:00 ERROR CPU monitoring unsupported'); console.error('\\tstack frame'); net.createServer().listen(port, '127.0.0.1')`

describe('superviseLiveKit', { skip: process.platform === 'win32' && 'fake binary is a node script' }, () => {
  test('ready once the port accepts connections; output prefixed; stop() ends it', async () => {
    const port = await freePort()
    const lines: string[] = []
    const lk = superviseLiveKit({
      binary: fakeBinary('ok.js', LISTEN),
      configPath: await configFor(port),
      port,
      log: (l) => lines.push(l),
      onFatal: (err) => assert.fail(err),
    })
    await lk.ready
    await lk.stop()
    await lk.stop() // idempotent
    assert.ok(lines.includes('[livekit] starting LiveKit server'), lines.join('\n'))
    assert.ok(!lines.some((l) => /CPU monitoring|stack frame/.test(l)), 'known-harmless error and its stack are hidden')
    const probe = createServer()
    await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(port, '127.0.0.1', resolve))
    await new Promise((r) => probe.close(r))
  })

  test('restarts after an unexpected exit', async () => {
    const port = await freePort()
    const marker = path.join(tmp, 'crashed-once')
    const lines: string[] = []
    const lk = superviseLiveKit({
      binary: fakeBinary('flaky.js', `if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ''); process.exit(3) }\n${LISTEN}`),
      configPath: await configFor(port),
      port,
      log: (l) => lines.push(l),
      onFatal: (err) => assert.fail(err),
    })
    await lk.ready
    await lk.stop()
    assert.ok(lines.some((l) => /exited unexpectedly \(code 3\); restarting in 500 ms/.test(l)), lines.join('\n'))
  })

  test('gives up after repeated crashes: onFatal + ready rejects', async () => {
    const port = await freePort()
    let fatal: Error | null = null
    const lk = superviseLiveKit({
      binary: fakeBinary('crash.js', 'console.error("listen tcp: address already in use"); process.exit(1)'),
      configPath: await configFor(port),
      port,
      maxCrashes: 3,
      log: () => {},
      onFatal: (err) => (fatal = err),
    })
    await assert.rejects(lk.ready, /exited 3 times/)
    assert.match(String(fatal), /exited 3 times/)
    await lk.stop()
  })

  test('missing binary is fatal right away', async () => {
    let fatal: Error | null = null
    const lk = superviseLiveKit({
      binary: path.join(tmp, 'does-not-exist'),
      configPath: path.join(tmp, 'none.yaml'),
      log: () => {},
      onFatal: (err) => (fatal = err),
    })
    await assert.rejects(lk.ready, /could not start/)
    assert.match(String(fatal), /ENOENT/)
  })
})
