// Chat v1: replies, mentions, edits and reactions (docs/SPEC.md §8 and "Mentions"). Boots the server
// in-process like protocol.test.ts and drives it with real socket.io clients. Run with `npm test -w server`.
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
  ServerToClientEvents,
} from '../../shared/protocol.ts'
import { MAX_MESSAGE_LENGTH, MAX_REACTIONS_PER_MESSAGE, REPLY_PREVIEW_LENGTH } from '../../shared/protocol.ts'
import { MESSAGE_ERRORS, start, type NexoInstance, type StartOptions } from '../src/server.ts'
import { openDb } from '../src/db.ts'

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>
type EventName = keyof ServerToClientEvents
type EventArg<E extends EventName> = Parameters<ServerToClientEvents[E]>[0]

const TIMEOUT = 3000
const tmpDirs: string[] = []
const clients: Client[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-messages-v1-'))
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
      resolve({ socket, boot: b, id: b.me.id, token: b.token ?? (auth.token as string) })
    })
    socket.once('connect_error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

const join = (url: string, name: string) => connect(url, { name })

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

/** A minimal PNG header (the server only reads the IHDR). */
function png(): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(4, 16)
  b.writeUInt32BE(3, 20)
  return b
}

async function upload(url: string, token: string): Promise<string> {
  const res = await fetch(`${url}/api/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
    body: new Uint8Array(png()),
  })
  assert.equal(res.status, 201)
  return ((await res.json()) as { attachment: { id: string } }).attachment.id
}

const send = (c: Conn, channelId: string, content: string, extra: Record<string, unknown> = {}) =>
  requestOk<Message>(c.socket, 'message:send', { channelId, content, ...extra })

const history = (c: Conn, channelId: string) => requestOk<Message[]>(c.socket, 'message:history', { channelId })

const react = (c: Conn, messageId: string, emoji: string, on = true) =>
  requestOk<null>(c.socket, 'message:react', { messageId, emoji, on })

after(() => {
  for (const c of clients) c.close()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('messages v1', () => {
  let server: NexoInstance
  let url: string
  let alice: Conn
  let bob: Conn
  let carol: Conn
  let general: Channel
  let other: Channel

  /** A fresh text channel (alice is the owner), so per-channel state doesn't leak between tests. */
  const newChannel = (name: string) => requestOk<Channel>(alice.socket, 'channel:create', { name, type: 'text' })

  before(async () => {
    server = await boot({ reactionLimit: { count: 1000, windowMs: 5000 } })
    url = server.url
    alice = await join(url, 'Alice')
    bob = await join(url, 'Bob')
    carol = await join(url, 'Carol')
    general = alice.boot.channels.find((c) => c.name === 'general')!
    other = alice.boot.channels.find((c) => c.name === 'clips-and-memes')!
  })
  after(() => server.close())

  // ----- plain messages -----

  test('a plain message has every new field with its empty value', async () => {
    const msg = await send(alice, general.id, 'plain')
    assert.equal(msg.editedAt, null)
    assert.equal(msg.replyTo, null)
    assert.deepEqual(msg.reactions, [])
    assert.deepEqual(msg.mentions, [])
    assert.equal(msg.mentionsEveryone, false)
    assert.deepEqual(msg.attachments, [])
  })

  // ----- replies -----

  test('reply: preview in the ack, the broadcast and history; pings the original author', async () => {
    const original = await send(bob, general.id, 'x'.repeat(REPLY_PREVIEW_LENGTH + 50))
    const forBob = nextEvent(bob.socket, 'message:new', (m) => m.content === 'agreed')
    const reply = await send(alice, general.id, 'agreed', { replyToId: original.id })
    assert.deepEqual(reply.replyTo, {
      id: original.id,
      userId: bob.id,
      content: 'x'.repeat(REPLY_PREVIEW_LENGTH),
      hasAttachments: false,
      deleted: false,
    })
    assert.deepEqual(reply.mentions, [bob.id])
    assert.deepEqual(await forBob, reply)
    const page = await history(carol, general.id)
    assert.deepEqual(page.find((m) => m.id === reply.id), reply)
  })

  test('reply: the preview never splits a surrogate pair; images are flagged', async () => {
    const attId = await upload(url, bob.token)
    const original = await send(bob, general.id, 'a' + '😀'.repeat(REPLY_PREVIEW_LENGTH), { attachmentIds: [attId] })
    const reply = await send(alice, general.id, 'nice', { replyToId: original.id })
    assert.equal(reply.replyTo?.hasAttachments, true)
    assert.equal(reply.replyTo?.content, 'a' + '😀'.repeat((REPLY_PREVIEW_LENGTH - 2) / 2))
  })

  test('reply: unknown, other channel or malformed ids fail', async () => {
    const elsewhere = await send(bob, other.id, 'over here')
    for (const replyToId of ['nope', elsewhere.id, 42, {}]) {
      assert.equal(
        await requestErr(alice.socket, 'message:send', { channelId: general.id, content: 'hm', replyToId }),
        MESSAGE_ERRORS.replyNotFound,
      )
    }
    // null / absent = not a reply.
    const msg = await send(alice, general.id, 'not a reply', { replyToId: null })
    assert.equal(msg.replyTo, null)
  })

  test('reply: replying to yourself pings nobody', async () => {
    const mine = await send(alice, general.id, 'first')
    const reply = await send(alice, general.id, 'and second', { replyToId: mine.id })
    assert.deepEqual(reply.mentions, [])
    assert.equal(reply.replyTo?.userId, alice.id)
  })

  test('reply: after the original is deleted the preview stays, marked deleted', async () => {
    const original = await send(bob, general.id, 'soon gone')
    const reply = await send(alice, general.id, 'replying', { replyToId: original.id })
    const deleted = nextEvent(alice.socket, 'message:deleted', (p) => p.messageId === original.id)
    await requestOk<null>(bob.socket, 'message:delete', { messageId: original.id })
    assert.deepEqual(await deleted, { messageId: original.id, channelId: general.id })
    const page = await history(alice, general.id)
    const after = page.find((m) => m.id === reply.id)!
    assert.deepEqual(after.replyTo, { id: original.id, userId: bob.id, content: '', hasAttachments: false, deleted: true })
    assert.deepEqual(after.mentions, [bob.id], 'the ping stays')
  })

  // ----- mentions -----

  test('mentions: unknown ids and the author dropped, deduplicated, in order; @everyone flag', async () => {
    const content = `hey <@${carol.id}> <@nope> <@${alice.id}> <@${bob.id}> <@${carol.id}> <@bad id>`
    const msg = await send(alice, general.id, content)
    assert.equal(msg.content, content, 'content is stored as sent')
    assert.deepEqual(msg.mentions, [carol.id, bob.id])
    assert.equal(msg.mentionsEveryone, false)

    const all = await send(bob, general.id, 'listen up @everyone')
    assert.deepEqual(all.mentions, [])
    assert.equal(all.mentionsEveryone, true)
  })

  test('bootstrap lastMentionAt: newest mention of me (or @everyone) by someone else, per channel', async () => {
    const a = await newChannel('mentions-a')
    const b = await newChannel('mentions-b')
    const c = await newChannel('mentions-c')
    await send(bob, a.id, `<@${carol.id}> first`)
    const newestA = await send(alice, a.id, `<@${carol.id}> second`)
    await send(alice, a.id, 'no mention after that')
    await send(carol, a.id, `<@${carol.id}> me myself @everyone`)
    const everyoneB = await send(bob, b.id, '@everyone hello')
    const reply = await send(bob, c.id, 'to carol', { replyToId: (await send(carol, c.id, 'question')).id })

    const again = await connect(url, { token: carol.token })
    assert.equal(again.boot.lastMentionAt?.[a.id], newestA.createdAt)
    assert.equal(again.boot.lastMentionAt?.[b.id], everyoneB.createdAt)
    assert.equal(again.boot.lastMentionAt?.[c.id], reply.createdAt, 'a reply counts as a mention')
    again.socket.close()

    // For bob, his own @everyone doesn't count, but carol's does.
    const bobAgain = await connect(url, { token: bob.token })
    assert.equal(bobAgain.boot.lastMentionAt?.[b.id], undefined)
    const carolsEveryone = (await history(bob, a.id)).find((m) => m.mentionsEveryone)!
    assert.equal(bobAgain.boot.lastMentionAt?.[a.id], carolsEveryone.createdAt)
    bobAgain.socket.close()
  })

  // ----- edits -----

  test('edit: author only; sets editedAt, recomputes mentions, broadcasts message:updated', async () => {
    const reply = await send(alice, general.id, `hi <@${carol.id}>`, { replyToId: (await send(bob, general.id, 'q')).id })
    assert.deepEqual(reply.mentions, [carol.id, bob.id])

    assert.equal(
      await requestErr(bob.socket, 'message:edit', { messageId: reply.id, content: 'hijack' }),
      MESSAGE_ERRORS.editOthers,
    )

    const forCarol = nextEvent(carol.socket, 'message:updated', (m) => m.id === reply.id)
    const before = Date.now()
    const edited = await requestOk<Message>(alice.socket, 'message:edit', { messageId: reply.id, content: '  now @everyone  ' })
    assert.equal(edited.content, 'now @everyone')
    assert.ok(typeof edited.editedAt === 'number' && edited.editedAt >= before)
    assert.equal(edited.createdAt, reply.createdAt)
    assert.deepEqual(edited.replyTo, reply.replyTo, 'replyTo does not change')
    assert.deepEqual(edited.mentions, [bob.id], 'carol is no longer named; the reply still pings bob')
    assert.equal(edited.mentionsEveryone, true)
    assert.deepEqual(await forCarol, edited)
    assert.deepEqual((await history(carol, general.id)).find((m) => m.id === reply.id), edited)
  })

  test('edit: validation, and unchanged content is a silent no-op', async () => {
    const msg = await send(alice, general.id, 'text only')
    assert.equal(await requestErr(alice.socket, 'message:edit', { messageId: msg.id, content: '   ' }), MESSAGE_ERRORS.empty)
    assert.equal(
      await requestErr(alice.socket, 'message:edit', { messageId: msg.id, content: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }),
      MESSAGE_ERRORS.tooLong,
    )
    assert.equal(await requestErr(alice.socket, 'message:edit', { messageId: msg.id }), MESSAGE_ERRORS.invalidContent)
    assert.equal(await requestErr(alice.socket, 'message:edit', { messageId: 'nope', content: 'x' }), MESSAGE_ERRORS.notFound)
    assert.equal(await requestErr(alice.socket, 'message:edit', null), MESSAGE_ERRORS.notFound)

    const quiet = noEvent(bob.socket, 'message:updated')
    const same = await requestOk<Message>(alice.socket, 'message:edit', { messageId: msg.id, content: ' text only ' })
    assert.deepEqual(same, msg)
    assert.equal(same.editedAt, null)
    await quiet

    // With an image, the text may be removed.
    const attId = await upload(url, alice.token)
    const withImage = await send(alice, general.id, 'caption', { attachmentIds: [attId] })
    const noCaption = await requestOk<Message>(alice.socket, 'message:edit', { messageId: withImage.id, content: '' })
    assert.equal(noCaption.content, '')
    assert.equal(noCaption.attachments.length, 1)
  })

  // ----- reactions -----

  test('react: add/remove broadcast the full list in order; idempotent; history has them', async () => {
    const msg = await send(alice, general.id, 'react to me')
    const first = nextEvent(carol.socket, 'message:reactions', (p) => p.messageId === msg.id)
    await react(bob, msg.id, '👍')
    assert.deepEqual(await first, { messageId: msg.id, channelId: general.id, reactions: [{ emoji: '👍', userIds: [bob.id] }] })

    await react(alice, msg.id, '🎉')
    const third = nextEvent(carol.socket, 'message:reactions', (p) => p.reactions[0]?.userIds.length === 2)
    await react(alice, msg.id, '👍')
    assert.deepEqual((await third).reactions, [
      { emoji: '👍', userIds: [bob.id, alice.id] },
      { emoji: '🎉', userIds: [alice.id] },
    ])

    // Nothing changes: ok, but no broadcast.
    const quiet = noEvent(carol.socket, 'message:reactions')
    await react(bob, msg.id, '👍')
    await react(carol, msg.id, '🎉', false)
    await quiet

    const removed = nextEvent(carol.socket, 'message:reactions', (p) => p.messageId === msg.id)
    await react(bob, msg.id, '👍', false)
    assert.deepEqual(
      (await removed).reactions,
      [
        { emoji: '👍', userIds: [alice.id] },
        { emoji: '🎉', userIds: [alice.id] },
      ],
      'an emoji keeps its place while anyone still has it',
    )
    const gone = nextEvent(carol.socket, 'message:reactions', (p) => p.messageId === msg.id)
    await react(alice, msg.id, '👍', false)
    assert.deepEqual((await gone).reactions, [{ emoji: '🎉', userIds: [alice.id] }], 'an emoji with no users disappears')

    // Re-adding puts the emoji after the ones already there.
    await react(bob, msg.id, '👍')
    const page = await history(carol, general.id)
    assert.deepEqual(page.find((m) => m.id === msg.id)?.reactions, [
      { emoji: '🎉', userIds: [alice.id] },
      { emoji: '👍', userIds: [bob.id] },
    ])
  })

  test('react: emoji validation and malformed payloads', async () => {
    const msg = await send(alice, general.id, 'emoji test')
    for (const emoji of ['👍🏽', '🇧🇷', '❤️', '1️⃣', '👨‍👩‍👧', '🏳️‍🌈', '😂']) await react(bob, msg.id, emoji)
    for (const emoji of ['a', '😂😂', '<b>', '', ' 😂', '😂 ', '1', '#', 42, null, '👨‍'.repeat(20) + '👨']) {
      assert.equal(
        await requestErr(bob.socket, 'message:react', { messageId: msg.id, emoji, on: true }),
        MESSAGE_ERRORS.invalidEmoji,
        `emoji ${JSON.stringify(emoji)}`,
      )
    }
    assert.equal(
      await requestErr(bob.socket, 'message:react', { messageId: msg.id, emoji: '😂', on: 'yes' }),
      MESSAGE_ERRORS.invalidReaction,
    )
    assert.equal(await requestErr(bob.socket, 'message:react', { messageId: 'nope', emoji: '😂', on: true }), MESSAGE_ERRORS.notFound)
    assert.equal(await requestErr(bob.socket, 'message:react', 'garbage'), MESSAGE_ERRORS.notFound)
  })

  test(`react: at most ${MAX_REACTIONS_PER_MESSAGE} different emoji per message`, async () => {
    const msg = await send(alice, general.id, 'so many')
    const emoji = [...'😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙😚🙂🤗🤩🤔']
    assert.ok(emoji.length > MAX_REACTIONS_PER_MESSAGE)
    for (const e of emoji.slice(0, MAX_REACTIONS_PER_MESSAGE)) await react(alice, msg.id, e)
    assert.equal(
      await requestErr(bob.socket, 'message:react', { messageId: msg.id, emoji: emoji[MAX_REACTIONS_PER_MESSAGE], on: true }),
      MESSAGE_ERRORS.tooManyReactions,
    )
    // Joining an existing emoji is fine.
    await react(bob, msg.id, emoji[0])
    // After one is removed entirely, a new one fits.
    await react(alice, msg.id, emoji[1], false)
    await react(bob, msg.id, emoji[MAX_REACTIONS_PER_MESSAGE])
    const page = await history(alice, general.id)
    assert.equal(page.find((m) => m.id === msg.id)?.reactions?.length, MAX_REACTIONS_PER_MESSAGE)
  })

  // ----- account removal and channel deletion -----

  test('removing an account drops its reactions (broadcast), mentions and reply authorship', async () => {
    const dave = await join(url, 'Dave')
    const msg = await send(alice, general.id, `for <@${dave.id}> and <@${bob.id}>`)
    await react(dave, msg.id, '👍')
    await react(bob, msg.id, '👍')
    await react(dave, msg.id, '🔥')
    const davesMsg = await send(dave, general.id, 'reply to me')
    const reply = await send(bob, general.id, 'ok dave', { replyToId: davesMsg.id })
    assert.deepEqual(reply.mentions, [dave.id])

    const update = nextEvent(carol.socket, 'message:reactions', (p) => p.messageId === msg.id)
    await requestOk<null>(alice.socket, 'user:remove', { userId: dave.id })
    assert.deepEqual(await update, { messageId: msg.id, channelId: general.id, reactions: [{ emoji: '👍', userIds: [bob.id] }] })

    const page = await history(carol, general.id)
    const after = page.find((m) => m.id === msg.id)!
    assert.deepEqual(after.reactions, [{ emoji: '👍', userIds: [bob.id] }])
    assert.deepEqual(after.mentions, [bob.id])
    assert.ok(!page.some((m) => m.id === davesMsg.id))
    const orphan = page.find((m) => m.id === reply.id)!
    assert.deepEqual(orphan.replyTo, { id: davesMsg.id, userId: '', content: '', hasAttachments: false, deleted: true })
    assert.deepEqual(orphan.mentions, [])
  })

  test('deleting a channel deletes the reactions and mentions of its messages', async () => {
    const doomed = await newChannel('doomed')
    const msg = await send(alice, doomed.id, `<@${bob.id}>`)
    await react(bob, msg.id, '👋')
    await requestOk<null>(alice.socket, 'channel:delete', { channelId: doomed.id })
    const db = new DatabaseSync(path.join(server.config.dataDir, 'nexo.db'), { readOnly: true })
    try {
      const count = (table: string) =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE message_id = ?`).get(msg.id) as { n: number }).n
      assert.equal(count('reactions'), 0)
      assert.equal(count('message_mentions'), 0)
    } finally {
      db.close()
    }
  })
})

