// Profile picture HTTP API: PUT/DELETE /api/avatar, GET /avatars/:userId, plus the users.avatar migration.
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
import { AVATAR_MAX_BYTES } from '../../shared/protocol.ts'
import { start, type NexoInstance, type StartOptions } from '../src/server.ts'

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>

const TIMEOUT = 3000
const tmpDirs: string[] = []
const clients: Client[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-avatar-test-'))
  tmpDirs.push(dir)
  return dir
}

function boot(opts: Partial<StartOptions> = {}): Promise<NexoInstance> {
  return start({
    port: 0,
    host: '127.0.0.1',
    dataDir: tempDir(),
    serverName: 'Avatar Test',
    serverPassword: '',
    livekit: { apiKey: 'k', apiSecret: 'test-secret-that-is-at-least-32-characters-long', publicUrl: '', port: 7880 },
    log: false,
    avatarIntervalMs: 0,
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
const token12 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 12)

function put(url: string, token: string | null, type: string, body: BodyInit) {
  const headers: Record<string, string> = { 'content-type': type }
  if (token !== null) headers.authorization = `Bearer ${token}`
  return fetch(`${url}/api/avatar`, { method: 'PUT', headers, body, duplex: 'half' } as RequestInit)
}

function del(url: string, token: string) {
  return fetch(`${url}/api/avatar`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
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

describe('avatar HTTP API', () => {
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

  test('users start without an avatar (bootstrap + upsert carry avatar: null)', () => {
    assert.equal(alice.boot.me.avatar, null)
    assert.ok(bob.boot.users.every((u) => u.avatar === null))
  })

  test('CORS preflight', async () => {
    const res = await fetch(`${url}/api/avatar`, {
      method: 'OPTIONS',
      headers: { origin: 'file://', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type' },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /PUT/)
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /DELETE/)
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /Authorization/i)
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /Content-Type/i)
  })

  test('upload: returns the user, broadcasts user:upsert, GET serves the bytes', async () => {
    const meId = alice.boot.me.id
    const upsert = nextUpsert(bob.socket, (u) => u.id === meId && u.avatar !== null)
    const res = await put(url, alice.token, 'image/png', PNG)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    const { user } = (await res.json()) as { user: User }
    assert.equal(user.id, meId)
    assert.equal(user.name, 'Alice')
    assert.equal(user.avatar, token12(PNG))
    assert.match(user.avatar!, /^[0-9a-f]{12}$/)
    assert.deepEqual(await upsert, user)

    const img = await fetch(`${url}/avatars/${meId}?v=${user.avatar}`)
    assert.equal(img.status, 200)
    assert.equal(img.headers.get('content-type'), 'image/png')
    assert.equal(img.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(img.headers.get('content-security-policy'), "default-src 'none'")
    assert.deepEqual(new Uint8Array(await img.arrayBuffer()), PNG)

    const head = await fetch(`${url}/avatars/${meId}?v=${user.avatar}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(PNG.length))

    // Stored in <dataDir>/avatars/<userId>, no temp files left behind.
    assert.deepEqual(readdirSync(path.join(server.config.dataDir, 'avatars')), [meId])
  })

  test('re-upload changes the version; old versions are not cached forever', async () => {
    const meId = alice.boot.me.id
    const oldVersion = token12(PNG)
    const res = await put(url, alice.token, 'image/webp', WEBP)
    assert.equal(res.status, 200)
    const { user } = (await res.json()) as { user: User }
    assert.equal(user.avatar, token12(WEBP))
    assert.notEqual(user.avatar, oldVersion)

    const img = await fetch(`${url}/avatars/${meId}?v=${user.avatar}`)
    assert.equal(img.headers.get('content-type'), 'image/webp')
    assert.deepEqual(new Uint8Array(await img.arrayBuffer()), WEBP)

    const stale = await fetch(`${url}/avatars/${meId}?v=${oldVersion}`)
    assert.equal(stale.status, 200)
    assert.equal(stale.headers.get('cache-control'), 'no-cache')

    const jpeg = await put(url, alice.token, 'image/jpeg; charset=binary', JPEG)
    assert.equal(jpeg.status, 200)
    const j = (await jpeg.json()) as { user: User }
    assert.equal((await fetch(`${url}/avatars/${meId}?v=${j.user.avatar}`)).headers.get('content-type'), 'image/jpeg')
  })

  test('reconnect bootstrap includes the avatar (persisted)', async () => {
    const again = await connect(url, { token: alice.token })
    assert.equal(again.boot.me.avatar, token12(JPEG))
    assert.equal(again.boot.users.find((u) => u.id === alice.boot.me.id)?.avatar, token12(JPEG))
    again.socket.close()
  })

  test('wrong magic bytes or content type → 415', async () => {
    const text = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    let res = await put(url, alice.token, 'image/png', text)
    assert.equal(res.status, 415)
    assert.match(await errorOf(res), /not a WebP, PNG or JPEG/)

    res = await put(url, alice.token, 'image/webp', PNG)
    assert.equal(res.status, 415, 'declared type must match the bytes')
    assert.match(await errorOf(res), /image\/png, not image\/webp/)

    res = await put(url, alice.token, 'image/svg+xml', text)
    assert.equal(res.status, 415)
    await errorOf(res)

    res = await put(url, alice.token, 'image/gif', new TextEncoder().encode('GIF89a......'))
    assert.equal(res.status, 415)
    await errorOf(res)

    // Unchanged.
    const again = await connect(url, { token: bob.token })
    assert.equal(again.boot.users.find((u) => u.id === alice.boot.me.id)?.avatar, token12(JPEG))
    again.socket.close()
  })

  test('too big → 413 (Content-Length and streamed)', async () => {
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1)
    big.set(PNG)
    let res = await put(url, alice.token, 'image/png', big)
    assert.equal(res.status, 413)
    assert.match(await errorOf(res), /limited to 512 KB/)

    // Chunked upload without Content-Length: aborted once the limit is crossed.
    const chunk = new Uint8Array(64 * 1024)
    chunk.set(PNG)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > AVATAR_MAX_BYTES * 2) return controller.close()
        sent += chunk.length
        controller.enqueue(chunk)
      },
    })
    res = await put(url, alice.token, 'image/png', stream)
    assert.equal(res.status, 413)
    await errorOf(res)

    // Exactly at the limit is fine.
    const max = new Uint8Array(AVATAR_MAX_BYTES)
    max.set(PNG)
    res = await put(url, bob.token, 'image/png', max)
    assert.equal(res.status, 200)
    await del(url, bob.token)
  })

  test('empty body → 400', async () => {
    const res = await put(url, alice.token, 'image/png', new Uint8Array(0))
    assert.equal(res.status, 400)
    await errorOf(res)
  })

  test('missing or invalid token → 401', async () => {
    let res = await put(url, null, 'image/png', PNG)
    assert.equal(res.status, 401)
    assert.match(await errorOf(res), /Missing device token/)

    res = await put(url, 'not-a-real-token', 'image/png', PNG)
    assert.equal(res.status, 401)
    assert.match(await errorOf(res), /Unknown device token/)

    res = await fetch(`${url}/api/avatar`, { method: 'PUT', headers: { authorization: `Basic ${alice.token}`, 'content-type': 'image/png' }, body: PNG })
    assert.equal(res.status, 401)
    await errorOf(res)

    res = await fetch(`${url}/api/avatar`, { method: 'DELETE', headers: { authorization: 'Bearer nope' } })
    assert.equal(res.status, 401)
    await errorOf(res)
  })

  test('other methods → 405', async () => {
    const res = await fetch(`${url}/api/avatar`, { method: 'POST', body: PNG, headers: { authorization: `Bearer ${alice.token}` } })
    assert.equal(res.status, 405)
    await errorOf(res)
  })

  test('delete: avatar becomes null, broadcast, GET → 404', async () => {
    const meId = alice.boot.me.id
    const upsert = nextUpsert(bob.socket, (u) => u.id === meId && u.avatar === null)
    const res = await del(url, alice.token)
    assert.equal(res.status, 200)
    const { user } = (await res.json()) as { user: User }
    assert.equal(user.avatar, null)
    assert.deepEqual(await upsert, user)
    assert.equal((await fetch(`${url}/avatars/${meId}?v=${token12(JPEG)}`)).status, 404)
    assert.equal(existsSync(path.join(server.config.dataDir, 'avatars', meId)), false)

    // Deleting again is a no-op.
    const again = await del(url, alice.token)
    assert.equal(again.status, 200)
    assert.equal(((await again.json()) as { user: User }).user.avatar, null)
  })

  test('unknown users and path traversal → 404', async () => {
    assert.equal((await fetch(`${url}/avatars/${randomUUID()}`)).status, 404)
    assert.equal((await fetch(`${url}/avatars/not-a-uuid`)).status, 404)
    assert.equal((await fetch(`${url}/avatars/`)).status, 404)
    assert.equal(await rawGet(url, '/avatars/../nexo.db'), 404)
    assert.equal(await rawGet(url, '/avatars/..%2Fnexo.db'), 404)
    assert.equal(await rawGet(url, '/avatars/%2e%2e%2fnexo.db'), 404)
    assert.equal(await rawGet(url, `/avatars/${alice.boot.me.id}%2F..%2F..%2Fnexo.db`), 404)
    assert.equal(await rawGet(url, '/avatars/..\\nexo.db'), 404)
  })
})

describe('avatar rate limit', () => {
  let server: NexoInstance

  before(async () => {
    server = await boot({ avatarIntervalMs: undefined })
  })
  after(() => server.close())

  test('one change per user every 3 s → 429 with Retry-After', async () => {
    const a = await connect(server.url, { name: 'Speedy', color: '#123456' })
    const b = await connect(server.url, { name: 'Other', color: '#654321' })
    assert.equal((await put(server.url, a.boot.token!, 'image/png', PNG)).status, 200)
    const res = await put(server.url, a.boot.token!, 'image/webp', WEBP)
    assert.equal(res.status, 429)
    assert.ok(Number(res.headers.get('retry-after')) >= 1)
    await errorOf(res)
    assert.equal((await del(server.url, a.boot.token!)).status, 429, 'delete counts too')
    // Per user.
    assert.equal((await put(server.url, b.boot.token!, 'image/png', PNG)).status, 200)
    a.socket.close()
    b.socket.close()
  })
})

describe('users.avatar migration', () => {
  test('an existing database without the column is migrated (idempotently)', async () => {
    const dataDir = tempDir()
    // A v0.1 database: users table without `avatar`.
    const old = new DatabaseSync(path.join(dataDir, 'nexo.db'))
    old.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
    `)
    const id = randomUUID()
    const token = 'legacy-device-token'
    old.prepare('INSERT INTO users (id, name, color, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      'Oldtimer',
      '#abcdef',
      createHash('sha256').update(token).digest('hex'),
      Date.now(),
    )
    old.close()

    for (let round = 0; round < 2; round++) {
      const server = await boot({ dataDir })
      try {
        const { socket, boot: b } = await connect(server.url, { token })
        assert.equal(b.me.id, id)
        assert.equal(b.me.avatar, round === 0 ? null : token12(PNG))
        if (round === 0) {
          const res = await put(server.url, token, 'image/png', PNG)
          assert.equal(res.status, 200)
        }
        socket.close()
      } finally {
        await server.close()
      }
    }

    const check = new DatabaseSync(path.join(dataDir, 'nexo.db'))
    const cols = (check.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name)
    check.close()
    assert.equal(cols.filter((c) => c === 'avatar').length, 1)
  })
})
