// Chat image attachments: header parsing, POST /api/attachments, GET /attachments/:id, message:send with
// attachmentIds, cleanup on delete, the pending sweep and the rate limit.
// Boots real servers on random ports with temp data dirs. Run with `npm test -w server`.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client'
import type {
  AckResult,
  Attachment,
  Bootstrap,
  Channel,
  ClientToServerEvents,
  HandshakeAuth,
  Message,
  ServerToClientEvents,
} from '../../shared/protocol.ts'
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_DIMENSION, MAX_ATTACHMENTS_PER_MESSAGE } from '../../shared/protocol.ts'
import { probeImage } from '../src/attachments.ts'
import { start, type NexoInstance, type StartOptions } from '../src/server.ts'

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>
type Person = { socket: Client; boot: Bootstrap; token: string }

const TIMEOUT = 3000
const tmpDirs: string[] = []
const clients: Client[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-attachment-test-'))
  tmpDirs.push(dir)
  return dir
}

function boot(opts: Partial<StartOptions> = {}): Promise<NexoInstance> {
  return start({
    port: 0,
    host: '127.0.0.1',
    dataDir: tempDir(),
    serverName: 'Attachment Test',
    serverPassword: '',
    livekit: { apiKey: 'k', apiSecret: 'test-secret-that-is-at-least-32-characters-long', publicUrl: '', port: 7880 },
    log: false,
    attachmentUploadsPerMinute: 10_000,
    ...opts,
  })
}

async function connect(url: string, auth: HandshakeAuth): Promise<Person> {
  const socket: Client = connectClient(url, { auth, transports: ['websocket'], forceNew: true, reconnection: false })
  clients.push(socket)
  const b = await new Promise<Bootstrap>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bootstrap timeout')), TIMEOUT)
    socket.once('bootstrap', (b) => {
      clearTimeout(timer)
      resolve(b)
    })
    socket.once('connect_error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
  return { socket, boot: b, token: b.token ?? (auth as { token: string }).token }
}

function request<T>(socket: Client, event: keyof ClientToServerEvents, payload: unknown): Promise<AckResult<T>> {
  const raw = socket as unknown as { timeout(ms: number): { emitWithAck(e: string, p: unknown): Promise<AckResult<T>> } }
  return raw.timeout(TIMEOUT).emitWithAck(event, payload)
}

async function requestOk<T>(socket: Client, event: keyof ClientToServerEvents, payload: unknown): Promise<T> {
  const res = await request<T>(socket, event, payload)
  if (!res.ok) assert.fail(`${event} failed: ${res.error}`)
  return res.data
}

async function requestErr(socket: Client, event: keyof ClientToServerEvents, payload: unknown): Promise<string> {
  const res = await request<unknown>(socket, event, payload)
  assert.equal(res.ok, false, `${event} should have failed`)
  return (res as { error: string }).error
}

function nextMessage(socket: Client, match: (m: Message) => boolean): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message:new', handler)
      reject(new Error('timed out waiting for message:new'))
    }, TIMEOUT)
    const handler = (m: Message) => {
      if (!match(m)) return
      clearTimeout(timer)
      socket.off('message:new', handler)
      resolve(m)
    }
    socket.on('message:new', handler)
  })
}

// ---------- image fixtures (headers only; the server never decodes) ----------

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff]
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff]
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const bytes = (s: string) => [...Buffer.from(s, 'latin1')]
const PAD = new Array(16).fill(0)

function png(w: number, h: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...bytes('IHDR'), ...u32be(w), ...u32be(h), 8, 6, 0, 0, 0, ...PAD])
}

function gif(w: number, h: number): Buffer {
  return Buffer.from([...bytes('GIF89a'), ...u16le(w), ...u16le(h), 0xf7, 0, 0, ...PAD])
}

