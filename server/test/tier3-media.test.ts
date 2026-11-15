// Tier 3 media: link previews (GET /api/embed, an SSRF boundary: only fixed oEmbed endpoints of allowlisted
// providers may ever be fetched) and the soundboard (POST/DELETE /api/sounds, GET /sounds/:id, `sound:play`).
// Boots the server in-process like protocol.test.ts. The oEmbed fetch is injected (StartOptions.embedFetch):
// these tests never touch the network. Run with `npm test -w server`.
import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client'
import type { AckResult, Bootstrap, ClientToServerEvents, Embed, ServerToClientEvents, Sound } from '../../shared/protocol.ts'
import { MAX_SOUNDS, SOUND_MAX_BYTES } from '../../shared/protocol.ts'
import { SOUND_ERRORS, start, type NexoInstance, type StartOptions } from '../src/server.ts'
import { SOUND_HTTP_ERRORS } from '../src/sounds.ts'
import { EMBED_ERRORS } from '../src/embeds.ts'

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>
type EventName = keyof ServerToClientEvents
type EventArg<E extends EventName> = Parameters<ServerToClientEvents[E]>[0]

const TIMEOUT = 3000
const tmpDirs: string[] = []
const clients: Client[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-tier3-'))
  tmpDirs.push(dir)
  return dir
}

function boot(opts: Partial<StartOptions> = {}): Promise<NexoInstance> {
  return start({
    port: 0,
    host: '127.0.0.1',
    dataDir: tempDir(),
    serverName: 'Test Space',
    serverPassword: '',
    livekit: { apiKey: 'testkey', apiSecret: 'test-secret-that-is-at-least-32-characters-long', publicUrl: '', port: 7880 },
    log: false,
    // Never the real network: tests that need oEmbed answers inject their own.
    embedFetch: () => Promise.reject(new Error('network disabled in tests')),
    ...opts,
  })
}

interface Conn {
  socket: Client
  boot: Bootstrap
  id: string
  token: string
}

function connect(url: string, auth: Record<string, unknown>): Promise<Conn> {
  const socket: Client = connectClient(url, { auth, transports: ['websocket'], forceNew: true, reconnection: false })
  clients.push(socket)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bootstrap timeout')), TIMEOUT)
    socket.once('bootstrap', (b) => {
      clearTimeout(timer)
      resolve({ socket, boot: b, id: b.me.id, token: b.token ?? (auth.token as string | undefined) ?? '' })
    })
    socket.once('connect_error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

const join = (url: string, name: string) => connect(url, { name, color: '#123456' })

function request<T>(socket: Client, event: string, payload: unknown): Promise<AckResult<T>> {
  const raw = socket as unknown as { timeout(ms: number): { emitWithAck(e: string, p: unknown): Promise<AckResult<T>> } }
  return raw.timeout(TIMEOUT).emitWithAck(event, payload)
}

async function requestOk<T>(socket: Client, event: string, payload: unknown): Promise<T> {
  const res = await request<T>(socket, event, payload)
  if (!res.ok) assert.fail(`${event} failed: ${res.error}`)
  return res.data
}

async function requestErr(socket: Client, event: string, payload: unknown): Promise<string> {
  const res = await request<unknown>(socket, event, payload)
  assert.equal(res.ok, false, `${event} should have failed`)
  return (res as { error: string }).error
}

const send = (socket: Client, event: string, payload?: unknown) =>
  (socket as unknown as { emit(e: string, p?: unknown): void }).emit(event, payload)

/** A round trip on `socket`: every event it sent before has been handled. */
const sync = (socket: Client) => request(socket, 'message:history', {})

function nextEvent<E extends EventName>(socket: Client, event: E, match: (arg: EventArg<E>) => boolean = () => true): Promise<EventArg<E>> {
  const s = socket as unknown as { on(e: string, f: (a: unknown) => void): void; off(e: string, f: (a: unknown) => void): void }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off(event, handler)
      reject(new Error(`timed out waiting for "${event}"`))
    }, TIMEOUT)
    const handler = (arg: unknown) => {
      if (!match(arg as EventArg<E>)) return
      clearTimeout(timer)
      s.off(event, handler)
      resolve(arg as EventArg<E>)
    }
    s.on(event, handler)
  })
}

