import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  applyEnvOverrides,
  ConfigError,
  createDefaultConfig,
  describeConfig,
  generateApiSecret,
  loadCliConfig,
  saveCliConfig,
  toServerConfig,
  toServerEnv,
  validateConfig,
} from '../src/cli/config.ts'
import { dataLayout, defaultDataDir, resolveDataDir } from '../src/cli/paths.ts'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'nexo-cli-config-'))

test('paths: OS defaults and --data / DATA_DIR precedence', () => {
  assert.equal(
    defaultDataDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' }, homedir: 'C:\\Users\\ana' }),
    'C:\\Users\\ana\\AppData\\Local\\Nexo Server',
  )
  assert.equal(defaultDataDir({ platform: 'win32', env: {}, homedir: 'C:\\Users\\ana' }), 'C:\\Users\\ana\\AppData\\Local\\Nexo Server')
  assert.equal(defaultDataDir({ platform: 'linux', env: {}, homedir: '/home/ana' }), '/home/ana/.local/share/nexo-server')
  assert.equal(defaultDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/xdg' }, homedir: '/home/ana' }), '/xdg/nexo-server')
  assert.equal(defaultDataDir({ platform: 'linux', env: { XDG_DATA_HOME: 'rel' }, homedir: '/home/ana' }), '/home/ana/.local/share/nexo-server')

  const base = { platform: 'linux' as const, homedir: '/home/ana', cwd: '/srv/nexo' }
  assert.equal(resolveDataDir({ ...base, env: {} }), '/home/ana/.local/share/nexo-server')
  assert.equal(resolveDataDir({ ...base, env: { DATA_DIR: './data' } }), '/srv/nexo/data')
  assert.equal(resolveDataDir({ ...base, env: { DATA_DIR: './data' }, flag: '/other' }), '/other')
  assert.equal(resolveDataDir({ ...base, env: { DATA_DIR: '  ' } }), '/home/ana/.local/share/nexo-server')
  assert.equal(resolveDataDir({ platform: 'win32', env: {}, cwd: 'C:\\srv', flag: 'data' }), 'C:\\srv\\data')

  const l = dataLayout('/d')
  assert.equal(l.db, path.join('/d', 'nexo.db'))
  assert.equal(l.config, path.join('/d', 'config.json'))
  assert.equal(l.logFile, path.join('/d', 'logs', 'nexo-server.log'))
})

test('secret generation: 32 random bytes as hex, key "nexo"', () => {
  const a = generateApiSecret()
  const b = generateApiSecret()
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, b)
  const c = createDefaultConfig()
  assert.equal(c.livekit.apiKey, 'nexo')
  assert.match(c.livekit.apiSecret, /^[0-9a-f]{64}$/)
  assert.deepEqual(validateConfig(c), [])
})

