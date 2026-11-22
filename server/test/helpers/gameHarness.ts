// Drives a game definition (shared/games/<id>/logic.ts) exactly like server/src/games.ts does, without sockets
// or timers, and checks the contract every game must keep (shared/games/types.ts). Used by games.test.ts for
// every registered game and by each game's own tests (games-<id>.test.ts).
import assert from 'node:assert/strict'
import type { GameSeat } from '../../../shared/protocol.ts'
import { GAME_PAD_MASK, GAME_SEAT_COLORS } from '../../../shared/protocol.ts'
import { seededRandom, type GameContext, type GameDefinition, type GameOutcome } from '../../../shared/games/types.ts'

/** Seats: `humans` people (userId p0, p1…) then bots (CPU 1…). */
export function makeSeats(humans: number, bots: number): GameSeat[] {
  const seats: GameSeat[] = []
  for (let i = 0; i < humans + bots; i++) {
    const human = i < humans
    seats.push({
      seat: i,
      userId: human ? `p${i}` : null,
      name: human ? `Player ${i + 1}` : `CPU ${i - humans + 1}`,
      color: GAME_SEAT_COLORS[i % GAME_SEAT_COLORS.length],
    })
  }
  return seats
}

export interface Sim<S> {
  def: GameDefinition<S>
  state: S
  ctx: GameContext
  seats: GameSeat[]
  tick: number
  held: number[]
  pressed: number[]
  gone: boolean[]
  /** Set a person's held buttons (like `games:input`). */
  input(seat: number, buttons: number): void
  /** A person's move (like `games:action`): the game's error or null. */
  action(seat: number, action: unknown): string | null
  /** Run one tick (bots decide first, like the server). */
  step(): void
  /** Run up to `ticks` ticks, stopping at the result. Returns it (or null). */
  run(ticks: number, each?: (sim: Sim<S>) => void): GameOutcome | null
  leave(seat: number): void
  view(seat: number | null): unknown
  result(): GameOutcome | null
}

export function simulate<S>(def: GameDefinition<S>, seats: GameSeat[], seed = 1): Sim<S> {
  const ctx: GameContext = { random: seededRandom(seed), dtMs: 1000 / def.tickHz }
  const sim: Sim<S> = {
    def,
    state: def.create(seats, ctx),
    ctx,
    seats,
    tick: 0,
    held: seats.map(() => 0),
    pressed: seats.map(() => 0),
    gone: seats.map(() => false),
    input(seat, buttons) {
      const next = buttons & GAME_PAD_MASK
      sim.pressed[seat] |= next & ~sim.held[seat]
      sim.held[seat] = next
    },
    action(seat, action) {
      assert.ok(def.action, `${def.id} has no action()`)
      return def.action(sim.state, seat, action, ctx)
    },
    step() {
      for (let i = 0; i < seats.length; i++) {
        if (seats[i].userId !== null || sim.gone[i]) continue
        if (def.controls === 'pad' && def.bot) {
          const next = def.bot(sim.state, i, ctx) & GAME_PAD_MASK
          sim.pressed[i] = next & ~sim.held[i]
          sim.held[i] = next
        } else if (def.controls === 'actions' && def.botAction) {
          const move = def.botAction(sim.state, i, ctx)
          if (move !== null && move !== undefined) def.action?.(sim.state, i, move, ctx)
        }
      }
      def.tick(
        sim.state,
        { held: sim.held.map((h, i) => (sim.gone[i] ? 0 : h)), pressed: sim.pressed.map((p, i) => (sim.gone[i] ? 0 : p)) },
        ctx,
      )
      sim.pressed = sim.pressed.map(() => 0)
      sim.tick++
    },
    run(ticks, each) {
      for (let n = 0; n < ticks; n++) {
        const r = def.result(sim.state)
        if (r) return r
        each?.(sim)
        sim.step()
      }
      return def.result(sim.state)
    },
    leave(seat) {
      sim.gone[seat] = true
      sim.held[seat] = sim.pressed[seat] = 0
      def.leave(sim.state, seat, ctx)
    },
    view: (seat) => def.view(sim.state, seat),
    result: () => def.result(sim.state),
  }
  return sim
}

/** Largest frame a game may send (JSON bytes). */
export const MAX_VIEW_BYTES = 16 * 1024

/** Checks a view: JSON round-trips unchanged (no undefined, NaN, functions, class instances) and is small. */
export function assertViewOk(view: unknown, what: string) {
  const json = JSON.stringify(view)
  assert.ok(json !== undefined, `${what}: view is not serializable`)
  assert.ok(json.length <= MAX_VIEW_BYTES, `${what}: view is ${json.length} bytes (max ${MAX_VIEW_BYTES})`)
  assert.deepEqual(JSON.parse(json), view, `${what}: view changes through JSON (undefined, NaN, Infinity, class instances?)`)
}

/** A random controller masher for "people" seats. */
export function masher(seed: number) {
  const rnd = seededRandom(seed)
  let current = 0
  return () => {
    if (rnd() < 0.15) current = Math.floor(rnd() * (GAME_PAD_MASK + 1))
    return current
  }
}

