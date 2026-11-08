import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createDefaultConfig, type ServerCliConfig } from '../src/cli/config.ts'
import { generatePassword, PASSWORD_RE, runSetup, SetupError, type SetupOptions } from '../src/cli/setup.ts'

/** Runs setup with the given answer lines (all written up front, like piped input). */
async function scripted(answers: string[], opts: Partial<SetupOptions> = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  let text = ''
  output.on('data', (c: Buffer) => (text += c.toString()))
  input.end(answers.map((a) => a + '\n').join(''))
  const result = await runSetup({ dataDir: '/data/nexo', input, output, interactive: true, platform: 'linux', ...opts })
  return { result, text }
}

test('generatePassword: memorable word-word-NN', () => {
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword()
    assert.match(pw, PASSWORD_RE)
    const [a, b] = pw.split('-')
    assert.notEqual(a, b)
  }
})

test('setup: Enter everywhere = defaults and a generated password', async () => {
  const { result, text } = await scripted(['', '', ''])
  assert.equal(result.config.serverName, 'Nexo')
  assert.match(result.config.serverPassword, PASSWORD_RE)
  assert.equal(result.generatedPassword, true)
  assert.deepEqual(result.config.ports, { http: 3001, livekit: 7880, livekitTcp: 7881, livekitUdp: 7882 })
  assert.equal(result.config.network.mode, 'auto')
  assert.match(result.config.livekit.apiSecret, /^[0-9a-f]{64}$/)
  assert.match(text, /first-time setup/)
  assert.match(text, /Server name {2}\[Nexo\]: /)
  // the suggested password is the one saved
  assert.ok(text.includes(`[${result.config.serverPassword}]`))
  assert.match(text, /Data folder: \/data\/nexo/)
  assert.ok(!text.includes(result.config.livekit.apiSecret))
})

test('setup: typed name and password', async () => {
  const { result } = await scripted(['  The   Lounge ', 'hunter22', 'n'])
  assert.equal(result.config.serverName, 'The Lounge')
  assert.equal(result.config.serverPassword, 'hunter22')
  assert.equal(result.generatedPassword, false)
})

test('setup: "none" needs a confirmation; declining asks again', async () => {
  const yes = await scripted(['', 'none', 'y', ''])
  assert.equal(yes.result.config.serverPassword, '')
  assert.match(yes.text, /anyone who has the address can join/)

  const no = await scripted(['', 'none', '', 'secret-pass', ''])
  assert.equal(no.result.config.serverPassword, 'secret-pass')
})

test('setup: advanced ports and network mode, with re-asks on bad input', async () => {
  const { result, text } = await scripted(['Lan party', '', 'y', '4000', 'abc', '4000', '4001', '', '4003', 'bogus', 'lan'])
  assert.deepEqual(result.config.ports, { http: 4000, livekit: 4001, livekitTcp: 7881, livekitUdp: 4003 })
  assert.equal(result.config.network.mode, 'lan')
  assert.match(text, /Enter a port number/)
  assert.match(text, /already used by another setting/)
  assert.match(text, /Choose one of/)
})

test('setup: re-run keeps current values and the LiveKit keys', async () => {
  const existing: ServerCliConfig = { ...createDefaultConfig({ serverName: 'Old', serverPassword: 'old-pass-10' }), network: { mode: 'tailscale' } }
  const { result, text } = await scripted(['', '', ''], { existing })
  assert.equal(result.config.serverName, 'Old')
  assert.equal(result.config.serverPassword, 'old-pass-10')
  assert.equal(result.generatedPassword, false)
  assert.deepEqual(result.config.livekit, existing.livekit)
  assert.equal(result.config.network.mode, 'tailscale')
  assert.match(text, /Enter = keep/)
})

test('setup: Windows explains the firewall prompt', async () => {
  const { text } = await scripted(['', '', ''], { platform: 'win32' })
  assert.match(text, /firewall/)
  assert.match(text, /Allow/)
})

test('setup: input ending early cancels without a result', async () => {
  await assert.rejects(scripted(['My server']), (e: Error) => e instanceof SetupError && /cancelled/.test(e.message))
})

test('setup: non-TTY without flags fails with how-to', async () => {
  const input = new PassThrough()
  await assert.rejects(
    runSetup({ dataDir: '/d', input, output: new PassThrough() }), // PassThrough has no isTTY
    (e: Error) => e instanceof SetupError && /not an interactive console/.test(e.message) && /--no-password/.test(e.message),
  )
})

test('setup: flags work without a console', async () => {
  const out = new PassThrough()
  const a = await runSetup({ dataDir: '/d', input: new PassThrough(), output: out, flags: { name: 'VPS', password: 'pw-from-flag' } })
  assert.equal(a.config.serverName, 'VPS')
  assert.equal(a.config.serverPassword, 'pw-from-flag')

  const b = await runSetup({ dataDir: '/d', output: new PassThrough(), flags: { name: 'VPS', noPassword: true } })
  assert.equal(b.config.serverPassword, '')

  const c = await runSetup({ dataDir: '/d', output: new PassThrough(), flags: { name: 'VPS' } })
  assert.match(c.config.serverPassword, PASSWORD_RE) // first run: generated
  assert.equal(c.generatedPassword, true)

  const existing = createDefaultConfig({ serverName: 'Old', serverPassword: 'keep-me-12' })
  const d = await runSetup({ dataDir: '/d', output: new PassThrough(), existing, flags: { name: 'New' } })
  assert.equal(d.config.serverPassword, 'keep-me-12') // re-run: kept
  assert.deepEqual(d.config.livekit, existing.livekit)

  await assert.rejects(runSetup({ dataDir: '/d', output: new PassThrough(), flags: { name: '   ' } }), SetupError)
  await assert.rejects(runSetup({ dataDir: '/d', output: new PassThrough(), flags: { password: 'a', noPassword: true } }), SetupError)
})

test('setup: answers typed after each question (interactive pacing)', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const answers = ['Paced', 'paced-pass', 'n']
  output.on('data', (c: Buffer) => {
    if (/: $/.test(c.toString()) && answers.length) {
      const a = answers.shift()!
      setTimeout(() => input.write(a + '\n'), 5)
    }
  })
  const r = await runSetup({ dataDir: '/d', input, output, interactive: true, platform: 'linux' })
  assert.equal(r.config.serverName, 'Paced')
  assert.equal(r.config.serverPassword, 'paced-pass')
})
