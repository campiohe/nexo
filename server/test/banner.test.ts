// Profile banner HTTP API: PUT/DELETE /api/banner, GET /banners/:userId, the bannerPreset profile field and the
// users.banner* migration.
// Boots real servers on random ports with temp data dirs. Run with `npm test -w server`.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client'
import type { Bootstrap, ClientToServerEvents, HandshakeAuth, ServerToClientEvents, User } from '../../shared/protocol.ts'
import { BANNER_ANIMATED_MAX_BYTES, BANNER_MAX_BYTES, BANNER_PRESETS } from '../../shared/protocol.ts'
import type { AckResult } from '../../shared/protocol.ts'
import { start, type NexoInstance, type StartOptions } from '../src/server.ts'

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>

const TIMEOUT = 3000
const tmpDirs: string[] = []
const clients: Client[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-banner-test-'))
  tmpDirs.push(dir)
  return dir
}

function boot(opts: Partial<StartOptions> = {}): Promise<NexoInstance> {
  return start({
    port: 0,
    host: '127.0.0.1',
    dataDir: tempDir(),
    serverName: 'Banner Test',
    serverPassword: '',
    livekit: { apiKey: 'k', apiSecret: 'test-secret-that-is-at-least-32-characters-long', publicUrl: '', port: 7880 },
    log: false,
    avatarIntervalMs: 0,
    bannerIntervalMs: 0,
    ...opts,
  })
}

function connect(url: string, auth: HandshakeAuth): Promise<{ socket: Client; boot: Bootstrap }> {
  const socket: Client = connectClient(url, { auth, transports: ['websocket'], forceNew: true, reconnection: false })
  clients.push(socket)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bootstrap timeout')), TIMEOUT)
    socket.once('bootstrap', (b) => {
      clearTimeout(timer)
      resolve({ socket, boot: b })
    })
    socket.once('connect_error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function nextUpsert(socket: Client, match: (u: User) => boolean): Promise<User> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('user:upsert', handler)
      reject(new Error('timed out waiting for user:upsert'))
    }, TIMEOUT)
    const handler = (u: User) => {
      if (!match(u)) return
      clearTimeout(timer)
      socket.off('user:upsert', handler)
      resolve(u)
    }
    socket.on('user:upsert', handler)
  })
}

// Minimal byte sequences with the right magic numbers (the server validates signatures, it doesn't decode).
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 9, 9])
const WEBP = new Uint8Array([...Buffer.from('RIFF'), 20, 0, 0, 0, ...Buffer.from('WEBPVP8 '), 4, 5, 6, 7])
const GIF = new Uint8Array([...Buffer.from('GIF89a'), 160, 0, 160, 0, 0xf7, 0, 0, 1, 2, 3, 0x3b])
const GIF87 = new Uint8Array([...Buffer.from('GIF87a'), 1, 0, 1, 0, 0, 0, 0, 0x3b])
const token12 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 12)

function put(url: string, token: string | null, type: string, body: BodyInit, api = '/api/banner') {
  const headers: Record<string, string> = { 'content-type': type }
  if (token !== null) headers.authorization = `Bearer ${token}`
  return fetch(`${url}${api}`, { method: 'PUT', headers, body, duplex: 'half' } as RequestInit)
}

function del(url: string, token: string) {
  return fetch(`${url}/api/banner`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
}

function profileUpdate(socket: Client, p: unknown): Promise<AckResult<User>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ack timeout')), TIMEOUT)
    ;(socket as unknown as { emit(e: string, p: unknown, ack: (r: AckResult<User>) => void): void }).emit(
      'profile:update',
      p,
      (r) => {
        clearTimeout(timer)
        resolve(r)
      },
    )
  })
}

/** Raw GET with an un-normalized path (fetch would resolve `..` segments). */
function rawGet(base: string, rawPath: string): Promise<number> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path: rawPath, method: 'GET' }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

async function errorOf(res: Response): Promise<string> {
  assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  const body = (await res.json()) as { error?: unknown }
  assert.equal(typeof body.error, 'string')
  return body.error as string
}