/** A JPEG with APP0, an optional EXIF orientation (APP1), a DQT segment, then SOF0 (or SOF2). */
function jpeg(w: number, h: number, opts: { orientation?: number; progressive?: boolean; bigEndianExif?: boolean } = {}): Buffer {
  const seg = (marker: number, payload: number[]) => [0xff, marker, ...u16be(payload.length + 2), ...payload]
  const parts = [0xff, 0xd8, ...seg(0xe0, [...bytes('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0])]
  if (opts.orientation) {
    const be = opts.bigEndianExif
    const w16 = be ? u16be : u16le
    const w32 = be ? u32be : u32le
    const tiff = [...bytes(be ? 'MM' : 'II'), ...w16(42), ...w32(8), ...w16(1), ...w16(0x0112), ...w16(3), ...w32(1), ...w16(opts.orientation), 0, 0, ...w32(0)]
    parts.push(...seg(0xe1, [...bytes('Exif\0\0'), ...tiff]))
  }
  parts.push(...seg(0xdb, [0, ...new Array(64).fill(1)]))
  parts.push(...seg(opts.progressive ? 0xc2 : 0xc0, [8, ...u16be(h), ...u16be(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]))
  parts.push(...seg(0xda, [1, 1, 0]), 0x12, 0x34, 0xff, 0xd9)
  return Buffer.from(parts)
}

function riff(chunk: string, payload: number[]): Buffer {
  const body = [...bytes('WEBP'), ...bytes(chunk), ...u32le(payload.length), ...payload, ...PAD]
  return Buffer.from([...bytes('RIFF'), ...u32le(body.length), ...body])
}
const webpLossy = (w: number, h: number) => riff('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...u16le(w), ...u16le(h)])
const webpLossless = (w: number, h: number) => riff('VP8L', [0x2f, ...u32le(((w - 1) | ((h - 1) << 14)) >>> 0)])
const webpExtended = (w: number, h: number) => riff('VP8X', [0x10, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)])

function post(url: string, token: string | null, type: string, body: Uint8Array | ReadableStream<Uint8Array>) {
  const headers: Record<string, string> = { 'content-type': type }
  if (token !== null) headers.authorization = `Bearer ${token}`
  return fetch(`${url}/api/attachments`, { method: 'POST', headers, body: body as BodyInit, duplex: 'half' } as RequestInit)
}

async function upload(url: string, token: string, body: Buffer = png(64, 32), type = 'image/png'): Promise<Attachment> {
  const res = await post(url, token, type, body)
  assert.equal(res.status, 201, await res.clone().text())
  return ((await res.json()) as { attachment: Attachment }).attachment
}

async function errorOf(res: Response): Promise<string> {
  assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  const body = (await res.json()) as { error?: unknown }
  assert.equal(typeof body.error, 'string')
  return body.error as string
}

const fileOf = (server: NexoInstance, id: string) => path.join(server.config.dataDir, 'attachments', id)

/** File deletion is fire-and-forget after the DB change; wait for it. */
async function waitGone(file: string) {
  for (let i = 0; i < 100 && existsSync(file); i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(existsSync(file), false, `${file} should be deleted`)
}

after(() => {
  for (const c of clients) c.close()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('image header parsing', () => {
  test('PNG, GIF, JPEG and the three WebP flavours', () => {
    assert.deepEqual(probeImage(png(640, 480)), { type: 'image/png', width: 640, height: 480 })
    assert.deepEqual(probeImage(gif(320, 200)), { type: 'image/gif', width: 320, height: 200 })
    assert.deepEqual(probeImage(jpeg(1920, 1080)), { type: 'image/jpeg', width: 1920, height: 1080 })
    assert.deepEqual(probeImage(jpeg(800, 600, { progressive: true })), { type: 'image/jpeg', width: 800, height: 600 })
    assert.deepEqual(probeImage(webpLossy(1000, 750)), { type: 'image/webp', width: 1000, height: 750 })
    assert.deepEqual(probeImage(webpLossless(16384, 1)), { type: 'image/webp', width: 16384, height: 1 })
    assert.deepEqual(probeImage(webpExtended(20000, 3)), { type: 'image/webp', width: 20000, height: 3 })
  })

  test('JPEG EXIF orientations 5–8 swap width and height (both byte orders)', () => {
    assert.deepEqual(probeImage(jpeg(4032, 3024, { orientation: 6 })), { type: 'image/jpeg', width: 3024, height: 4032 })
    assert.deepEqual(probeImage(jpeg(4032, 3024, { orientation: 8, bigEndianExif: true })), {
      type: 'image/jpeg',
      width: 3024,
      height: 4032,
    })
    assert.deepEqual(probeImage(jpeg(4032, 3024, { orientation: 3 })), { type: 'image/jpeg', width: 4032, height: 3024 })
  })

  test('unknown, truncated or headerless files → null', () => {
    assert.equal(probeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
    assert.equal(probeImage(Buffer.alloc(0)), null)
    assert.equal(probeImage(png(10, 10).subarray(0, 20)), null, 'PNG cut inside IHDR')
    const noIhdr = png(10, 10)
    noIhdr.write('IDAT', 12, 'latin1')
    assert.equal(probeImage(noIhdr), null, 'PNG whose first chunk is not IHDR')
    assert.equal(probeImage(gif(10, 10).subarray(0, 8)), null)
    assert.equal(probeImage(jpeg(10, 10).subarray(0, 30)), null, 'JPEG cut before SOF')
    assert.equal(probeImage(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9])), null, 'JPEG without a frame header')
    assert.equal(probeImage(riff('VP8Z', [1, 2, 3, 4])), null, 'unknown WebP chunk')
    const badVp8 = webpLossy(10, 10)
    badVp8[23] = 0
    assert.equal(probeImage(badVp8), null, 'VP8 without the key frame start code')
  })
})

describe('attachment HTTP API and messages', () => {
  let server: NexoInstance
  let url: string
  let alice: Person
  let bob: Person
  let general: Channel

  before(async () => {
    server = await boot()
    url = server.url
    alice = await connect(url, { name: 'Alice', color: '#ff0000' })
    bob = await connect(url, { name: 'Bob', color: '#00ff00' })
    general = alice.boot.channels.find((c) => c.name === 'general')!
  })
  after(() => server.close())

  test('CORS preflight', async () => {
    const res = await fetch(`${url}/api/attachments`, {
      method: 'OPTIONS',
      headers: {
        origin: 'file://',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
        'access-control-request-private-network': 'true',
      },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/)
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /Authorization/i)
    assert.equal(res.headers.get('access-control-allow-private-network'), 'true')
  })

  test('upload: 201 with the attachment, stored as a pending file that is not served yet', async () => {
    const res = await post(url, alice.token, 'image/png', png(640, 480))
    assert.equal(res.status, 201)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    const { attachment } = (await res.json()) as { attachment: Attachment }
    assert.match(attachment.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.deepEqual(attachment, { id: attachment.id, type: 'image/png', width: 640, height: 480, size: png(640, 480).length })
    assert.ok(existsSync(fileOf(server, attachment.id)))
    assert.ok(!readdirSync(path.join(server.config.dataDir, 'attachments')).some((f) => f.endsWith('.tmp')))
    assert.equal((await fetch(`${url}/attachments/${attachment.id}`)).status, 404, 'pending uploads are not public')
  })

  test('every format and its dimensions are accepted; Content-Type parameters are ignored', async () => {
    const cases: [string, Buffer, number, number][] = [
      ['image/gif', gif(300, 200), 300, 200],
      ['image/jpeg; charset=binary', jpeg(4032, 3024, { orientation: 6 }), 3024, 4032],
      ['image/webp', webpLossy(1000, 750), 1000, 750],
      ['image/webp', webpLossless(10, 20), 10, 20],
      ['IMAGE/WEBP', webpExtended(ATTACHMENT_MAX_DIMENSION, ATTACHMENT_MAX_DIMENSION), ATTACHMENT_MAX_DIMENSION, ATTACHMENT_MAX_DIMENSION],
    ]
    for (const [type, body, width, height] of cases) {
      const a = await upload(url, alice.token, body, type)
      assert.equal(a.type, type.split(';')[0].toLowerCase())
      assert.deepEqual([a.width, a.height], [width, height], type)
    }
  })

  test('wrong or unsupported Content-Type, or bytes that do not match it → 415', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    let res = await post(url, alice.token, 'image/svg+xml', svg)
    assert.equal(res.status, 415)
    assert.match(await errorOf(res), /PNG, JPEG, WebP or GIF/)

    res = await post(url, alice.token, 'application/octet-stream', png(10, 10))
    assert.equal(res.status, 415)
    await errorOf(res)

    res = await post(url, alice.token, 'image/png', svg)
    assert.equal(res.status, 415, 'bad magic bytes')
    assert.match(await errorOf(res), /not a PNG, JPEG, WebP or GIF/)

    res = await post(url, alice.token, 'image/png', gif(10, 10))
    assert.equal(res.status, 415, 'declared type must match the bytes')
    assert.match(await errorOf(res), /image\/gif, not image\/png/)
  })

  test('unreadable headers or dimensions over the limit → 422, for every format', async () => {
    const big = ATTACHMENT_MAX_DIMENSION + 1
    const cases: [string, Buffer][] = [
      ['image/png', png(big, 10)],
      ['image/png', png(10, big)],
      ['image/png', png(0, 10)],
      ['image/png', png(10, 10).subarray(0, 20)],
      ['image/gif', gif(10, 0)],
      ['image/gif', Buffer.from('GIF89a\x01')],
      ['image/jpeg', jpeg(big, 10)],
      ['image/jpeg', jpeg(10, 10).subarray(0, 30)],
      ['image/webp', webpLossy(10, 10).subarray(0, 24)],
      ['image/webp', webpExtended(big, 10)],
      ['image/webp', riff('VP8Z', [0, 0, 0, 0])],
    ]
    for (const [type, body] of cases) {
      const res = await post(url, alice.token, type, body)
      assert.equal(res.status, 422, `${type} (${body.length} bytes)`)
      assert.match(await errorOf(res), /image size|limited to 16384×16384/)
    }
  })

  test('too big → 413 (Content-Length and streamed); exactly at the limit is fine', async () => {
    const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1)
    png(10, 10).copy(big)
    let res = await post(url, alice.token, 'image/png', big)
    assert.equal(res.status, 413)
    assert.match(await errorOf(res), /limited to 10 MB/)

    // Chunked upload without Content-Length: rejected once the limit is crossed.
    const chunk = Buffer.alloc(256 * 1024)
    png(10, 10).copy(chunk)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > ATTACHMENT_MAX_BYTES * 1.5) return controller.close()
        sent += chunk.length
        controller.enqueue(new Uint8Array(chunk))
      },
    })
    res = await post(url, alice.token, 'image/png', stream)
    assert.equal(res.status, 413)
    await errorOf(res)

    const max = Buffer.alloc(ATTACHMENT_MAX_BYTES)
    png(10, 10).copy(max)
    const a = await upload(url, alice.token, max)
    assert.equal(a.size, ATTACHMENT_MAX_BYTES)
  })

  test('empty body → 400, bad token → 401, other methods → 405', async () => {
    let res = await post(url, alice.token, 'image/png', new Uint8Array(0))
    assert.equal(res.status, 400)
    await errorOf(res)

    res = await post(url, null, 'image/png', png(10, 10))
    assert.equal(res.status, 401)
    assert.match(await errorOf(res), /Missing device token/)
    res = await post(url, 'nope', 'image/png', png(10, 10))
    assert.equal(res.status, 401)
    assert.match(await errorOf(res), /Unknown device token/)

    res = await fetch(`${url}/api/attachments`, { method: 'PUT', headers: { authorization: `Bearer ${alice.token}` }, body: new Uint8Array(png(1, 1)) })
    assert.equal(res.status, 405)
    await errorOf(res)
    res = await fetch(`${url}/attachments/${randomUUID()}`, { method: 'DELETE' })
    assert.equal(res.status, 405)
  })

  test('send with attachments: order kept, broadcast, served, in history; empty text allowed', async () => {
    const a = await upload(url, alice.token, png(800, 600))
    const b = await upload(url, alice.token, gif(100, 50), 'image/gif')
    const incoming = nextMessage(bob.socket, (m) => m.attachments.length === 2)
    const msg = await requestOk<Message>(alice.socket, 'message:send', { channelId: general.id, content: '  ', attachmentIds: [b.id, a.id] })
    assert.equal(msg.content, '')
    assert.deepEqual(msg.attachments, [b, a])
    assert.deepEqual(await incoming, msg)

    const img = await fetch(`${url}/attachments/${a.id}`)
    assert.equal(img.status, 200)
    assert.equal(img.headers.get('content-type'), 'image/png')
    assert.equal(img.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(img.headers.get('access-control-allow-origin'), '*')
    assert.equal(img.headers.get('content-length'), String(a.size))
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), png(800, 600))
    const head = await fetch(`${url}/attachments/${b.id}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-type'), 'image/gif')

    const history = await requestOk<Message[]>(bob.socket, 'message:history', { channelId: general.id })
    assert.deepEqual(history.find((m) => m.id === msg.id), msg)
  })

  test('text-only messages carry attachments: []', async () => {
    const msg = await requestOk<Message>(alice.socket, 'message:send', { channelId: general.id, content: 'plain' })
    assert.deepEqual(msg.attachments, [])
    const withNull = await requestOk<Message>(alice.socket, 'message:send', { channelId: general.id, content: 'x', attachmentIds: null })
    assert.deepEqual(withNull.attachments, [])
    const history = await requestOk<Message[]>(alice.socket, 'message:history', { channelId: general.id })
    assert.deepEqual(history.find((m) => m.id === msg.id)?.attachments, [])
  })

  test('send validation: ownership, pending only, max 4, duplicates, types', async () => {
    const send = (who: Person, attachmentIds: unknown, content = '') =>
      requestErr(who.socket, 'message:send', { channelId: general.id, content, attachmentIds })

    assert.equal(await send(alice, []), 'Message is empty')
    assert.equal(await send(alice, 'nope'), 'Invalid attachments')
    assert.equal(await send(alice, [42]), 'Invalid attachments')

    const mine = await upload(url, alice.token)
    assert.match(await send(bob, [mine.id]), /expired or was not found/, "someone else's upload")
    assert.match(await send(alice, [randomUUID()]), /expired or was not found/, 'unknown id')
    assert.equal(await send(alice, [mine.id, mine.id]), 'The same image is attached twice')

    const five = await Promise.all(Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => upload(url, alice.token)))
    assert.match(await send(alice, five.map((a) => a.id)), /at most 4 images/)

    // A failed send claims nothing: the same uploads still work afterwards.
    assert.match(await send(alice, [mine.id, randomUUID()], 'hi'), /expired or was not found/)
    const ok = await requestOk<Message>(alice.socket, 'message:send', {
      channelId: general.id,
      content: 'four',
      attachmentIds: five.slice(0, 4).map((a) => a.id),
    })
    assert.equal(ok.attachments.length, 4)

    // Already claimed by a message.
    assert.match(await send(alice, [five[0].id]), /expired or was not found/)
    const again = await requestOk<Message>(alice.socket, 'message:send', { channelId: general.id, content: '', attachmentIds: [mine.id] })
    assert.equal(again.attachments[0].id, mine.id)
  })

  test('deleting a message deletes its attachment files', async () => {
    const a = await upload(url, alice.token)
    const msg = await requestOk<Message>(alice.socket, 'message:send', { channelId: general.id, content: 'bye', attachmentIds: [a.id] })
    assert.equal((await fetch(`${url}/attachments/${a.id}`)).status, 200)
    await requestOk<null>(alice.socket, 'message:delete', { messageId: msg.id })
    await waitGone(fileOf(server, a.id))
    assert.equal((await fetch(`${url}/attachments/${a.id}`)).status, 404)
  })

  test('deleting a channel deletes the attachment files of all its messages', async () => {
    const ch = await requestOk<Channel>(alice.socket, 'channel:create', { name: 'pics', type: 'text' })
    const a = await upload(url, alice.token)
    const b = await upload(url, bob.token)
    await requestOk<Message>(alice.socket, 'message:send', { channelId: ch.id, content: '', attachmentIds: [a.id] })
    await requestOk<Message>(bob.socket, 'message:send', { channelId: ch.id, content: 'me too', attachmentIds: [b.id] })
    const elsewhere = await upload(url, alice.token)
    await requestOk<Message>(alice.socket, 'message:send', { channelId: general.id, content: '', attachmentIds: [elsewhere.id] })

    await requestOk<null>(alice.socket, 'channel:delete', { channelId: ch.id })
    await waitGone(fileOf(server, a.id))
    await waitGone(fileOf(server, b.id))
    assert.equal((await fetch(`${url}/attachments/${b.id}`)).status, 404)
    assert.equal((await fetch(`${url}/attachments/${elsewhere.id}`)).status, 200, 'other channels are untouched')
  })

  test('unknown ids and path traversal → 404', async () => {
    assert.equal((await fetch(`${url}/attachments/${randomUUID()}`)).status, 404)
    assert.equal((await fetch(`${url}/attachments/not-a-uuid`)).status, 404)
    assert.equal((await fetch(`${url}/attachments/`)).status, 404)
    assert.equal((await fetch(`${url}/attachments/..%2Fnexo.db`)).status, 404)
    const res = await fetch(`${url}/attachments/${randomUUID()}`)
    assert.equal(res.headers.get('access-control-allow-origin'), '*', 'errors are readable cross-origin')
  })
})

describe('attachment rate limit', () => {
  let server: NexoInstance

  before(async () => {
    server = await boot({ attachmentUploadsPerMinute: undefined })
  })
  after(() => server.close())

  test('20 uploads per user per minute → 429 with Retry-After, per user', async () => {
    const a = await connect(server.url, { name: 'Spammer', color: '#123456' })
    const b = await connect(server.url, { name: 'Calm', color: '#654321' })
    for (let i = 0; i < 20; i++) await upload(server.url, a.token)
    const res = await post(server.url, a.token, 'image/png', png(1, 1))
    assert.equal(res.status, 429)
    assert.ok(Number(res.headers.get('retry-after')) >= 1)
    assert.match(await errorOf(res), /too many images/)
    await upload(server.url, b.token)
  })
})

describe('pending upload sweep', () => {
  test('unsent uploads expire on the periodic sweep', async () => {
    const server = await boot({ attachmentPendingTtlMs: 100, attachmentSweepIntervalMs: 50 })
    try {
      const a = await connect(server.url, { name: 'Slowpoke', color: '#123456' })
      const att = await upload(server.url, a.token)
      const general = a.boot.channels.find((c) => c.name === 'general')!
      await waitGone(fileOf(server, att.id))
      assert.match(
        await requestErr(a.socket, 'message:send', { channelId: general.id, content: '', attachmentIds: [att.id] }),
        /expired or was not found/,
      )
    } finally {
      await server.close()
    }
  })

  test('on start: expired uploads and orphan files are removed, sent images are kept', async () => {
    const dataDir = tempDir()
    let server = await boot({ dataDir })
    const a = await connect(server.url, { name: 'Restarter', color: '#123456' })
    const general = a.boot.channels.find((c) => c.name === 'general')!
    const stale = await upload(server.url, a.token)
    const fresh = await upload(server.url, a.token)
    const sent = await upload(server.url, a.token)
    await requestOk<Message>(a.socket, 'message:send', { channelId: general.id, content: '', attachmentIds: [sent.id] })
    a.socket.close()
    await server.close()

    // Age `stale` past the TTL and drop a stray file (e.g. a crash between writing the file and the row).
    const db = new DatabaseSync(path.join(dataDir, 'nexo.db'))
    db.prepare('UPDATE attachments SET created_at = ? WHERE id = ?').run(Date.now() - 2 * 60 * 60 * 1000, stale.id)
    db.close()
    const stray = path.join(dataDir, 'attachments', randomUUID())
    writeFileSync(stray, png(1, 1))

    server = await boot({ dataDir })
    try {
      await waitGone(path.join(dataDir, 'attachments', stale.id))
      assert.equal(existsSync(stray), false)
      assert.ok(existsSync(path.join(dataDir, 'attachments', fresh.id)))
      assert.equal((await fetch(`${server.url}/attachments/${sent.id}`)).status, 200)
    } finally {
      await server.close()
    }
  })
})

describe('attachments migration', () => {
  test('a v0.2 database gains the attachments table; old messages get attachments: []', async () => {
    const dataDir = tempDir()
    const old = new DatabaseSync(path.join(dataDir, 'nexo.db'))
    old.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, avatar TEXT NULL
      );
      CREATE TABLE channels (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('text', 'voice')),
        position INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `)
    const userId = randomUUID()
    const chanId = randomUUID()
    old.prepare("INSERT INTO users VALUES (?, 'Oldtimer', '#abcdef', 'hash', 1, NULL)").run(userId)
    old.prepare("INSERT INTO channels VALUES (?, 'general', 'text', 0, 1)").run(chanId)
    old.prepare("INSERT INTO messages VALUES ('m1', ?, ?, 'from v0.2', 5)").run(chanId, userId)
    old.close()

    for (let round = 0; round < 2; round++) {
      const server = await boot({ dataDir })
      try {
        const p = await connect(server.url, { name: `Reader${round}`, color: '#123456' })
        const history = await requestOk<Message[]>(p.socket, 'message:history', { channelId: chanId })
        assert.deepEqual([history[0].content, history[0].attachments], ['from v0.2', []])
        assert.equal(history.length, round + 1)
        const att = await upload(server.url, p.token)
        await requestOk<Message>(p.socket, 'message:send', { channelId: chanId, content: '', attachmentIds: [att.id] })
        p.socket.close()
      } finally {
        await server.close()
      }
    }
  })
})