test('config round-trip, atomic write, 0600 on POSIX', () => {
  const dir = tmp()
  try {
    assert.equal(loadCliConfig(dir), null)
    const c = {
      ...createDefaultConfig({ serverName: 'The Lounge', serverPassword: 'moss-tiger-41' }),
      network: { mode: 'tailscale' as const },
    }
    saveCliConfig(dir, c)
    assert.deepEqual(loadCliConfig(dir), c)
    assert.deepEqual(readdirSync(dir), ['config.json']) // no temp file left behind
    if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600)
    saveCliConfig(dir, { ...c, serverName: 'Other' }) // overwrite works
    assert.equal(loadCliConfig(dir)?.serverName, 'Other')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('config validation: clear errors, secret never echoed', () => {
  const dir = tmp()
  try {
    const file = path.join(dir, 'config.json')
    writeFileSync(file, '{ not json')
    assert.throws(() => loadCliConfig(dir), (e: Error) => e instanceof ConfigError && /not valid JSON/.test(e.message))

    const bad = {
      ...createDefaultConfig(),
      ports: { http: 3001, livekit: 3001, livekitTcp: 7881, livekitUdp: 70000 },
      livekit: { apiKey: 'nexo', apiSecret: 'tooshortsecret' },
    }
    writeFileSync(file, JSON.stringify(bad))
    assert.throws(
      () => loadCliConfig(dir),
      (e: Error) => {
        assert.match(e.message, /ports\.livekitUdp/)
        assert.match(e.message, /apiSecret/)
        assert.doesNotMatch(e.message, /tooshortsecret/)
        return true
      },
    )

    writeFileSync(file, JSON.stringify({ ...createDefaultConfig(), version: 99 }))
    assert.throws(() => loadCliConfig(dir), /newer version/)

    writeFileSync(file, '\uFEFF' + JSON.stringify(createDefaultConfig()))
    assert.ok(loadCliConfig(dir)) // BOM (Notepad) tolerated

    assert.throws(() => saveCliConfig(dir, { ...createDefaultConfig(), serverName: '' }), ConfigError)
    assert.equal(validateConfig({ ...createDefaultConfig(), network: { mode: 'magic' } }).length, 1)
    assert.ok(
      validateConfig({ ...createDefaultConfig(), ports: { http: 1, livekit: 1, livekitTcp: 2, livekitUdp: 3 } }).some((e) =>
        /different/.test(e),
      ),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("env overrides: real env vars with today's names win over config.json", () => {
  const c = createDefaultConfig({ serverName: 'From file', serverPassword: 'file-pass-11' })
  assert.deepEqual(toServerEnv(c, '/data', {}), {
    PORT: '3001',
    SERVER_NAME: 'From file',
    SERVER_PASSWORD: 'file-pass-11',
    DATA_DIR: '/data',
    LIVEKIT_API_KEY: 'nexo',
    LIVEKIT_API_SECRET: c.livekit.apiSecret,
    LIVEKIT_PORT: '7880',
  })

  const env = {
    PORT: '4000',
    SERVER_NAME: 'From env',
    SERVER_PASSWORD: '', // empty = unset (same rule as the server's loadConfig)
    LIVEKIT_API_KEY: 'envkey',
    LIVEKIT_API_SECRET: 'x'.repeat(40),
    LIVEKIT_PORT: '7990',
    LIVEKIT_PUBLIC_URL: 'wss://voice.example.com',
    HOST: '127.0.0.1',
    DATA_DIR: '/ignored-here',
  }
  const e = toServerEnv(c, '/data', env)
  assert.equal(e.PORT, '4000')
  assert.equal(e.SERVER_NAME, 'From env')
  assert.equal(e.SERVER_PASSWORD, 'file-pass-11')
  assert.equal(e.LIVEKIT_API_KEY, 'envkey')
  assert.equal(e.LIVEKIT_API_SECRET, 'x'.repeat(40))
  assert.equal(e.LIVEKIT_PORT, '7990')
  assert.equal(e.LIVEKIT_PUBLIC_URL, 'wss://voice.example.com')
  assert.equal(e.HOST, '127.0.0.1')
  assert.equal(e.DATA_DIR, '/data') // resolveDataDir already honoured DATA_DIR when choosing the folder

  const { config, overriddenBy } = applyEnvOverrides(c, env)
  assert.deepEqual(overriddenBy, ['PORT', 'SERVER_NAME', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_PORT'])
  assert.equal(config.ports.http, 4000)
  assert.equal(config.ports.livekitTcp, 7881) // no env name for it: from the file
  assert.equal(c.ports.http, 3001) // input not mutated

  assert.throws(() => applyEnvOverrides(c, { PORT: 'abc' }), /PORT must be a port number/)
})

test("toServerConfig produces the server's own Config (server/src/config.ts loadConfig)", () => {
  const c = createDefaultConfig({ serverName: 'Lounge', serverPassword: 'pw-pw-12' })
  const s = toServerConfig(c, '/data', { PORT: '3005' })
  assert.equal(s.port, 3005)
  assert.equal(s.host, '0.0.0.0')
  assert.equal(s.serverName, 'Lounge')
  assert.equal(s.serverPassword, 'pw-pw-12')
  assert.equal(s.dataDir, path.resolve('/data'))
  assert.deepEqual(s.livekit, { apiKey: 'nexo', apiSecret: c.livekit.apiSecret, publicUrl: '', port: 7880 })
})

test('describeConfig never shows the LiveKit secret', () => {
  const c = createDefaultConfig({ serverPassword: 'moss-tiger-41' })
  const text = describeConfig(c)
  assert.ok(!text.includes(c.livekit.apiSecret))
  assert.match(text, /moss-tiger-41/)
})