function collect<E extends EventName>(socket: Client, event: E) {
  const s = socket as unknown as { on(e: string, f: (a: unknown) => void): void; off(e: string, f: (a: unknown) => void): void }
  const seen: EventArg<E>[] = []
  const handler = (arg: unknown) => seen.push(arg as EventArg<E>)
  s.on(event, handler)
  return {
    seen,
    stop: () => {
      s.off(event, handler)
      return seen
    },
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
// Link previews

interface FetchCall {
  url: string
  init: RequestInit
}

/** A fake fetch that records every call and answers with `respond` (default: a valid oEmbed answer). */
function fakeFetch() {
  const calls: FetchCall[] = []
  let respond: (url: string, init: RequestInit) => Promise<Response> | Response = (url) =>
    Response.json({ title: `Title of ${new URL(url).searchParams.get('url')}`, author_name: 'Someone', html: '<iframe></iframe>' })
  const fn = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    try {
      return Promise.resolve(respond(url, init))
    } catch (err) {
      return Promise.reject(err)
    }
  }) as typeof fetch
  return {
    fn,
    calls,
    set respond(r: typeof respond) {
      respond = r
    },
    reset() {
      calls.length = 0
      respond = (url) =>
        Response.json({ title: `Title of ${new URL(url).searchParams.get('url')}`, author_name: 'Someone', html: '<iframe></iframe>' })
    },
  }
}

