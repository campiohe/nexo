// Emulator plugin (docs/SPEC.md §5.5): the session manager (emulator.ts) with a fake clock, then the socket
// events through an in-process server (voice checks, input relay to the host's voice socket, cleanup).
// Run with `npm test -w server`.
import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client'
import type {
  AckResult,
  Bootstrap,
  Channel,
  ClientToServerEvents,
  EmuSession,
  ServerPlugins,
  ServerToClientEvents,
  VoiceState,
} from '../../shared/protocol.ts'
import { EMU_PORTS, EMU_SYSTEMS, EMU_TITLE_MAX, GAME_PAD, GAME_PAD_MASK } from '../../shared/protocol.ts'
import { createEmuSessions, EMU_ERRORS, EMU_LIMITS, normalizeAxes, type EmuMember, type EmuRelay } from '../src/emulator.ts'
import { start, type NexoInstance } from '../src/server.ts'

type Relay = { to: string; p: EmuRelay }

// ---------- session manager ----------

describe('emulator session manager', () => {
  const CH = 'ch1'
  const T0 = 1_700_000_000_000
  let sessions: EmuSession[]
  let relays: Relay[]
  let emu: ReturnType<typeof createEmuSessions>
  const members = (...ids: string[]) => new Map<string, EmuMember[]>([[CH, ids.map((id) => ({ userId: id, socketId: `s-${id}` }))]])
  const ok = (r: EmuSession | string): EmuSession => {
    if (typeof r === 'string') assert.fail(`unexpected error: ${r}`)
    return r
  }
  const last = () => sessions[sessions.length - 1]
  const lastRelay = (): Relay => relays[relays.length - 1]

  beforeEach(() => {
    sessions = []
    relays = []
    emu = createEmuSessions({
      onSession: (s) => sessions.push(s),
      onInput: (to, p) => relays.push({ to, p }),
      now: () => T0,
    })
    emu.setMembers(members('ana', 'bo', 'cy', 'di', 'ed'))
  })

  test('start: validation, host on port 0, broadcast', () => {
    for (const bad of ['nes', 'SNES', '', 42, null, undefined, ['snes']]) {
      assert.equal(emu.start(CH, 'ana', bad, 'Mario'), EMU_ERRORS.unknownSystem)
    }
    assert.equal(emu.start(CH, 'ana', 'snes', ''), EMU_ERRORS.invalidTitle)
    assert.equal(emu.start(CH, 'ana', 'snes', ' \n\t '), EMU_ERRORS.invalidTitle)
    assert.equal(emu.start(CH, 'ana', 'snes', 42), EMU_ERRORS.invalidTitle)
    assert.equal(emu.start(CH, 'ana', 'snes', 'x'.repeat(EMU_TITLE_MAX + 1)), EMU_ERRORS.invalidTitle)
    assert.equal(sessions.length, 0)
    const s = ok(emu.start(CH, 'ana', 'snes', '  Super\n  Mario   World​ '))
    assert.deepEqual(s, {
      channelId: CH,
      hostId: 'ana',
      system: 'snes',
      title: 'Super Mario World',
      ports: ['ana', null, null, null],
      paused: false,
      status: 'running',
      rev: T0 + 1,
    })
    assert.equal(s.ports.length, EMU_PORTS)
    assert.deepEqual(sessions, [s])
    assert.deepEqual(emu.active(), [s])
  })

  test('start on a running session: only the host changes the game', () => {
    ok(emu.start(CH, 'ana', 'snes', 'Mario'))
    ok(emu.port(CH, 'bo', 1))
    assert.equal(emu.start(CH, 'bo', 'snes', 'Zelda'), EMU_ERRORS.busy)
    ok(emu.pause(CH, 'ana', true))
    const n = sessions.length
    const s = ok(emu.start(CH, 'ana', 'snes', 'Zelda'))
    assert.deepEqual([s.title, s.paused, s.ports], ['Zelda', false, ['ana', 'bo', null, null]])
    assert.equal(sessions.length, n + 1)
    // The same game again: nothing changes, nothing is broadcast.
    assert.deepEqual(ok(emu.start(CH, 'ana', 'snes', 'Zelda')), s)
    assert.equal(sessions.length, n + 1)
  })

  test('ports: take, taken, invalid, move, free (the host is told 0)', () => {
    ok(emu.start(CH, 'ana', 'snes', 'Mario'))
    assert.equal(emu.port('nope', 'bo', 1), EMU_ERRORS.noSession)
    for (const bad of [-1, EMU_PORTS, 1.5, '1', undefined, NaN]) assert.equal(emu.port(CH, 'bo', bad), EMU_ERRORS.invalidPort)
    assert.equal(emu.port(CH, 'bo', 0), EMU_ERRORS.portTaken)
    let s = ok(emu.port(CH, 'bo', 1))
    assert.deepEqual(s.ports, ['ana', 'bo', null, null])
    assert.equal(emu.port(CH, 'cy', 1), EMU_ERRORS.portTaken)
    // Taking your own port again is a no-op.
    const n = sessions.length
    assert.deepEqual(ok(emu.port(CH, 'bo', 1)), s)
    assert.equal(sessions.length, n)
    relays = []
    s = ok(emu.port(CH, 'bo', 3))
    assert.deepEqual(s.ports, ['ana', null, null, 'bo'])
    assert.deepEqual(relays, [{ to: 's-ana', p: { channelId: CH, port: 1, buttons: 0 } }])
    relays = []
    s = ok(emu.port(CH, 'bo', null))
    assert.deepEqual(s.ports, ['ana', null, null, null])
    assert.deepEqual(relays, [{ to: 's-ana', p: { channelId: CH, port: 3, buttons: 0 } }])
    // Nothing to give up: no-op.
    const m = sessions.length
    ok(emu.port(CH, 'bo', null))
    assert.equal(sessions.length, m)
  })

  test('assign: host or admins, people in the channel, moves them, frees', () => {
    emu.setMembers(members('ana', 'bo', 'cy'))
    ok(emu.start(CH, 'ana', 'snes', 'Mario'))
    ok(emu.port(CH, 'bo', 1))
    assert.equal(emu.assign(CH, 'bo', 2, 'cy', false), EMU_ERRORS.notHost)
    assert.equal(emu.assign(CH, 'ana', 4, 'cy', false), EMU_ERRORS.invalidPort)
    assert.equal(emu.assign(CH, 'ana', 2, 'zed', false), EMU_ERRORS.notInVoice)
    assert.equal(emu.assign(CH, 'ana', 2, 42, false), EMU_ERRORS.notInVoice)
    let s = ok(emu.assign(CH, 'ana', 2, 'cy', false))
    assert.deepEqual(s.ports, ['ana', 'bo', 'cy', null])
    // An admin (not the host) moves bo to port 2: cy loses it, bo leaves port 1; the host is told both are 0.
    relays = []
    s = ok(emu.assign(CH, 'bo', 2, 'bo', true))
    assert.deepEqual(s.ports, ['ana', null, 'bo', null])
    assert.deepEqual(
      relays.map((r) => r.p.port).sort(),
      [1, 2],
    )
    assert.ok(relays.every((r) => r.to === 's-ana' && r.p.buttons === 0))
    s = ok(emu.assign(CH, 'ana', 0, null, false))
    assert.deepEqual(s.ports, [null, null, 'bo', null])
    const n = sessions.length
    ok(emu.assign(CH, 'ana', 0, null, false))
    ok(emu.assign(CH, 'ana', 2, 'bo', false))
    assert.equal(sessions.length, n, 'no-ops broadcast nothing')
  })

  test('pause: host only; stop: host or admins', () => {
    ok(emu.start(CH, 'ana', 'snes', 'Mario'))
    assert.equal(emu.pause(CH, 'bo', true), EMU_ERRORS.notHost)
    assert.equal(emu.pause(CH, 'ana', 'yes'), EMU_ERRORS.invalidPaused)
    assert.equal(ok(emu.pause(CH, 'ana', true)).paused, true)
    assert.equal(emu.stop(CH, 'bo', false), EMU_ERRORS.notHost)
    assert.equal(emu.stop(CH, 'bo', true), null)
    assert.equal(last().status, 'closed')
    assert.equal(emu.session(CH), null)
    assert.equal(emu.stop(CH, 'ana', false), EMU_ERRORS.noSession)
    assert.equal(emu.pause(CH, 'ana', false), EMU_ERRORS.noSession)
  })

  test('input: relayed to the host only on change, masked; host and non-players ignored', () => {
    ok(emu.start(CH, 'ana', 'snes', 'Mario'))
    ok(emu.port(CH, 'bo', 1))
    emu.input(CH, 'ana', GAME_PAD.A) // the host's own controller never goes through the server
    emu.input(CH, 'cy', GAME_PAD.A) // no port
    emu.input('other', 'bo', GAME_PAD.A) // no session there
    emu.input(CH, 'bo', 1.5)
    emu.input(CH, 'bo', '16')
    assert.equal(relays.length, 0)
    emu.input(CH, 'bo', GAME_PAD.A)
    emu.input(CH, 'bo', GAME_PAD.A)
    emu.input(CH, 'bo', GAME_PAD.A | GAME_PAD.SELECT)
    emu.input(CH, 'bo', 0xffff)
    emu.input(CH, 'bo', 0x10000) // only bits outside the mask: 0
    assert.deepEqual(
      relays.map((r) => [r.to, r.p.port, r.p.buttons]),
      [
        ['s-ana', 1, GAME_PAD.A],
        ['s-ana', 1, GAME_PAD.A | GAME_PAD.SELECT],
        ['s-ana', 1, GAME_PAD_MASK],
        ['s-ana', 1, 0],
      ],
    )
  })

  test('start: every system of EMU_SYSTEMS; a new game can switch the system', () => {
    assert.deepEqual([...EMU_SYSTEMS], ['snes', 'genesis', 'psx', 'n64'])
    for (const [i, system] of EMU_SYSTEMS.entries()) {
      const ch = `sys-${i}`
      emu.setMembers(new Map([[ch, [{ userId: 'ana', socketId: 's-ana' }]]]))
      assert.equal(ok(emu.start(ch, 'ana', system, 'Game')).system, system)
    }
    emu.setMembers(members('ana', 'bo'))
    ok(emu.start(CH, 'ana', 'snes', 'Mario'))
    const s = ok(emu.start(CH, 'ana', 'n64', 'Mario'))
    assert.equal(s.system, 'n64')
    assert.equal(emu.start(CH, 'ana', 'dreamcast', 'Mario'), EMU_ERRORS.unknownSystem)
    assert.equal(emu.session(CH)?.system, 'n64')
  })

  test('normalizeAxes: 4 finite numbers, rounded and clamped; junk and centered are null', () => {
    assert.deepEqual(normalizeAxes([0, 127, -127, 5]), [0, 127, -127, 5])
    assert.deepEqual(normalizeAxes([200, -300, 0.4, -0.6]), [127, -127, 0, -1])
    assert.deepEqual(normalizeAxes([1e9, -1e9, 12.5, -12.5]), [127, -127, 13, -12])
    assert.ok(!Object.is(normalizeAxes([-0.2, 3, 0, 0])![0], -0), 'no negative zero')
    for (const bad of [
      undefined,
      null,
      0,
      'x',
      {},
      [],
      [1, 2, 3],
      [1, 2, 3, 4, 5],
      [1, 2, 3, NaN],
      [1, 2, Infinity, 4],
      [1, '2', 3, 4],
      [1, null, 3, 4],
      { 0: 1, 1: 2, 2: 3, 3: 4, length: 4 },
      [0, 0, 0, 0],
      [0.3, -0.4, 0.1, 0],
    ]) {
      assert.equal(normalizeAxes(bad), null, JSON.stringify(bad))
    }
  })

  test('input with axes: relayed on change (buttons or sticks), normalized, omitted when centered', () => {
    ok(emu.start(CH, 'ana', 'n64', 'Mario 64'))
    ok(emu.port(CH, 'bo', 1))
    relays = []
    emu.input(CH, 'bo', 0, [0, 0, 0, 0]) // centered = what the host already has: nothing
    emu.input(CH, 'bo', 0, 'junk')
    assert.equal(relays.length, 0)
    emu.input(CH, 'bo', 0, [64, -32, 0, 0])
    emu.input(CH, 'bo', 0, [64, -32, 0, 0]) // same: dropped
    emu.input(CH, 'bo', 0, [64.2, -31.9, 0, 0]) // rounds to the same: dropped
    emu.input(CH, 'bo', GAME_PAD.A, [64, -32, 0, 0]) // buttons changed
    emu.input(CH, 'bo', GAME_PAD.A, [500, -32, 0, 9]) // clamped
    emu.input(CH, 'bo', GAME_PAD.A, [1, 2, NaN, 4]) // junk axes = centered, the buttons still count
    emu.input(CH, 'bo', GAME_PAD.A) // still centered: dropped
    emu.input(CH, 'bo', 'x', [10, 10, 10, 10]) // junk buttons: the whole message is ignored
    emu.input(CH, 'ana', 0, [10, 10, 10, 10]) // the host: ignored
    emu.input(CH, 'cy', 0, [10, 10, 10, 10]) // no port: ignored
    assert.deepEqual(
      relays.map((r) => r.p),
      [
        { channelId: CH, port: 1, buttons: 0, axes: [64, -32, 0, 0] },
        { channelId: CH, port: 1, buttons: GAME_PAD.A, axes: [64, -32, 0, 0] },
        { channelId: CH, port: 1, buttons: GAME_PAD.A, axes: [127, -32, 0, 9] },
        { channelId: CH, port: 1, buttons: GAME_PAD.A },
      ],
    )
    assert.ok(relays.every((r) => r.to === 's-ana'))
    assert.ok(!('axes' in relays[3].p), 'no axes key when centered')
  })

  test('freeing a port with a tilted stick relays buttons 0 without axes; the new holder starts centered', () => {
    ok(emu.start(CH, 'ana', 'psx', 'Ape Escape'))
    ok(emu.port(CH, 'bo', 1))
    emu.input(CH, 'bo', GAME_PAD.L2, [0, 0, -90, 40])
    relays = []
    ok(emu.port(CH, 'bo', null))
    assert.deepEqual(relays, [{ to: 's-ana', p: { channelId: CH, port: 1, buttons: 0 } }])
    // cy takes it: centered is what the host has, so a centered input is not relayed again.
    ok(emu.port(CH, 'cy', 1))
    relays = []
    emu.input(CH, 'cy', 0)
    assert.equal(relays.length, 0)
    emu.input(CH, 'cy', 0, [0, 50, 0, 0])
    assert.deepEqual(lastRelay().p, { channelId: CH, port: 1, buttons: 0, axes: [0, 50, 0, 0] })
    // assign over it (admin): freed without axes.
    relays = []
    ok(emu.assign(CH, 'ana', 1, 'di', false))
    assert.deepEqual(relays, [{ to: 's-ana', p: { channelId: CH, port: 1, buttons: 0 } }])
  })

  test("the host's new device gets the held sticks too (and nothing for centered ports)", () => {
    emu.setMembers(members('ana', 'bo', 'cy', 'di'))
    ok(emu.start(CH, 'ana', 'n64', 'Mario Kart 64'))
    ok(emu.port(CH, 'bo', 1))
    ok(emu.port(CH, 'cy', 2))
    ok(emu.port(CH, 'di', 3))
    emu.input(CH, 'bo', 0, [-127, 0, 0, 0]) // stick only
    emu.input(CH, 'cy', GAME_PAD.A) // button only
    emu.input(CH, 'di', 0, [5, 0, 0, 0])
    emu.input(CH, 'di', 0) // back to centered
    relays = []
    emu.setMembers(
      new Map([
        [
          CH,
          ['ana', 'bo', 'cy', 'di'].map((id) => ({ userId: id, socketId: id === 'ana' ? 's-ana-2' : `s-${id}` })),
        ],
      ]),
    )
    assert.deepEqual(relays, [
      { to: 's-ana-2', p: { channelId: CH, port: 1, buttons: 0, axes: [-127, 0, 0, 0] } },
      { to: 's-ana-2', p: { channelId: CH, port: 2, buttons: GAME_PAD.A } },
    ])
  })

  test('voice changes: a player leaving frees their port; the host moving device gets the held buttons; the host leaving closes', () => {
    emu.setMembers(members('ana', 'bo', 'cy'))
    ok(emu.start(CH, 'ana', 'snes', 'Mario'))
    ok(emu.port(CH, 'bo', 1))
    ok(emu.port(CH, 'cy', 2))
    emu.input(CH, 'bo', GAME_PAD.RIGHT)
    relays = []
    const n = sessions.length
    emu.setMembers(members('ana', 'bo'))
    assert.deepEqual(relays, [{ to: 's-ana', p: { channelId: CH, port: 2, buttons: 0 } }])
    assert.equal(sessions.length, n + 1)
    assert.deepEqual(last().ports, ['ana', 'bo', null, null])
    // Nothing changed for the session: nothing is broadcast.
    emu.setMembers(members('ana', 'bo'))
    assert.equal(sessions.length, n + 1)

    // Ana's voice moves to her other device: it gets what bo holds, and later relays.
    relays = []
    emu.setMembers(new Map([[CH, [{ userId: 'ana', socketId: 's-ana-2' }, { userId: 'bo', socketId: 's-bo' }]]]))
    assert.deepEqual(relays, [{ to: 's-ana-2', p: { channelId: CH, port: 1, buttons: GAME_PAD.RIGHT } }])
    assert.equal(sessions.length, n + 1)
    emu.input(CH, 'bo', 0)
    assert.equal(lastRelay().to, 's-ana-2')

    emu.setMembers(new Map([[CH, [{ userId: 'bo', socketId: 's-bo' }]]]))
    assert.equal(last().status, 'closed')
    assert.deepEqual(emu.active(), [])
  })

  test('drop, clearAll; revisions never go back', () => {
    const other = 'ch2'
    emu.setMembers(new Map([...members('ana', 'bo'), [other, [{ userId: 'cy', socketId: 's-cy' }]]]))
    const a = ok(emu.start(CH, 'ana', 'snes', 'Mario'))
    const b = ok(emu.start(other, 'cy', 'snes', 'Zelda'))
    assert.ok(b.rev > a.rev)
    emu.drop(CH)
    assert.equal(last().status, 'closed')
    assert.equal(last().channelId, CH)
    const c = ok(emu.start(CH, 'ana', 'snes', 'Mario'))
    assert.ok(c.rev > b.rev)
    emu.clearAll()
    assert.deepEqual(emu.active(), [])
    const revs = sessions.map((s) => s.rev)
    assert.deepEqual(revs, [...revs].sort((x, y) => x - y))
    assert.equal(new Set(revs).size, revs.length)
  })
})

