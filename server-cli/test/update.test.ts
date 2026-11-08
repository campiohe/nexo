import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { crc32, deflateRawSync, gzipSync } from 'node:zlib'
import { extractTarGz, extractZip, parseSha256File, sha256 } from '../src/update/archive.ts'
import { CHECK_FILE, runUpdate, startupUpdateLine, type UpdateDeps } from '../src/update/command.ts'
import { cleanupOldFiles, installFiles, packagedBinary } from '../src/update/install.ts'
import { fetchReleases, planUpdate, serverAssetName, UpdateError, type GitHubRelease } from '../src/update/releases.ts'
import { compareVersions, isTestVersion, parseVersion } from '../src/update/semver.ts'

// ---------- semver ----------

test('compareVersions: semver precedence table', () => {
  // Each version is lower than the next one.
  const ordered = [
    '0.1.0-alpha.1',
    '0.2.0-alpha.1',
    '0.2.0-alpha.3',
    '0.2.0-alpha.10', // numeric, not lexical
    '0.3.0-alpha.1',
    '0.4.0-alpha',
    '0.4.0-alpha.1',
    '0.4.0-alpha.beta',
    '0.4.0-beta',
    '0.4.0-beta.2',
    '0.4.0-beta.11',
    '0.4.0-rc.1',
    '0.4.0',
    '0.4.1',
    '0.10.0',
    '1.0.0',
  ]
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.equal(compareVersions(ordered[i]!, ordered[j]!), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`)
    }
  }
  assert.equal(compareVersions('v1.2.3', '1.2.3+build.5'), 0)
  assert.equal(compareVersions('1.0.0-1', '1.0.0-a'), -1) // numeric ids rank below alphanumeric
  assert.throws(() => compareVersions('dev', '1.0.0'), /Not a version: dev/)
})

test('parseVersion / isTestVersion', () => {
  assert.deepEqual(parseVersion('v0.4.0-beta.2'), { major: 0, minor: 4, patch: 0, pre: ['beta', 2] })
  for (const bad of ['dev', '1.2', '01.2.3', '1.2.3-', '1.2.3-a..b', '']) assert.equal(parseVersion(bad), null, bad)
  assert.equal(isTestVersion('0.4.0-test.3'), true)
  assert.equal(isTestVersion('0.4.0-test'), true)
  assert.equal(isTestVersion('0.4.0-beta.2'), false)
  assert.equal(isTestVersion('0.4.0-testing.1'), false)
  assert.equal(isTestVersion('0.4.0'), false)
})

// ---------- release selection ----------

const win = { platform: 'win32' as const, arch: 'x64' }
const lin = { platform: 'linux' as const, arch: 'x64' }

function release(version: string, opts: { assets?: string[]; draft?: boolean; withBuild?: boolean } = {}): GitHubRelease {
  const names = opts.assets ?? (opts.withBuild === false ? [] : [`Nexo-Server-${version}-win-x64.zip`, `Nexo-Server-${version}-win-x64.zip.sha256`])
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/campiohe/nexo/releases/tag/v${version}`,
    draft: opts.draft ?? false,
    prerelease: version.includes('-'),
    assets: [`Nexo-Setup-${version}.exe`, ...names].map((name) => ({ name, browser_download_url: `https://dl/${name}`, size: 1000 })),
  }
}

test('serverAssetName', () => {
  assert.equal(serverAssetName('0.5.0', win), 'Nexo-Server-0.5.0-win-x64.zip')
  assert.equal(serverAssetName('0.5.0', lin), 'Nexo-Server-0.5.0-linux-x64.tar.gz')
  assert.equal(serverAssetName('0.5.0', { platform: 'darwin', arch: 'arm64' }), null)
  assert.equal(serverAssetName('0.5.0', { platform: 'win32', arch: 'arm64' }), null)
})

test('planUpdate: lanes, never a downgrade, drafts ignored', () => {
  const releases = [
    release('0.4.0-beta.2'),
    release('0.4.0-test.3'),
    release('0.4.0-beta.1'),
    release('0.4.0-test.2'),
    release('0.5.0-beta.1', { draft: true }),
    release('0.3.0-alpha.1'),
  ]
  const pick = (current: string) => {
    const p = planUpdate(releases, current, win)
    return p.kind === 'available' ? p.version : p.kind
  }
  // [current, expected]
  const table: [string, string][] = [
    ['0.3.0-alpha.1', '0.4.0-beta.2'], // alpha → newest non-test (beta)
    ['0.4.0-beta.1', '0.4.0-beta.2'],
    ['0.4.0-beta.2', 'up-to-date'],
    ['0.4.0-rc.1', 'up-to-date'], // never a downgrade to beta
    ['0.4.0', 'up-to-date'],
    ['0.4.0-test.2', '0.4.0-test.3'], // a test build follows test builds only
    ['0.4.0-test.3', 'up-to-date'], // …and doesn't jump to beta.2 (lower precedence anyway) or anything else
    ['0.4.0-test.1', '0.4.0-test.3'],
    ['0.2.0-alpha.1', '0.4.0-beta.2'], // never offered a test build
  ]
  for (const [current, expected] of table) assert.equal(pick(current), expected, current)
  assert.deepEqual(planUpdate(releases, '0.4.0-beta.2', win), { kind: 'up-to-date', current: '0.4.0-beta.2', latest: '0.4.0-beta.2' })
  assert.throws(() => planUpdate(releases, 'dev', win), /no release version/)
})

test('planUpdate: newest without a build for this OS', () => {
  const noBuild = [release('0.5.0', { withBuild: false }), release('0.4.0-beta.2', { withBuild: false })]
  const p = planUpdate(noBuild, '0.4.0-beta.1', win)
  assert.equal(p.kind, 'no-build')
  assert.equal(p.kind === 'no-build' && p.version, '0.5.0')
  assert.equal(p.kind === 'no-build' && p.assetName, 'Nexo-Server-0.5.0-win-x64.zip')

  // Linux: the Windows zip doesn't count.
  assert.equal(planUpdate([release('0.5.0')], '0.4.0', lin).kind, 'no-build')

  // An older-but-newer-than-current release with a build is taken; the newest is reported as skipped.
  const mixed = [release('0.5.1', { withBuild: false }), release('0.5.0')]
  const m = planUpdate(mixed, '0.4.0', win)
  assert.equal(m.kind, 'available')
  if (m.kind === 'available') {
    assert.equal(m.version, '0.5.0')
    assert.equal(m.skipped, '0.5.1')
    assert.equal(m.checksum?.name, 'Nexo-Server-0.5.0-win-x64.zip.sha256')
  }
  // No checksum file: still "available", without `checksum` (runUpdate refuses it).
  const noSum = planUpdate([release('0.5.0', { assets: ['Nexo-Server-0.5.0-win-x64.zip'] })], '0.4.0', win)
  assert.equal(noSum.kind === 'available' && noSum.checksum, undefined)
})

// ---------- GitHub API errors ----------

const jsonResponse = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init })

