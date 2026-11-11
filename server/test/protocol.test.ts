// End-to-end protocol test: boots the Nexo server in-process on a random port with a temp
// data dir and drives it with real socket.io clients. Run with `npm test -w server`.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client'
import { TokenVerifier } from 'livekit-server-sdk'
import type {
  AckResult,
  Bootstrap,
  Channel,
  ClientToServerEvents,
  HandshakeAuth,
  Message,
  ServerToClientEvents,
  StreamCredentials,
  User,
  VoiceCredentials,
  VoiceState,
  VoiceStatePatch,
} from '../../shared/protocol.ts'
import { MAX_MESSAGE_LENGTH, MESSAGE_PAGE_SIZE } from '../../shared/protocol.ts'
import { start, type NexoInstance } from '../src/server.ts'

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>
type EventName = keyof ServerToClientEvents
type EventArg<E extends EventName> = Parameters<ServerToClientEvents[E]>[0]

const LK_KEY = 'testkey'
const LK_SECRET = 'test-secret-that-is-at-least-32-characters-long'
const TIMEOUT = 3000

const tmpDirs: string[] = []
const clients: Client[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-test-'))
  tmpDirs.push(dir)
  return dir
}

async function boot(opts: { serverPassword?: string } = {}): Promise<NexoInstance> {
  return start({
    port: 0,
    host: '127.0.0.1',
    dataDir: tempDir(),
    serverName: 'Test Space',
    serverPassword: opts.serverPassword ?? '',
    livekit: { apiKey: LK_KEY, apiSecret: LK_SECRET, publicUrl: '', port: 7880 },
    log: false,
  })
}

function makeClient(url: string, auth: HandshakeAuth | Record<string, unknown>): Client {
  const socket: Client = connectClient(url, { auth, transports: ['websocket'], forceNew: true, reconnection: false })
  clients.push(socket)
  return socket
}

/** Connects and resolves with the socket and its bootstrap payload. */
function connect(url: string, auth: HandshakeAuth | Record<string, unknown>): Promise<{ socket: Client; boot: Bootstrap }> {
  const socket = makeClient(url, auth)
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

/** Expects the handshake to be rejected; resolves with the error message. */
function connectError(url: string, auth: HandshakeAuth | Record<string, unknown>): Promise<string> {
  const socket = makeClient(url, auth)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('expected connect_error')), TIMEOUT)
    socket.once('bootstrap', () => reject(new Error('unexpectedly connected')))
    socket.once('connect_error', (err) => {
      clearTimeout(timer)
      socket.close()
      resolve(err.message)
    })
  })
}

/** Emits with an ack and resolves with the ack result. */
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

/** Fire-and-forget emit (events without ack: typing, voice:state). */
function send(socket: Client, event: 'typing' | 'voice:state', payload: unknown) {
  ;(socket as unknown as { emit(e: string, p: unknown): void }).emit(event, payload)
}