const getEmbed = (base: string, link: string | null, token: string | null) =>
  fetch(`${base}/api/embed${link === null ? '' : `?url=${encodeURIComponent(link)}`}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  })

describe('link previews (GET /api/embed)', () => {
  const fake = fakeFetch()
  let server: NexoInstance
  let url: string
  let alice: Conn

  before(async () => {
    server = await boot({ embedFetch: fake.fn, embedTimeoutMs: 200, embedLookupsPerMinute: 1000 })
    url = server.url
    alice = await join(url, 'Alice')
  })
  after(() => server.close())
  beforeEach(() => fake.reset())

  const cases: { link: string; endpoint: string; canonical: string; provider: string; kind: Embed['kind'] }[] = [
    {
      link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s#comments',
      endpoint: 'https://www.youtube.com/oembed?format=json&url=',
      canonical: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      provider: 'YouTube',
      kind: 'video',
    },
    {
      link: 'https://youtu.be/aaaaaaaaa_1?si=tracking',
      endpoint: 'https://www.youtube.com/oembed?format=json&url=',
      canonical: 'https://www.youtube.com/watch?v=aaaaaaaaa_1',
      provider: 'YouTube',
      kind: 'video',
    },
    {
      link: 'https://youtube.com/shorts/bbbbbbbbb-2',
      endpoint: 'https://www.youtube.com/oembed?format=json&url=',
      canonical: 'https://www.youtube.com/watch?v=bbbbbbbbb-2',
      provider: 'YouTube',
      kind: 'video',
    },
    {
      link: 'https://music.youtube.com/watch?v=ccccccccc3c&list=RDAMVM',
      endpoint: 'https://www.youtube.com/oembed?format=json&url=',
      canonical: 'https://www.youtube.com/watch?v=ccccccccc3c',
      provider: 'YouTube',
      kind: 'video',
    },
    {
      link: 'http://m.youtube.com/watch?v=ddddddddd4d',
      endpoint: 'https://www.youtube.com/oembed?format=json&url=',
      canonical: 'https://www.youtube.com/watch?v=ddddddddd4d',
      provider: 'YouTube',
      kind: 'video',
    },
    {
      link: 'https://open.spotify.com/intl-pt/track/4uLU6hMCjMI75M1A2tKUQC?si=abc',
      endpoint: 'https://open.spotify.com/oembed?url=',
      canonical: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      provider: 'Spotify',
      kind: 'audio',
    },
    {
      link: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
      endpoint: 'https://open.spotify.com/oembed?url=',
      canonical: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
      provider: 'Spotify',
      kind: 'audio',
    },
    {
      link: 'https://soundcloud.com/forss/flickermood?in=forss/sets/soulhack',
      endpoint: 'https://soundcloud.com/oembed?format=json&url=',
      canonical: 'https://soundcloud.com/forss/flickermood',
      provider: 'SoundCloud',
      kind: 'audio',
    },
    {
      link: 'https://soundcloud.com/forss/sets/soulhack',
      endpoint: 'https://soundcloud.com/oembed?format=json&url=',
      canonical: 'https://soundcloud.com/forss/sets/soulhack',
      provider: 'SoundCloud',
      kind: 'audio',
    },
    {
      link: 'https://vimeo.com/76979871#t=10',
      endpoint: 'https://vimeo.com/api/oembed.json?url=',
      canonical: 'https://vimeo.com/76979871',
      provider: 'Vimeo',
      kind: 'video',
    },
    {
      link: 'https://old.reddit.com/r/aww/comments/abc123/cute_dog/?utm_source=share',
      endpoint: 'https://www.reddit.com/oembed?url=',
      canonical: 'https://www.reddit.com/r/aww/comments/abc123/cute_dog/',
      provider: 'Reddit',
      kind: 'post',
    },
  ]

  for (const c of cases) {
    test(`${c.provider}: ${c.link} → its oEmbed endpoint with the canonical link`, async () => {
      const res = await getEmbed(url, c.link, alice.token)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('access-control-allow-origin'), '*')
      const { embed } = (await res.json()) as { embed: Embed }
      assert.deepEqual(embed, { url: c.link, provider: c.provider, kind: c.kind, title: `Title of ${c.canonical}`, author: 'Someone' })
      assert.equal(fake.calls.length, 1)
      assert.equal(fake.calls[0].url, c.endpoint + encodeURIComponent(c.canonical))
      assert.equal(fake.calls[0].init.redirect, 'error')
      assert.ok(fake.calls[0].init.signal instanceof AbortSignal)
    })
  }

  test('maps the answer to plain text: control characters stripped, title capped, no HTML, CDN-only https thumbnail', async () => {
    fake.respond = () =>
      Response.json({
        title: `  Never\u0000 gonna\n give \u202eyou up ${'x'.repeat(300)}`,
        author_name: 'Rick\tAstley',
        html: '<iframe src="https://evil.example"></iframe>',
        thumbnail_url: 'https://i.ytimg.com/vi/eeeeeeeee5e/hqdefault.jpg',
        thumbnail_width: '480',
        thumbnail_height: 360,
        type: 'video',
      })
    const res = await getEmbed(url, 'https://www.youtube.com/watch?v=eeeeeeeee5e', alice.token)
    const { embed } = (await res.json()) as { embed: Embed & Record<string, unknown> }
    assert.equal(embed.title.length, 200)
    assert.ok(embed.title.startsWith('Never gonna give you up xxx'))
    assert.equal(embed.author, 'Rick Astley')
    assert.deepEqual(embed.thumbnail, { url: 'https://i.ytimg.com/vi/eeeeeeeee5e/hqdefault.jpg', width: 480, height: 360 })
    assert.deepEqual(Object.keys(embed).sort(), ['author', 'kind', 'provider', 'thumbnail', 'title', 'url'])
  })

  test('thumbnails that are not https on the provider CDN are dropped; missing sizes get defaults', async () => {
    const thumbs: [string, unknown][] = [
      ['https://evil.example/x.jpg', undefined],
      ['http://i.ytimg.com/vi/x/hq.jpg', undefined],
      ['https://i.ytimg.com.evil.example/x.jpg', undefined],
      ['javascript:alert(1)', undefined],
      ['https://i9.ytimg.com/vi/x/hq.jpg', { url: 'https://i9.ytimg.com/vi/x/hq.jpg', width: 480, height: 360 }],
    ]
    for (const [i, [thumb, expected]] of thumbs.entries()) {
      fake.respond = () => Response.json({ title: 'T', thumbnail_url: thumb })
      const res = await getEmbed(url, `https://www.youtube.com/watch?v=thumbtest0${i}`, alice.token)
      const { embed } = (await res.json()) as { embed: Embed }
      assert.deepEqual(embed.thumbnail, expected, thumb)
    }
  })

  test('links no provider previews → 204 without any fetch (lookalike hosts, redirects through other sites, local addresses, credentials, ports)', async () => {
    const links = [
      'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
      'https://evilyoutube.com/watch?v=dQw4w9WgXcQ',
      'https://evil.com/?u=https://youtube.com/watch?v=dQw4w9WgXcQ',
      'https://evil.com/https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com@evil.com/watch?v=dQw4w9WgXcQ',
      'https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com./watch?v=dQw4w9WgXcQ',
      'http://127.0.0.1/watch?v=dQw4w9WgXcQ',
      'http://localhost:3001/api/embed?url=x',
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/',
      'https://www.youtube.com/watch?v=tooshort',
      'https://www.youtube.com/redirect?q=https://evil.com',
      'https://open.spotify.com/track/../../oembed?url=x',
      'https://open.spotify.com/user/someone',
      'https://soundcloud.com/forss/likes',
      'https://vimeo.com/channels/staffpicks',
      'https://www.reddit.com/r/aww/',
      'https://www.twitch.tv/videos/123456789',
      'https://clips.twitch.tv/SomeClipSlug',
      'https://x.com/someone/status/1',
      'https://twitter.com/someone/status/1',
      'https://example.com/',
    ]
    for (const link of links) {
      const res = await getEmbed(url, link, alice.token)
      assert.equal(res.status, 204, link)
    }
    assert.equal(fake.calls.length, 0)
  })

  test('not an http(s) link → 400 without any fetch', async () => {
    const links = ['', 'not a url', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://youtube.com/watch?v=dQw4w9WgXcQ',
      'data:text/html,hi', `https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=${'a'.repeat(3000)}`]
    for (const link of links) {
      const res = await getEmbed(url, link, alice.token)
      assert.equal(res.status, 400, link)
      assert.equal(await errorOf(res), EMBED_ERRORS.invalidUrl)
    }
    const missing = await getEmbed(url, null, alice.token)
    assert.equal(missing.status, 400)
    assert.equal(fake.calls.length, 0)
  })

  test('auth: no token or an unknown one → 401 without any fetch', async () => {
    const link = 'https://www.youtube.com/watch?v=authtest000'
    assert.equal((await getEmbed(url, link, null)).status, 401)
    assert.equal((await getEmbed(url, link, 'nope')).status, 401)
    assert.equal(fake.calls.length, 0)
  })

  test('CORS preflight and wrong methods', async () => {
    const pre = await fetch(`${url}/api/embed`, { method: 'OPTIONS' })
    assert.equal(pre.status, 204)
    assert.equal(pre.headers.get('access-control-allow-origin'), '*')
    assert.match(pre.headers.get('access-control-allow-methods') ?? '', /GET/)
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Authorization/)
    const post = await fetch(`${url}/api/embed`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}` } })
    assert.equal(post.status, 405)
  })

  test('failures are misses (204), cached for an hour: timeout, oversized answer, invalid JSON, HTTP errors, redirects, no title', async () => {
    const failures: [string, (url: string, init: RequestInit) => Promise<Response> | Response][] = [
      [
        'timeout',
        (_u, init) =>
          new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))),
      ],
      ['declared oversize', () => new Response('{}', { headers: { 'content-length': String(300 * 1024) } })],
      [
        'streamed oversize',
        () => {
          const chunk = new Uint8Array(64 * 1024).fill(0x20)
          let sent = 0
          return new Response(
            new ReadableStream({
              pull(controller) {
                if (sent++ < 10) controller.enqueue(chunk)
                else controller.close()
              },
            }),
          )
        },
      ],
      ['invalid JSON', () => new Response('<html>not json</html>', { headers: { 'content-type': 'text/html' } })],
      ['JSON array', () => Response.json([{ title: 'x' }])],
      ['HTTP 404', () => new Response('Not Found', { status: 404 })],
      ['HTTP 500', () => Response.json({ title: 'x' }, { status: 500 })],
      ['redirect refused', () => Promise.reject(new TypeError('fetch failed: unexpected redirect'))],
      ['no title', () => Response.json({ author_name: 'x', thumbnail_url: 'https://i.ytimg.com/x.jpg' })],
      ['blank title', () => Response.json({ title: ' \u0000\n ' })],
    ]
    for (const [i, [label, respond]] of failures.entries()) {
      fake.reset()
      fake.respond = respond
      const link = `https://www.youtube.com/watch?v=failure000${i.toString(36)}`
      const started = Date.now()
      const res = await getEmbed(url, link, alice.token)
      assert.equal(res.status, 204, label)
      assert.ok(Date.now() - started < 2000, `${label} took too long`)
      assert.equal(fake.calls.length, 1, label)
      // The miss is cached: no second fetch.
      assert.equal((await getEmbed(url, link, alice.token)).status, 204, label)
      assert.equal(fake.calls.length, 1, `${label}: miss not cached`)
    }
  })

  test('hits are cached by canonical link (url echoes the link as asked)', async () => {
    const first = await getEmbed(url, 'https://www.youtube.com/watch?v=cachetest01', alice.token)
    assert.equal(first.status, 200)
    const again = await getEmbed(url, 'https://youtu.be/cachetest01', alice.token)
    assert.equal(again.status, 200)
    const { embed } = (await again.json()) as { embed: Embed }
    assert.equal(embed.url, 'https://youtu.be/cachetest01')
    assert.equal(embed.title, 'Title of https://www.youtube.com/watch?v=cachetest01')
    assert.equal(fake.calls.length, 1)
  })

  test('concurrent requests for the same link share one lookup', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    fake.respond = async (u) => {
      await gate
      return Response.json({ title: `Title of ${new URL(u).searchParams.get('url')}` })
    }
    const link = 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3'
    const pending = [getEmbed(url, link, alice.token), getEmbed(url, `${link}?si=1`, alice.token), getEmbed(url, link, alice.token)]
    await delay(100)
    release()
    const results = await Promise.all(pending)
    for (const r of results) assert.equal(r.status, 200)
    assert.equal(fake.calls.length, 1)
  })
})