// ---------- sockets ----------

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>
type EventName = keyof ServerToClientEvents
type EventArg<E extends EventName> = Parameters<ServerToClientEvents[E]>[0]

const TIMEOUT = 3000
const tmpDirs: string[] = []
const clients: Client[] = []

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
/** Every `emu:input` a socket receives from now on. */
function collectInputs(c: Conn): EventArg<'emu:input'>[] {
  const got: EventArg<'emu:input'>[] = []
  ;(c.socket as unknown as { on(e: string, f: (a: unknown) => void): void }).on('emu:input', (p) => got.push(p as EventArg<'emu:input'>))
  return got
}
async function setVoice(conn: Conn, observer: Conn, channelId: string | null) {
  const seen = nextEvent(observer.socket, 'voice:states', (states: VoiceState[]) => {
    const s = states.find((v) => v.userId === conn.id)
    return channelId === null ? !s : s?.channelId === channelId
  })
  emitRaw(conn, 'voice:state', { channelId, muted: false, deafened: false, camera: false, streaming: false })
  await seen
}
const emitRaw = (c: Conn, e: string, p: unknown) => (c.socket as unknown as { emit(e: string, p: unknown): void }).emit(e, p)
/** Waits until the server handled everything `c` sent before (its events are processed in order). */
const flush = (c: Conn) => requestOk(c.socket, 'time:now', {})