function assertOutcome(def: GameDefinition<any>, seats: GameSeat[], r: GameOutcome, what: string) {
  assert.ok(Array.isArray(r.winnerSeats), `${what}: winnerSeats`)
  for (const w of r.winnerSeats) assert.ok(Number.isInteger(w) && w >= 0 && w < seats.length, `${what}: bad winner seat ${w}`)
  assert.equal(new Set(r.winnerSeats).size, r.winnerSeats.length, `${what}: duplicate winners`)
  assert.ok(typeof r.summary === 'string' && r.summary.length > 0 && r.summary.length <= 120, `${what}: summary`)
  void def
}

/**
 * The contract checks every game must pass (games.test.ts runs them for each registered game):
 * metadata sane; views serializable and small for every seat and spectators; deterministic for a seed;
 * a match with bots (or mashing people when the game has no bots) ends on its own within `maxMinutes` of game
 * time; people leaving mid-match never breaks it and the last one standing case ends it; untrusted actions
 * never throw.
 */
export function checkGameContract(def: GameDefinition<any>, opts: { maxMinutes?: number } = {}) {
  const maxTicks = Math.ceil((opts.maxMinutes ?? 15) * 60 * def.tickHz)
  const what = def.id

  // Metadata.
  assert.ok(def.name && def.tagline, `${what}: name/tagline`)
  assert.ok(def.minPlayers >= 1 && def.minPlayers <= def.maxPlayers && def.maxPlayers <= 8, `${what}: player counts`)
  assert.ok(def.tickHz >= 1 && def.tickHz <= 60, `${what}: tickHz`)
  assert.ok(Array.isArray(def.help) && def.help.length > 0, `${what}: help`)
  if (def.bots) assert.ok(def.controls === 'pad' ? def.bot : def.botAction, `${what}: bots: true needs bot/botAction`)
  if (def.controls === 'actions') assert.ok(def.action, `${what}: actions games need action()`)

  // Garbage moves never throw and are refused.
  if (def.action) {
    const sim = simulate(def, makeSeats(def.maxPlayers, 0), 3)
    for (const junk of [null, undefined, 42, 'x', [], {}, { type: 'nope' }, { card: -1 }, { type: 'play', index: 1e9 }]) {
      for (let seat = 0; seat < def.maxPlayers; seat++) {
        const err = sim.action(seat, junk)
        assert.ok(typeof err === 'string' && err.length > 0, `${what}: junk move ${JSON.stringify(junk)} should be refused`)
      }
    }
  }

  // A full match: one mashing person and bots (actions games: all bots), or, without bots, mashing people.
  const playSeats = !def.bots
    ? makeSeats(def.maxPlayers, 0)
    : def.controls === 'pad'
      ? makeSeats(1, def.maxPlayers - 1)
      : makeSeats(0, def.maxPlayers)
  const mash = playSeats.map((_, i) => masher(100 + i))
  const views: string[] = []
  const sim = simulate(def, playSeats, 7)
  const result = sim.run(maxTicks, (s) => {
    for (const seat of s.seats) if (seat.userId !== null && def.controls === 'pad') s.input(seat.seat, mash[seat.seat]())
    if (s.tick % Math.max(1, Math.round(def.tickHz)) === 0) {
      const spectator = s.view(null)
      assertViewOk(spectator, `${what} spectator view at tick ${s.tick}`)
      views.push(JSON.stringify(spectator))
      if (def.perSeatView) for (const seat of s.seats) assertViewOk(s.view(seat.seat), `${what} seat ${seat.seat} view at tick ${s.tick}`)
    }
  })
  if (def.controls === 'pad' || def.bots) {
    assert.ok(result, `${what}: a match didn't end within ${maxTicks} ticks (${opts.maxMinutes ?? 15} min). Games need a time limit / sudden death.`)
    assertOutcome(def, playSeats, result, what)
    assertViewOk(sim.view(null), `${what} final view`)
  }

  // Deterministic: the same seed and inputs give the same views.
  const again = simulate(def, playSeats, 7)
  const mash2 = playSeats.map((_, i) => masher(100 + i))
  const views2: string[] = []
  again.run(maxTicks, (s) => {
    for (const seat of s.seats) if (seat.userId !== null && def.controls === 'pad') s.input(seat.seat, mash2[seat.seat]())
    if (s.tick % Math.max(1, Math.round(def.tickHz)) === 0) views2.push(JSON.stringify(s.view(null)))
  })
  assert.deepEqual(views2, views, `${what}: not deterministic (use ctx.random, never Math.random / Date.now)`)

  // People leaving: everyone but one leaves early; the match must end (the last one wins or it ends).
  if (def.minPlayers >= 2 || def.maxPlayers >= 2) {
    const n = Math.max(2, def.minPlayers)
    const leaveSim = simulate(def, makeSeats(n, 0), 11)
    leaveSim.run(def.tickHz * 3)
    for (let seat = 1; seat < n; seat++) leaveSim.leave(seat)
    assertViewOk(leaveSim.view(null), `${what} view after leaves`)
    if (def.perSeatView) assertViewOk(leaveSim.view(0), `${what} seat view after leaves`)
    const r = leaveSim.run(maxTicks)
    if (def.minPlayers >= 2) {
      assert.ok(r, `${what}: with everyone else gone, the match should end`)
      assertOutcome(def, leaveSim.seats, r, `${what} after leaves`)
      assert.ok(r.winnerSeats.length === 0 || r.winnerSeats.every((w) => w === 0), `${what}: only the remaining seat can win`)
    }
  }
}
