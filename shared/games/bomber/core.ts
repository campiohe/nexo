// Blast Arena: constants, state types and grid helpers shared by the rules (logic.ts), the bots (bot.ts) and
// the desktop view (desktop/src/renderer/src/games/bomber/View.tsx). Pure data, no side effects.
import type { GameSeat } from '../../protocol.ts'

/** Arena size in tiles (border included). */
export const W = 15
export const H = 13
/** Sub-tile units per tile (positions are integers in these units; a tile's center is at TILE / 2). */
export const TILE = 48
export const HALF = TILE / 2

export const TICK_HZ = 20
/** Ticks a bomb burns before it goes off (2.5 s). */
export const FUSE = 50
/** Ticks a blast lingers (and kills). */
export const FIRE_T = 10
/** Ticks a crate takes to crumble (blocks blasts and walking meanwhile; then its hidden item appears). */
export const BREAK_T = 10
/** Ticks between a sudden-death block's warning shadow and its landing. */
export const FALL_T = 8
/** A new sudden-death block every this many ticks. */
export const SD_EVERY = 3
export const INTRO_T = 60
/** After the last-but-one player dies: the survivor must live this long (else: draw). */
export const END_T = 30
export const RESULT_T = 70
/** Round time before sudden death (2 min). */
export const ROUND_T = 120 * TICK_HZ
export const MAX_ROUNDS = 7
/** Ticks an A press is remembered when a bomb can't be dropped yet (input buffering). */
export const DROP_BUFFER = 5
/** Invulnerability after a shield absorbs a blast. */
export const SHIELD_INVULN = 30

/** Movement speed in units per tick: BASE_SPEED + speed-ups. */
export const BASE_SPEED = 8
export const MAX_SPEED_UPS = 4
export const MAX_BOMBS = 8
export const MAX_RANGE = 8
/** A kicked bomb's speed (units per tick; divides TILE so it lands on tile centers). */
export const KICK_SPEED = 12

// Tiles
export const T_FLOOR = 0
export const T_PILLAR = 1
export const T_CRATE = 2
/** A sudden-death block. */
export const T_BLOCK = 3
/** A crate crumbling after a blast. */
export const T_BREAK = 4

// Items (power-ups)
export const I_NONE = 0
export const I_BOMB = 1
export const I_RANGE = 2
export const I_SPEED = 3
export const I_KICK = 4
export const I_SHIELD = 5
export const I_TRIGGER = 6

// Phases
export const PH_INTRO = 0
export const PH_PLAY = 1
/** One player (or nobody) left: a short wait to see if the survivor makes it. */
export const PH_END = 2
export const PH_RESULT = 3
export const PH_OVER = 4

// Events (for sounds and effects in the view): [id, kind, a, b]
export const EV_DROP = 1
export const EV_BOOM = 2
export const EV_PICK = 3
export const EV_DIE = 4
export const EV_KICK = 5
export const EV_COUNT = 6
export const EV_GO = 7
export const EV_SUDDEN = 8
export const EV_THUD = 9
export const EV_ROUND = 10
export const EV_SHIELD = 11
export const EV_MATCH = 12
export const EV_BURN = 13

/** Directions: up, down, left, right (also the facing in views). */
export const DX = [0, 0, -1, 1]
export const DY = [-1, 1, 0, 0]

/** Spawn tiles by seat: opposite corners first. */
export const SPAWNS: readonly (readonly [number, number])[] = [
  [1, 1],
  [W - 2, H - 2],
  [W - 2, 1],
  [1, H - 2],
]

export interface BomberPlayer {
  /** Center position in units. */
  x: number
  y: number
  /** Facing: 0 up, 1 down, 2 left, 3 right. */
  dir: number
  moving: boolean
  alive: boolean
  /** The person left the match (out for good). */
  gone: boolean
  /** Tick of death (-1 while alive). */
  diedAt: number
  /** Max bombs at once. */
  bombs: number
  range: number
  /** Speed-ups taken (0..MAX_SPEED_UPS). */
  speed: number
  kick: boolean
  trigger: boolean
  shield: boolean
  invuln: number
  wins: number
  /** Ticks left of a buffered bomb drop. */
  bufA: number
  /** Last pressed direction still held (-1: none). */
  pref: number
}

export interface BomberBomb {
  id: number
  /** Center in units (on a tile center unless kicked and sliding). */
  x: number
  y: number
  owner: number
  fuse: number
  range: number
  /** Slide direction when kicked (0, ±1). */
  dx: number
  dy: number
  /** Bit per seat still allowed to stand on it (whoever overlapped it when it was dropped, until they step off). */
  pass: number
}

export interface BomberBotMemory {
  /** Ticks before the bot considers dropping a bomb on a spot again (after a spot without an escape). */
  cool: number
  /** Random direction while wandering. */
  wander: number
}

