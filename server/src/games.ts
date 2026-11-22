// Games plugin ("play together", docs/SPEC.md §5.5): one game session per voice channel. A session is a lobby
// (game, host, seated players, bots) that runs matches: the game's pure logic (shared/games/<id>) is created,
// fed the seats' controller input or moves and ticked at the game's rate, and each recipient in the voice
// channel gets the game's view of the state as a `games:frame`. Lobby changes (not frames) are broadcast to
// everyone as `games:lobby` (the sidebar shows who plays what). Memory only. Clock and timers are injectable so
// tests can drive it without waiting.
import { randomBytes } from 'node:crypto'
import type { GameFrame, GameId, GameLobby, GameResult, GameSeat } from '../../shared/protocol.ts'
import { GAME_IDS, GAME_MAX_MATCH_MS, GAME_PAD_MASK, GAME_SEAT_COLORS } from '../../shared/protocol.ts'
import { GAMES } from '../../shared/games/index.ts'
import { seededRandom, type GameContext, type GameDefinition } from '../../shared/games/types.ts'

/** Ack errors of the `games:*` requests (the plugin / channel / voice checks are made by server.ts). */
export const GAME_ERRORS = {
  pluginOff: 'The Games plugin is off',
  channelNotFound: 'Voice channel not found',
  notInChannel: 'Join the voice channel to play',
  unknownGame: 'Unknown game',
  noSession: 'No game is open in this channel',
  notHost: 'Only the host can do that',
  matchRunning: 'A match is running. Stop it first',
  notRunning: 'No match is running',
  full: 'All seats are taken',
  notSeated: "You don't have a seat",
  noBots: 'This game has no computer players',
  invalidBots: 'Invalid number of bots',
  notEnoughPlayers: (min: number) => `This game needs at least ${min} players (bots count)`,
  notYourMatch: "You're not playing in this match",
  invalidAction: 'Invalid move',
  slowDown: 'Slow down',
} as const

export const GAME_LIMITS = {
  /** Catch-up ticks run in one timer wake-up at most (a stalled event loop doesn't fast-forward the game). */
  maxCatchUpTicks: 5,
  /** `games:input` messages per socket per second; more are dropped. */
  inputsPerSecond: 120,
  /** `games:action` + lobby requests per user per 10 s. */
  requestsPer10s: 40,
} as const

export interface GameTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: GameTimers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Someone in a voice channel: the socket that owns their voice state receives frames and sends input. */
export interface GameMember {
  userId: string
  socketId: string
}

export interface GamesOptions {
  /** Every lobby change (server.ts broadcasts it as `games:lobby`). */
  onLobby: (lobby: GameLobby) => void
  /** A frame for these sockets (server.ts emits `games:frame` to them). */
  onFrame: (socketIds: string[], frame: GameFrame) => void
  /** Display name of a user when a match starts. */
  nameOf: (userId: string) => string
  /** Default: Date.now. */
  now?: () => number
  /** Default: setTimeout/clearTimeout (unref'd). */
  timers?: GameTimers
  /** The game registry. Default: shared/games GAMES (tests inject their own). */
  games?: Partial<Record<GameId, GameDefinition<any>>>
  /** Match id + seed generator. Default: random. */
  newId?: () => string
  newSeed?: () => number
  /** Default: GAME_MAX_MATCH_MS. */
  maxMatchMs?: number
}

interface Match {
  id: string
  def: GameDefinition<any>
  state: unknown
  ctx: GameContext
  seats: GameSeat[]
  tick: number
  /** Server time of tick 0. */
  t0: number
  /** Last held buttons and the presses since the previous tick, by seat. */
  held: number[]
  pressed: number[]
  /** Seats whose person left (they send nothing more; their buttons are 0). */
  gone: boolean[]
  lastFrameTick: number
  timer: unknown
}

interface Session {
  channelId: string
  gameId: GameId
  status: 'lobby' | 'playing' | 'finished'
  hostId: string
  players: string[]
  bots: number
  match: Match | null
  result: GameResult | null
  startedAt: number | null
  rev: number
}

export type GameRequestResult = GameLobby | string

