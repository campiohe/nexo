// Tier 2: custom status text (`profile:update`), presence (`presence:update` / `presence:changed`), the
// `watching` list of voice states, and the users migration for the new columns. Boots the server in-process
// like protocol.test.ts. GIF avatars are tested in avatar.test.ts. Run with `npm test -w server`.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client'
import type {
  AckResult,
  Bootstrap,
  Channel,
  ClientToServerEvents,
  Presence,
  ServerToClientEvents,
  User,
  VoiceState,
  VoiceStatePatch,
} from '../../shared/protocol.ts'
import { ACTIVITY_NAME_MAX, DEFAULT_PRESENCE, MAX_WATCHING, STATUS_TEXT_MAX } from '../../shared/protocol.ts'
import { LIMITS, start, type NexoInstance, type StartOptions } from '../src/server.ts'

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>
type EventName = keyof ServerToClientEvents
type EventArg<E extends EventName> = Parameters<ServerToClientEvents[E]>[0]

const TIMEOUT = 3000
const tmpDirs: string[] = []
const clients: Client[] = []
/** The latest voice states each client has seen (bootstrap, then every `voice:states`). */
const seenVoice = new WeakMap<Client, VoiceState[]>()

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-tier2-'))
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
  socket.on('voice:states', (states) => seenVoice.set(socket, states))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bootstrap timeout')), TIMEOUT)
    socket.once('bootstrap', (b) => {
      clearTimeout(timer)
      seenVoice.set(socket, b.voice)
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

/** Emits without an ack (raw: payloads may be deliberately invalid). */
const send = (socket: Client, event: string, payload?: unknown) =>
  (socket as unknown as { emit(e: string, p?: unknown): void }).emit(event, payload)

/** A round trip on `socket`: every event it sent before has been handled. */
const sync = (socket: Client) => request(socket, 'message:history', {})

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

/** Collects every `event` (matching) on `socket` until the returned stop() is called. */
function collect<E extends EventName>(socket: Client, event: E, match: (arg: EventArg<E>) => boolean = () => true) {
  const s = socket as unknown as { on(e: string, f: (a: unknown) => void): void; off(e: string, f: (a: unknown) => void): void }
  const seen: EventArg<E>[] = []
  const handler = (arg: unknown) => {
    if (match(arg as EventArg<E>)) seen.push(arg as EventArg<E>)
  }
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

after(() => {
  for (const c of clients) c.close()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('custom status text (profile:update)', () => {
  let server: NexoInstance
  let alice: Conn
  let bob: Conn

  before(async () => {
    server = await boot()
    alice = await join(server.url, 'Alice')
    bob = await join(server.url, 'Bob')
  })
  after(() => server.close())

  test('users start without one', () => {
    assert.equal(alice.boot.me.statusText, null)
    assert.ok(bob.boot.users.every((u) => u.statusText === null))
  })

  test('set: normalized, broadcast, persisted, color kept', async () => {
    const upsert = nextEvent(bob.socket, 'user:upsert', (u) => u.id === alice.id)
    const user = await requestOk<User>(alice.socket, 'profile:update', { statusText: '  brb\n\t dinner  ' })
    assert.equal(user.statusText, 'brb dinner')
    assert.equal(user.color, '#123456')
    assert.deepEqual(await upsert, user)

    const again = await connect(server.url, { token: alice.token })
    assert.equal(again.boot.me.statusText, 'brb dinner')
    assert.equal(again.boot.users.find((u) => u.id === alice.id)?.statusText, 'brb dinner')
    again.socket.close()
  })

  test('control and format characters are stripped (emoji ZWJ sequences kept)', async () => {
    let user = await requestOk<User>(alice.socket, 'profile:update', { statusText: 'a\u0000b‮c​d' })
    assert.equal(user.statusText, 'abcd')
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'
    user = await requestOk<User>(alice.socket, 'profile:update', { statusText: `family time ${family}` })
    assert.equal(user.statusText, `family time ${family}`)
    // NFC: e + combining acute → é.
    user = await requestOk<User>(alice.socket, 'profile:update', { statusText: 'café' })
    assert.equal(user.statusText, 'café')
  })

  test('only color still works (older clients) and keeps the status', async () => {
    const user = await requestOk<User>(alice.socket, 'profile:update', { color: '#ABCDEF' })
    assert.equal(user.color, '#abcdef')
    assert.equal(user.statusText, 'café')
  })

  test('both at once', async () => {
    const user = await requestOk<User>(alice.socket, 'profile:update', { color: '#000000', statusText: 'gaming' })
    assert.equal(user.color, '#000000')
    assert.equal(user.statusText, 'gaming')
  })

  test("'' and null clear it", async () => {
    let user = await requestOk<User>(alice.socket, 'profile:update', { statusText: '' })
    assert.equal(user.statusText, null)
    await requestOk<User>(alice.socket, 'profile:update', { statusText: 'x' })
    const upsert = nextEvent(bob.socket, 'user:upsert', (u) => u.id === alice.id && u.statusText === null)
    user = await requestOk<User>(alice.socket, 'profile:update', { statusText: null })
    assert.equal(user.statusText, null)
    await upsert
    // Only whitespace / control characters is empty too.
    await requestOk<User>(alice.socket, 'profile:update', { statusText: 'x' })
    user = await requestOk<User>(alice.socket, 'profile:update', { statusText: ' \n\u0007 ' })
    assert.equal(user.statusText, null)
  })

  test(`at most ${STATUS_TEXT_MAX} characters (after normalization)`, async () => {
    assert.equal(
      await requestErr(alice.socket, 'profile:update', { statusText: 'x'.repeat(STATUS_TEXT_MAX + 1) }),
      'Status is limited to 64 characters',
    )
    const max = 'y'.repeat(STATUS_TEXT_MAX)
    assert.equal((await requestOk<User>(alice.socket, 'profile:update', { statusText: max })).statusText, max)
    const spaced = `a${' '.repeat(200)}b`
    assert.equal((await requestOk<User>(alice.socket, 'profile:update', { statusText: spaced })).statusText, 'a b')
    // A failed update changes nothing (not even a valid color sent with it).
    assert.equal(
      await requestErr(alice.socket, 'profile:update', { color: '#111111', statusText: 'z'.repeat(100) }),
      'Status is limited to 64 characters',
    )
    const again = await connect(server.url, { token: alice.token })
    assert.equal(again.boot.me.statusText, 'a b')
    assert.equal(again.boot.me.color, '#000000')
    again.socket.close()
  })

  test('invalid payloads', async () => {
    assert.equal(await requestErr(alice.socket, 'profile:update', {}), 'Nothing to update')
    assert.equal(await requestErr(alice.socket, 'profile:update', null), 'Nothing to update')
    assert.equal(await requestErr(alice.socket, 'profile:update', { statusText: 5 }), 'Invalid status')
    assert.equal(await requestErr(alice.socket, 'profile:update', { statusText: ['a'] }), 'Invalid status')
    assert.equal(await requestErr(alice.socket, 'profile:update', { color: null }), 'Invalid color')
    assert.equal(await requestErr(alice.socket, 'profile:update', { color: 'red', statusText: 'ok' }), 'Invalid color')
  })
})

// ---------------------------------------------------------------------------

describe('presence (status and activity)', () => {
  let server: NexoInstance
  let alice: Conn
  let bob: Conn

  before(async () => {
    server = await boot()
    alice = await join(server.url, 'Alice')
    bob = await join(server.url, 'Bob')
  })
  after(() => server.close())

  const changedFor = (userId: string, match: (p: Presence) => boolean = () => true) =>
    nextEvent(bob.socket, 'presence:changed', (e) => e.userId === userId && match(e.presence))

  test('bootstrap: nobody has a non-default presence yet', () => {
    assert.deepEqual(alice.boot.presence, {})
    assert.deepEqual(bob.boot.presence, {})
  })

  test('status: broadcast to everyone (including own sockets)', async () => {
    const toBob = changedFor(alice.id)
    const toSelf = nextEvent(alice.socket, 'presence:changed')
    send(alice.socket, 'presence:update', { status: 'dnd' })
    assert.deepEqual(await toBob, { userId: alice.id, presence: { status: 'dnd', activity: null } })
    assert.deepEqual(await toSelf, { userId: alice.id, presence: { status: 'dnd', activity: null } })
  })

  test('activity merges with the status; name trimmed and normalized', async () => {
    const startedAt = Date.now() - 60_000
    const changed = changedFor(alice.id)
    send(alice.socket, 'presence:update', { activity: { name: '  Counter-Strike\n 2 ', startedAt } })
    assert.deepEqual((await changed).presence, { status: 'dnd', activity: { name: 'Counter-Strike 2', startedAt } })

    // Status only: the activity stays.
    const idle = changedFor(alice.id)
    send(alice.socket, 'presence:update', { status: 'idle' })
    assert.deepEqual((await idle).presence, { status: 'idle', activity: { name: 'Counter-Strike 2', startedAt } })
  })

  test('no broadcast when nothing changed; invalid fields are ignored', async () => {
    const events = collect(bob.socket, 'presence:changed', (e) => e.userId === alice.id)
    send(alice.socket, 'presence:update', { status: 'idle' })
    send(alice.socket, 'presence:update', {})
    send(alice.socket, 'presence:update', null)
    send(alice.socket, 'presence:update', 'idle')
    send(alice.socket, 'presence:update', { status: 'invisible' })
    send(alice.socket, 'presence:update', { status: 5, activity: 'Minecraft' })
    send(alice.socket, 'presence:update', { activity: { name: '   ', startedAt: Date.now() } })
    send(alice.socket, 'presence:update', { activity: { name: '\u0000‮', startedAt: Date.now() } })
    send(alice.socket, 'presence:update', { activity: { name: 'Minecraft', startedAt: 'yesterday' } })
    send(alice.socket, 'presence:update', { activity: { name: 'Minecraft', startedAt: Number.NaN } })
    send(alice.socket, 'presence:update', { activity: { name: 42, startedAt: Date.now() } })
    await sync(alice.socket)
    await delay(150)
    assert.deepEqual(events.stop(), [])

    // An invalid field doesn't spoil a valid one next to it.
    const changed = changedFor(alice.id, (p) => p.status === 'online')
    send(alice.socket, 'presence:update', { status: 'online', activity: { name: '', startedAt: 1 } })
    assert.equal((await changed).presence.activity?.name, 'Counter-Strike 2')
  })

  test('activity: startedAt clamped to [now - 7 days, now]; long names cut', async () => {
    let before = Date.now()
    let changed = changedFor(alice.id, (p) => p.activity?.name === 'Future')
    send(alice.socket, 'presence:update', { activity: { name: 'Future', startedAt: Date.now() + 3_600_000 } })
    let { activity } = (await changed).presence
    assert.ok(activity!.startedAt >= before && activity!.startedAt <= Date.now(), 'clamped to now')

    before = Date.now()
    changed = changedFor(alice.id, (p) => p.activity?.name === 'Ancient')
    send(alice.socket, 'presence:update', { activity: { name: 'Ancient', startedAt: 0 } })
    ;({ activity } = (await changed).presence)
    const age = Date.now() - activity!.startedAt
    assert.ok(age >= LIMITS.activityMaxAgeMs - 1000 && age <= LIMITS.activityMaxAgeMs + (Date.now() - before) + 1000)

    changed = changedFor(alice.id, (p) => p.activity?.name.startsWith('x') === true)
    send(alice.socket, 'presence:update', { activity: { name: 'x'.repeat(200), startedAt: Date.now() } })
    assert.equal((await changed).presence.activity!.name, 'x'.repeat(ACTIVITY_NAME_MAX))
  })

  test('bootstrap includes non-default presences of online users only', async () => {
    const startedAt = Date.now() - 5000
    const changed = changedFor(alice.id, (p) => p.activity?.name === 'Factorio')
    send(alice.socket, 'presence:update', { status: 'dnd', activity: { name: 'Factorio', startedAt } })
    await changed
    const carol = await join(server.url, 'Carol')
    assert.deepEqual(carol.boot.presence, { [alice.id]: { status: 'dnd', activity: { name: 'Factorio', startedAt } } })
    carol.socket.close()
  })

  test('kept while another socket of the account is connected; cleared when the last one leaves', async () => {
    const second = await connect(server.url, { token: alice.token })
    // Any socket of the account can change it (latest wins).
    const changed = changedFor(alice.id, (p) => p.status === 'idle')
    send(second.socket, 'presence:update', { status: 'idle' })
    await changed
    assert.deepEqual(second.boot.presence?.[alice.id]?.activity?.name, 'Factorio')

    const none = collect(bob.socket, 'presence:changed', (e) => e.userId === alice.id)
    const stillOnline = nextEvent(bob.socket, 'user:upsert', (u) => u.id === alice.id)
    second.socket.close()
    // A later event from alice proves the disconnect above was handled first.
    await delay(100)
    await requestOk<User>(alice.socket, 'profile:update', { color: '#222222' })
    await stillOnline
    assert.deepEqual(none.stop(), [])

    const cleared = changedFor(alice.id)
    const offline = nextEvent(bob.socket, 'presence', (online) => !online.includes(alice.id))
    alice.socket.close()
    assert.deepEqual(await cleared, { userId: alice.id, presence: DEFAULT_PRESENCE })
    await offline

    alice = await connect(server.url, { token: alice.token })
    assert.deepEqual(alice.boot.presence, {})
  })

  test('back to the default presence: broadcast, and left out of bootstrap', async () => {
    let changed = changedFor(alice.id, (p) => p.status === 'dnd')
    send(alice.socket, 'presence:update', { status: 'dnd', activity: { name: 'Tetris', startedAt: Date.now() } })
    await changed
    changed = changedFor(alice.id, (p) => p.status === 'online' && p.activity === null)
    send(alice.socket, 'presence:update', { status: 'online', activity: null })
    assert.deepEqual((await changed).presence, DEFAULT_PRESENCE)
    const carol = await join(server.url, 'Carol2')
    assert.deepEqual(carol.boot.presence, {})
    carol.socket.close()
  })

  test('removing an account drops its presence', async () => {
    const dave = await join(server.url, 'Dave')
    const changed = changedFor(dave.id)
    send(dave.socket, 'presence:update', { status: 'dnd' })
    await changed
    assert.equal(alice.boot.me.role, 'owner')
    const none = collect(bob.socket, 'presence:changed', (e) => e.userId === dave.id)
    const removed = nextEvent(bob.socket, 'user:removed', (e) => e.userId === dave.id)
    await requestOk<null>(alice.socket, 'user:remove', { userId: dave.id })
    await removed
    await delay(150)
    assert.deepEqual(none.stop(), [], 'user:removed is enough')
    const eve = await join(server.url, 'Eve')
    assert.equal(eve.boot.presence?.[dave.id], undefined)
    eve.socket.close()
  })
})

describe('presence rate limit', () => {
  test('excess updates per user are dropped silently', async () => {
    const server = await boot({ presenceLimit: { count: 3, windowMs: 60_000 } })
    try {
      const alice = await join(server.url, 'Alice')
      const bob = await join(server.url, 'Bob')
      const second = await connect(server.url, { token: alice.token })
      const events = collect(bob.socket, 'presence:changed', (e) => e.userId === alice.id)
      for (const status of ['dnd', 'idle', 'dnd']) send(alice.socket, 'presence:update', { status })
      await sync(alice.socket)
      // The budget is per account, shared by all of its sockets.
      for (const status of ['idle', 'online']) send(second.socket, 'presence:update', { status })
      await sync(second.socket)
      await delay(150)
      assert.deepEqual(events.stop().map((e) => e.presence.status), ['dnd', 'idle', 'dnd'])
      // Bob's own budget is separate.
      const own = nextEvent(alice.socket, 'presence:changed', (e) => e.userId === bob.id)
      send(bob.socket, 'presence:update', { status: 'idle' })
      await own
    } finally {
      await server.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('voice state: watching', () => {
  let server: NexoInstance
  let owner: Conn
  let bob: Conn
  let carol: Conn
  let dave: Conn
  let lounge: Channel
  let gaming: Channel

  const stateOf = (states: VoiceState[], userId: string) => states.find((s) => s.userId === userId)

  /**
   * Announces a voice state from `conn` and waits until `observer` has seen the server's version of it
   * (matching `expect`), or, when it already had, for a round trip.
   */
  async function setVoice(
    conn: Conn,
    observer: Conn,
    patch: Partial<VoiceStatePatch> & { channelId: string | null } & Record<string, unknown>,
    expect: (s: VoiceState | undefined) => boolean,
  ) {
    const full = { muted: false, deafened: false, camera: false, streaming: false, ...patch }
    const matches = (states: VoiceState[]) => expect(stateOf(states, conn.id))
    const seen = nextEvent(observer.socket, 'voice:states', matches)
    send(conn.socket, 'voice:state', full)
    await seen
    return stateOf(seenVoice.get(observer.socket)!, conn.id)!
  }

  before(async () => {
    server = await boot()
    owner = await join(server.url, 'Olivia')
    bob = await join(server.url, 'Bob')
    carol = await join(server.url, 'Carol')
    dave = await join(server.url, 'Dave')
    lounge = owner.boot.channels.find((c) => c.name === 'Lounge')!
    gaming = owner.boot.channels.find((c) => c.name === 'Gaming')!
    await setVoice(bob, owner, { channelId: lounge.id, streaming: true }, (s) => s?.channelId === lounge.id)
    await setVoice(carol, owner, { channelId: lounge.id, streaming: true }, (s) => s?.channelId === lounge.id)
    await setVoice(dave, owner, { channelId: gaming.id, streaming: true }, (s) => s?.channelId === gaming.id)
  })
  after(() => server.close())

  test('missing → []', () => {
    const s = stateOf(seenVoice.get(owner.socket)!, bob.id)!
    assert.deepEqual(s.watching, [])
  })

  test('kept: users in the same channel; dropped: self, duplicates, other channels, unknown ids, non-strings', async () => {
    const s = await setVoice(
      owner,
      bob,
      { channelId: lounge.id, watching: [carol.id, carol.id, owner.id, dave.id, 'nope', 5, bob.id] as string[] },
      (v) => !!v,
    )
    assert.deepEqual(s.watching, [carol.id, bob.id])
  })

  test('a change of watching alone is broadcast; the same list is not', async () => {
    let s = await setVoice(owner, bob, { channelId: lounge.id, watching: [bob.id] }, (v) => v?.watching?.length === 1)
    assert.deepEqual(s.watching, [bob.id])

    const events = collect(bob.socket, 'voice:states')
    send(owner.socket, 'voice:state', { channelId: lounge.id, muted: false, deafened: false, camera: false, streaming: false, watching: [bob.id] })
    // Same list after filtering (other-channel ids dropped) is unchanged too.
    send(owner.socket, 'voice:state', { channelId: lounge.id, muted: false, deafened: false, camera: false, streaming: false, watching: [bob.id, dave.id] })
    await sync(owner.socket)
    await delay(150)
    assert.deepEqual(events.stop(), [])

    s = await setVoice(owner, bob, { channelId: lounge.id, watching: 'everyone' as unknown as string[] }, (v) => v?.watching?.length === 0)
    assert.deepEqual(s.watching, [])
  })

  test(`at most ${MAX_WATCHING}`, async () => {
    const crowd: Conn[] = []
    for (let i = 0; i < MAX_WATCHING + 2; i++) crowd.push(await join(server.url, `Viewer${i}`))
    for (const c of crowd) await setVoice(c, owner, { channelId: lounge.id }, (v) => v?.channelId === lounge.id)
    const ids = crowd.map((c) => c.id)
    const s = await setVoice(owner, bob, { channelId: lounge.id, watching: [owner.id, ...ids] }, (v) => (v?.watching?.length ?? 0) > 0)
    assert.deepEqual(s.watching, ids.slice(0, MAX_WATCHING))
    for (const c of crowd) {
      const left = nextEvent(owner.socket, 'voice:states', (st) => !stateOf(st, c.id))
      c.socket.close()
      await left
    }
  })

  test('voice:move clears the moved user’s watching', async () => {
    await setVoice(bob, owner, { channelId: lounge.id, streaming: true, watching: [carol.id] }, (v) => v?.watching?.length === 1)
    const moved = nextEvent(bob.socket, 'voice:moved')
    const broadcast = nextEvent(carol.socket, 'voice:states', (st) => stateOf(st, bob.id)?.channelId === gaming.id)
    await requestOk<null>(owner.socket, 'voice:move', { userId: bob.id, channelId: gaming.id })
    await moved
    assert.deepEqual(stateOf(await broadcast, bob.id), {
      userId: bob.id,
      channelId: gaming.id,
      muted: false,
      deafened: false,
      camera: false,
      streaming: false,
      watching: [],
    })
    // In the new channel, the people there can be watched.
    const s = await setVoice(bob, owner, { channelId: gaming.id, watching: [dave.id, carol.id] }, (v) => v?.watching?.length === 1)
    assert.deepEqual(s.watching, [dave.id])
  })
})

// ---------------------------------------------------------------------------

describe('users migration (status_text, avatar_animated)', () => {
  test('a database without the columns is migrated (idempotently); values persist', async () => {
    const dataDir = tempDir()
    // A v0.6 users table: avatar and role, but no status_text / avatar_animated.
    const old = new DatabaseSync(path.join(dataDir, 'nexo.db'))
    old.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, avatar TEXT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member'))
      );
    `)
    const token = 'legacy-device-token'
    old
      .prepare("INSERT INTO users (id, name, color, token_hash, created_at, avatar, role) VALUES (?, ?, ?, ?, ?, ?, 'owner')")
      .run('u-old', 'Oldtimer', '#abcdef', createHash('sha256').update(token).digest('hex'), 1000, 'abcdef123456')
    old.close()

    for (let round = 0; round < 2; round++) {
      const server = await boot({ dataDir })
      try {
        const conn = await connect(server.url, { token })
        assert.equal(conn.boot.me.id, 'u-old')
        assert.equal(conn.boot.me.avatar, 'abcdef123456')
        assert.equal(conn.boot.me.avatarAnimated, false)
        assert.equal(conn.boot.me.statusText, round === 0 ? null : 'upgraded')
        if (round === 0) await requestOk<User>(conn.socket, 'profile:update', { statusText: 'upgraded' })
        conn.socket.close()
      } finally {
        await server.close()
      }
    }

    const check = new DatabaseSync(path.join(dataDir, 'nexo.db'))
    const cols = (check.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name)
    check.close()
    assert.equal(cols.filter((c) => c === 'status_text').length, 1)
    assert.equal(cols.filter((c) => c === 'avatar_animated').length, 1)
  })
})