describe('link previews: rate limit', () => {
  const fake = fakeFetch()
  let server: NexoInstance
  let alice: Conn
  let bob: Conn

  before(async () => {
    server = await boot({ embedFetch: fake.fn, embedLookupsPerMinute: 2 })
    alice = await join(server.url, 'Alice')
    bob = await join(server.url, 'Bob')
  })
  after(() => server.close())

  test('lookups per user per minute → 429; cached links and links without a provider still answer', async () => {
    assert.equal((await getEmbed(server.url, 'https://vimeo.com/1', alice.token)).status, 200)
    assert.equal((await getEmbed(server.url, 'https://vimeo.com/2', alice.token)).status, 200)
    const limited = await getEmbed(server.url, 'https://vimeo.com/3', alice.token)
    assert.equal(limited.status, 429)
    assert.equal(await errorOf(limited), EMBED_ERRORS.slowDown)
    assert.ok(Number(limited.headers.get('retry-after')) >= 1)
    assert.equal(fake.calls.length, 2)
    // Cached, no provider: not limited.
    assert.equal((await getEmbed(server.url, 'https://vimeo.com/1', alice.token)).status, 200)
    assert.equal((await getEmbed(server.url, 'https://example.com/', alice.token)).status, 204)
    // Per user.
    assert.equal((await getEmbed(server.url, 'https://vimeo.com/3', bob.token)).status, 200)
  })
})