/** Resolves with the next `event` payload that matches `match`. */
function nextEvent<E extends EventName>(
  socket: Client,
  event: E,
  match: (arg: EventArg<E>) => boolean = () => true,
): Promise<EventArg<E>> {
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

/** Asserts that `event` is NOT received within `ms`. */
function noEvent(socket: Client, event: EventName, ms = 250): Promise<void> {
  const s = socket as unknown as { on(e: string, f: (a: unknown) => void): void; off(e: string, f: (a: unknown) => void): void }
  return new Promise((resolve, reject) => {
    const handler = (arg: unknown) => {
      clearTimeout(timer)
      s.off(event, handler)
      reject(new Error(`unexpected "${event}": ${JSON.stringify(arg)}`))
    }
    const timer = setTimeout(() => {
      s.off(event, handler)
      resolve()
    }, ms)
    s.on(event, handler)
  })
}

const voicePatch = (channelId: string | null, extra: Partial<VoiceStatePatch> = {}): VoiceStatePatch => ({
  channelId,
  muted: false,
  deafened: false,
  camera: false,
  streaming: false,
  ...extra,
})

const findVoice = (states: VoiceState[], userId: string) => states.find((s) => s.userId === userId)

after(() => {
  for (const c of clients) c.close()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('Nexo protocol', () => {
  let server: NexoInstance
  let url: string
  let alice: { socket: Client; boot: Bootstrap; token: string }
  let bob: { socket: Client; boot: Bootstrap; token: string }
  let general: Channel
  let lounge: Channel

  before(async () => {
    server = await boot()
    url = server.url
  })
  after(() => server.close())

  // ----- health -----

  test('GET /health', async () => {
    const res = await fetch(`${url}/health`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, name: 'Test Space' })
    assert.equal((await fetch(`${url}/nope`)).status, 404)
  })

  // ----- identity -----

  test('new identity: token returned once, seeded channels, presence', async () => {
    const { socket, boot: b } = await connect(url, { name: '  Alice  ', color: '#FF0000' })
    assert.equal(b.serverName, 'Test Space')
    assert.equal(b.me.name, 'Alice', 'name is trimmed')
    assert.equal(b.me.color, '#ff0000')
    assert.ok(typeof b.token === 'string' && b.token.length >= 43, 'raw token (256 bit) is returned')
    assert.ok(b.users.some((u) => u.id === b.me.id))
    assert.ok(b.online.includes(b.me.id))
    assert.deepEqual(b.voice, [])
    const names = b.channels.map((c) => `${c.type}:${c.name}`)
    assert.deepEqual(names, ['text:general', 'text:clips-and-memes', 'voice:Lounge', 'voice:Gaming'])
    alice = { socket, boot: b, token: b.token }
    general = b.channels.find((c) => c.name === 'general')!
    lounge = b.channels.find((c) => c.name === 'Lounge')!
  })

  test('reconnect with token: same user, no token in bootstrap', async () => {
    const { socket, boot: b } = await connect(url, { token: alice.token })
    assert.equal(b.me.id, alice.boot.me.id)
    assert.equal(b.me.name, 'Alice')
    assert.equal(b.token, undefined)
    assert.equal('token' in b, false)
    socket.close()
  })

  test('unknown token is rejected with UNKNOWN_TOKEN', async () => {
    assert.equal(await connectError(url, { token: 'not-a-real-token' }), 'UNKNOWN_TOKEN')
  })

  test('duplicate name (case-insensitive) is rejected', async () => {
    assert.equal(await connectError(url, { name: 'alice', color: '#00ff00' }), 'That name is already taken')
  })

  test('invalid names and garbage auth are rejected', async () => {
    assert.match(await connectError(url, { name: 'A', color: '#00ff00' }), /Names must be/)
    assert.match(await connectError(url, { name: 'x'.repeat(25), color: '#00ff00' }), /Names must be/)
    assert.match(await connectError(url, { name: '<script>', color: '#00ff00' }), /Names must be/)
    assert.match(await connectError(url, { name: 42 }), /Names must be/)
    assert.match(await connectError(url, {}), /Names must be/)
  })

  test('a new user is broadcast (user:upsert + presence) and gets a default color if invalid', async () => {
    const upsert = nextEvent(alice.socket, 'user:upsert', (u) => u.name === 'Bob')
    const presence = nextEvent(alice.socket, 'presence', (ids) => ids.length === 2)
    const { socket, boot: b } = await connect(url, { name: 'Bob', color: 'red' })
    assert.match(b.me.color, /^#[0-9a-f]{6}$/)
    bob = { socket, boot: b, token: b.token! }
    assert.equal((await upsert).id, b.me.id)
    assert.ok((await presence).includes(b.me.id))
  })

  // ----- channels -----

  test('channel create / rename / delete are broadcast', async () => {
    const upsert = nextEvent(bob.socket, 'channel:upsert')
    const created = await requestOk<Channel>(alice.socket, 'channel:create', { name: '  My Cool  Channel!! ', type: 'text' })
    assert.equal(created.name, 'my-cool-channel')
    assert.equal(created.type, 'text')
    assert.equal(created.position, 2)
    assert.deepEqual(await upsert, created)

    const voice = await requestOk<Channel>(alice.socket, 'channel:create', { name: '  Late   Night  ', type: 'voice' })
    assert.equal(voice.name, 'Late Night')
    assert.equal(voice.position, 2)

    const long = await requestOk<Channel>(alice.socket, 'channel:create', { name: 'a'.repeat(100), type: 'text' })
    assert.equal(long.name.length, 32)

    const renamed = nextEvent(bob.socket, 'channel:upsert', (c) => c.id === created.id)
    const r = await requestOk<Channel>(alice.socket, 'channel:rename', { channelId: created.id, name: 'Renamed' })
    assert.equal(r.name, 'renamed')
    assert.equal((await renamed).name, 'renamed')

    const deleted = nextEvent(bob.socket, 'channel:deleted')
    assert.equal(await requestOk<null>(alice.socket, 'channel:delete', { channelId: created.id }), null)
    assert.deepEqual(await deleted, { channelId: created.id })
    await requestOk<null>(alice.socket, 'channel:delete', { channelId: long.id })
    await requestOk<null>(alice.socket, 'channel:delete', { channelId: voice.id })
  })

  test('channel validation errors', async () => {
    assert.equal(await requestErr(alice.socket, 'channel:create', { name: 'x', type: 'video' }), 'Invalid channel type')
    assert.equal(await requestErr(alice.socket, 'channel:create', { name: '!!!', type: 'text' }), 'Invalid channel name')
    assert.equal(await requestErr(alice.socket, 'channel:create', { name: '   ', type: 'voice' }), 'Invalid channel name')
    assert.equal(await requestErr(alice.socket, 'channel:create', null), 'Invalid channel type')
    assert.equal(await requestErr(alice.socket, 'channel:rename', { channelId: 'nope', name: 'x' }), 'Channel not found')
    assert.equal(await requestErr(alice.socket, 'channel:rename', { channelId: general.id, name: '' }), 'Invalid channel name')
    assert.equal(await requestErr(alice.socket, 'channel:delete', { channelId: 'nope' }), 'Channel not found')
    assert.equal(await requestErr(alice.socket, 'channel:delete', { channelId: 123 }), 'Channel not found')
  })

  // ----- messages -----

  test('message send is broadcast and validated', async () => {
    const incoming = nextEvent(bob.socket, 'message:new')
    const msg = await requestOk<Message>(alice.socket, 'message:send', { channelId: general.id, content: '  hello  ' })
    assert.equal(msg.content, 'hello')
    assert.equal(msg.userId, alice.boot.me.id)
    assert.equal(msg.channelId, general.id)
    assert.deepEqual(await incoming, msg)

    assert.equal(await requestErr(alice.socket, 'message:send', { channelId: general.id, content: '   ' }), 'Message is empty')
    assert.match(
      await requestErr(alice.socket, 'message:send', { channelId: general.id, content: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }),
      /limited to/,
    )
    await requestOk<Message>(alice.socket, 'message:send', { channelId: general.id, content: 'x'.repeat(MAX_MESSAGE_LENGTH) })
    assert.equal(await requestErr(alice.socket, 'message:send', { channelId: lounge.id, content: 'hi' }), 'Channel not found')
    assert.equal(await requestErr(alice.socket, 'message:send', { channelId: 'nope', content: 'hi' }), 'Channel not found')
    assert.equal(await requestErr(alice.socket, 'message:send', { channelId: general.id, content: 7 }), 'Message is empty')
  })

  test('history pages of 50, oldest first, no gaps or duplicates on timestamp ties', async () => {
    const ch = await requestOk<Channel>(alice.socket, 'channel:create', { name: 'paging', type: 'text' })
    const total = MESSAGE_PAGE_SIZE + 12
    // Sent concurrently so many land in the same millisecond.
    const sent = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        requestOk<Message>(i % 2 ? alice.socket : bob.socket, 'message:send', { channelId: ch.id, content: `m${i}` }),
      ),
    )
    const stamps = new Set(sent.map((m) => m.createdAt))
    assert.equal(stamps.size, total, 'createdAt is unique per message')

    const page1 = await requestOk<Message[]>(alice.socket, 'message:history', { channelId: ch.id })
    assert.equal(page1.length, MESSAGE_PAGE_SIZE)
    for (let i = 1; i < page1.length; i++) assert.ok(page1[i - 1].createdAt < page1[i].createdAt, 'oldest first')
    const newest = sent.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
    assert.equal(page1[page1.length - 1].id, newest.id)

    const page2 = await requestOk<Message[]>(alice.socket, 'message:history', { channelId: ch.id, before: page1[0].createdAt })
    assert.equal(page2.length, total - MESSAGE_PAGE_SIZE)
    assert.ok(page2[page2.length - 1].createdAt < page1[0].createdAt)

    const all = new Set([...page2, ...page1].map((m) => m.id))
    assert.equal(all.size, total)
    for (const m of sent) assert.ok(all.has(m.id))

    const page3 = await requestOk<Message[]>(alice.socket, 'message:history', { channelId: ch.id, before: page2[0].createdAt })
    assert.deepEqual(page3, [])

    assert.equal(await requestErr(alice.socket, 'message:history', { channelId: ch.id, before: 'yesterday' }), 'Invalid "before" timestamp')
    assert.equal(await requestErr(alice.socket, 'message:history', { channelId: 'nope' }), 'Channel not found')

    // Deleting a text channel deletes its messages too.
    await requestOk<null>(alice.socket, 'channel:delete', { channelId: ch.id })
    assert.equal(await requestErr(alice.socket, 'message:history', { channelId: ch.id }), 'Channel not found')
  })

  test('message delete: members only their own, broadcast with channelId', async () => {
    const msg = await requestOk<Message>(alice.socket, 'message:send', { channelId: general.id, content: 'delete me' })
    assert.equal(await requestErr(bob.socket, 'message:delete', { messageId: msg.id }), "Only admins can delete other people's messages")

    const deleted = nextEvent(bob.socket, 'message:deleted')
    assert.equal(await requestOk<null>(alice.socket, 'message:delete', { messageId: msg.id }), null)
    assert.deepEqual(await deleted, { messageId: msg.id, channelId: general.id })

    const history = await requestOk<Message[]>(alice.socket, 'message:history', { channelId: general.id })
    assert.ok(!history.some((m) => m.id === msg.id))
    assert.equal(await requestErr(alice.socket, 'message:delete', { messageId: msg.id }), 'Message not found')
  })

  test('bootstrap lastMessageAt: newest message by someone else, per channel', async () => {
    const ch = await requestOk<Channel>(alice.socket, 'channel:create', { name: 'unread', type: 'text' })
    const fromBob = await requestOk<Message>(bob.socket, 'message:send', { channelId: ch.id, content: 'for alice' })
    const fromAlice = await requestOk<Message>(alice.socket, 'message:send', { channelId: ch.id, content: 'reply' })
    assert.ok(fromAlice.createdAt > fromBob.createdAt)

    const a = await connect(url, { token: alice.token })
    // Alice's own (newer) reply doesn't count: the newest message by someone else is Bob's.
    assert.equal(a.boot.lastMessageAt?.[ch.id], fromBob.createdAt)
    const b = await connect(url, { token: bob.token })
    assert.equal(b.boot.lastMessageAt?.[ch.id], fromAlice.createdAt)
    a.socket.close()
    b.socket.close()

    // A channel with only your own messages is left out.
    const solo = await requestOk<Channel>(alice.socket, 'channel:create', { name: 'solo', type: 'text' })
    await requestOk<Message>(alice.socket, 'message:send', { channelId: solo.id, content: 'just me' })
    const again = await connect(url, { token: alice.token })
    assert.equal(again.boot.lastMessageAt?.[solo.id], undefined)
    again.socket.close()

    await requestOk<null>(alice.socket, 'channel:delete', { channelId: ch.id })
    await requestOk<null>(alice.socket, 'channel:delete', { channelId: solo.id })
  })

  // ----- typing -----

  test('typing is broadcast to others, not echoed to the typer', async () => {
    const aliceSecond = await connect(url, { token: alice.token })
    const got = nextEvent(bob.socket, 'typing')
    const notSelf = noEvent(alice.socket, 'typing')
    const notOwnOtherDevice = noEvent(aliceSecond.socket, 'typing')
    send(alice.socket, 'typing', { channelId: general.id })
    assert.deepEqual(await got, { channelId: general.id, userId: alice.boot.me.id })
    await notSelf
    await notOwnOtherDevice
    // Unknown and voice channels are ignored.
    const none = noEvent(alice.socket, 'typing')
    send(bob.socket, 'typing', { channelId: 'nope' })
    send(bob.socket, 'typing', { channelId: lounge.id })
    await none
    aliceSecond.socket.close()
  })

  // ----- voice -----

  test('voice:state set and clear are broadcast as full lists', async () => {
    const joined = nextEvent(bob.socket, 'voice:states', (s) => !!findVoice(s, alice.boot.me.id))
    send(alice.socket, 'voice:state', voicePatch(lounge.id, { muted: true, streaming: true }))
    const states = await joined
    assert.deepEqual(findVoice(states, alice.boot.me.id), {
      userId: alice.boot.me.id,
      channelId: lounge.id,
      muted: true,
      deafened: false,
      camera: false,
      streaming: true,
    })

    const left = nextEvent(bob.socket, 'voice:states', (s) => !findVoice(s, alice.boot.me.id))
    send(alice.socket, 'voice:state', voicePatch(null))
    await left
  })

  test('voice:state for unknown or text channels is ignored', async () => {
    const none = noEvent(bob.socket, 'voice:states')
    send(alice.socket, 'voice:state', voicePatch(general.id))
    send(alice.socket, 'voice:state', voicePatch('nope'))
    send(alice.socket, 'voice:state', null)
    await none
  })

  test('voice state and presence are cleared when the owning socket disconnects', async () => {
    const carol = await connect(url, { name: 'Carol', color: '#123456' })
    const carolId = carol.boot.me.id
    const joined = nextEvent(alice.socket, 'voice:states', (s) => !!findVoice(s, carolId))
    send(carol.socket, 'voice:state', voicePatch(lounge.id))
    await joined

    const cleared = nextEvent(alice.socket, 'voice:states', (s) => !findVoice(s, carolId))
    const offline = nextEvent(alice.socket, 'presence', (ids) => !ids.includes(carolId))
    carol.socket.close()
    await cleared
    await offline
  })

  test('multiple sockets per user: presence and voice survive closing a non-owning socket', async () => {
    const aliceId = alice.boot.me.id
    const second = await connect(url, { token: alice.token })
    assert.ok(second.boot.online.includes(aliceId))

    const joined = nextEvent(bob.socket, 'voice:states', (s) => !!findVoice(s, aliceId))
    send(alice.socket, 'voice:state', voicePatch(lounge.id))
    await joined

    // A null state from a socket that doesn't own the voice session is ignored.
    const noChange = noEvent(bob.socket, 'voice:states')
    send(second.socket, 'voice:state', voicePatch(null))
    await noChange

    const noPresence = noEvent(bob.socket, 'presence')
    const noVoice = noEvent(bob.socket, 'voice:states')
    second.socket.close()
    await noPresence
    await noVoice

    const check = await connect(url, { token: bob.token })
    assert.ok(check.boot.online.includes(aliceId), 'still online via the first socket')
    assert.ok(findVoice(check.boot.voice, aliceId), 'voice state kept')
    check.socket.close()

    const left = nextEvent(bob.socket, 'voice:states', (s) => !findVoice(s, aliceId))
    send(alice.socket, 'voice:state', voicePatch(null))
    await left
  })

  test('deleting a voice channel clears voice states in it', async () => {
    const temp = await requestOk<Channel>(alice.socket, 'channel:create', { name: 'Temp', type: 'voice' })
    const aliceId = alice.boot.me.id
    const bobId = bob.boot.me.id
    const both = nextEvent(alice.socket, 'voice:states', (s) => !!findVoice(s, aliceId) && !!findVoice(s, bobId))
    send(alice.socket, 'voice:state', voicePatch(temp.id))
    send(bob.socket, 'voice:state', voicePatch(lounge.id))
    await both

    const deleted = nextEvent(alice.socket, 'channel:deleted')
    const cleared = nextEvent(alice.socket, 'voice:states', (s) => !findVoice(s, aliceId))
    await requestOk<null>(alice.socket, 'channel:delete', { channelId: temp.id })
    assert.deepEqual(await deleted, { channelId: temp.id })
    const states = await cleared
    assert.equal(findVoice(states, bobId)?.channelId, lounge.id, 'other channels untouched')

    const bobLeft = nextEvent(alice.socket, 'voice:states', (s) => !findVoice(s, bobId))
    send(bob.socket, 'voice:state', voicePatch(null))
    await bobLeft
  })

  test('voice:token returns a LiveKit JWT for room voice-<id>', async () => {
    const creds = await requestOk<VoiceCredentials>(alice.socket, 'voice:token', { channelId: lounge.id })
    assert.equal(creds.room, `voice-${lounge.id}`)
    assert.equal(creds.url, 'ws://127.0.0.1:7880', 'derived from the host the client used')
    assert.equal(creds.token.split('.').length, 3)

    const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(creds.token)
    assert.equal(claims.sub, alice.boot.me.id)
    assert.equal(claims.name, 'Alice')
    assert.deepEqual(JSON.parse(claims.metadata ?? '{}'), { color: alice.boot.me.color })
    assert.equal(claims.video?.room, `voice-${lounge.id}`)
    assert.equal(claims.video?.roomJoin, true)
    assert.equal(claims.video?.canPublish, true)
    assert.equal(claims.video?.canSubscribe, true)
    const ttl = (claims.exp ?? 0) - (claims.nbf ?? Math.floor(Date.now() / 1000))
    assert.ok(ttl > 11 * 3600 && ttl <= 12 * 3600 + 60, `ttl ~12h (got ${ttl}s)`)

    await assert.rejects(new TokenVerifier(LK_KEY, 'some-other-secret-that-is-32-chars-long!!').verify(creds.token))
    assert.equal(await requestErr(alice.socket, 'voice:token', { channelId: general.id }), 'Voice channel not found')
    assert.equal(await requestErr(alice.socket, 'voice:token', {}), 'Voice channel not found')
  })

  test('voice:streamToken mints a publish-only screen-share token while in that voice channel', async () => {
    const aliceId = alice.boot.me.id
    // Not in voice yet.
    assert.equal(
      await requestErr(alice.socket, 'voice:streamToken', { channelId: lounge.id }),
      'Join the voice channel before streaming',
    )
    assert.equal(await requestErr(alice.socket, 'voice:streamToken', { channelId: general.id }), 'Voice channel not found')
    assert.equal(await requestErr(alice.socket, 'voice:streamToken', {}), 'Voice channel not found')

    const joined = nextEvent(bob.socket, 'voice:states', (s) => findVoice(s, aliceId)?.channelId === lounge.id)
    send(alice.socket, 'voice:state', voicePatch(lounge.id))
    await joined

    const creds = await requestOk<StreamCredentials>(alice.socket, 'voice:streamToken', { channelId: lounge.id })
    assert.equal(creds.room, `voice-${lounge.id}`)
    assert.equal(creds.identity, `${aliceId}#stream`)
    assert.equal(creds.url, 'ws://127.0.0.1:7880')
    const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(creds.token)
    assert.equal(claims.sub, `${aliceId}#stream`)
    assert.equal(claims.name, 'Alice')
    assert.equal(claims.video?.room, `voice-${lounge.id}`)
    assert.equal(claims.video?.roomJoin, true)
    assert.equal(claims.video?.canPublish, true)
    assert.equal(claims.video?.canSubscribe, false)
    assert.equal(claims.video?.canPublishData, false)
    assert.deepEqual(
      [...((claims.video?.canPublishSources ?? []) as unknown[])].map(String).sort(),
      ['screen_share', 'screen_share_audio'],
    )

    // Another voice channel than the one Alice is in.
    const other = await requestOk<Channel>(alice.socket, 'channel:create', { name: 'Other', type: 'voice' })
    assert.equal(
      await requestErr(alice.socket, 'voice:streamToken', { channelId: other.id }),
      'Join the voice channel before streaming',
    )
    // Another socket of the same user doesn't own the voice session.
    const second = await connect(url, { token: alice.token })
    assert.equal(
      await requestErr(second.socket, 'voice:streamToken', { channelId: lounge.id }),
      'Join the voice channel before streaming',
    )
    second.socket.close()
    // Bob is not in voice.
    assert.equal(
      await requestErr(bob.socket, 'voice:streamToken', { channelId: lounge.id }),
      'Join the voice channel before streaming',
    )

    await requestOk<null>(alice.socket, 'channel:delete', { channelId: other.id })
    const left = nextEvent(bob.socket, 'voice:states', (s) => !findVoice(s, aliceId))
    send(alice.socket, 'voice:state', voicePatch(null))
    await left
  })

  // ----- profile -----

  test('profile:update broadcasts and refreshes every socket of the user', async () => {
    const second = await connect(url, { token: alice.token })
    const upsert = nextEvent(bob.socket, 'user:upsert', (u) => u.id === alice.boot.me.id)
    const updated = await requestOk<User>(alice.socket, 'profile:update', { color: '#ABCDEF' })
    assert.deepEqual(updated, { id: alice.boot.me.id, name: 'Alice', color: '#abcdef', avatar: null, role: 'owner' })
    assert.deepEqual(await upsert, updated)

    // The other socket mints tokens with the new color.
    const creds = await requestOk<VoiceCredentials>(second.socket, 'voice:token', { channelId: lounge.id })
    const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(creds.token)
    assert.deepEqual(JSON.parse(claims.metadata ?? '{}'), { color: '#abcdef' })
    second.socket.close()

    assert.equal(await requestErr(alice.socket, 'profile:update', { color: 'blue' }), 'Invalid color')
    assert.equal(await requestErr(alice.socket, 'profile:update', null), 'Invalid color')
  })

  // ----- robustness -----

  test('malformed payloads never crash the server', async () => {
    const raw = alice.socket as unknown as { emit(e: string, ...a: unknown[]): void }
    for (const event of ['channel:create', 'channel:rename', 'channel:delete', 'message:send', 'message:delete', 'message:history', 'voice:token', 'voice:streamToken', 'profile:update']) {
      raw.emit(event) // no payload, no ack
      raw.emit(event, 'string-payload')
      raw.emit(event, { channelId: { $ne: 1 }, messageId: [1], name: {}, content: [], color: 5 })
      const res = await request<unknown>(alice.socket, event as keyof ClientToServerEvents, undefined)
      assert.equal(res.ok, false, event)
    }
    raw.emit('typing')
    raw.emit('voice:state', 'x')
    raw.emit('voice:state', { channelId: 5 })
    // Still alive and responsive.
    const history = await requestOk<Message[]>(alice.socket, 'message:history', { channelId: general.id })
    assert.ok(Array.isArray(history))
  })

  test('payloads over 64 KB are rejected by disconnecting', async () => {
    const big = await connect(url, { token: bob.token })
    const disconnected = new Promise<string>((resolve) => big.socket.once('disconnect', resolve))
    send(big.socket, 'typing', { channelId: 'x'.repeat(70 * 1024) })
    assert.ok(await disconnected)
    // Server still fine for others.
    await requestOk<Message[]>(bob.socket, 'message:history', { channelId: general.id })
  })

  test('identity persists across a server restart (same data dir)', async () => {
    const dataDir = server.config.dataDir
    const restarted = await start({ ...server.config, port: 0, host: '127.0.0.1', dataDir, log: false })
    try {
      const { socket, boot: b } = await connect(restarted.url, { token: alice.token })
      assert.equal(b.me.id, alice.boot.me.id)
      assert.equal(b.me.color, '#abcdef')
      assert.equal(b.channels.length, 4, 'not re-seeded')
      socket.close()
    } finally {
      await restarted.close()
    }
  })
})

describe('server password', () => {
  let server: NexoInstance

  before(async () => {
    server = await boot({ serverPassword: 'hunter2' })
  })
  after(() => server.close())

  test('new users need the password; token reconnects do not', async () => {
    assert.equal(await connectError(server.url, { name: 'Dave', color: '#111111' }), 'Wrong server password')
    assert.equal(await connectError(server.url, { name: 'Dave', color: '#111111', password: 'wrong' }), 'Wrong server password')
    const { socket, boot: b } = await connect(server.url, { name: 'Dave', color: '#111111', password: 'hunter2' })
    assert.ok(b.token)
    socket.close()
    const again = await connect(server.url, { token: b.token! })
    assert.equal(again.boot.me.id, b.me.id)
    again.socket.close()
  })

  test('close() disconnects clients and stops listening', async () => {
    const { socket } = await connect(server.url, { name: 'Erin', color: '#222222', password: 'hunter2' })
    const disconnected = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()))
    await server.close()
    await disconnected
    await assert.rejects(fetch(`${server.url}/health`))
  })
})