test('fetchReleases: offline, rate limit, HTTP error, good list', async () => {
  const offline = (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
  }) as typeof fetch
  await assert.rejects(fetchReleases({ fetch: offline, userAgent: 't' }), (e: Error) => e instanceof UpdateError && /Couldn't reach GitHub \(ENOTFOUND\)/.test(e.message))

  const reset = Math.floor(Date.parse('2026-11-08T12:30:00Z') / 1000)
  const limited = (async () =>
    jsonResponse({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } })) as typeof fetch
  await assert.rejects(
    fetchReleases({ fetch: limited, userAgent: 't', now: () => new Date('2026-11-08T12:00:00Z') }),
    /limiting update checks.*in 30 min/,
  )
  const broken = (async () => jsonResponse({}, { status: 502 })) as typeof fetch
  await assert.rejects(fetchReleases({ fetch: broken, userAgent: 't' }), /HTTP 502/)

  let headers: Headers | undefined
  const ok = (async (_url: string, init?: RequestInit) => {
    headers = new Headers(init?.headers)
    return jsonResponse([release('0.5.0'), { junk: true }])
  }) as typeof fetch
  const list = await fetchReleases({ fetch: ok, userAgent: 'nexo-server/0.4.0' })
  assert.equal(list.length, 1)
  assert.equal(headers?.get('user-agent'), 'nexo-server/0.4.0')
})

// ---------- sha256 file ----------