describe('emulator over sockets', () => {
  const clock = { t: 1_700_000_000_000 }
  let server: NexoInstance
  let owner: Conn
  let mia: Conn
  let bob: Conn
  let lounge: Channel
  let gaming: Channel
  let general: Channel
  /** What each socket was relayed (only the host's voice socket should get any). */
  let inputs: { owner: EventArg<'emu:input'>[]; mia: EventArg<'emu:input'>[]; bob: EventArg<'emu:input'>[] }

  before(async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'nexo-emu-'))
    tmpDirs.push(dataDir)
    server = await start({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      serverName: 'Test Space',
      serverPassword: '',
      livekit: { apiKey: 'testkey', apiSecret: 'test-secret-that-is-at-least-32-characters-long', publicUrl: '', port: 7880 },
      log: false,
      now: () => clock.t,
      emuLimit: { count: 1000, windowMs: 1000 },
    })
    owner = await join(server.url, 'Olivia')
    mia = await join(server.url, 'Mia')
    bob = await join(server.url, 'Bob')
    lounge = owner.boot.channels.find((c) => c.name === 'Lounge')!
    gaming = owner.boot.channels.find((c) => c.name === 'Gaming')!
    general = owner.boot.channels.find((c) => c.name === 'general')!
    inputs = { owner: collectInputs(owner), mia: collectInputs(mia), bob: collectInputs(bob) }
  })
  after(() => server.close())

  test('plugin off by default; requests refused', async () => {
    assert.deepEqual(owner.boot.plugins, { music: false, emulator: false })
    assert.deepEqual(owner.boot.emulator, [])
    await setVoice(mia, owner, lounge.id)
    assert.equal(await requestErr(mia.socket, 'emu:start', { channelId: lounge.id, system: 'snes', title: 'Mario' }), EMU_ERRORS.pluginOff)
    assert.equal(await requestErr(mia.socket, 'emu:port', { channelId: lounge.id, port: 1 }), EMU_ERRORS.pluginOff)
  })

  test('turn it on; channel and voice checks; start broadcasts to everyone; bootstrap', async () => {
    const changed = nextEvent(bob.socket, 'plugins:changed')
    assert.deepEqual(await requestOk<ServerPlugins>(owner.socket, 'plugins:set', { plugin: 'emulator', enabled: true }), {
      music: false,
      emulator: true,
    })
    assert.deepEqual(await changed, { music: false, emulator: true })
    const start = (c: Conn, p: Record<string, unknown>) => request<EmuSession>(c.socket, 'emu:start', { system: 'snes', title: 'Mario', ...p })
    assert.deepEqual(await start(mia, { channelId: general.id }), { ok: false, error: EMU_ERRORS.channelNotFound })
    assert.deepEqual(await start(mia, { channelId: 'nope' }), { ok: false, error: EMU_ERRORS.channelNotFound })
    assert.deepEqual(await start(mia, { channelId: gaming.id }), { ok: false, error: EMU_ERRORS.notInChannel })
    assert.deepEqual(await start(bob, { channelId: lounge.id }), { ok: false, error: EMU_ERRORS.notInChannel })
    // Another device of Mia (not the voice-owning socket) can't host either.
    const mia2 = await connect(server.url, { token: mia.token })
    assert.deepEqual(await start(mia2, { channelId: lounge.id }), { ok: false, error: EMU_ERRORS.notInChannel })
    mia2.socket.close()
    assert.deepEqual(await start(mia, { channelId: lounge.id, title: '   ' }), { ok: false, error: EMU_ERRORS.invalidTitle })
    assert.deepEqual(await start(mia, { channelId: lounge.id, system: 'nes' }), { ok: false, error: EMU_ERRORS.unknownSystem })

    const seenByBob = nextEvent(bob.socket, 'emu:session')
    const s = await requestOk<EmuSession>(mia.socket, 'emu:start', { channelId: lounge.id, system: 'snes', title: ' Super  Metroid ' })
    assert.deepEqual([s.hostId, s.title, s.ports, s.status], [mia.id, 'Super Metroid', [mia.id, null, null, null], 'running'])
    assert.deepEqual(await seenByBob, s)
    const late = await join(server.url, 'Late')
    assert.deepEqual(late.boot.emulator, [s])
    late.socket.close()

    await setVoice(bob, owner, lounge.id)
    assert.equal(await requestErr(bob.socket, 'emu:start', { channelId: lounge.id, system: 'snes', title: 'Zelda' }), EMU_ERRORS.busy)
  })

  test('ports, assign, pause over sockets', async () => {
    assert.equal(await requestErr(bob.socket, 'emu:port', { channelId: lounge.id, port: 0 }), EMU_ERRORS.portTaken)
    assert.equal(await requestErr(bob.socket, 'emu:port', { channelId: lounge.id, port: 9 }), EMU_ERRORS.invalidPort)
    let s = await requestOk<EmuSession>(bob.socket, 'emu:port', { channelId: lounge.id, port: 1 })
    assert.deepEqual(s.ports, [mia.id, bob.id, null, null])
    // The owner (an admin) assigns, but only people in the channel.
    await setVoice(owner, mia, gaming.id)
    assert.equal(await requestErr(owner.socket, 'emu:assign', { channelId: lounge.id, port: 2, userId: bob.id }), EMU_ERRORS.notInChannel)
    await setVoice(owner, mia, lounge.id)
    assert.equal(await requestErr(bob.socket, 'emu:assign', { channelId: lounge.id, port: 2, userId: bob.id }), EMU_ERRORS.notHost)
    const outsider = await join(server.url, 'Outsider')
    assert.equal(
      await requestErr(owner.socket, 'emu:assign', { channelId: lounge.id, port: 2, userId: outsider.id }),
      EMU_ERRORS.notInVoice,
    )
    outsider.socket.close()
    s = await requestOk<EmuSession>(owner.socket, 'emu:assign', { channelId: lounge.id, port: 2, userId: owner.id })
    assert.deepEqual(s.ports, [mia.id, bob.id, owner.id, null])
    s = await requestOk<EmuSession>(mia.socket, 'emu:assign', { channelId: lounge.id, port: 2, userId: null })
    assert.deepEqual(s.ports, [mia.id, bob.id, null, null])
    assert.equal(await requestErr(owner.socket, 'emu:pause', { channelId: lounge.id, paused: true }), EMU_ERRORS.notHost)
    s = await requestOk<EmuSession>(mia.socket, 'emu:pause', { channelId: lounge.id, paused: true })
    assert.equal(s.paused, true)
    s = await requestOk<EmuSession>(mia.socket, 'emu:pause', { channelId: lounge.id, paused: false })
    assert.equal(s.paused, false)
  })

  test('input: relayed only to the host voice socket, on change, masked; others ignored', async () => {
    inputs.owner.length = inputs.mia.length = inputs.bob.length = 0
    // Ignored: the host itself, someone without a port, Bob's other device, junk.
    emitRaw(mia, 'emu:input', { channelId: lounge.id, buttons: GAME_PAD.A })
    emitRaw(owner, 'emu:input', { channelId: lounge.id, buttons: GAME_PAD.A })
    const bob2 = await connect(server.url, { token: bob.token })
    emitRaw(bob2, 'emu:input', { channelId: lounge.id, buttons: GAME_PAD.B })
    await flush(bob2)
    bob2.socket.close()
    emitRaw(bob, 'emu:input', { channelId: lounge.id, buttons: 'x' })
    emitRaw(bob, 'emu:input', { channelId: gaming.id, buttons: GAME_PAD.B })

    emitRaw(bob, 'emu:input', { channelId: lounge.id, buttons: GAME_PAD.A })
    emitRaw(bob, 'emu:input', { channelId: lounge.id, buttons: GAME_PAD.A })
    const last = nextEvent(mia.socket, 'emu:input', (p) => p.buttons === GAME_PAD_MASK)
    emitRaw(bob, 'emu:input', { channelId: lounge.id, buttons: 0xffff })
    await last
    await flush(owner)
    await flush(mia)
    assert.deepEqual(inputs.mia, [
      { channelId: lounge.id, port: 1, buttons: GAME_PAD.A },
      { channelId: lounge.id, port: 1, buttons: GAME_PAD_MASK },
    ])
    assert.deepEqual([inputs.owner, inputs.bob], [[], []])
  })

  test('input with axes over sockets: normalized, relayed on change, absent when centered', async () => {
    inputs.mia.length = 0
    emitRaw(bob, 'emu:input', { channelId: lounge.id, buttons: 0 })
    emitRaw(bob, 'emu:input', { channelId: lounge.id, buttons: 0, axes: [40.4, -300, 0, 0] })
    emitRaw(bob, 'emu:input', { channelId: lounge.id, buttons: 0, axes: [40, -127, 0, 0] }) // same after normalizing
    emitRaw(bob, 'emu:input', { channelId: lounge.id, buttons: 0, axes: 'nope' }) // junk = centered
    const done = nextEvent(mia.socket, 'emu:input', (p) => p.buttons === GAME_PAD.R2)
    emitRaw(bob, 'emu:input', { channelId: lounge.id, buttons: GAME_PAD.R2, axes: [0, 0, 0, 0] })
    await done
    await flush(owner)
    assert.deepEqual(inputs.mia, [
      { channelId: lounge.id, port: 1, buttons: 0 },
      { channelId: lounge.id, port: 1, buttons: 0, axes: [40, -127, 0, 0] },
      { channelId: lounge.id, port: 1, buttons: 0 },
      { channelId: lounge.id, port: 1, buttons: GAME_PAD.R2 },
    ])
    assert.deepEqual([inputs.owner, inputs.bob], [[], []])
    // Back to nothing held for the next tests.
    const zero = nextEvent(mia.socket, 'emu:input', (p) => p.buttons === 0)
    emitRaw(bob, 'emu:input', { channelId: lounge.id, buttons: 0 })
    await zero
  })

  test('input: at most EMU_LIMITS.inputsPerSecond per socket', async () => {
    inputs.mia.length = 0
    clock.t += 5000
    for (let i = 0; i < EMU_LIMITS.inputsPerSecond + 30; i++) {
      emitRaw(bob, 'emu:input', { channelId: lounge.id, buttons: i % 2 === 0 ? GAME_PAD.UP : GAME_PAD.DOWN })
    }
    await flush(bob)
    clock.t += 1000
    const marker = nextEvent(mia.socket, 'emu:input', (p) => p.buttons === GAME_PAD.START)
    emitRaw(bob, 'emu:input', { channelId: lounge.id, buttons: GAME_PAD.START })
    await marker
    assert.equal(inputs.mia.length, EMU_LIMITS.inputsPerSecond + 1)
  })

  test('a player leaving frees their port (the host is told 0); the host leaving closes', async () => {
    emitRaw(bob, 'emu:input', { channelId: lounge.id, buttons: GAME_PAD.RIGHT })
    await nextEvent(mia.socket, 'emu:input', (p) => p.buttons === GAME_PAD.RIGHT)
    const freed = nextEvent(owner.socket, 'emu:session', (s) => s.ports[1] === null)
    const zero = nextEvent(mia.socket, 'emu:input', (p) => p.port === 1 && p.buttons === 0)
    await setVoice(bob, owner, null)
    await freed
    await zero
    const closed = nextEvent(bob.socket, 'emu:session', (s) => s.status === 'closed')
    await setVoice(mia, owner, null)
    assert.equal((await closed).channelId, lounge.id)
    await setVoice(owner, mia, null)
  })

  test('deleting the channel closes its session', async () => {
    const room = await requestOk<Channel>(owner.socket, 'channel:create', { name: 'Retro', type: 'voice' })
    await setVoice(mia, owner, room.id)
    await requestOk<EmuSession>(mia.socket, 'emu:start', { channelId: room.id, system: 'snes', title: 'Mario Kart' })
    const closed = nextEvent(bob.socket, 'emu:session', (s) => s.status === 'closed' && s.channelId === room.id)
    await requestOk(owner.socket, 'channel:delete', { channelId: room.id })
    await closed
  })

  test('stop: host or admins; turning the plugin off closes every session', async () => {
    await setVoice(mia, owner, lounge.id)
    await setVoice(bob, owner, lounge.id)
    await requestOk<EmuSession>(mia.socket, 'emu:start', { channelId: lounge.id, system: 'snes', title: 'Mario' })
    assert.equal(await requestErr(bob.socket, 'emu:stop', { channelId: lounge.id }), EMU_ERRORS.notHost)
    const stopped = nextEvent(owner.socket, 'emu:session', (s) => s.status === 'closed')
    assert.equal(await requestOk(mia.socket, 'emu:stop', { channelId: lounge.id }), null)
    await stopped
    assert.equal(await requestErr(mia.socket, 'emu:stop', { channelId: lounge.id }), EMU_ERRORS.noSession)
    await requestOk<EmuSession>(mia.socket, 'emu:start', { channelId: lounge.id, system: 'snes', title: 'Mario' })
    const closed = nextEvent(owner.socket, 'emu:session', (s) => s.status === 'closed')
    await requestOk(owner.socket, 'plugins:set', { plugin: 'emulator', enabled: false })
    await closed
    assert.equal(await requestErr(mia.socket, 'emu:stop', { channelId: lounge.id }), EMU_ERRORS.pluginOff)
    const late = await join(server.url, 'Later')
    assert.deepEqual(late.boot.emulator, [])
    late.socket.close()
  })
})

after(() => {
  for (const c of clients) c.close()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})