export interface BomberState {
  seats: GameSeat[]
  tick: number
  phase: number
  /** Ticks left in the current phase (intro, end, result). */
  phaseT: number
  round: number
  winsNeeded: number
  /** Ticks before sudden death. */
  timeLeft: number
  /** Ticks since sudden death started (-1 before). */
  sdT: number
  /** Next index in SPIRAL to drop. */
  sdNext: number
  /** Tiles by index y * W + x. */
  grid: number[]
  /** Visible items. */
  items: number[]
  /** Items hidden in crates. */
  hidden: number[]
  /** Blast ticks left per tile. */
  fire: number[]
  /** Crumbling crates: [tile, ticks left]. */
  breaking: number[][]
  /** Falling sudden-death blocks: [tile, ticks left]. */
  falling: number[][]
  bombs: BomberBomb[]
  players: BomberPlayer[]
  bots: BomberBotMemory[]
  /** -2 not decided, -1 draw, else the seat that won the last round. */
  roundWinner: number
  /** Set when the match is decided ([] = draw). */
  matchWinners: number[] | null
  summary: string
  /** Recent events: [id, tick, kind, a, b]. */
  events: number[][]
  nextEvent: number
  nextBomb: number
}

/** What every client receives (one view for everyone; see logic.ts `view`). */
export interface BomberView {
  /** Phase (PH_*), ticks left in it, round, wins needed. */
  ph: number
  pt: number
  rd: number
  wn: number
  /** Ticks before sudden death; ticks since it started (-1 before). */
  tl: number
  sd: number
  /** Last round's winner (-1 draw, -2 undecided); match winners. */
  rw: number
  mw: number[]
  /** Tiles, W * H chars: '.' floor, '#' pillar, '%' crate, 'X' block, '*' crumbling crate, '1'..'6' item. */
  g: string
  /** Blast per tile: '.' none, 'a'.. = ticks left (1..). */
  f: string
  /** Crumbling crates and falling blocks: flat [tile, ticks left, …]. */
  br: number[]
  fl: number[]
  /** Bombs: [id, x, y, fuse, owner, sliding 0/1]. */
  b: number[][]
  /** Players by seat: [x, y, dir, flags, diedAt, wins, bombs, range, speed]. */
  p: number[][]
  /** Recent events: [id, kind, a, b]. */
  e: number[][]
}

/** Player flags in BomberView.p[i][3]. */
export const PF_ALIVE = 1
export const PF_MOVING = 2
export const PF_GONE = 4
export const PF_KICK = 8
export const PF_TRIGGER = 16
export const PF_SHIELD = 32
export const PF_INVULN = 64

export const ITEM_CHARS = '.123456'

export const cellOf = (u: number) => Math.floor(u / TILE)
export const centerOf = (c: number) => c * TILE + HALF
export const idx = (x: number, y: number) => y * W + x
export const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H

/** Tile of a player or bomb center. */
export function tileOf(o: { x: number; y: number }): number {
  return idx(cellOf(o.x), cellOf(o.y))
}

/** Static walls: the border and every other tile inside. */
export function isPillar(x: number, y: number): boolean {
  return x === 0 || y === 0 || x === W - 1 || y === H - 1 || (x % 2 === 0 && y % 2 === 0)
}

/** The order sudden-death blocks fall in: a clockwise spiral from the outer ring inward (pillars skipped). */
export const SPIRAL: readonly number[] = (() => {
  const out: number[] = []
  let x0 = 1
  let y0 = 1
  let x1 = W - 2
  let y1 = H - 2
  const add = (x: number, y: number) => {
    if (!isPillar(x, y) && !out.includes(idx(x, y))) out.push(idx(x, y))
  }
  while (x0 <= x1 && y0 <= y1) {
    for (let x = x0; x <= x1; x++) add(x, y0)
    for (let y = y0 + 1; y <= y1; y++) add(x1, y)
    for (let x = x1 - 1; x >= x0; x--) add(x, y1)
    for (let y = y1 - 1; y > y0; y--) add(x0, y)
    x0++
    y0++
    x1--
    y1--
  }
  return out
})()

/** The bomb whose center is on tile `c`, or undefined. */
export function bombAt(s: BomberState, c: number): BomberBomb | undefined {
  for (const b of s.bombs) if (tileOf(b) === c) return b
  return undefined
}

/** Whether a body centered at (ax, ay) overlaps the tile box centered at (bx, by). */
export function overlaps(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) < TILE && Math.abs(ay - by) < TILE
}

/**
 * Tiles a blast from tile `c` with `range` reaches on the current grid (not the crates it would break). Arms
 * stop at walls, crates and crumbling crates (excluded) and at items (included).
 */
export function blastTiles(s: BomberState, c: number, range: number, out: number[] = []): number[] {
  const cx = c % W
  const cy = (c - cx) / W
  out.push(c)
  for (let d = 0; d < 4; d++) {
    for (let k = 1; k <= range; k++) {
      const x = cx + DX[d] * k
      const y = cy + DY[d] * k
      if (!inside(x, y)) break
      const n = idx(x, y)
      if (s.grid[n] !== T_FLOOR) break
      out.push(n)
      if (s.items[n] !== I_NONE) break
    }
  }
  return out
}

export const speedOf = (p: BomberPlayer) => BASE_SPEED + p.speed