test('parseSha256File: sha256sum text and binary (*) forms, bare hex, case', () => {
  const hex = 'ab'.repeat(32)
  const name = 'Nexo-Server-0.4.0-beta.2-win-x64.zip'
  assert.equal(parseSha256File(`${hex}  ${name}\n`, name), hex)
  // Git Bash sha256sum on the Windows runner writes binary mode: "<hex> *<name>".
  assert.equal(parseSha256File(`${hex} *${name}\n`, name), hex)
  assert.equal(parseSha256File(`${hex.toUpperCase()} *${name}\r\n`, name), hex)
  assert.equal(parseSha256File(`${hex}\n`, name), hex)
  assert.equal(parseSha256File(`\uFEFF${hex}  dist/${name}`, name), hex)
  assert.throws(() => parseSha256File(`${hex}  other.zip`, name), /is for "other.zip"/)
  assert.throws(() => parseSha256File('not a hash', name), /format/)
  assert.throws(() => parseSha256File('', name), /format/)
  assert.throws(() => parseSha256File(`${hex}ab  ${name}`, name), /format/)
})

// ---------- archives ----------

/** A small zip: entries stored (method 0) or deflated (method 8), like PowerShell/7-Zip would write. */
function makeZip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const body = e.deflate ? deflateRawSync(e.data) : e.data
    const name = Buffer.from(e.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(e.deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc32(e.data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(e.deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc32(e.data), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

function makeTarGz(entries: { name: string; data: Buffer; mode?: number }[]): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const h = Buffer.alloc(512)
    h.write(e.name, 0, 100, 'utf8')
    h.write((e.mode ?? 0o644).toString(8).padStart(7, '0'), 100)
    h.write(e.data.length.toString(8).padStart(11, '0'), 124)
    h.write('0', 156)
    h.write('ustar', 257)
    blocks.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const exe = Buffer.from('MZ fake nexo-server '.repeat(500))
const lk = Buffer.from('MZ fake livekit-server '.repeat(300))

test('extractZip: flat and nested names, stored and deflated, CRC checked', () => {
  const zip = makeZip([
    { name: 'README.txt', data: Buffer.from('hi') },
    { name: 'nexo-server.exe', data: exe, deflate: true },
    { name: 'sub/livekit-server.exe', data: lk },
  ])
  const got = extractZip(zip, ['nexo-server.exe', 'livekit-server.exe'])
  assert.deepEqual(got.map((e) => e.name), ['nexo-server.exe', 'sub/livekit-server.exe'])
  assert.deepEqual(got[0]!.data, exe)
  assert.deepEqual(got[1]!.data, lk)
  assert.deepEqual(extractZip(zip, ['missing.exe']), [])

  const corrupt = Buffer.from(zip)
  corrupt[30 + 'README.txt'.length] ^= 0xff // flip a byte of README's stored data
  assert.throws(() => extractZip(corrupt, ['README.txt']), /corrupt \(size or CRC mismatch\)/)
  assert.throws(() => extractZip(Buffer.from('not a zip at all, just text padding....'), ['x']), /not a zip/)
})

test('extractTarGz: picks the binaries with their modes', () => {
  const tgz = makeTarGz([
    { name: 'nexo-server', data: exe, mode: 0o755 },
    { name: 'LICENSE.txt', data: Buffer.from('MIT') },
    { name: 'livekit-server', data: lk, mode: 0o755 },
  ])
  const got = extractTarGz(tgz, ['nexo-server', 'livekit-server'])
  assert.deepEqual(got.map((e) => [e.name, e.mode, e.data.length]), [['nexo-server', 0o755, exe.length], ['livekit-server', 0o755, lk.length]])
})

// ---------- install ----------

test('installFiles renames the old binaries aside; cleanupOldFiles removes them next start', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-install-'))
  try {
    writeFileSync(path.join(dir, 'nexo-server.exe'), 'old nexo')
    writeFileSync(path.join(dir, 'livekit-server.exe'), 'old lk')
    writeFileSync(path.join(dir, 'livekit-server.exe.old'), 'older lk') // from an earlier update
    installFiles(dir, [
      { name: 'nexo-server.exe', data: Buffer.from('new nexo') },
      { name: 'livekit-server.exe', data: Buffer.from('new lk') },
    ])
    assert.equal(readFileSync(path.join(dir, 'nexo-server.exe'), 'utf8'), 'new nexo')
    assert.equal(readFileSync(path.join(dir, 'livekit-server.exe'), 'utf8'), 'new lk')
    assert.equal(readFileSync(path.join(dir, 'nexo-server.exe.old'), 'utf8'), 'old nexo')
    assert.equal(readFileSync(path.join(dir, 'livekit-server.exe.old'), 'utf8'), 'old lk')

    writeFileSync(path.join(dir, 'nexo-server.exe.1700000000000.old'), 'x')
    writeFileSync(path.join(dir, 'notes.old'), 'not ours')
    const removed = cleanupOldFiles(dir, ['nexo-server.exe', 'livekit-server.exe']).sort()
    assert.deepEqual(removed, ['livekit-server.exe.old', 'nexo-server.exe.1700000000000.old', 'nexo-server.exe.old'])
    assert.deepEqual(readdirSync(dir).sort(), ['livekit-server.exe', 'nexo-server.exe', 'notes.old'])
    assert.deepEqual(cleanupOldFiles(path.join(dir, 'missing')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('installFiles rolls back when a file cannot be placed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-install-'))
  try {
    writeFileSync(path.join(dir, 'nexo-server'), 'old nexo')
    mkdirSync(path.join(dir, 'livekit-server.new')) // a directory where the new file is staged: writing fails
    writeFileSync(path.join(dir, 'livekit-server.new', 'x'), '')
    assert.throws(() =>
      installFiles(dir, [
        { name: 'nexo-server', data: Buffer.from('new nexo') },
        { name: 'livekit-server', data: Buffer.from('new lk') },
      ]),
    )
    assert.equal(readFileSync(path.join(dir, 'nexo-server'), 'utf8'), 'old nexo')
    assert.ok(!existsSync(path.join(dir, 'nexo-server.new')))
    assert.ok(!existsSync(path.join(dir, 'nexo-server.old')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('packagedBinary: only the SEA named nexo-server', () => {
  assert.equal(packagedBinary('C:\\Nexo\\nexo-server.exe'.replace(/\\/g, '/'), true), 'C:/Nexo/nexo-server.exe')
  assert.equal(packagedBinary('/opt/nexo/nexo-server', true), '/opt/nexo/nexo-server')
  assert.equal(packagedBinary('/usr/bin/node', true), null)
  assert.equal(packagedBinary('/opt/nexo/nexo-server', false), null)
})

// ---------- the update command, end to end with a fake GitHub ----------

function fakeGitHub(releases: GitHubRelease[], files: Record<string, Buffer | string>) {
  const calls: string[] = []
  const f = (async (url: string) => {
    calls.push(url)
    if (url.startsWith('https://api.github.com/')) return jsonResponse(releases)
    const body = files[url.replace('https://dl/', '')]
    return body === undefined ? new Response('nope', { status: 404 }) : new Response(typeof body === 'string' ? body : new Uint8Array(body), { headers: { 'content-length': String(Buffer.byteLength(body)) } })
  }) as typeof fetch
  return { fetch: f, calls }
}

function updateDeps(dir: string, fetchFn: typeof fetch, over: Partial<UpdateDeps> = {}) {
  const lines: string[] = []
  const deps: UpdateDeps = {
    version: '0.4.0-beta.2',
    platform: 'win32',
    arch: 'x64',
    binary: path.join(dir, 'nexo-server.exe'),
    runningPid: null,
    out: (l = '') => lines.push(l),
    err: (l = '') => lines.push(`ERR ${l}`),
    fetch: fetchFn,
    ...over,
  }
  return { deps, text: () => lines.join('\n') }
}

test('runUpdate: downloads, verifies, swaps; refuses bad checksums and a running server', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-update-'))
  try {
    writeFileSync(path.join(dir, 'nexo-server.exe'), 'old nexo')
    writeFileSync(path.join(dir, 'livekit-server.exe'), 'old lk')
    const zipName = 'Nexo-Server-0.5.0-win-x64.zip'
    const zip = makeZip([
      { name: 'nexo-server.exe', data: exe, deflate: true },
      { name: 'livekit-server.exe', data: lk, deflate: true },
      { name: 'README.txt', data: Buffer.from('readme') },
    ])
    const releases = [release('0.5.0'), release('0.4.0-beta.2')]

    // A server running for this data folder: refused before any network access.
    let gh = fakeGitHub(releases, {})
    let r = updateDeps(dir, gh.fetch, { runningPid: 4242 })
    assert.equal(await runUpdate(r.deps), 1)
    assert.match(r.text(), /running \(PID 4242\)\. Stop it first/)
    assert.equal(gh.calls.length, 0)

    // From source: refused.
    r = updateDeps(dir, gh.fetch, { binary: null })
    assert.equal(await runUpdate(r.deps), 1)
    assert.match(r.text(), /only works in the downloaded nexo-server/)

    // Checksum mismatch: nothing replaced.
    gh = fakeGitHub(releases, { [zipName]: zip, [`${zipName}.sha256`]: `${'0'.repeat(64)} *${zipName}\n` })
    r = updateDeps(dir, gh.fetch)
    assert.equal(await runUpdate(r.deps), 1)
    assert.match(r.text(), /doesn't match its checksum/)
    assert.equal(readFileSync(path.join(dir, 'nexo-server.exe'), 'utf8'), 'old nexo')

    // Good download (binary-mode checksum line, as Git Bash's sha256sum writes it).
    gh = fakeGitHub(releases, { [zipName]: zip, [`${zipName}.sha256`]: `${sha256(zip).toUpperCase()} *${zipName}\n` })
    r = updateDeps(dir, gh.fetch)
    assert.equal(await runUpdate(r.deps), 0, r.text())
    assert.match(r.text(), /Updated Nexo Server 0\.4\.0-beta\.2 -> 0\.5\.0\./)
    assert.match(r.text(), /releases\/tag\/v0\.5\.0/)
    assert.deepEqual(readFileSync(path.join(dir, 'nexo-server.exe')), exe)
    assert.deepEqual(readFileSync(path.join(dir, 'livekit-server.exe')), lk)
    assert.equal(readFileSync(path.join(dir, 'nexo-server.exe.old'), 'utf8'), 'old nexo')
    assert.ok(!existsSync(path.join(dir, 'README.txt')))

    // Now up to date.
    r = updateDeps(dir, gh.fetch, { version: '0.5.0' })
    assert.equal(await runUpdate(r.deps), 0)
    assert.match(r.text(), /You have the newest version \(0\.5\.0\)/)

    // Zip without livekit-server.exe: refused.
    const partial = makeZip([{ name: 'nexo-server.exe', data: exe }])
    gh = fakeGitHub(releases, { [zipName]: partial, [`${zipName}.sha256`]: `${sha256(partial)}  ${zipName}\n` })
    r = updateDeps(dir, gh.fetch, { version: '0.4.0' })
    assert.equal(await runUpdate(r.deps), 1)
    assert.match(r.text(), /doesn't contain livekit-server\.exe/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runUpdate: no build in the newest release, no checksum file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-update-'))
  try {
    let r = updateDeps(dir, fakeGitHub([release('0.5.0', { withBuild: false })], {}).fetch)
    assert.equal(await runUpdate(r.deps), 1)
    assert.match(r.text(), /Nexo 0\.5\.0 is out, but that release has no Nexo Server download for Windows yet \(no Nexo-Server-0\.5\.0-win-x64\.zip\)/)

    r = updateDeps(dir, fakeGitHub([release('0.5.0')], {}).fetch, { platform: 'linux' })
    assert.equal(await runUpdate(r.deps), 1)
    assert.match(r.text(), /no Nexo Server download for Linux yet/)

    r = updateDeps(dir, fakeGitHub([release('0.5.0', { assets: ['Nexo-Server-0.5.0-win-x64.zip'] })], {}).fetch)
    assert.equal(await runUpdate(r.deps), 1)
    assert.match(r.text(), /no checksum file/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startupUpdateLine: prints when newer, checks at most once a day, quiet when offline', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-check-'))
  try {
    let now = new Date('2026-11-08T10:00:00Z')
    const gh = fakeGitHub([release('0.5.0'), release('0.4.0-beta.2')], {})
    const opts = { dataDir: dir, version: '0.4.0-beta.2', ...win, fetch: gh.fetch, now: () => now }
    const line = await startupUpdateLine(opts)
    assert.match(line ?? '', /Nexo Server 0\.5\.0 is available \(you have 0\.4\.0-beta\.2\)\..*nexo-server update/)
    assert.equal(gh.calls.length, 1)
    const cache = JSON.parse(readFileSync(path.join(dir, CHECK_FILE), 'utf8'))
    assert.equal(cache.available.version, '0.5.0')

    now = new Date('2026-11-09T09:00:00Z') // 23 h later: cached
    assert.equal(await startupUpdateLine(opts), line)
    assert.equal(gh.calls.length, 1)

    // The updated binary (another version) checks again.
    assert.equal(await startupUpdateLine({ ...opts, version: '0.5.0' }), null)
    assert.equal(gh.calls.length, 2)

    // Offline: no line, no throw, and the attempt is recorded.
    rmSync(path.join(dir, CHECK_FILE))
    const offline = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    assert.equal(await startupUpdateLine({ ...opts, fetch: offline }), null)
    assert.ok(existsSync(path.join(dir, CHECK_FILE)))

    // From source: never checks.
    assert.equal(await startupUpdateLine({ ...opts, version: 'dev', fetch: offline }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