// ---------------------------------------------------------------------------
// Soundboard

// Minimal byte sequences with the right magic numbers (the server validates signatures, it doesn't decode).
const pad = (head: number[], n = 64) => new Uint8Array([...head, ...new Array(n).fill(7)])
const AUDIO = {
  ogg: pad([...Buffer.from('OggS'), 0, 2]),
  mp3id3: pad([...Buffer.from('ID3'), 4, 0, 0]),
  mp3frame: pad([0xff, 0xfb, 0x90, 0x64]),
  wav: pad([...Buffer.from('RIFF'), 36, 0, 0, 0, ...Buffer.from('WAVEfmt ')]),
  webm: pad([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86]),
  aac: pad([0xff, 0xf1, 0x50, 0x80]),
  png: pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
}

interface UploadParams {
  name?: string | null
  emoji?: string | null
  durationMs?: string | number | null
}

function upload(base: string, token: string | null, type: string, body: Uint8Array, params: UploadParams = {}) {
  const q = new URLSearchParams()
  const { name = 'Air horn', emoji = null, durationMs = 1200 } = params
  if (name !== null) q.set('name', name)
  if (emoji !== null) q.set('emoji', emoji)
  if (durationMs !== null) q.set('durationMs', String(durationMs))
  const headers: Record<string, string> = { 'content-type': type }
  if (token !== null) headers.authorization = `Bearer ${token}`
  return fetch(`${base}/api/sounds?${q}`, { method: 'POST', headers, body: body as Uint8Array<ArrayBuffer> })
}

