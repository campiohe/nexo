// Games plugin (docs/SPEC.md §5.5): the session manager (games.ts) with a fake clock, fake timers and a tiny
// test game, the socket events through an in-process server, and the contract checks for every registered
// game (shared/games). Each game also has its own games-<id>.test.ts. Run with `npm test -w server`.
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
  GameFrame,
  GameLobby,
  ServerPlugins,
  ServerToClientEvents,
  VoiceState,
} from '../../shared/protocol.ts'
import { GAME_IDS, GAME_PAD } from '../../shared/protocol.ts'
import { GAMES } from '../../shared/games/index.ts'
import type { GameDefinition } from '../../shared/games/types.ts'
import { createGames, GAME_ERRORS, type GameMember, type GameTimers } from '../src/games.ts'
import { start, type NexoInstance, type StartOptions } from '../src/server.ts'
import { checkGameContract } from './helpers/gameHarness.ts'

// ---------- fakes ----------

function fakeTime(start = 1_700_000_000_000) {
  const clock = { t: start }
  const pending = new Map<number, { at: number; fn: () => void }>()
  let nextId = 0
  const timers: GameTimers = {
    set(fn, ms) {
      const id = ++nextId
      pending.set(id, { at: clock.t + Math.max(0, ms), fn })
      return id
    },
    clear: (h) => void pending.delete(h as number),
  }
  return {
    clock,
    now: () => clock.t,
    timers,
    pending: () => pending.size,
    advance(ms: number) {
      const target = clock.t + ms
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | undefined
        for (const e of pending) if (e[1].at <= target && (!due || e[1].at < due[1].at)) due = e
        if (!due) break
        pending.delete(due[0])
        clock.t = Math.max(clock.t, due[1].at)
        due[1].fn()
      }
      clock.t = target
    },
  }
}

/**
 * Test game "race": every seat has a position; RIGHT held moves +1 per tick, A pressed jumps +5. First to 100
 * wins. Bots hold RIGHT. Leaving drops you; the last one left wins. 10 Hz.
 */
interface RaceState {
  pos: number[]
  out: boolean[]
  winner: number | null
  log: string[]
}
const race: GameDefinition<RaceState> = {
  id: 'bomber',
  name: 'Race',
  tagline: 'Test game',
  minPlayers: 2,
  maxPlayers: 3,
  bots: true,
  controls: 'pad',
  help: [['Right', 'Run']],
  tickHz: 10,
  perSeatView: false,
  create: (seats) => ({ pos: seats.map(() => 0), out: seats.map(() => false), winner: null, log: [] }),
  tick(s, input) {
    for (let i = 0; i < s.pos.length; i++) {
      if (s.out[i]) continue
      if (input.held[i] & GAME_PAD.RIGHT) s.pos[i]++
      if (input.pressed[i] & GAME_PAD.A) s.pos[i] += 5
      if (s.pos[i] >= 100 && s.winner === null) s.winner = i
    }
  },
  bot: () => GAME_PAD.RIGHT,
  leave(s, seat) {
    s.out[seat] = true
    const left = s.out.flatMap((o, i) => (o ? [] : [i]))
    if (left.length === 1 && s.winner === null) s.winner = left[0]
  },
  view: (s) => ({ pos: s.pos, out: s.out }),
  result: (s) => (s.winner === null ? null : { winnerSeats: [s.winner], summary: `Seat ${s.winner} wins` }),
}

/** Test card-ish game "count": actions { add: 1..3 } in turn; whoever reaches 10 wins. Per-seat views. */
interface CountState {
  total: number
  turn: number
  n: number
  winner: number | null
}
const count: GameDefinition<CountState> = {
  id: 'cards',
  name: 'Count',
  tagline: 'Test game',
  minPlayers: 2,
  maxPlayers: 2,
  bots: true,
  controls: 'actions',
  help: [['Click', 'Add']],
  tickHz: 5,
  perSeatView: true,
  create: (seats) => ({ total: 0, turn: 0, n: seats.length, winner: null }),
  tick() {},
  action(s, seat, a) {
    if (seat !== s.turn) return 'Not your turn'
    const add = (a as { add?: unknown } | null)?.add
    if (add !== 1 && add !== 2 && add !== 3) return 'Invalid move'
    s.total += add
    if (s.total >= 10) s.winner = seat
    s.turn = (s.turn + 1) % s.n
    return null
  },
  botAction: (s, seat) => (s.turn === seat ? { add: 1 } : null),
  leave(s, seat) {
    if (s.winner === null) s.winner = 1 - seat
  },
  view: (s, seat) => ({ total: s.total, turn: s.turn, you: seat }),
  result: (s) => (s.winner === null ? null : { winnerSeats: [s.winner], summary: `Seat ${s.winner} wins` }),
}

