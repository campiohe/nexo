// Tier 3 (messages): pins (`message:pin` / `message:pins`), full-text search (`message:search`, SQLite FTS5)
// and channel ordering (`channel:reorder`), plus the migration that indexes an existing database. Boots the
// server in-process like protocol.test.ts and drives it with real socket.io clients. Run with `npm test -w server`.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
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
  Message,
  SearchResult,
  ServerToClientEvents,
} from '../../shared/protocol.ts'
import { MAX_PINS_PER_CHANNEL, SEARCH_PAGE_SIZE, SEARCH_QUERY_MAX } from '../../shared/protocol.ts'
import {
  MESSAGE_ERRORS,
  PERMISSION_ERRORS,
  REORDER_ERRORS,
  SEARCH_ERRORS,
  start,
  type NexoInstance,
  type StartOptions,
} from '../src/server.ts'
import { openDb, searchWords, SEARCH_MAX_WORDS } from '../src/db.ts'

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

/** Collects every `event` on `socket` until the returned stop() is called. */
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

function nextEvent<E extends EventName>(socket: Client, event: E, match: (arg: EventArg<E>) => boolean = () => true) {
  const s = socket as unknown as { on(e: string, f: (a: unknown) => void): void; off(e: string, f: (a: unknown) => void): void }
  return new Promise<EventArg<E>>((resolve, reject) => {
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

/** A round trip on `socket`: everything the server emitted before has arrived. */
const roundTrip = (socket: Client) => request(socket, 'message:history', {})

const say = (c: Conn, channelId: string, content: string, extra: Record<string, unknown> = {}) =>
  requestOk<Message>(c.socket, 'message:send', { channelId, content, ...extra })
const pin = (c: Conn, messageId: string, pinned = true) => request<null>(c.socket, 'message:pin', { messageId, pinned })
const search = (c: Conn, p: Record<string, unknown>) => requestOk<SearchResult>(c.socket, 'message:search', p)
const searchIds = async (c: Conn, p: Record<string, unknown>) => (await search(c, p)).messages.map((m) => m.id)
const history = (c: Conn, channelId: string) => requestOk<Message[]>(c.socket, 'message:history', { channelId })

after(() => {
  for (const c of clients) c.close()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('pins', () => {
  let server: NexoInstance
  let owner: Conn
  let bob: Conn
  let carol: Conn
  let dave: Conn
  let general: Channel

  before(async () => {
    server = await boot()
    owner = await join(server.url, 'Owner')
    bob = await join(server.url, 'Bob')
    carol = await join(server.url, 'Carol')
    dave = await join(server.url, 'Dave')
    general = owner.boot.channels.find((c) => c.name === 'general')!
  })
  after(() => server.close())

  test('anyone pins: broadcast message:updated with pinned, ack null, shown in history', async () => {
    const msg = await say(bob, general.id, 'pin me')
    assert.equal(msg.pinned, null)
    const updated = nextEvent(dave.socket, 'message:updated', (m) => m.id === msg.id)
    const t0 = Date.now()
    const res = await pin(carol, msg.id)
    assert.deepEqual(res, { ok: true, data: null })
    const m = await updated
    assert.equal(m.pinned?.by, carol.id)
    assert.ok(m.pinned!.at >= t0 && m.pinned!.at <= Date.now() + 1000)
    assert.equal(m.content, 'pin me')
    const page = await history(owner, general.id)
    assert.deepEqual(page.find((x) => x.id === msg.id)?.pinned, m.pinned)
    assert.ok(page.filter((x) => x.id !== msg.id).every((x) => x.pinned === null))
  })

  test('idempotent: pinning a pinned / unpinning an unpinned message is a no-op without broadcast', async () => {
    const msg = await say(bob, general.id, 'twice')
    await pin(carol, msg.id)
    const seen = collect(owner.socket, 'message:updated')
    assert.deepEqual(await pin(dave, msg.id), { ok: true, data: null })
    const other = await say(bob, general.id, 'never pinned')
    assert.deepEqual(await pin(dave, other.id, false), { ok: true, data: null })
    await roundTrip(owner.socket)
    assert.deepEqual(seen.stop(), [])
    // The first pinner stays.
    assert.equal((await history(owner, general.id)).find((x) => x.id === msg.id)?.pinned?.by, carol.id)
  })

  test('unpin: the pinner, the author or an admin; nobody else', async () => {
    const msg = await say(bob, general.id, 'who unpins')
    await pin(carol, msg.id)
    assert.equal((await pin(dave, msg.id, false)).ok, false)
    assert.equal(await requestErr(dave.socket, 'message:pin', { messageId: msg.id, pinned: false }), MESSAGE_ERRORS.unpinOthers)
    assert.equal(MESSAGE_ERRORS.unpinOthers, 'Only the person who pinned it, its author or an admin can unpin it')

    // The pinner.
    const updated = nextEvent(dave.socket, 'message:updated', (m) => m.id === msg.id && m.pinned === null)
    assert.equal((await pin(carol, msg.id, false)).ok, true)
    await updated
    // The author.
    await pin(carol, msg.id)
    assert.equal((await pin(bob, msg.id, false)).ok, true)
    // An admin (here the owner).
    await pin(carol, msg.id)
    assert.equal((await pin(owner, msg.id, false)).ok, true)
    assert.equal((await history(owner, general.id)).find((x) => x.id === msg.id)?.pinned, null)
  })

  test('invalid requests', async () => {
    const msg = await say(bob, general.id, 'x')
    assert.equal(await requestErr(bob.socket, 'message:pin', { messageId: msg.id }), MESSAGE_ERRORS.invalidPin)
    assert.equal(await requestErr(bob.socket, 'message:pin', { messageId: msg.id, pinned: 'yes' }), MESSAGE_ERRORS.invalidPin)
    assert.equal(await requestErr(bob.socket, 'message:pin', { messageId: 'nope', pinned: true }), MESSAGE_ERRORS.notFound)
    assert.equal(await requestErr(bob.socket, 'message:pin', null), MESSAGE_ERRORS.notFound)
  })

  test('message:pins: most recently pinned first; channel checks', async () => {
    const ch = await requestOk<Channel>(owner.socket, 'channel:create', { name: 'pins-order', type: 'text' })
    const [a, b, c, d] = [await say(bob, ch.id, 'a'), await say(bob, ch.id, 'b'), await say(bob, ch.id, 'c'), await say(bob, ch.id, 'd')]
    await pin(carol, b.id)
    await pin(carol, c.id)
    await pin(carol, a.id)
    void d
    const pins = await requestOk<Message[]>(dave.socket, 'message:pins', { channelId: ch.id })
    assert.deepEqual(pins.map((m) => m.content), ['a', 'c', 'b'])
    assert.ok(pins[0].pinned!.at > pins[1].pinned!.at && pins[1].pinned!.at > pins[2].pinned!.at)
    // Full messages.
    assert.deepEqual(pins[0].attachments, [])
    assert.ok(Array.isArray(pins[0].reactions))
    // Unpinned ones leave the list; deleted ones too.
    await pin(carol, c.id, false)
    await requestOk(bob.socket, 'message:delete', { messageId: b.id })
    assert.deepEqual((await requestOk<Message[]>(dave.socket, 'message:pins', { channelId: ch.id })).map((m) => m.content), ['a'])

    const voice = owner.boot.channels.find((x) => x.type === 'voice')!
    assert.equal(await requestErr(dave.socket, 'message:pins', { channelId: voice.id }), 'Channel not found')
    assert.equal(await requestErr(dave.socket, 'message:pins', { channelId: 'nope' }), 'Channel not found')
    assert.equal(await requestErr(dave.socket, 'message:pins', {}), 'Channel not found')
  })

  test(`at most ${MAX_PINS_PER_CHANNEL} pins per channel`, async () => {
    const ch = await requestOk<Channel>(owner.socket, 'channel:create', { name: 'pins-cap', type: 'text' })
    const msgs: Message[] = []
    for (let i = 0; i <= MAX_PINS_PER_CHANNEL; i++) msgs.push(await say(bob, ch.id, `m${i}`))
    for (let i = 0; i < MAX_PINS_PER_CHANNEL; i++) assert.equal((await pin(dave, msgs[i].id)).ok, true)
    const last = msgs[MAX_PINS_PER_CHANNEL]
    assert.equal(await requestErr(dave.socket, 'message:pin', { messageId: last.id, pinned: true }), MESSAGE_ERRORS.tooManyPins)
    assert.equal(MESSAGE_ERRORS.tooManyPins, 'This channel has 50 pinned messages. Unpin one first')
    // Re-pinning a pinned one at the cap is still a no-op success; other channels are not affected.
    assert.equal((await pin(dave, msgs[0].id)).ok, true)
    assert.equal((await pin(dave, (await say(bob, general.id, 'elsewhere')).id)).ok, true)
    const pins = await requestOk<Message[]>(dave.socket, 'message:pins', { channelId: ch.id })
    assert.equal(pins.length, MAX_PINS_PER_CHANNEL)
    // Unpin one, and there's room again.
    await pin(dave, msgs[3].id, false)
    assert.equal((await pin(dave, last.id)).ok, true)
  })

  test("a removed pinner's pins stay, pinned by '' (the author or an admin can unpin them)", async () => {
    const eve = await join(server.url, 'Eve')
    const msg = await say(bob, general.id, 'pinned by eve')
    await pin(eve, msg.id)
    await requestOk(owner.socket, 'user:remove', { userId: eve.id })
    const after = (await history(bob, general.id)).find((x) => x.id === msg.id)!
    assert.equal(after.pinned?.by, '')
    assert.ok(after.pinned!.at > 0)
    assert.equal(await requestErr(dave.socket, 'message:pin', { messageId: msg.id, pinned: false }), MESSAGE_ERRORS.unpinOthers)
    assert.equal((await pin(bob, msg.id, false)).ok, true)
  })
})

// ---------------------------------------------------------------------------

describe('search', () => {
  let server: NexoInstance
  let owner: Conn
  let bob: Conn
  let carol: Conn
  let general: Channel
  let clips: Channel

  before(async () => {
    server = await boot()
    owner = await join(server.url, 'Owner')
    bob = await join(server.url, 'Bob')
    carol = await join(server.url, 'Carol')
    general = owner.boot.channels.find((c) => c.name === 'general')!
    clips = owner.boot.channels.find((c) => c.name === 'clips-and-memes')!
  })
  after(() => server.close())

  test('all words must match, each as a prefix; newest first', async () => {
    const m1 = await say(bob, general.id, 'hello there')
    const m2 = await say(bob, general.id, 'world peace')
    const m3 = await say(carol, general.id, 'hello big world')
    const m4 = await say(carol, clips.id, 'Hello, WORLD!')
    assert.deepEqual(await searchIds(owner, { query: 'hello world' }), [m4.id, m3.id])
    assert.deepEqual(await searchIds(owner, { query: 'hello' }), [m4.id, m3.id, m1.id])
    assert.deepEqual(await searchIds(owner, { query: 'wor' }), [m4.id, m3.id, m2.id])
    assert.deepEqual(await searchIds(owner, { query: 'hel wor' }), [m4.id, m3.id])
    // Prefix only at the start of a word.
    assert.deepEqual(await searchIds(owner, { query: 'orld' }), [])
    const res = await search(owner, { query: 'peace' })
    assert.equal(res.hasMore, false)
    assert.deepEqual(res.messages[0], m2)
  })

  test('case and accent insensitive (both ways)', async () => {
    const m1 = await say(bob, general.id, 'Às vezes o Café é ótimo')
    const m2 = await say(bob, general.id, 'naive cafe')
    // Decomposed (NFD) input finds and is found too.
    const m3 = await say(bob, general.id, 'Café NFD')
    assert.deepEqual(await searchIds(owner, { query: 'as vezes' }), [m1.id])
    assert.deepEqual(await searchIds(owner, { query: 'ÀS VEZES' }), [m1.id])
    assert.deepEqual(await searchIds(owner, { query: 'otimo' }), [m1.id])
    assert.deepEqual(await searchIds(owner, { query: 'café' }), [m3.id, m2.id, m1.id])
    assert.deepEqual(await searchIds(owner, { query: 'CAFE' }), [m3.id, m2.id, m1.id])
    assert.deepEqual(await searchIds(owner, { query: 'café nfd' }), [m3.id])
  })

  test('filters: channel, author, both', async () => {
    const a = await say(bob, general.id, 'filterword one')
    const b = await say(carol, general.id, 'filterword two')
    const c = await say(bob, clips.id, 'filterword three')
    assert.deepEqual(await searchIds(owner, { query: 'filterword', channelId: general.id }), [b.id, a.id])
    assert.deepEqual(await searchIds(owner, { query: 'filterword', authorId: bob.id }), [c.id, a.id])
    assert.deepEqual(await searchIds(owner, { query: 'filterword', authorId: bob.id, channelId: general.id }), [a.id])
    assert.deepEqual(await searchIds(owner, { query: 'filterword', authorId: 'nobody' }), [])
    const voice = owner.boot.channels.find((x) => x.type === 'voice')!
    assert.equal(await requestErr(owner.socket, 'message:search', { query: 'x', channelId: voice.id }), SEARCH_ERRORS.channelNotFound)
    assert.equal(await requestErr(owner.socket, 'message:search', { query: 'x', channelId: 'nope' }), 'Channel not found')
  })

  test(`pages of ${SEARCH_PAGE_SIZE} with before / hasMore`, async () => {
    const sent: Message[] = []
    for (let i = 0; i < SEARCH_PAGE_SIZE + 5; i++) sent.push(await say(bob, clips.id, `pagetest ${i}`))
    const newestFirst = sent.map((m) => m.id).reverse()
    const p1 = await search(owner, { query: 'pagetest' })
    assert.equal(p1.messages.length, SEARCH_PAGE_SIZE)
    assert.equal(p1.hasMore, true)
    assert.deepEqual(p1.messages.map((m) => m.id), newestFirst.slice(0, SEARCH_PAGE_SIZE))
    const p2 = await search(owner, { query: 'pagetest', before: p1.messages.at(-1)!.createdAt })
    assert.equal(p2.hasMore, false)
    assert.deepEqual(p2.messages.map((m) => m.id), newestFirst.slice(SEARCH_PAGE_SIZE))
    // Exactly a page: no more.
    const p3 = await search(owner, { query: 'pagetest', before: sent[SEARCH_PAGE_SIZE].createdAt })
    assert.equal(p3.messages.length, SEARCH_PAGE_SIZE)
    assert.equal(p3.hasMore, false)
    assert.equal(await requestErr(owner.socket, 'message:search', { query: 'x', before: 'soon' }), 'Invalid "before" timestamp')
  })

  test('empty query: only with authorId (that author, newest first)', async () => {
    const dana = await join(server.url, 'Dana')
    const x = await say(dana, general.id, 'first')
    const img = await say(dana, clips.id, '!!!')
    const y = await say(dana, general.id, 'second')
    assert.deepEqual(await searchIds(owner, { query: '', authorId: dana.id }), [y.id, img.id, x.id])
    assert.deepEqual(await searchIds(owner, { query: '  ', authorId: dana.id, channelId: general.id }), [y.id, x.id])
    // Only punctuation is no words: the same.
    assert.deepEqual(await searchIds(owner, { query: '"*', authorId: dana.id, before: y.createdAt }), [img.id, x.id])
    assert.equal(await requestErr(owner.socket, 'message:search', { query: '' }), SEARCH_ERRORS.noWords)
    assert.equal(await requestErr(owner.socket, 'message:search', { query: '  ' }), SEARCH_ERRORS.noWords)
    assert.equal(SEARCH_ERRORS.noWords, 'Type at least one word to search')
  })

  test(`query length: at most ${SEARCH_QUERY_MAX} characters; invalid payloads`, async () => {
    assert.equal((await search(owner, { query: 'a'.repeat(SEARCH_QUERY_MAX) })).messages.length, 0)
    assert.equal(await requestErr(owner.socket, 'message:search', { query: 'a'.repeat(SEARCH_QUERY_MAX + 1) }), SEARCH_ERRORS.tooLong)
    assert.equal(SEARCH_ERRORS.tooLong, 'Search is limited to 200 characters')
    assert.equal(await requestErr(owner.socket, 'message:search', {}), SEARCH_ERRORS.invalid)
    assert.equal(await requestErr(owner.socket, 'message:search', null), SEARCH_ERRORS.invalid)
    assert.equal(await requestErr(owner.socket, 'message:search', { query: 'x', authorId: 5 }), SEARCH_ERRORS.invalid)
  })

  test('FTS syntax in queries is just text (never a server error)', async () => {
    const m = await say(bob, general.id, 'NOT this col:x (or AND that) "quoted" star*')
    const hostile = ['"', '""', '*', 'AND OR NOT', 'col:x', ')', '(', 'NEAR(a b)', '^x', '-x', '+', 'a"b', "'; DROP TABLE messages; --", '{body}: x', '\u0000', 'body:*']
    for (const query of hostile) {
      const res = await request<SearchResult>(owner.socket, 'message:search', { query })
      if (!res.ok) assert.equal(res.error, SEARCH_ERRORS.noWords, `query ${JSON.stringify(query)}`)
    }
    // The words in them still match literally.
    assert.deepEqual(await searchIds(owner, { query: 'AND OR NOT' }), [m.id])
    assert.deepEqual(await searchIds(owner, { query: 'col:x' }), [m.id])
    assert.deepEqual(await searchIds(owner, { query: '"quoted"' }), [m.id])
    assert.deepEqual(await searchIds(owner, { query: 'star*)' }), [m.id])
    // Still works afterwards.
    assert.ok((await search(owner, { query: 'hello' })).messages.length > 0)
  })

  test('words beyond the cap are ignored', () => {
    const words = Array.from({ length: SEARCH_MAX_WORDS + 5 }, (_, i) => `w${i}`)
    assert.deepEqual(searchWords(words.join(' ')), words.slice(0, SEARCH_MAX_WORDS))
    assert.deepEqual(searchWords('col:x "y"* (z)'), ['col', 'x', 'y', 'z'])
    assert.deepEqual(searchWords('!!! ...'), [])
  })

  test('mention tokens are not indexed', async () => {
    const m = await say(carol, general.id, `<@${bob.id}> mentiontest`)
    const firstPart = bob.id.split('-')[0]
    assert.deepEqual(await searchIds(owner, { query: 'mentiontest' }), [m.id])
    assert.ok(!(await searchIds(owner, { query: firstPart })).includes(m.id))
  })

  test('results are full messages (reply, reactions, pinned)', async () => {
    const orig = await say(bob, general.id, 'fullmsg original')
    const reply = await say(carol, general.id, 'fullmsg reply', { replyToId: orig.id })
    await requestOk(bob.socket, 'message:react', { messageId: reply.id, emoji: '👍', on: true })
    await requestOk(bob.socket, 'message:pin', { messageId: reply.id, pinned: true })
    const [r] = (await search(owner, { query: 'fullmsg reply' })).messages
    assert.equal(r.replyTo?.id, orig.id)
    assert.equal(r.replyTo?.content, 'fullmsg original')
    assert.deepEqual(r.reactions, [{ emoji: '👍', userIds: [bob.id] }])
    assert.equal(r.pinned?.by, bob.id)
    assert.deepEqual(r.mentions, [bob.id])
  })

  test('the index follows edits, deletes, channel deletes and account removal', async () => {
    const m = await say(bob, general.id, 'syncalpha')
    await requestOk(bob.socket, 'message:edit', { messageId: m.id, content: 'syncbeta' })
    assert.deepEqual(await searchIds(owner, { query: 'syncalpha' }), [])
    assert.deepEqual(await searchIds(owner, { query: 'syncbeta' }), [m.id])
    await requestOk(bob.socket, 'message:delete', { messageId: m.id })
    assert.deepEqual(await searchIds(owner, { query: 'syncbeta' }), [])

    const ch = await requestOk<Channel>(owner.socket, 'channel:create', { name: 'doomed', type: 'text' })
    await say(bob, ch.id, 'syncgamma')
    assert.equal((await searchIds(owner, { query: 'syncgamma' })).length, 1)
    await requestOk(owner.socket, 'channel:delete', { channelId: ch.id })
    assert.deepEqual(await searchIds(owner, { query: 'syncgamma' }), [])

    const gone = await join(server.url, 'Gone')
    await say(gone, general.id, 'syncdelta')
    assert.equal((await searchIds(owner, { query: 'syncdelta' })).length, 1)
    await requestOk(owner.socket, 'user:remove', { userId: gone.id })
    assert.deepEqual(await searchIds(owner, { query: 'syncdelta' }), [])

    // No index entries left behind.
    const raw = new DatabaseSync(path.join(server.config.dataDir, 'nexo.db'), { readOnly: true })
    try {
      const n = (sql: string) => (raw.prepare(sql).get() as { n: number }).n
      assert.equal(n('SELECT COUNT(*) AS n FROM message_search_ids'), n('SELECT COUNT(*) AS n FROM messages'))
      assert.equal(
        n('SELECT COUNT(*) AS n FROM message_search_ids s WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = s.message_id)'),
        0,
      )
    } finally {
      raw.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('search performance', () => {
  test('a search over 20k messages stays well under 50 ms', (t) => {
    const db = openDb(tempDir())
    try {
      const authors = Array.from({ length: 8 }, (_, i) => db.users.create(`Perf${i}`, '#123456', `perf-hash-${i}`))
      const chans = db.channels.all().filter((c) => c.type === 'text')
      const vocab = 'the a and to of game play stream voice chat hello world café às vezes muito bom ranked match tonight gg nice clip patch bug fix'.split(' ')
      let seed = 42
      const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
      for (let i = 0; i < 20_000; i++) {
        const words = Array.from({ length: 5 + (i % 15) }, () => vocab[Math.floor(random() * vocab.length)])
        db.messages.create(chans[i % chans.length].id, authors[i % authors.length].id, words.join(' '))
      }
      const cases: [string, Parameters<typeof db.messages.search>][] = [
        ['common word', [searchWords('the')]],
        ['one-letter prefix', [searchWords('g')]],
        ['two words', [searchWords('game ranked')]],
        ['accent folded', [searchWords('as vezes')]],
        ['common word in a channel', [searchWords('the'), { channelId: chans[0].id }]],
        ['common word by an author', [searchWords('the'), { authorId: authors[3].id }]],
        ['author only', [[], { authorId: authors[3].id }]],
      ]
      for (const [label, args] of cases) {
        db.messages.search(...args)
        const runs = 10
        const t0 = performance.now()
        for (let i = 0; i < runs; i++) assert.equal(db.messages.search(...args).messages.length, SEARCH_PAGE_SIZE, label)
        const ms = (performance.now() - t0) / runs
        t.diagnostic(`${label}: ${ms.toFixed(2)} ms`)
        assert.ok(ms < 50, `${label}: ${ms.toFixed(1)} ms`)
      }
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('migration: an existing database gets pins and its messages indexed', () => {
  test('old messages are found; reopening adds nothing twice; later raw inserts are indexed on the next open', () => {
    const dir = tempDir()
    const old = new DatabaseSync(path.join(dir, 'nexo.db'))
    // The v0.7 schema of the tables involved (no pinned_* columns, no search tables).
    old.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, avatar TEXT NULL,
        role TEXT NOT NULL DEFAULT 'member', status_text TEXT NULL, avatar_animated INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE channels (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('text', 'voice')),
        position INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL, created_at INTEGER NOT NULL,
        edited_at INTEGER NULL, reply_to_id TEXT NULL, reply_to_user_id TEXT NULL,
        mentions_everyone INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX messages_by_channel ON messages (channel_id, created_at);
    `)
    old.prepare("INSERT INTO users (id, name, color, token_hash, created_at, role) VALUES (?, ?, ?, ?, ?, 'owner')").run('u1', 'Old', '#111111', 'h1', 1000)
    old.prepare('INSERT INTO channels VALUES (?, ?, ?, ?, ?)').run('c1', 'general', 'text', 0, 1000)
    old.prepare('INSERT INTO channels VALUES (?, ?, ?, ?, ?)').run('c2', 'Lounge', 'voice', 0, 1000)
    const insert = old.prepare('INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
    insert.run('m1', 'c1', 'u1', 'Às vezes, from the old days', 1500)
    insert.run('m2', 'c1', 'u1', 'old days again <@u1>', 1600)
    for (let i = 0; i < 500; i++) insert.run(`bulk${i}`, 'c1', 'u1', `bulk message ${i}`, 2000 + i)
    old.close()

    const db = openDb(dir)
    try {
      assert.deepEqual(db.messages.search(searchWords('as vezes')).messages.map((m) => m.id), ['m1'])
      assert.deepEqual(db.messages.search(searchWords('old days')).messages.map((m) => m.id), ['m2', 'm1'])
      assert.deepEqual(db.messages.search(searchWords('u1')).messages, [])
      const bulk = db.messages.search(searchWords('bulk'))
      assert.equal(bulk.messages[0].id, 'bulk499')
      assert.equal(bulk.hasMore, true)
      assert.equal(db.messages.history('c1').at(-1)?.pinned, null)
      // Pins work on the upgraded database.
      const pinned = db.messages.pin('m1', 'u1', true)
      assert.ok(pinned && pinned !== 'tooMany' && pinned.changed && pinned.message.pinned?.by === 'u1')
      assert.deepEqual(db.messages.pins('c1').map((m) => m.id), ['m1'])
    } finally {
      db.close()
    }

    // Simulate an older server after a downgrade: a message it wrote is not indexed yet.
    const raw = new DatabaseSync(path.join(dir, 'nexo.db'))
    raw.prepare('INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)').run('m3', 'c1', 'u1', 'written by an older server', 9000)
    raw.close()

    const again = openDb(dir)
    try {
      assert.deepEqual(again.messages.search(searchWords('older server')).messages.map((m) => m.id), ['m3'])
      assert.deepEqual(again.messages.search(searchWords('old days')).messages.map((m) => m.id), ['m2', 'm1'])
      assert.deepEqual(again.messages.pins('c1').map((m) => m.id), ['m1'])
    } finally {
      again.close()
    }
    const check = new DatabaseSync(path.join(dir, 'nexo.db'), { readOnly: true })
    try {
      const n = (sql: string) => (check.prepare(sql).get() as { n: number }).n
      assert.equal(n('SELECT COUNT(*) AS n FROM message_search_ids'), 503)
      assert.equal(n('SELECT COUNT(*) AS n FROM messages'), 503)
      const cols = (check.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name)
      assert.ok(cols.includes('pinned_by') && cols.includes('pinned_at'))
    } finally {
      check.close()
    }
  })

  test('the search index survives VACUUM (stable ids)', () => {
    const dir = tempDir()
    const db = openDb(dir)
    const u = db.users.create('Vac', '#123456', 'vac-hash')
    const ch = db.channels.all().find((c) => c.type === 'text')!
    const keep: string[] = []
    for (let i = 0; i < 200; i++) {
      const m = db.messages.create(ch.id, u.id, `vacuum ${i % 2 ? 'odd' : 'even'} ${i}`)
      if (i % 2) keep.push(m.id)
      else db.messages.delete(m.id)
    }
    db.close()
    const raw = new DatabaseSync(path.join(dir, 'nexo.db'))
    raw.exec('VACUUM')
    raw.close()
    const again = openDb(dir)
    try {
      const found = again.messages.search(searchWords('vacuum odd'))
      assert.deepEqual(found.messages.map((m) => m.id), keep.slice(-SEARCH_PAGE_SIZE).reverse())
      assert.deepEqual(again.messages.search(searchWords('even')).messages, [])
    } finally {
      again.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('channel:reorder', () => {
  let server: NexoInstance
  let owner: Conn
  let admin: Conn
  let member: Conn

  before(async () => {
    server = await boot()
    owner = await join(server.url, 'Owner')
    admin = await join(server.url, 'Admin')
    member = await join(server.url, 'Member')
    await requestOk(owner.socket, 'user:setRole', { userId: admin.id, role: 'admin' })
    await requestOk(owner.socket, 'channel:create', { name: 'third', type: 'text' })
  })
  after(() => server.close())

  const ofType = (list: Channel[], type: 'text' | 'voice') =>
    list.filter((c) => c.type === type).sort((a, b) => a.position - b.position)
  const current = async (type: 'text' | 'voice') => ofType((await join(server.url, `Peek${Math.random().toString(36).slice(2, 8)}`)).boot.channels, type)

  test('members may not', async () => {
    const ids = (await current('text')).map((c) => c.id)
    assert.equal(await requestErr(member.socket, 'channel:reorder', { type: 'text', ids: ids.reverse() }), PERMISSION_ERRORS.manageChannels)
  })

  test('ids must be exactly the channels of that type', async () => {
    const text = (await current('text')).map((c) => c.id)
    const voice = (await current('voice')).map((c) => c.id)
    const bad: unknown[] = [
      { type: 'text', ids: text.slice(1) },
      { type: 'text', ids: [...text, 'nope'] },
      { type: 'text', ids: [text[0], text[0], text[1]] },
      { type: 'text', ids: [...text.slice(1), voice[0]] },
      { type: 'voice', ids: text },
      { type: 'text', ids: 'all' },
      { type: 'text', ids: [1, 2, 3] },
      { type: 'text' },
    ]
    for (const p of bad) assert.equal(await requestErr(admin.socket, 'channel:reorder', p), REORDER_ERRORS.changed, JSON.stringify(p))
    assert.equal(REORDER_ERRORS.changed, 'The channel list changed, try again')
    assert.equal(await requestErr(admin.socket, 'channel:reorder', { type: 'stage', ids: [] }), REORDER_ERRORS.invalidType)
    assert.deepEqual((await current('text')).map((c) => c.id), text)
  })

  test('positions 0..n-1; channel:upsert only for channels that moved; persisted', async () => {
    const [a, b, c] = await current('text')
    const seen = collect(member.socket, 'channel:upsert')
    // a b c -> c a b: move c to the top (all three positions change).
    assert.deepEqual(await requestOk(admin.socket, 'channel:reorder', { type: 'text', ids: [c.id, a.id, b.id] }), null)
    await roundTrip(member.socket)
    assert.deepEqual(
      seen.stop().sort((x, y) => x.position - y.position),
      [
        { ...c, position: 0 },
        { ...a, position: 1 },
        { ...b, position: 2 },
      ],
    )
    assert.deepEqual((await current('text')).map((x) => x.id), [c.id, a.id, b.id])

    // Swap the last two: only they are broadcast.
    const seen2 = collect(member.socket, 'channel:upsert')
    await requestOk(owner.socket, 'channel:reorder', { type: 'text', ids: [c.id, b.id, a.id] })
    await roundTrip(member.socket)
    assert.deepEqual(seen2.stop().map((x) => [x.id, x.position]).sort(), [[a.id, 2], [b.id, 1]].sort())

    // Same order again: nothing.
    const seen3 = collect(member.socket, 'channel:upsert')
    await requestOk(admin.socket, 'channel:reorder', { type: 'text', ids: [c.id, b.id, a.id] })
    await roundTrip(member.socket)
    assert.deepEqual(seen3.stop(), [])

    // Voice is separate.
    const voice = await current('voice')
    await requestOk(admin.socket, 'channel:reorder', { type: 'voice', ids: voice.map((x) => x.id).reverse() })
    assert.deepEqual((await current('voice')).map((x) => x.id), voice.map((x) => x.id).reverse())
    assert.deepEqual((await current('text')).map((x) => x.id), [c.id, b.id, a.id])
    // New channels go last.
    const d = await requestOk<Channel>(owner.socket, 'channel:create', { name: 'fourth', type: 'text' })
    assert.equal(d.position, 3)
  })
})