async function uploadOk(base: string, token: string, type: string, body: Uint8Array, params: UploadParams = {}): Promise<Sound> {
  const res = await upload(base, token, type, body, params)
  if (res.status !== 201) assert.fail(`upload failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { sound: Sound }).sound
}

const del = (base: string, token: string | null, id: string) =>
  fetch(`${base}/api/sounds/${id}`, { method: 'DELETE', headers: token === null ? {} : { authorization: `Bearer ${token}` } })

describe('soundboard HTTP API', () => {
  let server: NexoInstance
  let url: string
  let dataDir: string
  let alice: Conn // owner
  let bob: Conn
  let carol: Conn

  before(async () => {
    dataDir = tempDir()
    server = await boot({ dataDir, soundUploadsPerMinute: 1000 })
    url = server.url
    alice = await join(url, 'Alice')
    bob = await join(url, 'Bob')
    carol = await join(url, 'Carol')
  })
  after(() => server.close())

  test('bootstrap starts with an empty board', () => {
    assert.deepEqual(alice.boot.sounds, [])
  })

  test('upload: 201 {sound}, broadcast sound:upsert, served back with its type, in later bootstraps', async () => {
    const upsert = nextEvent(carol.socket, 'sound:upsert')
    const before = Date.now()
    const sound = await uploadOk(url, bob.token, 'audio/ogg', AUDIO.ogg, { name: '  Air\n\thorn\u0000 ', emoji: '📯', durationMs: 1500 })
    assert.match(sound.id, /^[0-9a-f-]{36}$/)
    assert.deepEqual({ ...sound, id: '', createdAt: 0 }, { id: '', name: 'Air horn', emoji: '📯', uploaderId: bob.id, durationMs: 1500, createdAt: 0 })
    assert.ok(sound.createdAt >= before)
    assert.deepEqual(await upsert, sound)

    const res = await fetch(`${url}/sounds/${sound.id}`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'audio/ogg')
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), AUDIO.ogg)
    const head = await fetch(`${url}/sounds/${sound.id}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(AUDIO.ogg.length))
    assert.ok(existsSync(path.join(dataDir, 'sounds', sound.id)))

    const later = await uploadOk(url, alice.token, 'audio/wav', AUDIO.wav, { name: 'Bruh', durationMs: 5000 })
    const again = await connect(url, { token: carol.token })
    assert.deepEqual(again.boot.sounds, [sound, later])
    again.socket.close()
  })

  test('every accepted container: OGG, MP3 (ID3 or bare frame), WAV, WebM', async () => {
    for (const [type, body] of [
      ['audio/mpeg', AUDIO.mp3id3],
      ['audio/mpeg', AUDIO.mp3frame],
      ['audio/webm', AUDIO.webm],
      ['audio/wav', AUDIO.wav],
    ] as const) {
      const sound = await uploadOk(url, carol.token, `${type}; codecs=x`, body, { name: type })
      assert.equal((await fetch(`${url}/sounds/${sound.id}`)).headers.get('content-type'), type)
      assert.equal((await del(url, carol.token, sound.id)).status, 204)
    }
  })

  test('wrong or missing Content-Type → 415', async () => {
    for (const type of ['audio/flac', 'audio/x-wav', 'application/octet-stream', '']) {
      const res = await upload(url, bob.token, type, AUDIO.ogg)
      assert.equal(res.status, 415, type)
      assert.equal(await errorOf(res), SOUND_HTTP_ERRORS.badType)
    }
  })

  test('magic bytes must match the declared type → 415', async () => {
    let res = await upload(url, bob.token, 'audio/ogg', AUDIO.wav)
    assert.equal(res.status, 415)
    assert.equal(await errorOf(res), 'The file is audio/wav, not audio/ogg')
    for (const body of [AUDIO.aac, AUDIO.png, new Uint8Array([1, 2, 3])]) {
      res = await upload(url, bob.token, 'audio/mpeg', body)
      assert.equal(res.status, 415)
      assert.equal(await errorOf(res), SOUND_HTTP_ERRORS.notAudio)
    }
  })

  test('too big → 413; empty → 400', async () => {
    const big = new Uint8Array(SOUND_MAX_BYTES + 1)
    big.set(AUDIO.ogg)
    let res = await upload(url, bob.token, 'audio/ogg', big)
    assert.equal(res.status, 413)
    assert.equal(await errorOf(res), 'Sounds are limited to 512 KB')
    res = await upload(url, bob.token, 'audio/ogg', new Uint8Array())
    assert.equal(res.status, 400)
    assert.equal(await errorOf(res), SOUND_HTTP_ERRORS.empty)
  })

  test('names: required, normalized, at most 32 characters', async () => {
    for (const name of [null, '', '   ', '\u0000\u200b']) {
      const res = await upload(url, bob.token, 'audio/ogg', AUDIO.ogg, { name })
      assert.equal(res.status, 400, String(name))
      assert.equal(await errorOf(res), 'Give the sound a name')
    }
    const res = await upload(url, bob.token, 'audio/ogg', AUDIO.ogg, { name: 'x'.repeat(33) })
    assert.equal(res.status, 400)
    assert.equal(await errorOf(res), 'Sound names are limited to 32 characters')
    const sound = await uploadOk(url, bob.token, 'audio/ogg', AUDIO.ogg, { name: ` ${'y'.repeat(32)}  ` })
    assert.equal(sound.name, 'y'.repeat(32))
    await del(url, bob.token, sound.id)
  })

  test('emoji: optional, one emoji (EMOJI_RE)', async () => {
    for (const emoji of ['abc', '📯📯', '<b>', '1']) {
      const res = await upload(url, bob.token, 'audio/ogg', AUDIO.ogg, { emoji })
      assert.equal(res.status, 400, emoji)
      assert.equal(await errorOf(res), SOUND_HTTP_ERRORS.invalidEmoji)
    }
    const none = await uploadOk(url, bob.token, 'audio/ogg', AUDIO.ogg, { emoji: '' })
    assert.equal(none.emoji, null)
    const flag = await uploadOk(url, bob.token, 'audio/ogg', AUDIO.ogg, { emoji: '🇧🇷' })
    assert.equal(flag.emoji, '🇧🇷')
    await del(url, bob.token, none.id)
    await del(url, bob.token, flag.id)
  })

  test('duration: an integer 1..5000 ms', async () => {
    for (const durationMs of [null, '', 'abc', '0', '-5', '1.5', '1e3']) {
      const res = await upload(url, bob.token, 'audio/ogg', AUDIO.ogg, { durationMs })
      assert.equal(res.status, 400, String(durationMs))
      assert.equal(await errorOf(res), SOUND_HTTP_ERRORS.invalidDuration)
    }
    for (const durationMs of [5001, 60_000, '999999999']) {
      const res = await upload(url, bob.token, 'audio/ogg', AUDIO.ogg, { durationMs })
      assert.equal(res.status, 400)
      assert.equal(await errorOf(res), 'Sounds are limited to 5 seconds')
    }
  })

  test('auth: 401 without a valid token', async () => {
    assert.equal((await upload(url, null, 'audio/ogg', AUDIO.ogg)).status, 401)
    assert.equal((await upload(url, 'nope', 'audio/ogg', AUDIO.ogg)).status, 401)
    assert.equal((await del(url, null, randomUUID())).status, 401)
  })

  test('DELETE: uploader or admins/owner; 403 for others; 404 unknown', async () => {
    const sound = await uploadOk(url, bob.token, 'audio/ogg', AUDIO.ogg, { name: 'Bob sound' })
    let res = await del(url, carol.token, sound.id)
    assert.equal(res.status, 403)
    assert.equal(await errorOf(res), 'Only the uploader or admins can delete this sound')

    const deleted = nextEvent(carol.socket, 'sound:deleted', (p) => p.soundId === sound.id)
    res = await del(url, bob.token, sound.id)
    assert.equal(res.status, 204)
    assert.deepEqual(await deleted, { soundId: sound.id })
    assert.equal((await fetch(`${url}/sounds/${sound.id}`)).status, 404)
    assert.equal(existsSync(path.join(dataDir, 'sounds', sound.id)), false)
    assert.equal((await del(url, bob.token, sound.id)).status, 404)

    // The owner deletes anyone's; so does an admin.
    const s2 = await uploadOk(url, carol.token, 'audio/ogg', AUDIO.ogg, { name: 'Carol 1' })
    assert.equal((await del(url, alice.token, s2.id)).status, 204)
    await requestOk(alice.socket, 'user:setRole', { userId: bob.id, role: 'admin' })
    const s3 = await uploadOk(url, carol.token, 'audio/ogg', AUDIO.ogg, { name: 'Carol 2' })
    assert.equal((await del(url, bob.token, s3.id)).status, 204)
    await requestOk(alice.socket, 'user:setRole', { userId: bob.id, role: 'member' })

    assert.equal((await del(url, bob.token, 'not-a-uuid')).status, 404)
    assert.equal((await del(url, bob.token, '..%2F..%2Fnexo.db')).status, 404)
  })

  test('GET: unknown or malformed ids → 404; preflight; wrong methods → 405', async () => {
    assert.equal((await fetch(`${url}/sounds/${randomUUID()}`)).status, 404)
    assert.equal((await fetch(`${url}/sounds/not-a-uuid`)).status, 404)
    assert.equal((await fetch(`${url}/sounds/..%2Fnexo.db`)).status, 404)
    assert.equal((await fetch(`${url}/sounds/`)).status, 404)
    const pre = await fetch(`${url}/api/sounds`, { method: 'OPTIONS' })
    assert.equal(pre.status, 204)
    assert.match(pre.headers.get('access-control-allow-methods') ?? '', /POST, DELETE/)
    assert.equal((await fetch(`${url}/api/sounds/${randomUUID()}`, { method: 'OPTIONS' })).status, 204)
    assert.equal((await fetch(`${url}/api/sounds`, { method: 'GET' })).status, 405)
    assert.equal((await fetch(`${url}/sounds/${randomUUID()}`, { method: 'POST' })).status, 405)
  })
})

