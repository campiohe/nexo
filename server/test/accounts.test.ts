// Accounts and roles (docs/SPEC-ACCOUNTS.md §2–§5): permissions per role, role changes and account removal,
// "welcome back" device links and claims, sign-in requests over HTTP, and the migration of an old database.
// Boots the server in-process like protocol.test.ts. Run with `npm test -w server`.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client'
import type {
  AccessRequest,
  AckResult,
  Bootstrap,
  Channel,
  ClientToServerEvents,
  HandshakeAuth,
  Message,
  ServerInfo,
  ServerToClientEvents,
  User,
  VoiceState,
} from '../../shared/protocol.ts'
import { start, type NexoInstance, type StartOptions } from '../src/server.ts'
import { isTailscaleAddress, unwrapAddress } from '../src/address.ts'
import { openDb } from '../src/db.ts'

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>
type EventName = keyof ServerToClientEvents
type EventArg<E extends EventName> = Parameters<ServerToClientEvents[E]>[0]

const TIMEOUT = 3000
const tmpDirs: string[] = []
const clients: Client[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-accounts-'))
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

function makeClient(url: string, auth: HandshakeAuth | Record<string, unknown>): Client {
  const socket: Client = connectClient(url, { auth, transports: ['websocket'], forceNew: true, reconnection: false })
  clients.push(socket)
  return socket
}

interface Conn {
  socket: Client
  boot: Bootstrap
  id: string
  token: string
}

/** Connects and resolves with the socket, its bootstrap, its user id and its token (new, or the one used). */
function connect(url: string, auth: HandshakeAuth | Record<string, unknown>): Promise<Conn> {
  const socket = makeClient(url, auth)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bootstrap timeout')), TIMEOUT)
    socket.once('bootstrap', (b) => {
      clearTimeout(timer)
      resolve({ socket, boot: b, id: b.me.id, token: b.token ?? (auth as { token?: string }).token ?? '' })
    })
    socket.once('connect_error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

const join = (url: string, name: string) => connect(url, { name, color: '#123456' })

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

const disconnected = (socket: Client) => new Promise<string>((resolve) => socket.once('disconnect', resolve))

/** Plain HTTP (node:http, so the source address can be chosen: any 127.x.y.z is loopback on Linux). */
function http(
  url: string,
  method: string,
  pathname: string,
  opts: { json?: unknown; body?: Buffer; type?: string; bearer?: string; localAddress?: string } = {},
): Promise<{ status: number; body: any }> {
  const target = new URL(pathname, url)
  const body = opts.body ?? (opts.json !== undefined ? Buffer.from(JSON.stringify(opts.json)) : undefined)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method,
        localAddress: opts.localAddress,
        headers: {
          ...(body ? { 'content-type': opts.type ?? 'application/json', 'content-length': body.length } : {}),
          ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown = text
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** A tiny PNG header: enough for the server's magic-byte and dimension checks. */
function png(width = 4, height = 3): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

async function waitFor(check: () => boolean, what: string) {
  const end = Date.now() + TIMEOUT
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`)
    await delay(20)
  }
}

const voicePatch = (channelId: string | null) => ({ channelId, muted: false, deafened: false, camera: false, streaming: false })
const hasVoice = (states: VoiceState[], userId: string) => states.some((s) => s.userId === userId)

after(() => {
  for (const c of clients) c.close()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('address checks', () => {
  test('Tailscale ranges, IPv4-mapped IPv6 unwrapped', () => {
    for (const a of ['100.64.0.1', '100.91.169.79', '100.127.255.255', '::ffff:100.77.123.46', 'fd7a:115c:a1e0::1', 'FD7A:115C:A1E0:AB12::9']) {
      assert.equal(isTailscaleAddress(a), true, a)
    }
    for (const a of ['100.63.255.255', '100.128.0.0', '127.0.0.1', '::1', '192.168.1.5', 'fd7a:115c:a1e1::1', '', 'nonsense', undefined]) {
      assert.equal(isTailscaleAddress(a), false, String(a))
    }
    assert.equal(unwrapAddress('::ffff:127.0.0.1'), '127.0.0.1')
    assert.equal(unwrapAddress('::1'), '::1')
  })
})

describe('roles and permissions', () => {
  let server: NexoInstance
  let url: string
  let owner: Conn
  let admin: Conn
  let member: Conn
  let general: Channel

  before(async () => {
    server = await boot()
    url = server.url
  })
  after(() => server.close())

  test('the first account is the owner, later ones members; bootstrap has serverId and roles', async () => {
    owner = await join(url, 'Olivia')
    assert.equal(owner.boot.me.role, 'owner')
    assert.match(owner.boot.serverId ?? '', /^[0-9a-f-]{36}$/)
    assert.deepEqual(owner.boot.accessRequests, [])
    admin = await join(url, 'Adam')
    member = await join(url, 'Mia')
    assert.equal(admin.boot.me.role, 'member')
    assert.equal(member.boot.me.role, 'member')
    assert.equal(member.boot.serverId, owner.boot.serverId)
    const roles = Object.fromEntries(member.boot.users.map((u) => [u.name, u.role]))
    assert.deepEqual(roles, { Adam: 'member', Mia: 'member', Olivia: 'owner' })
    general = owner.boot.channels.find((c) => c.name === 'general')!
  })

  test('setRole: only the owner, never on the owner, broadcast as user:upsert', async () => {
    assert.equal(await requestErr(member.socket, 'user:setRole', { userId: admin.id, role: 'admin' }), 'Only the owner can change roles')
    const upsert = nextEvent(member.socket, 'user:upsert', (u) => u.id === admin.id)
    const updated = await requestOk<User>(owner.socket, 'user:setRole', { userId: admin.id, role: 'admin' })
    assert.equal(updated.role, 'admin')
    assert.equal((await upsert).role, 'admin')
    // Admins can't change roles either.
    assert.equal(await requestErr(admin.socket, 'user:setRole', { userId: member.id, role: 'admin' }), 'Only the owner can change roles')
    assert.equal(await requestErr(owner.socket, 'user:setRole', { userId: owner.id, role: 'member' }), "The owner's role can't be changed")
    assert.equal(await requestErr(owner.socket, 'user:setRole', { userId: member.id, role: 'owner' }), 'Invalid role')
    assert.equal(await requestErr(owner.socket, 'user:setRole', { userId: 'nope', role: 'admin' }), 'User not found')
    assert.equal(await requestErr(owner.socket, 'user:setRole', null), 'User not found')
  })

  test('channels: members are refused, admins and the owner manage them', async () => {
    const refused = 'Only admins can manage channels'
    assert.equal(await requestErr(member.socket, 'channel:create', { name: 'nope', type: 'text' }), refused)
    assert.equal(await requestErr(member.socket, 'channel:rename', { channelId: general.id, name: 'x' }), refused)
    assert.equal(await requestErr(member.socket, 'channel:delete', { channelId: general.id }), refused)

    const ch = await requestOk<Channel>(admin.socket, 'channel:create', { name: 'admins-made-this', type: 'text' })
    await requestOk<Channel>(admin.socket, 'channel:rename', { channelId: ch.id, name: 'renamed' })
    await requestOk<null>(admin.socket, 'channel:delete', { channelId: ch.id })
    const ch2 = await requestOk<Channel>(owner.socket, 'channel:create', { name: 'Owner Room', type: 'voice' })
    await requestOk<null>(owner.socket, 'channel:delete', { channelId: ch2.id })
  })

  test("messages: members delete only their own, admins and the owner anyone's", async () => {
    const byOwner = await requestOk<Message>(owner.socket, 'message:send', { channelId: general.id, content: 'hi' })
    const byMember = await requestOk<Message>(member.socket, 'message:send', { channelId: general.id, content: 'yo' })
    const byMember2 = await requestOk<Message>(member.socket, 'message:send', { channelId: general.id, content: 'yo 2' })
    const byAdmin = await requestOk<Message>(admin.socket, 'message:send', { channelId: general.id, content: 'hey' })
    assert.equal(
      await requestErr(member.socket, 'message:delete', { messageId: byOwner.id }),
      "Only admins can delete other people's messages",
    )
    await requestOk<null>(member.socket, 'message:delete', { messageId: byMember.id })
    const deleted = nextEvent(member.socket, 'message:deleted', (d) => d.messageId === byMember2.id)
    await requestOk<null>(admin.socket, 'message:delete', { messageId: byMember2.id })
    await deleted
    await requestOk<null>(admin.socket, 'message:delete', { messageId: byOwner.id })
    await requestOk<null>(owner.socket, 'message:delete', { messageId: byAdmin.id })
  })

  test('remove: rules per role', async () => {
    assert.equal(await requestErr(member.socket, 'user:remove', { userId: admin.id }), 'Only admins can remove accounts')
    assert.equal(await requestErr(admin.socket, 'user:remove', { userId: owner.id }), "The owner can't be removed")
    assert.equal(await requestErr(owner.socket, 'user:remove', { userId: owner.id }), "You can't remove your own account")
    assert.equal(await requestErr(admin.socket, 'user:remove', { userId: admin.id }), "You can't remove your own account")
    assert.equal(await requestErr(admin.socket, 'user:remove', { userId: 'nope' }), 'User not found')
    const admin2 = await join(url, 'Second Admin')
    await requestOk<User>(owner.socket, 'user:setRole', { userId: admin2.id, role: 'admin' })
    assert.equal(await requestErr(admin.socket, 'user:remove', { userId: admin2.id }), 'Only the owner can remove admins')
    // The owner removes an admin.
    const gone = nextEvent(owner.socket, 'user:removed', (p) => p.userId === admin2.id)
    await requestOk<null>(owner.socket, 'user:remove', { userId: admin2.id })
    await gone
  })

  test('remove: messages, pictures, logins, voice and the name go with the account', async () => {
    const victim = await join(url, 'Victor')
    const second = await connect(url, { token: victim.token })
    const dataDir = server.config.dataDir

    // A profile picture, a sent image, a pending upload and a message.
    const avatar = await http(url, 'PUT', '/api/avatar', { body: png(), type: 'image/png', bearer: victim.token })
    assert.equal(avatar.status, 200)
    const sent = await http(url, 'POST', '/api/attachments', { body: png(), type: 'image/png', bearer: victim.token })
    const pending = await http(url, 'POST', '/api/attachments', { body: png(), type: 'image/png', bearer: victim.token })
    assert.equal(sent.status, 201)
    const msg = await requestOk<Message>(victim.socket, 'message:send', {
      channelId: general.id,
      content: 'bye',
      attachmentIds: [sent.body.attachment.id],
    })
    const files = [
      path.join(dataDir, 'avatars', victim.id),
      path.join(dataDir, 'attachments', sent.body.attachment.id),
      path.join(dataDir, 'attachments', pending.body.attachment.id),
    ]
    for (const f of files) assert.ok(existsSync(f), f)

    // In voice.
    const lounge = owner.boot.channels.find((c) => c.name === 'Lounge')!
    const inVoice = nextEvent(owner.socket, 'voice:states', (s) => hasVoice(s, victim.id))
    ;(victim.socket as unknown as { emit(e: string, p: unknown): void }).emit('voice:state', voicePatch(lounge.id))
    await inVoice

    const removedForOthers = nextEvent(member.socket, 'user:removed', (p) => p.userId === victim.id)
    const removedForSelf = nextEvent(victim.socket, 'user:removed', (p) => p.userId === victim.id)
    const voiceFreed = nextEvent(owner.socket, 'voice:states', (s) => !hasVoice(s, victim.id))
    const offline = nextEvent(owner.socket, 'presence', (ids) => !ids.includes(victim.id))
    const cut1 = disconnected(victim.socket)
    const cut2 = disconnected(second.socket)
    await requestOk<null>(admin.socket, 'user:remove', { userId: victim.id })
    await removedForOthers
    await removedForSelf
    await voiceFreed
    await offline
    assert.equal(await cut1, 'io server disconnect')
    assert.equal(await cut2, 'io server disconnect')

    await waitFor(() => files.every((f) => !existsSync(f)), 'the files to be deleted')
    const history = await requestOk<Message[]>(owner.socket, 'message:history', { channelId: general.id })
    assert.ok(!history.some((m) => m.id === msg.id))
    assert.equal(await connectError(url, { token: victim.token }), 'UNKNOWN_TOKEN')
    assert.equal((await http(url, 'GET', `/avatars/${victim.id}`)).status, 404)

    // The name is free again: a new, different account.
    const again = await join(url, 'victor')
    assert.notEqual(again.id, victim.id)
    assert.equal(again.boot.me.role, 'member')
    assert.ok(!again.boot.users.some((u) => u.id === victim.id))
  })

  test('a demoted admin loses the rights at once', async () => {
    await requestOk<User>(owner.socket, 'user:setRole', { userId: admin.id, role: 'member' })
    assert.equal(await requestErr(admin.socket, 'channel:create', { name: 'x', type: 'text' }), 'Only admins can manage channels')
    assert.equal(await requestErr(admin.socket, 'user:remove', { userId: member.id }), 'Only admins can remove accounts')
  })

  test('malformed account payloads never crash the server', async () => {
    const raw = owner.socket as unknown as { emit(e: string, ...a: unknown[]): void }
    for (const event of ['user:setRole', 'user:remove', 'access:respond']) {
      raw.emit(event)
      raw.emit(event, 'x')
      raw.emit(event, { userId: { $ne: 1 }, role: [], requestId: 5, approve: 'yes' })
      const res = await request<unknown>(owner.socket, event as keyof ClientToServerEvents, undefined)
      assert.equal(res.ok, false, event)
    }
    await requestOk<Message[]>(owner.socket, 'message:history', { channelId: general.id })
  })
})

describe('welcome back (device links and claims)', () => {
  test('GET /api/info: never recognizes untrusted addresses', async () => {
    const server = await boot({ serverPassword: 'pw' })
    try {
      const a = await connect(server.url, { name: 'Alice', color: '#111111', password: 'pw' })
      const info = await http(server.url, 'GET', '/api/info')
      assert.equal(info.status, 200)
      assert.deepEqual(info.body as ServerInfo, {
        serverId: a.boot.serverId,
        serverName: 'Test Space',
        passwordRequired: true,
        recognized: [],
      })
      // A claim from an untrusted address is refused even for a real account.
      assert.equal(await connectError(server.url, { claim: a.id }), 'NOT_RECOGNIZED')
      // CORS preflight.
      assert.equal((await http(server.url, 'OPTIONS', '/api/info')).status, 204)
      assert.equal((await http(server.url, 'POST', '/api/info')).status, 405)
    } finally {
      await server.close()
    }
  })

  describe('with a trusted address (injected check)', () => {
    let server: NexoInstance
    let trust = true
    let alice: Conn
    let bob: Conn

    before(async () => {
      server = await boot({ isTrustedDeviceAddress: (a) => trust && a === '127.0.0.1' })
    })
    after(() => server.close())

    test('connections link the device; /api/info lists its accounts, most recent first', async () => {
      alice = await join(server.url, 'Alice')
      bob = await join(server.url, 'Bob')
      let info = await http(server.url, 'GET', '/api/info')
      assert.equal(info.body.passwordRequired, false)
      assert.deepEqual(
        (info.body as ServerInfo).recognized.map((u) => u.name),
        ['Bob', 'Alice'],
      )
      assert.equal((info.body as ServerInfo).recognized[1].role, 'owner')
      await delay(5)
      ;(await connect(server.url, { token: alice.token })).socket.close()
      info = await http(server.url, 'GET', '/api/info')
      assert.deepEqual(
        (info.body as ServerInfo).recognized.map((u) => u.name),
        ['Alice', 'Bob'],
      )
    })

    test('claim: a new login for a linked account, delivered once', async () => {
      const claimed = await connect(server.url, { claim: alice.id })
      assert.equal(claimed.boot.me.id, alice.id)
      assert.ok(claimed.boot.token && claimed.boot.token !== alice.token)
      // Both logins work; the new one is a normal token.
      const viaNew = await connect(server.url, { token: claimed.boot.token })
      assert.equal(viaNew.boot.me.id, alice.id)
      assert.equal(viaNew.boot.token, undefined)
      const viaOld = await connect(server.url, { token: alice.token })
      assert.equal(viaOld.boot.me.id, alice.id)
      for (const c of [claimed, viaNew, viaOld]) c.socket.close()
    })

    test('claim: refused for unknown or unlinked accounts and from untrusted addresses', async () => {
      assert.equal(await connectError(server.url, { claim: 'not-a-user' }), 'NOT_RECOGNIZED')
      assert.equal(await connectError(server.url, { claim: 42 }), 'NOT_RECOGNIZED')
      assert.equal(await connectError(server.url, { claim: '' }), 'NOT_RECOGNIZED')
      trust = false
      try {
        // Carol signs up from a device that isn't trusted: no link is recorded.
        const carol = await join(server.url, 'Carol')
        assert.equal(await connectError(server.url, { claim: alice.id }), 'NOT_RECOGNIZED')
        assert.deepEqual((await http(server.url, 'GET', '/api/info')).body.recognized, [])
        trust = true
        assert.equal(await connectError(server.url, { claim: carol.id }), 'NOT_RECOGNIZED')
        assert.ok(!(await http(server.url, 'GET', '/api/info')).body.recognized.some((u: User) => u.id === carol.id))
      } finally {
        trust = true
      }
    })

    test('a removed account is no longer recognized', async () => {
      await requestOk<null>(alice.socket, 'user:remove', { userId: bob.id })
      const info = await http(server.url, 'GET', '/api/info')
      assert.deepEqual((info.body as ServerInfo).recognized.map((u) => u.name), ['Alice'])
      assert.equal(await connectError(server.url, { claim: bob.id }), 'NOT_RECOGNIZED')
    })
  })
})

describe('sign-in requests', () => {
  let server: NexoInstance
  let url: string
  let owner: Conn
  let bob: Conn
  let carol: Conn

  before(async () => {
    server = await boot({ serverPassword: 'pw' })
    url = server.url
    owner = await connect(url, { name: 'Olivia', color: '#111111', password: 'pw' })
    bob = await connect(url, { name: 'Bob', color: '#222222', password: 'pw' })
    carol = await connect(url, { name: 'Carol', color: '#333333', password: 'pw' })
  })
  after(() => server.close())

  const ask = (name: string, extra: { password?: string; localAddress?: string } = {}) =>
    http(url, 'POST', '/api/access-requests', {
      json: { name, password: extra.password ?? 'pw' },
      localAddress: extra.localAddress,
    })
  const poll = (id: string, secret?: string) => http(url, 'GET', `/api/access-requests/${id}`, { bearer: secret })

  test('refused: wrong or missing password, unknown account, bad body', async () => {
    assert.deepEqual(await ask('Bob', { password: 'nope' }), { status: 403, body: { error: 'Wrong server password' } })
    const noPassword = await http(url, 'POST', '/api/access-requests', { json: { name: 'Bob' } })
    assert.equal(noPassword.status, 403)
    assert.equal((await ask('Nobody')).status, 404)
    assert.equal((await http(url, 'POST', '/api/access-requests', { body: Buffer.from('{oops'), type: 'application/json' })).status, 400)
    assert.equal((await http(url, 'POST', '/api/access-requests', { json: [1] })).status, 400)
    assert.equal((await http(url, 'PUT', '/api/access-requests')).status, 405)
    assert.equal((await http(url, 'OPTIONS', '/api/access-requests')).status, 204)
  })

  test('approve: approvers are told, the token is delivered once and works', async () => {
    const toOwner = nextEvent(owner.socket, 'access:request')
    const toBob = nextEvent(bob.socket, 'access:request')
    const notCarol = noEvent(carol.socket, 'access:request')
    const created = await ask('  bob ')
    assert.equal(created.status, 201)
    const { id, secret, expiresAt } = created.body as { id: string; secret: string; expiresAt: number }
    assert.ok(secret.length >= 43)
    const r = await toOwner
    assert.deepEqual(r, { id, userId: bob.id, address: '127.0.0.1', createdAt: r.createdAt, expiresAt })
    assert.ok(expiresAt - r.createdAt === 10 * 60 * 1000)
    assert.deepEqual(await toBob, r)
    await notCarol

    // Pending requests are in the bootstrap of those who may answer them.
    const ownerAgain = await connect(url, { token: owner.token })
    assert.deepEqual(ownerAgain.boot.accessRequests, [r])
    const bobAgain = await connect(url, { token: bob.token })
    assert.deepEqual(bobAgain.boot.accessRequests, [r])
    const carolAgain = await connect(url, { token: carol.token })
    assert.deepEqual(carolAgain.boot.accessRequests, [])
    for (const c of [ownerAgain, bobAgain, carolAgain]) c.socket.close()

    assert.deepEqual((await poll(id, secret)).body, { status: 'pending' })
    assert.equal((await poll(id, 'wrong-secret')).status, 404)
    assert.equal((await poll(id)).status, 401)

    assert.equal(
      await requestErr(carol.socket, 'access:respond', { requestId: id, approve: true }),
      'Only admins can answer sign-in requests',
    )
    assert.equal(await requestErr(owner.socket, 'access:respond', { requestId: id, approve: 'yes' }), 'Invalid answer')
    const resolvedOwner = nextEvent(owner.socket, 'access:resolved', (p) => p.requestId === id)
    const resolvedBob = nextEvent(bob.socket, 'access:resolved', (p) => p.requestId === id)
    await requestOk<null>(owner.socket, 'access:respond', { requestId: id, approve: true })
    await resolvedOwner
    await resolvedBob
    assert.equal(
      await requestErr(owner.socket, 'access:respond', { requestId: id, approve: false }),
      'This sign-in request expired or was already answered',
    )

    const approved = await poll(id, secret)
    assert.equal(approved.status, 200)
    assert.equal(approved.body.status, 'approved')
    assert.ok(typeof approved.body.token === 'string' && approved.body.token !== bob.token)
    assert.equal((await poll(id, secret)).status, 404, 'delivered once')

    const signedIn = await connect(url, { token: approved.body.token })
    assert.equal(signedIn.boot.me.id, bob.id)
    signedIn.socket.close()
    // The original login still works.
    ;(await connect(url, { token: bob.token })).socket.close()
  })

  test('deny: the account itself can answer from another device', async () => {
    const created = (await ask('Carol')).body as { id: string; secret: string }
    const resolved = nextEvent(owner.socket, 'access:resolved', (p) => p.requestId === created.id)
    await requestOk<null>(carol.socket, 'access:respond', { requestId: created.id, approve: false })
    await resolved
    assert.deepEqual((await poll(created.id, created.secret)).body, { status: 'denied' })
  })

  test('cancel and replace', async () => {
    const first = (await ask('Carol')).body as { id: string; secret: string }
    const replaced = nextEvent(carol.socket, 'access:resolved', (p) => p.requestId === first.id)
    const second = (await ask('Carol')).body as { id: string; secret: string }
    await replaced
    assert.equal((await poll(first.id, first.secret)).status, 404, 'a new request replaces the old one')

    const cancelled = nextEvent(owner.socket, 'access:resolved', (p) => p.requestId === second.id)
    assert.equal((await http(url, 'DELETE', `/api/access-requests/${second.id}`, { bearer: 'wrong' })).status, 404)
    assert.equal((await http(url, 'DELETE', `/api/access-requests/${second.id}`, { bearer: second.secret })).status, 204)
    await cancelled
    assert.equal((await poll(second.id, second.secret)).status, 404)
    assert.equal(
      await requestErr(owner.socket, 'access:respond', { requestId: second.id, approve: true }),
      'This sign-in request expired or was already answered',
    )
  })

  test('removing an account resolves its requests', async () => {
    const victim = await connect(url, { name: 'Gone Soon', color: '#555555', password: 'pw' })
    const created = await ask('Gone Soon', { localAddress: '127.0.0.99' })
    assert.equal(created.status, 201)
    const r = created.body as { id: string; secret: string }
    const resolved = nextEvent(owner.socket, 'access:resolved', (p) => p.requestId === r.id)
    await requestOk<null>(owner.socket, 'user:remove', { userId: victim.id })
    await resolved
    assert.equal((await poll(r.id, r.secret)).status, 404)
  })

  test('limits: 3 pending per address, 20 in total', async () => {
    // Accounts to ask for (one pending request per account).
    const names = Array.from({ length: 22 }, (_, i) => `user${String(i).padStart(2, '0')}`)
    for (const name of names) (await connect(url, { name, color: '#444444', password: 'pw' })).socket.close()

    const ids: { id: string; secret: string }[] = []
    for (let i = 0; i < 3; i++) {
      const r = await ask(names[i], { localAddress: '127.0.0.2' })
      assert.equal(r.status, 201)
      ids.push(r.body)
    }
    const fourth = await ask(names[3], { localAddress: '127.0.0.2' })
    assert.equal(fourth.status, 429)
    assert.match(fourth.body.error, /Too many sign-in requests from this device/)
    // Replacing one of your own pending requests is fine.
    const again = await ask(names[0], { localAddress: '127.0.0.2' })
    assert.equal(again.status, 201)

    // 20 in total, from several addresses.
    let n = 3
    for (let a = 3; n < 20; a++) {
      for (let k = 0; k < 3 && n < 20; k++, n++) {
        const r = await ask(names[n], { localAddress: `127.0.0.${a}` })
        assert.equal(r.status, 201, `request ${n}`)
      }
    }
    const tooMany = await ask(names[20], { localAddress: '127.0.0.50' })
    assert.equal(tooMany.status, 429)
    assert.match(tooMany.body.error, /Too many sign-in requests right now/)
    assert.equal(owner.boot.accessRequests?.length, 0)
    const ownerAgain = await connect(url, { token: owner.token })
    assert.equal(ownerAgain.boot.accessRequests?.length, 20)
    ownerAgain.socket.close()
  })
})

describe('sign-in request expiry', () => {
  test('expired requests are announced as resolved and are gone', async () => {
    const server = await boot({ accessRequestTtlMs: 300, accessRequestSweepIntervalMs: 50 })
    try {
      const owner = await join(server.url, 'Olivia')
      await join(server.url, 'Bob')
      const announced = nextEvent(owner.socket, 'access:request')
      const created = await http(server.url, 'POST', '/api/access-requests', { json: { name: 'Bob' } })
      assert.equal(created.status, 201)
      const r: AccessRequest = await announced
      assert.equal(r.expiresAt - r.createdAt, 300)
      await nextEvent(owner.socket, 'access:resolved', (p) => p.requestId === r.id)
      assert.equal((await http(server.url, 'GET', `/api/access-requests/${r.id}`, { bearer: created.body.secret })).status, 404)
      assert.equal(
        await requestErr(owner.socket, 'access:respond', { requestId: r.id, approve: true }),
        'This sign-in request expired or was already answered',
      )
    } finally {
      await server.close()
    }
  })
})

describe('migration of an old database', () => {
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

  /** The v0.1 schema (no avatar, no role, no tokens/devices/meta tables), with two accounts and a message. */
  function oldDatabase(): string {
    const dir = tempDir()
    const db = new DatabaseSync(path.join(dir, 'nexo.db'))
    db.exec(`
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
    `)
    // The newer account is inserted first: the owner is chosen by created_at, not by insertion order.
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run('u-new', 'Newer', '#222222', sha256('token-new'), 2000)
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run('u-old', 'Oldest', '#111111', sha256('token-old'), 1000)
    db.prepare('INSERT INTO channels VALUES (?, ?, ?, ?, ?)').run('c1', 'general', 'text', 0, 1000)
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run('m1', 'c1', 'u-old', 'from the old days', 1500)
    db.close()
    return dir
  }

  test('owner, logins and server id are backfilled; old tokens keep working', async () => {
    const dataDir = oldDatabase()
    const server = await boot({ dataDir })
    let serverId: string | undefined
    try {
      const old = await connect(server.url, { token: 'token-old' })
      assert.equal(old.boot.me.id, 'u-old')
      assert.equal(old.boot.me.role, 'owner')
      assert.equal(old.boot.me.avatar, null)
      serverId = old.boot.serverId
      assert.ok(serverId)
      const newer = await connect(server.url, { token: 'token-new' })
      assert.equal(newer.boot.me.role, 'member')
      // The owner's rights work right away.
      await requestOk<Channel>(old.socket, 'channel:create', { name: 'after-upgrade', type: 'text' })
      const history = await requestOk<Message[]>(old.socket, 'message:history', { channelId: 'c1' })
      assert.equal(history[0].content, 'from the old days')
      // New accounts still fill the legacy column.
      await join(server.url, 'Fresh')
    } finally {
      await server.close()
    }

    const db = new DatabaseSync(path.join(dataDir, 'nexo.db'), { readOnly: true })
    try {
      const tokens = db.prepare('SELECT token_hash AS h, user_id AS u FROM user_tokens ORDER BY u').all() as { h: string; u: string }[]
      assert.deepEqual(
        tokens.filter((t) => t.u.startsWith('u-')).map((t) => ({ ...t })),
        [
          { h: sha256('token-new'), u: 'u-new' },
          { h: sha256('token-old'), u: 'u-old' },
        ],
      )
      const fresh = db.prepare("SELECT token_hash AS h, id FROM users WHERE name = 'Fresh'").get() as { h: string; id: string }
      assert.ok(tokens.some((t) => t.u === fresh.id && t.h === fresh.h))
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'server_id'").get() as { value: string }
      assert.equal(meta.value, serverId)
    } finally {
      db.close()
    }

    // Opening again changes nothing: same server id, same single owner.
    const again = openDb(dataDir)
    try {
      assert.equal(again.serverId, serverId)
      assert.deepEqual(
        again.users.all().filter((u) => u.role === 'owner').map((u) => u.id),
        ['u-old'],
      )
    } finally {
      again.close()
    }
  })

  test('an existing owner is kept; transferOwnership moves it', () => {
    const dir = tempDir()
    const db = openDb(dir)
    try {
      const a = db.users.create('Ann', '#111111', 'h-a')
      const b = db.users.create('Ben', '#222222', 'h-b')
      assert.equal(a.role, 'owner')
      assert.equal(b.role, 'member')
      const moved = db.users.transferOwnership(b.id)
      assert.equal(moved?.owner.role, 'owner')
      assert.equal(moved?.previous?.id, a.id)
      assert.equal(moved?.previous?.role, 'admin')
      assert.equal(db.users.transferOwnership('nope'), undefined)
    } finally {
      db.close()
    }
    const reopened = openDb(dir)
    try {
      const owners = reopened.users.all().filter((u) => u.role === 'owner')
      assert.deepEqual(owners.map((u) => u.name), ['Ben'], 'the backfill does not pick the oldest again')
    } finally {
      reopened.close()
    }
  })
})