describe('reaction rate limit', () => {
  test('too many reaction changes in the window: Slow down', async () => {
    const server = await boot({ reactionLimit: { count: 3, windowMs: 60_000 } })
    try {
      const a = await join(server.url, 'Ann')
      const b = await join(server.url, 'Ben')
      const general = a.boot.channels.find((c) => c.name === 'general')!
      const msg = await send(a, general.id, 'spam me')
      await react(a, msg.id, '👍')
      await react(a, msg.id, '👍', false)
      await react(a, msg.id, '👍')
      assert.equal(await requestErr(a.socket, 'message:react', { messageId: msg.id, emoji: '🎉', on: true }), MESSAGE_ERRORS.slowDown)
      // Per user: others are not affected.
      await react(b, msg.id, '🎉')
    } finally {
      await server.close()
    }
  })
})

describe('migration of a pre-v0.6 database', () => {
  test('messages gain the new columns in place; old messages read fine; reopening is a no-op', () => {
    const dir = tempDir()
    const old = new DatabaseSync(path.join(dir, 'nexo.db'))
    // The v0.4/v0.5 schema of the tables involved.
    old.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
      CREATE TABLE channels (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('text', 'voice')),
        position INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX messages_by_channel ON messages (channel_id, created_at);
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY, message_id TEXT NULL REFERENCES messages(id) ON DELETE CASCADE,
        uploader_id TEXT NOT NULL REFERENCES users(id), type TEXT NOT NULL, width INTEGER NOT NULL,
        height INTEGER NOT NULL, size INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
    `)
    old.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run('u1', 'Old', '#111111', 'h1', 1000)
    old.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run('u2', 'Older', '#222222', 'h2', 900)
    old.prepare('INSERT INTO channels VALUES (?, ?, ?, ?, ?)').run('c1', 'general', 'text', 0, 1000)
    old.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run('m1', 'c1', 'u1', 'from the old days', 1500)
    old.close()

    const db = openDb(dir)
    try {
      const [m1] = db.messages.history('c1')
      assert.deepEqual(m1, {
        id: 'm1',
        channelId: 'c1',
        userId: 'u1',
        content: 'from the old days',
        createdAt: 1500,
        attachments: [],
        editedAt: null,
        replyTo: null,
        reactions: [],
        mentions: [],
        mentionsEveryone: false,
      })
      // New features work on the upgraded database.
      const reply = db.messages.create('c1', 'u2', 'hi @everyone', [], {
        replyTo: { id: 'm1', userId: 'u1' },
        mentions: ['u1'],
        mentionsEveryone: true,
      })
      assert.equal(reply.replyTo?.content, 'from the old days')
      assert.deepEqual(db.messages.react('m1', 'u2', '👍', true), { changed: true, reactions: [{ emoji: '👍', userIds: ['u2'] }] })
      assert.deepEqual(db.messages.lastMentionAt('u1'), { c1: reply.createdAt })
      assert.ok(db.messages.edit('m1', 'edited', [], false)?.editedAt)
    } finally {
      db.close()
    }

    const cols = (table: string) => {
      const raw = new DatabaseSync(path.join(dir, 'nexo.db'), { readOnly: true })
      try {
        return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
      } finally {
        raw.close()
      }
    }
    for (const c of ['edited_at', 'reply_to_id', 'reply_to_user_id', 'mentions_everyone']) assert.ok(cols('messages').includes(c), c)

    const again = openDb(dir)
    try {
      const page = again.messages.history('c1')
      assert.equal(page.length, 2)
      assert.equal(page[0].content, 'edited')
      assert.deepEqual(page[0].reactions, [{ emoji: '👍', userIds: ['u2'] }])
      assert.deepEqual(page[1].mentions, ['u1'])
    } finally {
      again.close()
    }
  })
})
