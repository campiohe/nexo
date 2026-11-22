// Ring Out: tuning data shared by the logic (shared/games/brawl/logic.ts) and the view
// (desktop/src/renderer/src/games/brawl). World units are pixels at camera zoom 1; y grows downward; a
// fighter's (x, y) is the middle of its feet. 60 ticks per second: every speed is in px/tick.

export const TICK_HZ = 60
/** "3, 2, 1, GO" before the fight (and before sudden death). */
export const COUNTDOWN_TICKS = 180
export const MATCH_TICKS = 4 * 60 * TICK_HZ
export const SUDDEN_DEATH_TICKS = 60 * TICK_HZ
/** "GAME!" shows this long before the result. */
export const END_TICKS = 120
export const STOCKS = 3
export const RESPAWN_DELAY = 70
export const RESPAWN_INVULN = 110
/** A press counts this many ticks after it happened (inputs arrive late over the network). */
export const BUFFER_TICKS = 10
export const SHIELD_MAX = 50

// ---------------------------------------------------------------------------------------------
// Stages

export interface Platform {
  l: number
  r: number
  y: number
}

export interface StageDef {
  name: string
  /** The solid main platform: top at y, `d` deep, ledges at l and r. */
  main: { l: number; r: number; y: number; d: number }
  /** Pass-through platforms (land from above, drop through with Down). */
  plats: Platform[]
  /** Leaving this box loses a stock. */
  blast: { l: number; r: number; t: number; b: number }
  /** Start positions (x on the main platform), by seat. */
  spawns: number[]
  /** Respawn points (floating, above the stage). */
  respawns: [number, number][]
}

export const STAGES: StageDef[] = [
  {
    name: 'Sky Forge',
    main: { l: -112, r: 112, y: 0, d: 30 },
    plats: [
      { l: -82, r: -34, y: -42 },
      { l: 34, r: 82, y: -42 },
      { l: -24, r: 24, y: -82 },
    ],
    blast: { l: -260, r: 260, t: -205, b: 150 },
    spawns: [-72, 72, -30, 30],
    respawns: [
      [-44, -116],
      [44, -116],
      [0, -126],
      [-88, -100],
    ],
  },
  {
    name: 'Tide Ruins',
    main: { l: -128, r: 128, y: 0, d: 26 },
    plats: [
      { l: -92, r: -40, y: -48 },
      { l: 40, r: 92, y: -48 },
    ],
    blast: { l: -275, r: 275, t: -205, b: 150 },
    spawns: [-80, 80, -34, 34],
    respawns: [
      [-50, -110],
      [50, -110],
      [0, -120],
      [90, -100],
    ],
  },
]

// ---------------------------------------------------------------------------------------------
// Fighters

export type DownSpecial = 'counter' | 'flip' | 'slam'

export interface CharDef {
  name: string
  /** Hurtbox: half width and height. */
  hw: number
  h: number
  /** Knockback taken is divided by this. */
  weight: number
  run: number
  air: number
  airAcc: number
  grav: number
  fall: number
  ffall: number
  jump: number
  djump: number
  /** Up special launch speed. */
  ub: number
  /** Side special dash speed. */
  sb: number
  /** Damage and knockback dealt multiplier. */
  power: number
  /** Hitbox offsets and radii multiplier (bigger body, longer reach). */
  reach: number
  /** Endlag multiplier (lower is faster). */
  lag: number
  db: DownSpecial
}

export const CHARS: CharDef[] = [
  // Balanced: counters.
  { name: 'Mako', hw: 6, h: 22, weight: 1, run: 2.3, air: 1.75, airAcc: 0.14, grav: 0.34, fall: 4.6, ffall: 6.8, jump: 7.2, djump: 6.6, ub: 8.9, sb: 5.2, power: 1, reach: 1, lag: 1, db: 'counter' },
  // Light and fast: flip kick.
  { name: 'Zip', hw: 5, h: 19, weight: 0.84, run: 3, air: 2.05, airAcc: 0.18, grav: 0.37, fall: 5.1, ffall: 7.6, jump: 7.6, djump: 7.1, ub: 9.4, sb: 6, power: 0.88, reach: 0.9, lag: 0.8, db: 'flip' },
  // Heavy: ground slam.
  { name: 'Grum', hw: 8, h: 25, weight: 1.3, run: 1.85, air: 1.45, airAcc: 0.11, grav: 0.32, fall: 4.3, ffall: 6.3, jump: 6.9, djump: 6.4, ub: 8.4, sb: 4.5, power: 1.18, reach: 1.15, lag: 1.15, db: 'slam' },
]

// ---------------------------------------------------------------------------------------------
// Moves (frame data at 60 Hz). t counts from 1 the tick after the move starts: hitboxes are out for
// s <= t < s + a; the move ends at t >= s + a + e. Hitboxes: [forward, up (negative = above the feet), radius].

export interface MoveDef {
  s: number
  a: number
  e: number
  hb: [number, number, number][]
  dmg: number
  bkb: number
  kbg: number
  /** Launch angle in degrees: 0 = forward, 90 = up, -90 = down, 180 = backward. */
  ang: number
  /** Aerial: landing during it costs `ll` ticks. */
  air?: boolean
  ll?: number
  grab?: boolean
}