// ---------- session manager ----------

describe('games session manager', () => {
  let time: ReturnType<typeof fakeTime>
  let lobbies: GameLobby[]
  let frames: { to: string[]; frame: GameFrame }[]
  let games: ReturnType<typeof createGames>
  const CH = 'ch1'
  const members = (...ids: string[]) => new Map<string, GameMember[]>([[CH, ids.map((id) => ({ userId: id, socketId: `s-${id}` }))]])
  const lobby = (r: GameLobby | string): GameLobby => {
    if (typeof r === 'string') assert.fail(`unexpected error: ${r}`)
    return r
  }

  beforeEach(() => {
    time = fakeTime()
    lobbies = []
    frames = []
    let id = 0
    games = createGames({
      onLobby: (l) => lobbies.push(l),
      onFrame: (to, frame) => frames.push({ to, frame }),
      nameOf: (u) => u.toUpperCase(),
      now: time.now,
      timers: time.timers,
      games: { bomber: race, cards: count },
      newId: () => `m${++id}`,
      newSeed: () => 42,
    })
    games.setMembers(members('ana', 'bo', 'cy'))
  })

  test('open, join, bots, start: seats in join order then bots, colors per seat', () => {
    let l = lobby(games.open(CH, 'ana', 'bomber', false))
    assert.equal(l.status, 'lobby')
    assert.equal(l.hostId, 'ana')
    assert.deepEqual(l.players, ['ana'])
    assert.equal(games.open(CH, 'ana', 'nope', false), GAME_ERRORS.unknownGame)
    assert.equal(games.open(CH, 'ana', 'kart', false), GAME_ERRORS.unknownGame) // not in this registry
    l = lobby(games.join(CH, 'bo'))
    assert.deepEqual(l.players, ['ana', 'bo'])
    assert.equal(games.bots(CH, 'bo', 1, false), GAME_ERRORS.notHost)
    assert.equal(games.bots(CH, 'ana', 2, false), GAME_ERRORS.full)
    assert.equal(games.bots(CH, 'ana', -1, false), GAME_ERRORS.invalidBots)
    l = lobby(games.bots(CH, 'ana', 1, false))
    assert.equal(l.bots, 1)
    // Table full: joining takes a bot's seat.
    l = lobby(games.join(CH, 'cy'))
    assert.deepEqual([l.players, l.bots], [['ana', 'bo', 'cy'], 0])
    lobby(games.leave(CH, 'cy'))
    lobby(games.bots(CH, 'ana', 1, false))
    assert.equal(games.start(CH, 'bo', false), GAME_ERRORS.notHost)
    l = lobby(games.start(CH, 'ana', false))
    assert.equal(l.status, 'playing')
    assert.equal(l.matchId, 'm1')
    assert.deepEqual(
      l.seats.map((s) => [s.seat, s.userId, s.name]),
      [
        [0, 'ana', 'ANA'],
        [1, 'bo', 'BO'],
        [2, null, 'CPU 1'],
      ],
    )
    assert.notEqual(l.seats[0].color, l.seats[1].color)
    // The first frame goes out at once, to everyone in the channel (spectators too).
    assert.equal(frames.length, 1)
    assert.deepEqual(frames[0].to.sort(), ['s-ana', 's-bo', 's-cy'])
    assert.equal(frames[0].frame.tick, 0)
    assert.equal(games.join(CH, 'cy'), GAME_ERRORS.matchRunning)
  })

  test('min players counts bots; one person alone needs bots', () => {
    games.open(CH, 'ana', 'bomber', false)
    assert.equal(games.start(CH, 'ana', false), GAME_ERRORS.notEnoughPlayers(2))
    games.bots(CH, 'ana', 1, false)
    assert.equal(lobby(games.start(CH, 'ana', false)).status, 'playing')
  })

  test('ticks on the clock, input held / pressed, frames every tick, result ends the match', () => {
    games.open(CH, 'ana', 'bomber', false)
    games.join(CH, 'bo')
    const l = lobby(games.start(CH, 'ana', false))
    games.input(CH, 'ana', l.matchId, GAME_PAD.RIGHT)
    games.input(CH, 'bo', 'stale-match', GAME_PAD.RIGHT) // ignored
    games.input(CH, 'cy', l.matchId, GAME_PAD.RIGHT) // not seated: ignored
    time.advance(1000) // 10 ticks
    const last = frames[frames.length - 1].frame
    assert.equal(last.tick, 10)
    assert.deepEqual((last.view as { pos: number[] }).pos, [10, 0])
    // A tap shorter than a tick still counts once.
    games.input(CH, 'bo', l.matchId, GAME_PAD.A)
    games.input(CH, 'bo', l.matchId, 0)
    time.advance(100)
    assert.deepEqual((frames[frames.length - 1].frame.view as { pos: number[] }).pos, [11, 5])
    time.advance(9000) // ana reaches 100
    const done = lobbies[lobbies.length - 1]
    assert.equal(done.status, 'finished')
    assert.deepEqual(done.result?.winners.map((w) => w.userId), ['ana'])
    assert.equal(done.result?.summary, 'Seat 0 wins')
    const n = frames.length
    time.advance(5000)
    assert.equal(frames.length, n, 'no frames after the end')
    assert.equal(time.pending(), 0)
    // Play again: a new match id.
    assert.equal(lobby(games.start(CH, 'ana', false)).matchId, 'm2')
  })

  test('a stalled clock catches up a few ticks at most, then drops the backlog', () => {
    games.open(CH, 'ana', 'bomber', false)
    games.join(CH, 'bo')
    const l = lobby(games.start(CH, 'ana', false))
    games.input(CH, 'ana', l.matchId, GAME_PAD.RIGHT)
    time.clock.t += 5000 // the event loop was blocked for 5 s
    time.advance(0)
    assert.equal(frames[frames.length - 1].frame.tick, 5)
    time.advance(100)
    assert.equal(frames[frames.length - 1].frame.tick, 6)
  })

  test('leaving mid-match forfeits; the game decides the winner; host moves on', () => {
    games.open(CH, 'ana', 'bomber', false)
    games.join(CH, 'bo')
    lobby(games.start(CH, 'ana', false))
    time.advance(300)
    // ana leaves the voice channel: forfeits, bo is the last one and wins; bo becomes host.
    games.setMembers(members('bo', 'cy'))
    const l = lobbies[lobbies.length - 1]
    assert.equal(l.status, 'finished')
    assert.deepEqual(l.result?.winners.map((w) => w.userId), ['bo'])
    assert.equal(l.hostId, 'bo')
    assert.deepEqual(l.players, ['bo'])
  })

  test('host leaving the channel passes the role to a player, then to anyone; empty channel closes', () => {
    games.open(CH, 'ana', 'bomber', false)
    games.join(CH, 'cy')
    games.setMembers(members('bo', 'cy'))
    assert.equal(lobbies[lobbies.length - 1].hostId, 'cy')
    games.leave(CH, 'cy')
    games.setMembers(members('bo'))
    assert.equal(lobbies[lobbies.length - 1].hostId, 'bo')
    games.setMembers(new Map())
    assert.equal(lobbies[lobbies.length - 1].status, 'closed')
    assert.equal(games.lobby(CH), null)
    assert.deepEqual(games.active(), [])
  })

  test('switching games keeps players that fit; not while playing', () => {
    games.open(CH, 'ana', 'bomber', false)
    games.join(CH, 'bo')
    games.join(CH, 'cy')
    let l = lobby(games.open(CH, 'ana', 'cards', false))
    assert.deepEqual([l.gameId, l.players], ['cards', ['ana', 'bo']])
    l = lobby(games.start(CH, 'ana', false))
    assert.equal(games.open(CH, 'ana', 'bomber', false), GAME_ERRORS.matchRunning)
    assert.equal(games.open(CH, 'bo', 'bomber', false), GAME_ERRORS.notHost)
    // An admin may do host things.
    assert.equal(lobby(games.stop(CH, 'cy', true)).status, 'lobby')
  })

  test('actions games: moves, per-seat views, bots move on ticks', () => {
    games.open(CH, 'ana', 'cards', false)
    games.bots(CH, 'ana', 1, false)
    const l = lobby(games.start(CH, 'ana', false))
    // Per seat: ana sees you: 0, the others spectate (you: null).
    const first = frames.filter((f) => f.frame.tick === 0)
    assert.deepEqual(
      first.map((f) => [f.to.sort(), (f.frame.view as { you: number | null }).you]),
      [
        [['s-ana'], 0],
        [['s-bo', 's-cy'], null],
      ],
    )
    assert.equal(games.action(CH, 'bo', l.matchId, { add: 1 }), GAME_ERRORS.notYourMatch)
    assert.equal(games.action(CH, 'ana', l.matchId, { add: 9 }), 'Invalid move')
    assert.equal(games.action(CH, 'ana', 'old', { add: 1 }), GAME_ERRORS.notRunning)
    assert.equal(games.action(CH, 'ana', l.matchId, { add: 3 }), null)
    assert.equal(games.action(CH, 'ana', l.matchId, { add: 3 }), 'Not your turn')
    time.advance(200) // the bot adds 1
    assert.equal((frames[frames.length - 1].frame.view as { total: number }).total, 4)
    games.action(CH, 'ana', l.matchId, { add: 3 }) // 7
    time.advance(200) // 8
    games.action(CH, 'ana', l.matchId, { add: 3 }) // 11: ana wins
    assert.deepEqual(lobbies[lobbies.length - 1].result?.winners.map((w) => w.userId), ['ana'])
  })

  test('the time cap ends a match without a winner', () => {
    const capped = createGames({
      onLobby: (l) => lobbies.push(l),
      onFrame: () => {},
      nameOf: (u) => u,
      now: time.now,
      timers: time.timers,
      games: { bomber: { ...race, bot: () => 0 } },
      maxMatchMs: 2000,
    })
    capped.setMembers(members('ana'))
    capped.open(CH, 'ana', 'bomber', false)
    capped.bots(CH, 'ana', 1, false)
    capped.start(CH, 'ana', false)
    time.advance(2500)
    const l = lobbies[lobbies.length - 1]
    assert.equal(l.status, 'finished')
    assert.deepEqual(l.result?.winners, [])
  })

  test('clearAll and drop close sessions with a closed lobby', () => {
    games.open(CH, 'ana', 'bomber', false)
    games.clearAll()
    assert.equal(lobbies[lobbies.length - 1].status, 'closed')
    assert.equal(games.lobby(CH), null)
  })
})