describe('soundboard limits', () => {
  test('per-user upload rate limit → 429', async () => {
    const server = await boot({ soundUploadsPerMinute: 2 })
    try {
      const alice = await join(server.url, 'Alice')
      const bob = await join(server.url, 'Bob')
      await uploadOk(server.url, alice.token, 'audio/ogg', AUDIO.ogg)
      await uploadOk(server.url, alice.token, 'audio/ogg', AUDIO.ogg)
      const res = await upload(server.url, alice.token, 'audio/ogg', AUDIO.ogg)
      assert.equal(res.status, 429)
      assert.equal(await errorOf(res), SOUND_HTTP_ERRORS.slowDown)
      assert.ok(Number(res.headers.get('retry-after')) >= 1)
      await uploadOk(server.url, bob.token, 'audio/ogg', AUDIO.ogg)
    } finally {
      await server.close()
    }
  })

  test(`a full board (${MAX_SOUNDS}) → 409 until one is deleted`, async () => {
    const server = await boot({ soundUploadsPerMinute: 1000 })
    try {
      const alice = await join(server.url, 'Alice')
      const ids: string[] = []
      for (let i = 0; i < MAX_SOUNDS; i++) ids.push((await uploadOk(server.url, alice.token, 'audio/ogg', AUDIO.ogg, { name: `s${i}` })).id)
      const res = await upload(server.url, alice.token, 'audio/ogg', AUDIO.ogg)
      assert.equal(res.status, 409)
      assert.equal(await errorOf(res), 'The soundboard is full (100 sounds). Delete one first')
      assert.equal((await del(server.url, alice.token, ids[0])).status, 204)
      await uploadOk(server.url, alice.token, 'audio/ogg', AUDIO.ogg)
    } finally {
      await server.close()
    }
  })

  test('sounds survive a restart; orphaned files are swept at start', async () => {
    const dataDir = tempDir()
    let server = await boot({ dataDir })
    const alice = await join(server.url, 'Alice')
    const sound = await uploadOk(server.url, alice.token, 'audio/webm', AUDIO.webm)
    alice.socket.close()
    await server.close()
    const orphan = path.join(dataDir, 'sounds', randomUUID())
    writeFileSync(orphan, AUDIO.ogg)
    writeFileSync(path.join(dataDir, 'sounds', '.abc.tmp'), AUDIO.ogg)
    server = await boot({ dataDir })
    try {
      assert.deepEqual(readdirSync(path.join(dataDir, 'sounds')), [sound.id])
      const again = await connect(server.url, { token: alice.token })
      assert.deepEqual(again.boot.sounds, [sound])
      assert.equal((await fetch(`${server.url}/sounds/${sound.id}`)).headers.get('content-type'), 'audio/webm')
    } finally {
      await server.close()
    }
  })
})