export const MOVES: Record<string, MoveDef> = {
  // Light attacks (A).
  jab: { s: 4, a: 3, e: 9, hb: [[12, -13, 7]], dmg: 3, bkb: 2.6, kbg: 0.035, ang: 30 },
  ftilt: { s: 6, a: 3, e: 14, hb: [[15, -11, 8]], dmg: 7, bkb: 3.6, kbg: 0.068, ang: 35 },
  utilt: { s: 5, a: 5, e: 12, hb: [[4, -26, 9]], dmg: 6, bkb: 3.6, kbg: 0.064, ang: 88 },
  dtilt: { s: 5, a: 3, e: 11, hb: [[14, -3, 7]], dmg: 5, bkb: 3.2, kbg: 0.055, ang: 22 },
  nair: { s: 4, a: 10, e: 10, hb: [[0, -11, 12]], dmg: 6, bkb: 3.2, kbg: 0.055, ang: 45, air: true, ll: 7 },
  fair: { s: 7, a: 4, e: 14, hb: [[13, -12, 9]], dmg: 9, bkb: 3.6, kbg: 0.08, ang: 40, air: true, ll: 9 },
  bair: { s: 6, a: 4, e: 12, hb: [[-14, -12, 9]], dmg: 10, bkb: 4, kbg: 0.082, ang: 145, air: true, ll: 9 },
  uair: { s: 5, a: 5, e: 11, hb: [[2, -28, 10]], dmg: 7, bkb: 3.6, kbg: 0.07, ang: 84, air: true, ll: 8 },
  dair: { s: 9, a: 4, e: 16, hb: [[2, 4, 9]], dmg: 9, bkb: 3.2, kbg: 0.072, ang: -70, air: true, ll: 12 },
  // Heavy / specials (B).
  nb: { s: 14, a: 4, e: 22, hb: [[17, -12, 10]], dmg: 14, bkb: 4.6, kbg: 0.1, ang: 40, ll: 10 },
  sb: { s: 7, a: 12, e: 14, hb: [[11, -11, 9]], dmg: 9, bkb: 4.2, kbg: 0.07, ang: 35, ll: 10 },
  ub: { s: 4, a: 14, e: 0, hb: [[6, -16, 11]], dmg: 6, bkb: 4.2, kbg: 0.04, ang: 80 },
  ctr: { s: 4, a: 22, e: 18, hb: [], dmg: 0, bkb: 0, kbg: 0, ang: 0, ll: 10 },
  ctrs: { s: 1, a: 1, e: 20, hb: [], dmg: 0, bkb: 5, kbg: 0.1, ang: 40 },
  flip: { s: 5, a: 7, e: 13, hb: [[8, -10, 11]], dmg: 8, bkb: 4.2, kbg: 0.07, ang: 78, ll: 8 },
  slam: { s: 12, a: 4, e: 18, hb: [[15, -4, 10], [-15, -4, 10]], dmg: 11, bkb: 4.4, kbg: 0.08, ang: 72 },
  slama: { s: 8, a: 400, e: 0, hb: [[0, 2, 10]], dmg: 10, bkb: 3.4, kbg: 0.07, ang: -60 },
  // Grab and throws (the throw's hit is applied straight to the held fighter).
  grab: { s: 6, a: 3, e: 22, hb: [[13, -12, 7]], dmg: 0, bkb: 0, kbg: 0, ang: 0, grab: true },
  thf: { s: 5, a: 1, e: 16, hb: [], dmg: 8, bkb: 4.4, kbg: 0.072, ang: 38 },
  thb: { s: 7, a: 1, e: 16, hb: [], dmg: 9, bkb: 4.6, kbg: 0.075, ang: 140 },
  thu: { s: 5, a: 1, e: 16, hb: [], dmg: 7, bkb: 4.4, kbg: 0.068, ang: 88 },
  thd: { s: 6, a: 1, e: 18, hb: [], dmg: 6, bkb: 3.8, kbg: 0.05, ang: 70 },
  // Getting up from the ledge with an attack.
  lga: { s: 6, a: 3, e: 12, hb: [[12, -8, 9]], dmg: 6, bkb: 3.6, kbg: 0.04, ang: 30 },
}

/** Animation ids sent in views: the states, then one per move (MOVE_IDS order). */
export const STATES = [
  'idle',
  'run',
  'squat',
  'air',
  'land',
  'crouch',
  'shield',
  'roll',
  'spot',
  'adodge',
  'hurt',
  'dizzy',
  'ledge',
  'climb',
  'hold',
  'held',
  'helpless',
  'respawn',
  'dead',
] as const
export const MOVE_IDS = Object.keys(MOVES)
export const ANIMS: string[] = [...STATES, ...MOVE_IDS]

/** View flags (fighter tuple index F_FLAGS). */
export const FL = {
  /** Can't be hit (respawn / dodge / ledge): drawn flashing. */
  INV: 1,
  SHIELD: 2,
  HELPLESS: 4,
  OUT: 8,
  DIZZY: 16,
  /** Standing on the respawn halo. */
  HALO: 32,
  /** Frozen by hit impact. */
  HITLAG: 64,
  /** Counter window open. */
  COUNTER: 128,
  /** Moving up (jump rising) vs falling, for the air pose. */
  RISING: 256,
  FASTFALL: 512,
} as const

/** Event kinds (view `e` entries). */
export const EV = {
  HIT: 1,
  HEAVY: 2,
  BLOCK: 3,
  BREAK: 4,
  KO: 5,
  JUMP: 6,
  COUNT: 7,
  GO: 8,
  GAME: 9,
  COUNTER: 10,
  GRAB: 11,
  LAND: 12,
  SUDDEN: 13,
  RESPAWN: 14,
} as const

/** Fighter tuple layout in the view. */
export const F_X = 0
export const F_Y = 1
export const F_FACE = 2
export const F_ANIM = 3
export const F_T = 4
export const F_DMG = 5
export const F_STOCKS = 6
export const F_FLAGS = 7
export const F_CH = 8
export const F_SHIELD = 9
/** Knockback speed ×10 (trails). */
export const F_KB = 10
export const F_KOS = 11