// ---------- every registered game keeps the contract ----------

describe('registered games keep the contract', () => {
  for (const id of GAME_IDS) {
    test(`${id}: ${GAMES[id].name}`, () => checkGameContract(GAMES[id]))
  }
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
async function setVoice(conn: Conn, observer: Conn, channelId: string | null) {
  const seen = nextEvent(observer.socket, 'voice:states', (states: VoiceState[]) => {
    const s = states.find((v) => v.userId === conn.id)
    return channelId === null ? !s : s?.channelId === channelId
  })
  ;(conn.socket as unknown as { emit(e: string, p: unknown): void }).emit('voice:state', {
    channelId,
    muted: false,
    deafened: false,
    camera: false,
    streaming: false,
  })
  await seen
}
const emitRaw = (c: Conn, e: string, p: unknown) => (c.socket as unknown as { emit(e: string, p: unknown): void }).emit(e, p)

describe('games over sockets', () => {
  let time: ReturnType<typeof fakeTime>
  let server: NexoInstance
  let owner: Conn
  let mia: Conn
  let bob: Conn
  let lounge: Channel

  before(async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'nexo-games-'))
    tmpDirs.push(dataDir)
    time = fakeTime()
    const opts: Partial<StartOptions> = {
      now: time.now,
      gameTimers: time.timers,
      gameRegistry: { bomber: race, cards: count },
      gameLimit: { count: 1000, windowMs: 1000 },
    }
    server = await start({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      serverName: 'Test Space',
      serverPassword: '',
      livekit: { apiKey: 'testkey', apiSecret: 'test-secret-that-is-at-least-32-characters-long', publicUrl: '', port: 7880 },
      log: false,
      ...opts,
    })
    owner = await join(server.url, 'Olivia')
    mia = await join(server.url, 'Mia')
    bob = await join(server.url, 'Bob')
    lounge = owner.boot.channels.find((c) => c.name === 'Lounge')!
  })
  after(() => server.close())

  test('plugin off by default; requests refused', async () => {
    assert.deepEqual(owner.boot.plugins, { music: false, games: false, emulator: false })
    assert.deepEqual(owner.boot.games, [])
    await setVoice(mia, owner, lounge.id)
    assert.equal(await requestErr(mia.socket, 'games:open', { channelId: lounge.id, gameId: 'bomber' }), GAME_ERRORS.pluginOff)
  })

  test('turn it on; voice checks; open → join → start → frames → input', async () => {
    const changed = nextEvent(bob.socket, 'plugins:changed')
    assert.deepEqual(await requestOk<ServerPlugins>(owner.socket, 'plugins:set', { plugin: 'games', enabled: true }), {
      music: false,
      games: true,
      emulator: false,
    })
    assert.deepEqual(await changed, { music: false, games: true, emulator: false })
    assert.equal(await requestErr(bob.socket, 'games:open', { channelId: lounge.id, gameId: 'bomber' }), GAME_ERRORS.notInChannel)
    // Another device of Mia (not the voice-owning socket) can't play either.
    const mia2 = await connect(server.url, { token: mia.token })
    assert.equal(await requestErr(mia2.socket, 'games:open', { channelId: lounge.id, gameId: 'bomber' }), GAME_ERRORS.notInChannel)
    mia2.socket.close()

    const seenByBob = nextEvent(bob.socket, 'games:lobby')
    let l = await requestOk<GameLobby>(mia.socket, 'games:open', { channelId: lounge.id, gameId: 'bomber' })
    assert.deepEqual(await seenByBob, l)
    await setVoice(bob, owner, lounge.id)
    l = await requestOk<GameLobby>(bob.socket, 'games:join', { channelId: lounge.id })
    assert.deepEqual(l.players, [mia.id, bob.id])
    const late = await join(server.url, 'Late')
    assert.deepEqual(late.boot.games, [l])
    late.socket.close()

    const firstFrame = nextEvent(bob.socket, 'games:frame')
    l = await requestOk<GameLobby>(mia.socket, 'games:start', { channelId: lounge.id })
    assert.equal(l.status, 'playing')
    const f0 = await firstFrame
    assert.deepEqual([f0.matchId, f0.tick], [l.matchId, 0])

    emitRaw(mia, 'games:input', { channelId: lounge.id, matchId: l.matchId, buttons: GAME_PAD.RIGHT })
    // Let the input arrive, then run 3 ticks.
    await requestOk(mia.socket, 'time:now', {})
    const f3 = nextEvent(bob.socket, 'games:frame', (f) => f.tick === 3)
    time.advance(300)
    assert.deepEqual((await f3).view, { pos: [3, 0], out: [false, false] })
  })

  test('leaving voice forfeits and ends the match; empty channel closes the session', async () => {
    const finished = nextEvent(owner.socket, 'games:lobby', (l) => l.status === 'finished')
    await setVoice(mia, owner, null)
    const l = await finished
    assert.deepEqual(l.result?.winners.map((w) => w.userId), [bob.id])
    assert.equal(l.hostId, bob.id)
    const closed = nextEvent(owner.socket, 'games:lobby', (x) => x.status === 'closed')
    await setVoice(bob, owner, null)
    await closed
  })

  test('turning the plugin off closes sessions', async () => {
    await setVoice(mia, owner, lounge.id)
    await requestOk<GameLobby>(mia.socket, 'games:open', { channelId: lounge.id, gameId: 'cards' })
    const closed = nextEvent(owner.socket, 'games:lobby', (x) => x.status === 'closed')
    await requestOk(owner.socket, 'plugins:set', { plugin: 'games', enabled: false })
    await closed
  })
})

after(() => {
  for (const c of clients) c.close()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})