describe('sound:play', () => {
  let server: NexoInstance
  let alice: Conn
  let aliceOther: Conn
  let bob: Conn
  let carol: Conn
  let dave: Conn
  let sound: Sound
  let lounge: string
  let gaming: string
  let dataDir: string
  const COOLDOWN = 400

  const voice = (c: Conn, channelId: string | null) =>
    send(c.socket, 'voice:state', { channelId, muted: false, deafened: false, camera: false, streaming: false })

  before(async () => {
    dataDir = tempDir()
    server = await boot({ dataDir, soundCooldownMs: COOLDOWN })
    alice = await join(server.url, 'Alice')
    aliceOther = await connect(server.url, { token: alice.token })
    bob = await join(server.url, 'Bob')
    carol = await join(server.url, 'Carol')
    dave = await join(server.url, 'Dave')
    lounge = alice.boot.channels.find((c) => c.name === 'Lounge')!.id
    gaming = alice.boot.channels.find((c) => c.name === 'Gaming')!.id
    sound = await uploadOk(server.url, bob.token, 'audio/ogg', AUDIO.ogg)
    voice(alice, lounge)
    voice(bob, lounge)
    voice(carol, gaming)
    await Promise.all([alice, bob, carol].map((c) => sync(c.socket)))
  })
  after(() => server.close())

  test('delivered only to the voice-owning sockets of that channel', async () => {
    const seen = [alice, aliceOther, bob, carol, dave].map((c) => collect(c.socket, 'sound:played'))
    const toBob = nextEvent(bob.socket, 'sound:played')
    assert.equal(await requestOk(alice.socket, 'sound:play', { soundId: sound.id }), null)
    assert.deepEqual(await toBob, { soundId: sound.id, userId: alice.id, channelId: lounge })
    await Promise.all([alice, aliceOther, carol, dave].map((c) => sync(c.socket)))
    const [a, a2, b, c, d] = seen.map((s) => s.stop())
    assert.equal(a.length, 1)
    assert.equal(b.length, 1)
    assert.deepEqual([a2.length, c.length, d.length], [0, 0, 0])
  })

  test('cooldown per user', async () => {
    await delay(COOLDOWN)
    await requestOk(bob.socket, 'sound:play', { soundId: sound.id })
    assert.equal(await requestErr(bob.socket, 'sound:play', { soundId: sound.id }), 'Wait a moment before playing another sound')
    // Per user: Carol isn't affected.
    await requestOk(carol.socket, 'sound:play', { soundId: sound.id })
    await delay(COOLDOWN + 50)
    await requestOk(bob.socket, 'sound:play', { soundId: sound.id })
  })

  test('not in voice / unknown sound / bad payloads', async () => {
    assert.equal(await requestErr(dave.socket, 'sound:play', { soundId: sound.id }), 'Join a voice channel to play sounds')
    assert.equal(SOUND_ERRORS.notInVoice, 'Join a voice channel to play sounds')
    for (const p of [{ soundId: randomUUID() }, { soundId: 5 }, {}, null, 'x']) {
      assert.equal(await requestErr(carol.socket, 'sound:play', p), SOUND_ERRORS.notFound)
    }
  })

  test('removing an account deletes its sounds (rows, files, sound:deleted)', async () => {
    const extra = await uploadOk(server.url, carol.token, 'audio/ogg', AUDIO.ogg, { name: 'Carol' })
    const deleted = collect(alice.socket, 'sound:deleted')
    const removed = nextEvent(alice.socket, 'user:removed')
    await requestOk(alice.socket, 'user:remove', { userId: carol.id })
    await removed
    await sync(alice.socket)
    assert.deepEqual(deleted.stop(), [{ soundId: extra.id }])
    assert.equal((await fetch(`${server.url}/sounds/${extra.id}`)).status, 404)
    await delay(50)
    assert.deepEqual(readdirSync(path.join(dataDir, 'sounds')), [sound.id])
    const fresh = await connect(server.url, { token: alice.token })
    assert.deepEqual(fresh.boot.sounds?.map((s) => s.id), [sound.id])
    fresh.socket.close()
  })

  test('a deleted sound can no longer be played', async () => {
    assert.equal((await del(server.url, bob.token, sound.id)).status, 204)
    await delay(COOLDOWN)
    assert.equal(await requestErr(bob.socket, 'sound:play', { soundId: sound.id }), SOUND_ERRORS.notFound)
  })
})
