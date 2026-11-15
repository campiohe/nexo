// Voice extras: admins/owner move people between voice channels (`voice:move`), and anyone nudges someone
// muted or deafened (`voice:nudge`). Boots the server in-process like protocol.test.ts. Run with `npm test -w server`.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client'
import type {
  AckResult,
  Bootstrap,
  Channel,
  ClientToServerEvents,
  ServerToClientEvents,
  User,
  VoiceState,
  VoiceStatePatch,
} from '../../shared/protocol.ts'
import { start, type NexoInstance, type StartOptions } from '../src/server.ts'

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>
type EventName = keyof ServerToClientEvents
type EventArg<E extends EventName> = Parameters<ServerToClientEvents[E]>[0]

const TIMEOUT = 3000
const tmpDirs: string[] = []
const clients: Client[] = []
/** The latest voice states each client has seen (bootstrap, then every `voice:states`). */
const seenVoice = new WeakMap<Client, VoiceState[]>()

function boot(opts: Partial<StartOptions> = {}): Promise<NexoInstance> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'nexo-voice-extras-'))
  tmpDirs.push(dataDir)
  return start({
    port: 0,
    host: '127.0.0.1',
    dataDir,
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

const stateOf = (states: VoiceState[], userId: string) => states.find((s) => s.userId === userId)

/**
 * Announces a voice state from `conn` and waits until `observer` sees it (the server broadcasts only
 * changes, so if the observer already sees it, a round trip on `conn` is enough).
 */
async function setVoice(conn: Conn, observer: Conn, patch: Partial<VoiceStatePatch> & { channelId: string | null }) {
  const full = { muted: false, deafened: false, camera: false, streaming: false, ...patch }
  const matches = (states: VoiceState[]) => {
    const s = stateOf(states, conn.id)
    if (full.channelId === null) return !s
    return !!s && s.channelId === full.channelId && s.muted === full.muted && s.deafened === full.deafened &&
      s.camera === full.camera && s.streaming === full.streaming
  }
  const already = matches(seenVoice.get(observer.socket) ?? [])
  const seen = already ? undefined : nextEvent(observer.socket, 'voice:states', matches)
  ;(conn.socket as unknown as { emit(e: string, p: unknown): void }).emit('voice:state', full)
  if (seen) await seen
  else await request(conn.socket, 'message:history', {}) // any ack: the voice:state before it was handled
}

after(() => {
  for (const c of clients) c.close()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('voice extras', () => {
  let server: NexoInstance
  let owner: Conn
  let admin: Conn
  let member: Conn
  let bob: Conn
  let lounge: Channel
  let gaming: Channel
  let general: Channel

  before(async () => {
    server = await boot({ nudgeCooldownMs: 400 })
    owner = await join(server.url, 'Olivia')
    admin = await join(server.url, 'Adam')
    member = await join(server.url, 'Mia')
    bob = await join(server.url, 'Bob')
    await requestOk<User>(owner.socket, 'user:setRole', { userId: admin.id, role: 'admin' })
    lounge = owner.boot.channels.find((c) => c.name === 'Lounge')!
    general = owner.boot.channels.find((c) => c.name === 'general')!
    gaming = await requestOk<Channel>(owner.socket, 'channel:create', { name: 'Gaming', type: 'voice' })
  })
  after(() => server.close())

  describe('voice:move', () => {
    test('members are refused', async () => {
      await setVoice(bob, owner, { channelId: lounge.id })
      assert.equal(await requestErr(member.socket, 'voice:move', { userId: bob.id, channelId: gaming.id }), 'Only admins can move people')
      assert.equal(stateOf(await currentVoice(), bob.id)?.channelId, lounge.id)
    })

    test('an admin moves a member: state moved in place, camera/stream cleared, target told', async () => {
      await setVoice(bob, owner, { channelId: lounge.id, muted: true, camera: true, streaming: true })
      const moved = nextEvent(bob.socket, 'voice:moved')
      const broadcast = nextEvent(member.socket, 'voice:states', (s) => stateOf(s, bob.id)?.channelId === gaming.id)
      const notOthers = noEvent(member.socket, 'voice:moved')
      await requestOk<null>(admin.socket, 'voice:move', { userId: bob.id, channelId: gaming.id })
      assert.deepEqual(await moved, { channelId: gaming.id, by: admin.id })
      assert.deepEqual(stateOf(await broadcast, bob.id), {
        userId: bob.id,
        channelId: gaming.id,
        muted: true,
        deafened: false,
        camera: false,
        streaming: false,
        watching: [],
      })
      await notOthers
      // The target's client rejoins and re-announces from the same socket: still its own state.
      await setVoice(bob, owner, { channelId: gaming.id, muted: false })
      await requestOk(bob.socket, 'voice:streamToken', { channelId: gaming.id })
    })

    test('only the voice-owning socket is told', async () => {
      const second = await connect(server.url, { token: bob.token })
      await setVoice(bob, owner, { channelId: lounge.id })
      const moved = nextEvent(bob.socket, 'voice:moved')
      const notSecond = noEvent(second.socket, 'voice:moved')
      await requestOk<null>(owner.socket, 'voice:move', { userId: bob.id, channelId: gaming.id })
      await moved
      await notSecond
      second.socket.close()
    })

    test('moving to the current channel is a no-op', async () => {
      await setVoice(bob, owner, { channelId: gaming.id, camera: true })
      const noMove = noEvent(bob.socket, 'voice:moved')
      const noBroadcast = noEvent(owner.socket, 'voice:states')
      await requestOk<null>(admin.socket, 'voice:move', { userId: bob.id, channelId: gaming.id })
      await noMove
      await noBroadcast
      assert.equal(stateOf(await currentVoice(), bob.id)?.camera, true)
    })

    test('admins cannot move the owner; the owner can move an admin, and staff themselves', async () => {
      await setVoice(owner, admin, { channelId: lounge.id })
      assert.equal(await requestErr(admin.socket, 'voice:move', { userId: owner.id, channelId: gaming.id }), "Admins can't move the owner")
      await setVoice(admin, owner, { channelId: lounge.id })
      const moved = nextEvent(admin.socket, 'voice:moved')
      await requestOk<null>(owner.socket, 'voice:move', { userId: admin.id, channelId: gaming.id })
      assert.deepEqual(await moved, { channelId: gaming.id, by: owner.id })
      const self = nextEvent(owner.socket, 'voice:moved')
      await requestOk<null>(owner.socket, 'voice:move', { userId: owner.id, channelId: gaming.id })
      assert.deepEqual(await self, { channelId: gaming.id, by: owner.id })
      await setVoice(owner, admin, { channelId: null })
      await setVoice(admin, owner, { channelId: null })
    })

    test('bad destinations, targets not in voice, malformed payloads', async () => {
      await setVoice(bob, owner, { channelId: lounge.id })
      assert.equal(await requestErr(admin.socket, 'voice:move', { userId: bob.id, channelId: general.id }), 'Voice channel not found')
      assert.equal(await requestErr(admin.socket, 'voice:move', { userId: bob.id, channelId: 'nope' }), 'Voice channel not found')
      assert.equal(await requestErr(admin.socket, 'voice:move', { userId: bob.id }), 'Voice channel not found')
      assert.equal(await requestErr(admin.socket, 'voice:move', { userId: member.id, channelId: gaming.id }), "They're not in voice")
      assert.equal(await requestErr(admin.socket, 'voice:move', { userId: 'nope', channelId: gaming.id }), 'User not found')
      assert.equal(await requestErr(admin.socket, 'voice:move', null), 'User not found')
      assert.equal(await requestErr(admin.socket, 'voice:move', 'x'), 'User not found')
      assert.equal(stateOf(await currentVoice(), bob.id)?.channelId, lounge.id)
    })
  })

  describe('voice:nudge', () => {
    test('refused when the target is not muted, not in voice, unknown or yourself', async () => {
      await setVoice(bob, owner, { channelId: lounge.id })
      assert.equal(await requestErr(member.socket, 'voice:nudge', { userId: bob.id }), "They're not muted")
      assert.equal(await requestErr(member.socket, 'voice:nudge', { userId: owner.id }), "They're not in voice")
      assert.equal(await requestErr(member.socket, 'voice:nudge', { userId: 'nope' }), 'User not found')
      assert.equal(await requestErr(member.socket, 'voice:nudge', null), 'User not found')
      await setVoice(member, owner, { channelId: lounge.id, muted: true })
      assert.equal(await requestErr(member.socket, 'voice:nudge', { userId: member.id }), "You can't nudge yourself")
      await setVoice(member, owner, { channelId: null })
    })

    test('a member nudges a muted or deafened user; cooldown per sender → target', async () => {
      await setVoice(bob, owner, { channelId: lounge.id, muted: true })
      const second = await connect(server.url, { token: member.token })
      const nudged = nextEvent(bob.socket, 'voice:nudged')
      const notOthers = noEvent(owner.socket, 'voice:nudged')
      await requestOk<null>(member.socket, 'voice:nudge', { userId: bob.id })
      assert.deepEqual(await nudged, { by: member.id })
      await notOthers

      // Shared by all of the sender's sockets.
      assert.match(await requestErr(member.socket, 'voice:nudge', { userId: bob.id }), /^You can nudge them again in \d+ s$/)
      assert.match(await requestErr(second.socket, 'voice:nudge', { userId: bob.id }), /^You can nudge them again in 1 s$/)
      // Another sender is not affected.
      await requestOk<null>(owner.socket, 'voice:nudge', { userId: bob.id })

      // Deafened only also counts, and the cooldown runs out.
      await setVoice(bob, owner, { channelId: lounge.id, deafened: true })
      await delay(450)
      const again = nextEvent(bob.socket, 'voice:nudged')
      await requestOk<null>(second.socket, 'voice:nudge', { userId: bob.id })
      assert.deepEqual(await again, { by: member.id })
      second.socket.close()
    })

    test('the default cooldown is NUDGE_COOLDOWN_MS (15 s)', async () => {
      const s = await boot()
      try {
        const a = await join(s.url, 'Ann')
        const b = await join(s.url, 'Ben')
        const lounge2 = a.boot.channels.find((c) => c.name === 'Lounge')!
        await setVoice(b, a, { channelId: lounge2.id, muted: true })
        await requestOk<null>(a.socket, 'voice:nudge', { userId: b.id })
        assert.equal(await requestErr(a.socket, 'voice:nudge', { userId: b.id }), 'You can nudge them again in 15 s')
      } finally {
        await s.close()
      }
    })
  })

  /** The current voice states, as seen by a fresh connection's bootstrap. */
  async function currentVoice(): Promise<VoiceState[]> {
    const c = await connect(server.url, { token: owner.token })
    c.socket.close()
    return c.boot.voice
  }
})
