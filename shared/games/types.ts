// The contract every game of the Games plugin implements (docs/SPEC.md §5.5). A game is pure, deterministic
// logic: the server (server/src/games.ts) creates its state, feeds it controller input or moves, ticks it at
// `tickHz`, and sends each recipient `view(state, seat)`. The desktop app only draws views
// (desktop/src/renderer/src/games/<id>/View.tsx) and sends input.
//
// Rules for game modules (they run in Node with native type stripping AND in the renderer bundle):
// - No Node or DOM APIs, no imports outside shared/ (relative imports with the `.ts` extension, `import type`
//   for types), only erasable TypeScript (no enums, namespaces or constructor parameter properties).
// - Deterministic: randomness only from `ctx.random()`, time only from ticks (`ctx.dtMs` per tick). Never
//   Math.random() or Date.now().
// - Everything untrusted (an `action`) is validated; a bad one returns an error text and changes nothing.
// - State is plain data the module mutates in place. Views are compact JSON (no class instances, no
//   functions, no undefined in arrays; prefer small integers; keep a frame well under 16 KB).
import type { GameId, GameSeat } from '../protocol.ts'

export interface GameContext {
  /** Deterministic random number in [0, 1) (seeded per match). */
  random(): number
  /** Milliseconds per tick (1000 / tickHz). */
  dtMs: number
}

export interface TickInput {
  /** Buttons (GAME_PAD bits) each seat holds at this tick, by seat. Bots: from `bot`. Gone players: 0. */
  held: readonly number[]
  /**
   * Buttons each seat pressed down since the previous tick, by seat: a tap shorter than a tick still shows up
   * here even though `held` may already be 0 again. Use it for one-shot actions (drop a bomb, jump, attack).
   */
  pressed: readonly number[]
}

export interface GameOutcome {
  /** Winning seats ([] = nobody: a draw, or everyone left). */
  winnerSeats: number[]
  /** One short line for the result screen, e.g. "Red wins 3–1". Seat names are in `seats` passed to create. */
  summary: string
}

export interface GameDefinition<S = unknown> {
  id: GameId
  /** Display name (original: not the name of an existing game). */
  name: string
  /** One line for the game picker. */
  tagline: string
  /** Players including bots. */
  minPlayers: number
  maxPlayers: number
  /** Whether `bot` / `botAction` exists: the host can fill empty seats with computer players. */
  bots: boolean
  /** `pad`: real time, driven by controller buttons. `actions`: discrete moves (cards, turns) via `action`. */
  controls: 'pad' | 'actions'
  /** Controls shown in the lobby and the game view, e.g. [['Arrows', 'Move'], ['A', 'Drop a bomb']]. */
  help: [string, string][]
  /** Simulation ticks per second (e.g. 20 for a grid game, 60 for a fighter; an actions game ~10 for its timers). */
  tickHz: number
  /** A frame goes out every this many ticks (default 1). Actions games also get one right after each move. */
  frameEvery?: number
  /** Views differ per seat (hidden information such as card hands). False: one view is sent to everyone. */
  perSeatView: boolean

  /** A new match for these seats (length between minPlayers and maxPlayers, seat i at index i). */
  create(seats: GameSeat[], ctx: GameContext): S
  /** Advance one tick (mutate `state`). Called tickHz times per second until `result` is non-null. */
  tick(state: S, input: TickInput, ctx: GameContext): void
  /** `actions` games: apply `seat`'s move (untrusted). Returns an error text for the player, or null when applied. */
  action?(state: S, seat: number, action: unknown, ctx: GameContext): string | null
  /** `pad` games with bots: the buttons a bot holds at this tick. */
  bot?(state: S, seat: number, ctx: GameContext): number
  /** `actions` games with bots: a bot's move now, or null to wait (bots pace themselves with ticks). */
  botAction?(state: S, seat: number, ctx: GameContext): unknown
  /** `seat`'s person left mid-match (left the call, gave up the seat). Usually: they're out. */
  leave(state: S, seat: number, ctx: GameContext): void
  /** What a recipient sees: `seat` is theirs, or null for spectators. Compact, JSON-serializable. */
  view(state: S, seat: number | null): unknown
  /** Non-null once the match is over (then it isn't ticked any more). */
  result(state: S): GameOutcome | null
}

/** Mulberry32: a small, fast, seedable PRNG. Returns a function giving numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