export function createGames(options: GamesOptions) {
  const {
    onLobby,
    onFrame,
    nameOf,
    now = Date.now,
    timers = realTimers,
    games = GAMES,
    newId = () => randomBytes(9).toString('base64url'),
    newSeed = () => randomBytes(4).readUInt32LE(0),
    maxMatchMs = GAME_MAX_MATCH_MS,
  } = options

  const sessions = new Map<string, Session>()
  /** channelId -> who is in that voice channel now (from server.ts after every voice change). */
  let members = new Map<string, GameMember[]>()
  /** Server-wide revision counter seeded from the clock (never goes back, like music). */
  let lastRev = Math.max(0, Math.floor(now()))

  const defOf = (id: GameId) => games[id]

  const snapshot = (s: Session): GameLobby => ({
    channelId: s.channelId,
    gameId: s.gameId,
    status: s.status,
    hostId: s.hostId,
    players: [...s.players],
    bots: s.bots,
    matchId: s.match?.id ?? null,
    seats: s.match ? s.match.seats.map((x) => ({ ...x })) : [],
    startedAt: s.startedAt,
    result: s.result,
    rev: s.rev,
  })

  function commit(s: Session): GameLobby {
    s.rev = ++lastRev
    const lobby = snapshot(s)
    onLobby(lobby)
    return lobby
  }

  /** Seats of the next match: max seats for players + bots. */
  const capacity = (s: Session) => defOf(s.gameId)?.maxPlayers ?? 0

  // ---------- matches ----------

  function stopTimer(m: Match) {
    if (m.timer !== undefined) timers.clear(m.timer)
    m.timer = undefined
  }

  function seatOf(m: Match, userId: string): number {
    return m.seats.findIndex((x) => x.userId === userId)
  }

  /** Sends the current view to everyone in the channel (per seat when the game hides information). */
  function sendFrame(s: Session, m: Match) {
    m.lastFrameTick = m.tick
    const list = members.get(s.channelId) ?? []
    if (list.length === 0) return
    const frame = (view: unknown): GameFrame => ({ channelId: s.channelId, matchId: m.id, tick: m.tick, view })
    if (!m.def.perSeatView) {
      onFrame(
        list.map((x) => x.socketId),
        frame(m.def.view(m.state, null)),
      )
      return
    }
    const bySeat = new Map<number | null, string[]>()
    for (const x of list) {
      const i = seatOf(m, x.userId)
      const key = i >= 0 && !m.gone[i] ? i : null
      bySeat.set(key, [...(bySeat.get(key) ?? []), x.socketId])
    }
    for (const [seat, ids] of bySeat) onFrame(ids, frame(m.def.view(m.state, seat)))
  }

  /** The match ended (by the game, the time cap, or everyone leaving): result + last frame, back to `finished`. */
  function finish(s: Session, m: Match, outcome: { winnerSeats: number[]; summary: string }) {
    stopTimer(m)
    sendFrame(s, m)
    s.status = 'finished'
    s.result = {
      winners: outcome.winnerSeats.filter((i) => m.seats[i]).map((i) => ({ ...m.seats[i] })),
      summary: outcome.summary,
    }
    commit(s)
  }

  function runTick(s: Session, m: Match): boolean {
    const def = m.def
    // Bots decide now; their presses are the buttons they didn't hold at the previous tick. People's presses are
    // every button that went down since the previous tick (a tap shorter than a tick is never lost).
    for (let i = 0; i < m.seats.length; i++) {
      if (m.seats[i].userId !== null || m.gone[i]) continue
      if (def.controls === 'pad' && def.bot) {
        const next = def.bot(m.state, i, m.ctx) & GAME_PAD_MASK
        m.pressed[i] = next & ~m.held[i]
        m.held[i] = next
      } else if (def.controls === 'actions' && def.botAction) {
        const move = def.botAction(m.state, i, m.ctx)
        if (move !== null && move !== undefined) def.action?.(m.state, i, move, m.ctx)
      }
    }
    def.tick(m.state, { held: m.held.map((h, i) => (m.gone[i] ? 0 : h)), pressed: m.pressed.map((p, i) => (m.gone[i] ? 0 : p)) }, m.ctx)
    m.pressed = m.pressed.map(() => 0)
    m.tick++
    const outcome = def.result(m.state)
    if (outcome) {
      finish(s, m, outcome)
      return false
    }
    if (now() - m.t0 >= maxMatchMs) {
      finish(s, m, { winnerSeats: [], summary: 'Time is up: nobody wins' })
      return false
    }
    return true
  }

  function schedule(s: Session, m: Match) {
    const dt = m.ctx.dtMs
    const due = m.t0 + (m.tick + 1) * dt
    m.timer = timers.set(() => {
      m.timer = undefined
      if (sessions.get(s.channelId) !== s || s.match !== m || s.status !== 'playing') return
      // Run the ticks that are due by the clock (bounded), then send a frame when one is owed.
      const target = Math.floor((now() - m.t0) / dt)
      let ran = 0
      while (m.tick < target && ran < GAME_LIMITS.maxCatchUpTicks) {
        ran++
        if (!runTick(s, m)) return
      }
      if (m.tick < target) m.t0 = now() - m.tick * dt // too far behind: drop the backlog instead of racing
      if (m.tick - m.lastFrameTick >= (m.def.frameEvery ?? 1)) sendFrame(s, m)
      schedule(s, m)
    }, Math.max(0, due - now()))
  }

  function startMatch(s: Session): GameLobby {
    const def = defOf(s.gameId)!
    if (s.match) stopTimer(s.match)
    const seats: GameSeat[] = []
    for (const userId of s.players) {
      seats.push({ seat: seats.length, userId, name: nameOf(userId), color: GAME_SEAT_COLORS[seats.length % GAME_SEAT_COLORS.length] })
    }
    for (let b = 1; b <= s.bots; b++) {
      seats.push({ seat: seats.length, userId: null, name: `CPU ${b}`, color: GAME_SEAT_COLORS[seats.length % GAME_SEAT_COLORS.length] })
    }
    const ctx: GameContext = { random: seededRandom(newSeed()), dtMs: 1000 / def.tickHz }
    const m: Match = {
      id: newId(),
      def,
      state: def.create(seats, ctx),
      ctx,
      seats,
      tick: 0,
      t0: now(),
      held: seats.map(() => 0),
      pressed: seats.map(() => 0),
      gone: seats.map(() => false),
      lastFrameTick: 0,
      timer: undefined,
    }
    s.match = m
    s.status = 'playing'
    s.result = null
    s.startedAt = m.t0
    const lobby = commit(s)
    sendFrame(s, m)
    schedule(s, m)
    return lobby
  }

  /** A seated person is gone from the running match: the game decides what that means (usually: out). */
  function forfeit(s: Session, userId: string) {
    const m = s.match
    if (!m || s.status !== 'playing') return
    const i = seatOf(m, userId)
    if (i < 0 || m.gone[i]) return
    m.gone[i] = true
    m.held[i] = m.pressed[i] = 0
    m.def.leave(m.state, i, m.ctx)
    // Everyone left: there's nobody to play for.
    if (m.seats.every((x, j) => x.userId === null || m.gone[j])) {
      finish(s, m, { winnerSeats: [], summary: 'Everyone left' })
      return
    }
    const outcome = m.def.result(m.state)
    if (outcome) finish(s, m, outcome)
    else sendFrame(s, m)
  }

  function close(s: Session): void {
    if (s.match) stopTimer(s.match)
    sessions.delete(s.channelId)
    s.rev = ++lastRev
    onLobby({ ...snapshot(s), status: 'closed' })
  }

  /** Removes `userId` from the session (seat, host). Closes it when nobody of the channel is left to host. */
  function dropPlayer(s: Session, userId: string): boolean {
    let changed = false
    if (s.players.includes(userId)) {
      s.players = s.players.filter((id) => id !== userId)
      changed = true
    }
    // The host role moves first, so a lobby the forfeit below broadcasts already names the new host.
    if (s.hostId === userId) {
      const inChannel = (members.get(s.channelId) ?? []).map((x) => x.userId)
      const next = s.players.find((id) => inChannel.includes(id)) ?? inChannel.find((id) => id !== userId)
      if (!next) {
        close(s)
        return false
      }
      s.hostId = next
      changed = true
    }
    if (s.status === 'playing') {
      forfeit(s, userId)
      // A finished match was just broadcast with everything above.
      if (s.status !== 'playing') changed = false
    }
    return changed
  }

  // ---------- requests ----------

  const isHost = (s: Session, userId: string, admin: boolean) => admin || s.hostId === userId

  return {
    /** The channel's session, or null. */
    lobby(channelId: string): GameLobby | null {
      const s = sessions.get(channelId)
      return s ? snapshot(s) : null
    },

    /** Every open session (bootstrap). */
    active(): GameLobby[] {
      return [...sessions.values()].map(snapshot)
    },

    /** `games:open`: a new session with the caller as host and first player, or switch the game (host). */
    open(channelId: string, userId: string, gameId: unknown, admin: boolean): GameRequestResult {
      if (typeof gameId !== 'string' || !(GAME_IDS as readonly string[]).includes(gameId) || !defOf(gameId as GameId)) {
        return GAME_ERRORS.unknownGame
      }
      const id = gameId as GameId
      const def = defOf(id)!
      const s = sessions.get(channelId)
      if (!s) {
        const created: Session = {
          channelId,
          gameId: id,
          status: 'lobby',
          hostId: userId,
          players: [userId],
          bots: 0,
          match: null,
          result: null,
          startedAt: null,
          rev: lastRev,
        }
        sessions.set(channelId, created)
        return commit(created)
      }
      if (!isHost(s, userId, admin)) return GAME_ERRORS.notHost
      if (s.status === 'playing') return GAME_ERRORS.matchRunning
      if (s.gameId === id && s.status === 'lobby') return snapshot(s)
      s.gameId = id
      s.status = 'lobby'
      s.result = null
      if (s.match) stopTimer(s.match)
      s.match = null
      s.startedAt = null
      // Seats beyond the new game's table go (the latest to join first); bots only where the game has them.
      s.players = s.players.slice(0, def.maxPlayers)
      s.bots = def.bots ? Math.max(0, Math.min(s.bots, def.maxPlayers - s.players.length)) : 0
      return commit(s)
    },

    join(channelId: string, userId: string): GameRequestResult {
      const s = sessions.get(channelId)
      if (!s) return GAME_ERRORS.noSession
      if (s.players.includes(userId)) return snapshot(s)
      if (s.status === 'playing') return GAME_ERRORS.matchRunning
      if (s.players.length + s.bots >= capacity(s)) {
        if (s.bots === 0) return GAME_ERRORS.full
        s.bots--
      }
      s.players.push(userId)
      return commit(s)
    },

    leave(channelId: string, userId: string): GameRequestResult {
      const s = sessions.get(channelId)
      if (!s) return GAME_ERRORS.noSession
      if (!s.players.includes(userId)) return GAME_ERRORS.notSeated
      s.players = s.players.filter((id) => id !== userId)
      forfeit(s, userId)
      return sessions.get(channelId) === s ? commit(s) : snapshot(s)
    },

    bots(channelId: string, userId: string, count: unknown, admin: boolean): GameRequestResult {
      const s = sessions.get(channelId)
      if (!s) return GAME_ERRORS.noSession
      if (!isHost(s, userId, admin)) return GAME_ERRORS.notHost
      if (s.status === 'playing') return GAME_ERRORS.matchRunning
      if (!defOf(s.gameId)?.bots) return GAME_ERRORS.noBots
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return GAME_ERRORS.invalidBots
      if (s.players.length + count > capacity(s)) return GAME_ERRORS.full
      if (count === s.bots) return snapshot(s)
      s.bots = count
      return commit(s)
    },

    start(channelId: string, userId: string, admin: boolean): GameRequestResult {
      const s = sessions.get(channelId)
      if (!s) return GAME_ERRORS.noSession
      if (!isHost(s, userId, admin)) return GAME_ERRORS.notHost
      if (s.status === 'playing') return GAME_ERRORS.matchRunning
      const def = defOf(s.gameId)
      if (!def) return GAME_ERRORS.unknownGame
      const total = s.players.length + s.bots
      if (s.players.length === 0 || total < def.minPlayers) return GAME_ERRORS.notEnoughPlayers(def.minPlayers)
      if (total > def.maxPlayers) return GAME_ERRORS.full
      return startMatch(s)
    },

    stop(channelId: string, userId: string, admin: boolean): GameRequestResult {
      const s = sessions.get(channelId)
      if (!s) return GAME_ERRORS.noSession
      if (!isHost(s, userId, admin)) return GAME_ERRORS.notHost
      if (s.status !== 'playing' || !s.match) return GAME_ERRORS.notRunning
      stopTimer(s.match)
      s.status = 'lobby'
      s.result = null
      return commit(s)
    },

    close(channelId: string, userId: string, admin: boolean): string | null {
      const s = sessions.get(channelId)
      if (!s) return GAME_ERRORS.noSession
      if (!isHost(s, userId, admin)) return GAME_ERRORS.notHost
      close(s)
      return null
    },

    /** `games:input`: the caller's held buttons in the running match (ignored when not seated / stale). */
    input(channelId: string, userId: string, matchId: unknown, buttons: unknown): void {
      const s = sessions.get(channelId)
      const m = s?.match
      if (!s || !m || s.status !== 'playing' || m.id !== matchId || m.def.controls !== 'pad') return
      if (typeof buttons !== 'number' || !Number.isInteger(buttons)) return
      const i = seatOf(m, userId)
      if (i < 0 || m.gone[i]) return
      const next = buttons & GAME_PAD_MASK
      m.pressed[i] |= next & ~m.held[i]
      m.held[i] = next
    },

    /** `games:action`: one move of an `actions` game. null when applied, else the error. */
    action(channelId: string, userId: string, matchId: unknown, action: unknown): string | null {
      const s = sessions.get(channelId)
      const m = s?.match
      if (!s || !m || s.status !== 'playing' || m.id !== matchId) return GAME_ERRORS.notRunning
      if (m.def.controls !== 'actions' || !m.def.action) return GAME_ERRORS.invalidAction
      const i = seatOf(m, userId)
      if (i < 0 || m.gone[i]) return GAME_ERRORS.notYourMatch
      const error = m.def.action(m.state, i, action, m.ctx)
      if (error) return error
      const outcome = m.def.result(m.state)
      if (outcome) finish(s, m, outcome)
      else sendFrame(s, m)
      return null
    },

    /**
     * Who is in which voice channel now (after every voice state change). People who left a channel lose their
     * seat (forfeit when playing) and the host role; a session whose channel emptied closes. Someone whose voice
     * socket changed (another device took over) keeps their seat: frames simply go to the new socket.
     */
    setMembers(next: Map<string, GameMember[]>) {
      members = next
      for (const s of [...sessions.values()]) {
        const here = new Set((members.get(s.channelId) ?? []).map((x) => x.userId))
        if (here.size === 0) {
          close(s)
          continue
        }
        let changed = false
        const gone = new Set([...s.players, s.hostId].filter((id) => !here.has(id)))
        // Seated in the running match but no longer in the lobby's players (left earlier) are already handled.
        if (s.match && s.status === 'playing') for (const x of s.match.seats) if (x.userId && !here.has(x.userId)) gone.add(x.userId)
        for (const id of gone) {
          if (dropPlayer(s, id)) changed = true
          if (sessions.get(s.channelId) !== s) break
        }
        if (changed && sessions.get(s.channelId) === s) commit(s)
      }
    },

    /** Ends a channel's session (channel deleted). */
    drop(channelId: string) {
      const s = sessions.get(channelId)
      if (s) close(s)
    },

    /** Ends every session (the plugin was turned off). */
    clearAll() {
      for (const s of [...sessions.values()]) close(s)
    },

    /** Stops every match timer and forgets all sessions, without broadcasting (server shutdown). */
    shutdown() {
      for (const s of sessions.values()) if (s.match) stopTimer(s.match)
      sessions.clear()
    },
  }
}

export type Games = ReturnType<typeof createGames>