after(() => {
  for (const c of clients) c.close()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('banner HTTP API', () => {
  let server: NexoInstance
  let url: string
  let alice: { socket: Client; boot: Bootstrap; token: string }
  let bob: { socket: Client; boot: Bootstrap; token: string }

  before(async () => {
    server = await boot()
    url = server.url
    const a = await connect(url, { name: 'Alice', color: '#ff0000' })
    alice = { ...a, token: a.boot.token! }
    const b = await connect(url, { name: 'Bob', color: '#00ff00' })
    bob = { ...b, token: b.boot.token! }
  })
  after(() => server.close())

  test('users start without a banner, with the solid preset', () => {
    assert.equal(alice.boot.me.banner, null)
    assert.equal(alice.boot.me.bannerAnimated, false)
    assert.equal(alice.boot.me.bannerPreset, 'solid')
    assert.ok(bob.boot.users.every((u) => u.banner === null && u.bannerPreset === 'solid'))
  })

  test('CORS preflight', async () => {
    const res = await fetch(`${url}/api/banner`, {
      method: 'OPTIONS',
      headers: { origin: 'file://', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type' },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /PUT/)
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /DELETE/)
  })

  test('upload: returns the user, broadcasts user:upsert, GET serves the bytes', async () => {
    const meId = alice.boot.me.id
    const upsert = nextUpsert(bob.socket, (u) => u.id === meId && u.banner != null)
    const res = await put(url, alice.token, 'image/png', PNG)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    const { user } = (await res.json()) as { user: User }
    assert.equal(user.id, meId)
    assert.equal(user.banner, token12(PNG))
    assert.equal(user.bannerAnimated, false)
    assert.equal(user.avatar, null, 'the avatar is untouched')
    assert.deepEqual(await upsert, user)

    const img = await fetch(`${url}/banners/${meId}?v=${user.banner}`)
    assert.equal(img.status, 200)
    assert.equal(img.headers.get('content-type'), 'image/png')
    assert.equal(img.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(img.headers.get('content-security-policy'), "default-src 'none'")
    assert.deepEqual(new Uint8Array(await img.arrayBuffer()), PNG)

    const head = await fetch(`${url}/banners/${meId}?v=${user.banner}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(PNG.length))

    // Stored in <dataDir>/banners/<userId>, separately from the avatar.
    assert.deepEqual(readdirSync(path.join(server.config.dataDir, 'banners')), [meId])
    assert.deepEqual(readdirSync(path.join(server.config.dataDir, 'avatars')), [])
    assert.equal((await fetch(`${url}/avatars/${meId}?v=${user.banner}`)).status, 404)
  })

  test('banner and avatar are independent', async () => {
    const meId = alice.boot.me.id
    const res = await put(url, alice.token, 'image/jpeg', JPEG, '/api/avatar')
    assert.equal(res.status, 200)
    const { user } = (await res.json()) as { user: User }
    assert.equal(user.avatar, token12(JPEG))
    assert.equal(user.banner, token12(PNG))
    assert.deepEqual(
      new Uint8Array(await (await fetch(`${url}/banners/${meId}?v=${user.banner}`)).arrayBuffer()),
      PNG,
    )
  })

  test('re-upload changes the version; old versions are not cached forever', async () => {
    const meId = alice.boot.me.id
    const oldVersion = token12(PNG)
    const res = await put(url, alice.token, 'image/webp', WEBP)
    assert.equal(res.status, 200)
    const { user } = (await res.json()) as { user: User }
    assert.equal(user.banner, token12(WEBP))

    const img = await fetch(`${url}/banners/${meId}?v=${user.banner}`)
    assert.equal(img.headers.get('content-type'), 'image/webp')
    const stale = await fetch(`${url}/banners/${meId}?v=${oldVersion}`)
    assert.equal(stale.status, 200)
    assert.equal(stale.headers.get('cache-control'), 'no-cache')
  })

  test('reconnect bootstrap includes the banner (persisted)', async () => {
    const again = await connect(url, { token: bob.token })
    assert.equal(again.boot.users.find((u) => u.id === alice.boot.me.id)?.banner, token12(WEBP))
    again.socket.close()
  })

  test('wrong magic bytes or content type → 415', async () => {
    const text = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    let res = await put(url, alice.token, 'image/png', text)
    assert.equal(res.status, 415)
    assert.match(await errorOf(res), /not a WebP, PNG, JPEG or GIF/)

    res = await put(url, alice.token, 'image/webp', PNG)
    assert.equal(res.status, 415)
    assert.equal(await errorOf(res), 'The file is image/png, not image/webp')

    res = await put(url, alice.token, 'image/svg+xml', text)
    assert.equal(res.status, 415)
    assert.match(await errorOf(res), /^Banners must be WebP, PNG, JPEG or GIF/)
  })

  test('static banners up to BANNER_MAX_BYTES, GIFs up to BANNER_ANIMATED_MAX_BYTES → else 413', async () => {
    const max = new Uint8Array(BANNER_MAX_BYTES)
    max.set(PNG)
    assert.equal((await put(url, bob.token, 'image/png', max)).status, 200, 'exactly at the limit')

    const big = new Uint8Array(BANNER_MAX_BYTES + 1)
    big.set(PNG)
    let res = await put(url, bob.token, 'image/png', big)
    assert.equal(res.status, 413)
    assert.equal(await errorOf(res), 'Banners are limited to 2 MB')

    // A GIF bigger than the static limit is fine, up to the animated limit.
    const gif = new Uint8Array(BANNER_ANIMATED_MAX_BYTES)
    gif.set(GIF)
    res = await put(url, bob.token, 'image/gif', gif)
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { user: User }).user.bannerAnimated, true)

    const bigGif = new Uint8Array(BANNER_ANIMATED_MAX_BYTES + 1)
    bigGif.set(GIF)
    res = await put(url, bob.token, 'image/gif', bigGif)
    assert.equal(res.status, 413)
    assert.equal(await errorOf(res), 'Animated banners are limited to 4 MB')

    // Streamed without Content-Length: aborted once the limit is crossed.
    const chunk = new Uint8Array(256 * 1024)
    chunk.set(PNG)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > BANNER_MAX_BYTES * 2) return controller.close()
        sent += chunk.length
        controller.enqueue(chunk)
      },
    })
    res = await put(url, bob.token, 'image/png', stream)
    assert.equal(res.status, 413)
    await errorOf(res)
    await del(url, bob.token)
  })

  test('GIF: bannerAnimated true; a static upload or delete clears it', async () => {
    const meId = alice.boot.me.id
    const upsert = nextUpsert(bob.socket, (u) => u.id === meId && u.bannerAnimated === true)
    let res = await put(url, alice.token, 'image/gif', GIF)
    assert.equal(res.status, 200)
    let { user } = (await res.json()) as { user: User }
    assert.equal(user.banner, token12(GIF))
    assert.equal(user.bannerAnimated, true)
    assert.equal(user.avatarAnimated, false, 'the avatar flag is separate')
    assert.deepEqual(await upsert, user)
    assert.equal((await fetch(`${url}/banners/${meId}?v=${user.banner}`)).headers.get('content-type'), 'image/gif')

    res = await put(url, alice.token, 'image/gif', GIF87)
    assert.equal(((await res.json()) as { user: User }).user.bannerAnimated, true)

    res = await put(url, alice.token, 'image/png', PNG)
    ;({ user } = (await res.json()) as { user: User })
    assert.equal(user.bannerAnimated, false)

    assert.equal((await put(url, alice.token, 'image/gif', GIF)).status, 200)
    res = await del(url, alice.token)
    ;({ user } = (await res.json()) as { user: User })
    assert.equal(user.banner, null)
    assert.equal(user.bannerAnimated, false)
  })

  test('empty body → 400, missing or invalid token → 401, other methods → 405', async () => {
    let res = await put(url, alice.token, 'image/png', new Uint8Array(0))
    assert.equal(res.status, 400)
    await errorOf(res)

    res = await put(url, null, 'image/png', PNG)
    assert.equal(res.status, 401)
    assert.match(await errorOf(res), /Missing device token/)

    res = await put(url, 'not-a-real-token', 'image/png', PNG)
    assert.equal(res.status, 401)
    assert.match(await errorOf(res), /Unknown device token/)

    res = await fetch(`${url}/api/banner`, { method: 'DELETE', headers: { authorization: 'Bearer nope' } })
    assert.equal(res.status, 401)
    await errorOf(res)

    res = await fetch(`${url}/api/banner`, { method: 'POST', body: PNG, headers: { authorization: `Bearer ${alice.token}` } })
    assert.equal(res.status, 405)
    await errorOf(res)

    res = await fetch(`${url}/banners/${alice.boot.me.id}`, { method: 'DELETE' })
    assert.equal(res.status, 405)
    await errorOf(res)
  })

  test('delete: banner becomes null, broadcast, GET → 404; again is a no-op', async () => {
    const meId = alice.boot.me.id
    assert.equal((await put(url, alice.token, 'image/png', PNG)).status, 200)
    const upsert = nextUpsert(bob.socket, (u) => u.id === meId && u.banner === null)
    const res = await del(url, alice.token)
    assert.equal(res.status, 200)
    const { user } = (await res.json()) as { user: User }
    assert.equal(user.banner, null)
    assert.equal(user.avatar, token12(JPEG), 'the avatar stays')
    assert.deepEqual(await upsert, user)
    const missing = await fetch(`${url}/banners/${meId}?v=${token12(PNG)}`)
    assert.equal(missing.status, 404)
    assert.equal(await errorOf(missing), 'No banner')
    assert.equal(existsSync(path.join(server.config.dataDir, 'banners', meId)), false)

    const again = await del(url, alice.token)
    assert.equal(again.status, 200)
    assert.equal(((await again.json()) as { user: User }).user.banner, null)
  })

  test('unknown users and path traversal → 404', async () => {
    assert.equal((await fetch(`${url}/banners/${randomUUID()}`)).status, 404)
    assert.equal((await fetch(`${url}/banners/not-a-uuid`)).status, 404)
    assert.equal((await fetch(`${url}/banners/`)).status, 404)
    assert.equal(await rawGet(url, '/banners/../nexo.db'), 404)
    assert.equal(await rawGet(url, '/banners/..%2Fnexo.db'), 404)
    assert.equal(await rawGet(url, `/banners/${alice.boot.me.id}%2F..%2F..%2Fnexo.db`), 404)
  })

  test('removing an account deletes its banner file', async () => {
    const carol = await connect(url, { name: 'Carol', color: '#0000ff' })
    const carolId = carol.boot.me.id
    assert.equal((await put(url, carol.boot.token!, 'image/png', PNG)).status, 200)
    assert.ok(existsSync(path.join(server.config.dataDir, 'banners', carolId)))
    const removed = new Promise<void>((resolve) => bob.socket.once('user:removed', () => resolve()))
    // Alice is the owner (first account).
    const res = await new Promise<AckResult<null>>((resolve) =>
      alice.socket.emit('user:remove', { userId: carolId }, resolve),
    )
    assert.equal(res.ok, true)
    await removed
    for (let i = 0; i < 50 && existsSync(path.join(server.config.dataDir, 'banners', carolId)); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(existsSync(path.join(server.config.dataDir, 'banners', carolId)), false)
  })
})

describe('banner presets (profile:update bannerPreset)', () => {
  let server: NexoInstance
  let alice: { socket: Client; boot: Bootstrap; token: string }
  let bob: { socket: Client; boot: Bootstrap; token: string }

  before(async () => {
    server = await boot()
    const a = await connect(server.url, { name: 'Alice', color: '#ff0000' })
    alice = { ...a, token: a.boot.token! }
    const b = await connect(server.url, { name: 'Bob', color: '#00ff00' })
    bob = { ...b, token: b.boot.token! }
  })
  after(() => server.close())

  test('every preset id is accepted, returned and broadcast', async () => {
    const meId = alice.boot.me.id
    for (const preset of [...BANNER_PRESETS.slice(1), BANNER_PRESETS[0]]) {
      const upsert = nextUpsert(bob.socket, (u) => u.id === meId && u.bannerPreset === preset)
      const res = await profileUpdate(alice.socket, { bannerPreset: preset })
      assert.ok(res.ok, `preset ${preset}`)
      assert.equal(res.data.bannerPreset, preset)
      assert.equal(res.data.color, '#ff0000', 'other fields unchanged')
      assert.deepEqual(await upsert, res.data)
    }
  })

  test('combined with other fields; persisted across reconnects', async () => {
    const res = await profileUpdate(alice.socket, { color: '#123456', bannerPreset: 'aurora' })
    assert.ok(res.ok)
    assert.equal(res.data.color, '#123456')
    assert.equal(res.data.bannerPreset, 'aurora')
    const again = await connect(server.url, { token: bob.token })
    assert.equal(again.boot.users.find((u) => u.id === alice.boot.me.id)?.bannerPreset, 'aurora')
    again.socket.close()
  })

  test('unknown or malformed preset ids → "Invalid banner", nothing changes', async () => {
    for (const bad of ['rainbow', '', 'Solid', 5, null, {}, ['solid']]) {
      const res = await profileUpdate(alice.socket, { bannerPreset: bad })
      assert.deepEqual(res, { ok: false, error: 'Invalid banner' }, `bannerPreset ${JSON.stringify(bad)}`)
    }
    // A bad preset fails the whole update.
    const res = await profileUpdate(alice.socket, { color: '#654321', bannerPreset: 'nope' })
    assert.equal(res.ok, false)
    const again = await connect(server.url, { token: alice.token })
    assert.equal(again.boot.me.color, '#123456')
    assert.equal(again.boot.me.bannerPreset, 'aurora')
    again.socket.close()
  })

  test('an uploaded banner keeps the preset (clients show the upload while there is one)', async () => {
    const res = await put(server.url, alice.token, 'image/png', PNG)
    const { user } = (await res.json()) as { user: User }
    assert.equal(user.banner, token12(PNG))
    assert.equal(user.bannerPreset, 'aurora')
    const removed = (await (await del(server.url, alice.token)).json()) as { user: User }
    assert.equal(removed.user.bannerPreset, 'aurora')
  })
})

describe('banner rate limit', () => {
  let server: NexoInstance

  before(async () => {
    server = await boot({ bannerIntervalMs: undefined })
  })
  after(() => server.close())

  test('one change per user every 3 s → 429 with Retry-After; separate from the avatar limit', async () => {
    const a = await connect(server.url, { name: 'Speedy', color: '#123456' })
    const b = await connect(server.url, { name: 'Other', color: '#654321' })
    assert.equal((await put(server.url, a.boot.token!, 'image/png', PNG)).status, 200)
    const res = await put(server.url, a.boot.token!, 'image/webp', WEBP)
    assert.equal(res.status, 429)
    assert.ok(Number(res.headers.get('retry-after')) >= 1)
    assert.equal(await errorOf(res), 'Slow down: you can change your banner again in a few seconds')
    assert.equal((await del(server.url, a.boot.token!)).status, 429, 'delete counts too')
    // Per user, and the avatar has its own limit.
    assert.equal((await put(server.url, b.boot.token!, 'image/png', PNG)).status, 200)
    assert.equal((await put(server.url, a.boot.token!, 'image/png', PNG, '/api/avatar')).status, 200)
    a.socket.close()
    b.socket.close()
  })
})

describe('users.banner* migration', () => {
  test('an existing database without the columns is migrated (idempotently)', async () => {
    const dataDir = tempDir()
    // A v1.2 database: users without the banner columns.
    const old = new DatabaseSync(path.join(dataDir, 'nexo.db'))
    old.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, avatar TEXT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
        status_text TEXT NULL, avatar_animated INTEGER NOT NULL DEFAULT 0
      );
    `)
    const id = randomUUID()
    const token = 'legacy-device-token'
    old.prepare('INSERT INTO users (id, name, color, token_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      'Oldtimer',
      '#abcdef',
      createHash('sha256').update(token).digest('hex'),
      Date.now(),
      'owner',
    )
    old.close()

    for (let round = 0; round < 2; round++) {
      const server = await boot({ dataDir })
      try {
        const { socket, boot: b } = await connect(server.url, { token })
        assert.equal(b.me.id, id)
        assert.equal(b.me.banner, round === 0 ? null : token12(GIF))
        assert.equal(b.me.bannerAnimated, round === 1)
        assert.equal(b.me.bannerPreset, round === 0 ? 'solid' : 'waves')
        if (round === 0) {
          assert.equal((await put(server.url, token, 'image/gif', GIF)).status, 200)
          assert.ok((await profileUpdate(socket, { bannerPreset: 'waves' })).ok)
        }
        socket.close()
      } finally {
        await server.close()
      }
    }

    const check = new DatabaseSync(path.join(dataDir, 'nexo.db'))
    const cols = (check.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name)
    check.close()
    for (const col of ['banner', 'banner_animated', 'banner_preset']) {
      assert.equal(cols.filter((c) => c === col).length, 1, col)
    }
  })
})
