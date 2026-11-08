import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultConfig, type NetworkMode } from '../src/cli/config.ts'
import { httpUrl, inviteFromProbe, renderInvite, supportsUnicode, type InviteInput, type NetworkProbe } from '../src/cli/invite.ts'
import { statusLine } from '../src/cli/status.ts'

const base: InviteInput = {
  serverName: 'The Lounge',
  password: 'moss-tiger-41',
  addresses: [
    { label: 'Same network', url: 'http://192.168.1.20:3001' },
    { label: 'Internet', url: 'http://187.12.34.56:3001', recommended: true },
  ],
  localUrl: 'http://localhost:3001',
  notes: ['Keep this window open while you play. Press Ctrl+C to stop.'],
}

const cols = (lines: string[]) => Math.max(...lines.map((l) => [...l].length))

test('invite: unicode box like the spec', () => {
  const lines = renderInvite(base)
  const text = lines.join('\n')
  assert.match(text, /Invite your friends to "The Lounge" — send them this:/)
  assert.match(lines[1], /^ {2}┌─+┐$/)
  assert.match(text, /│ Server: {3}http:\/\/187\.12\.34\.56:3001 +│/)
  assert.match(text, /│ Password: moss-tiger-41 +│/)
  assert.match(text, /Other addresses:\n {4}Same network: http:\/\/192\.168\.1\.20:3001/)
  assert.match(text, /You \(on this PC\): http:\/\/localhost:3001/)
  // box lines all the same width
  const box = lines.filter((l) => /[┌│└]/.test(l))
  assert.equal(new Set(box.map((l) => [...l].length)).size, 1)
  assert.equal([...box[0]].length, 2 + 46) // 46 wide like §3.1
})

test('invite: ASCII fallback has only ASCII', () => {
  const lines = renderInvite(base, { ascii: true })
  for (const l of lines) assert.match(l, /^[\x20-\x7e]*$/, l)
  assert.match(lines[1], /^ {2}\+-+\+$/)
  assert.match(lines.join('\n'), /\| Password: moss-tiger-41 +\|/)
})

test('invite: no password and no addresses', () => {
  const text = renderInvite({ ...base, password: '', addresses: [], notes: [] }).join('\n')
  assert.match(text, /Password: \(none needed\)/)
  assert.match(text, /Server: {3}http:\/\/localhost:3001/)
  assert.match(text, /Only reachable from this PC/)
})

test('invite: long names and narrow consoles stay within the width', () => {
  const long = { ...base, serverName: 'The Extraordinarily Long Named Friday Night Gaming Lounge Of Doom', notes: ['word '.repeat(60)] }
  for (const width of [80, 60, 40]) {
    const lines = renderInvite(long, { width })
    assert.ok(cols(lines) <= width, `width ${width}: ${cols(lines)}`)
  }
  // narrow: no box, plain lines, URL intact
  const narrow = renderInvite(base, { width: 40 })
  assert.ok(!narrow.some((l) => /[┌│]/.test(l)))
  assert.ok(narrow.includes('  Server:   http://187.12.34.56:3001'))
  assert.match(renderInvite(long, { width: 80 }).join('\n'), /…/)
  assert.match(renderInvite(long, { width: 80, ascii: true }).join('\n'), /\.\.\./)
})

test('invite: a long URL widens the box instead of overflowing', () => {
  const url = 'http://[fd7a:115c:a1e0:ab12:4843:cd96:6258:b240]:3001'
  const lines = renderInvite({ ...base, addresses: [{ label: 'Tailscale', url }] }, { width: 100 })
  const box = lines.filter((l) => l.includes('│'))
  assert.ok(box.some((l) => l.includes(url)))
  assert.equal(new Set(box.map((l) => l.length)).size, 1)
})

test('supportsUnicode', () => {
  assert.equal(supportsUnicode({}, 'win32'), true)
  assert.equal(supportsUnicode({ NEXO_ASCII: '1' }, 'win32'), false)
  assert.equal(supportsUnicode({ LANG: 'en_US.UTF-8' }, 'linux'), true)
  assert.equal(supportsUnicode({ LANG: 'C' }, 'linux'), false)
  assert.equal(supportsUnicode({ LANG: 'en_US.UTF-8', TERM: 'dumb' }, 'linux'), false)
})

const probe = (p: Partial<NetworkProbe> = {}): NetworkProbe => ({
  lan: ['192.168.1.20'],
  tailscale: null,
  stunIp: '187.12.34.56',
  gateway: { found: true, externalIp: '187.12.34.56' },
  reachability: 'public',
  notes: [],
  ...p,
})
const cfg = (mode: NetworkMode = 'auto') => ({ ...createDefaultConfig({ serverName: 'L', serverPassword: 'pw-pw-10' }), network: { mode } })

test('inviteFromProbe: recommendation per mode', () => {
  const pub = inviteFromProbe(probe(), cfg())
  assert.deepEqual(pub.addresses.map((a) => [a.label, a.url, !!a.recommended]), [
    ['Internet', 'http://187.12.34.56:3001', true],
    ['Same network', 'http://192.168.1.20:3001', false],
  ])
  assert.equal(pub.localUrl, 'http://localhost:3001')
  assert.equal(pub.password, 'pw-pw-10')

  const ts = inviteFromProbe(probe({ tailscale: { ip: '100.101.102.103' } }), cfg())
  assert.equal(ts.addresses[0].label, 'Tailscale')
  assert.equal(ts.addresses[0].recommended, true)
  assert.equal(ts.addresses.length, 3)

  const cgnat = inviteFromProbe(probe({ reachability: 'cgnat', notes: ['Use Tailscale instead'] }), cfg())
  assert.deepEqual(cgnat.addresses.map((a) => a.label), ['Same network'])
  assert.deepEqual(cgnat.notes, ['Use Tailscale instead'])

  const lan = inviteFromProbe(probe({ tailscale: { ip: '100.1.1.1' } }), cfg('lan'))
  assert.deepEqual(lan.addresses.map((a) => a.label), ['Same network'])

  const forcedTs = inviteFromProbe(probe(), cfg('tailscale'))
  assert.ok(!forcedTs.addresses.some((a) => a.recommended))
  assert.match(forcedTs.notes[0], /Tailscale is not running/)

  const forcedPublic = inviteFromProbe(probe({ reachability: 'unknown' }), cfg('public'))
  assert.match(forcedPublic.notes[0], /could not confirm a public address/)

  const nothing = inviteFromProbe(probe({ lan: [], reachability: 'unknown' }), cfg())
  assert.deepEqual(nothing.addresses, [])
  assert.match(renderInvite(nothing).join('\n'), /Server: {3}http:\/\/localhost:3001/)

  const custom = { ...cfg(), ports: { ...cfg().ports, http: 4000 } }
  assert.equal(inviteFromProbe(probe(), custom).addresses[0].url, 'http://187.12.34.56:4000')
  assert.equal(httpUrl('fe80::1', 3001), 'http://[fe80::1]:3001')
})

test('statusLine', () => {
  assert.equal(statusLine({ online: 3, inVoice: 2, streaming: 1, uploadMbps: 9.44 }), '3 online · 2 in voice · 1 streaming · PC upload 9.4 Mbit/s')
  assert.equal(statusLine({ online: 0, inVoice: 0, streaming: 0 }), '0 online')
  assert.equal(statusLine({ online: 2, inVoice: 2, streaming: 0 }, { ascii: true }), '2 online | 2 in voice')
})
