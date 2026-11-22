// Dojo Duel: the fighters, their frame data and the constants shared by the logic (sim.ts) and the view
// (desktop games/fighter). Distances are logical pixels of a ~62 px tall fighter (scaled per fighter), times are
// ticks at 60 Hz. Hitboxes are [x0, x1, y0, y1]: x forward from the fighter's center, y up from its feet.

export interface ProjDef {
  /** Speed (px / tick). */
  vx: number
  /** Lifetime (ticks): the range of short projectiles. */
  ttl: number
  /** Height of its center above the ground (unscaled). */
  y: number
  /** Look in the view: 0 energy orb, 1 needle. */
  kind: number
}

export interface MoveDef {
  /** Pose key for the view. */
  pose: string
  /** Startup, active and recovery ticks. */
  su: number
  ac: number
  rc: number
  dmg: number
  /** Damage on block (specials). */
  chip: number
  /** Hitstun / blockstun ticks. */
  hs: number
  bs: number
  hb: readonly [number, number, number, number] | null
  /** 0 mid, 1 low (block crouching), 2 overhead (block standing). */
  guard: number
  /** Pushback distance on hit / block. */
  push: number
  /** Knocks down. */
  kd: boolean
  /** Bigger hitstop, shake, heavy sound. */
  heavy: boolean
  /** Cancellable into a special on contact. */
  cancel: boolean
  /** A light normal that chains into light normals on contact. */
  chain: boolean
  /** Air normal (jumping). */
  air: boolean
  /** Forward speed during startup + active. */
  vx: number
  /** Rising speed given at the first active tick (rising specials) and the forward speed with it. */
  vy: number
  rvx: number
  /** Invulnerable (strikes and throws) while t < inv. */
  inv: number
  /** Hits absorbed during startup + active. */
  armor: number
  /** Landing recovery after an airborne special. */
  land: number
  proj: ProjDef | null
  /** Command throw: grabs a grounded opponent this close (center to center) at the first active tick. */
  grab: number
  special: boolean
  /** Crouching normal (low hurtbox). */
  crouch: boolean
}

const BASE: MoveDef = {
  pose: 'jab',
  su: 4,
  ac: 3,
  rc: 8,
  dmg: 30,
  chip: 0,
  hs: 14,
  bs: 10,
  hb: null,
  guard: 0,
  push: 7,
  kd: false,
  heavy: false,
  cancel: false,
  chain: false,
  air: false,
  vx: 0,
  vy: 0,
  rvx: 0,
  inv: 0,
  armor: 0,
  land: 3,
  proj: null,
  grab: 0,
  special: false,
  crouch: false,
}

function mv(p: Partial<MoveDef>): MoveDef {
  return { ...BASE, ...p }
}

// Move slots, the same for every fighter. Specials follow: SP0 + 2·special + (0 light | 1 heavy).
export const M_STLP = 0
export const M_STHP = 1
export const M_STLK = 2
export const M_STHK = 3
export const M_CRLP = 4
export const M_CRHP = 5
export const M_CRLK = 6
export const M_CRHK = 7
export const M_JLP = 8
export const M_JHP = 9
export const M_JLK = 10
export const M_JHK = 11
export const M_OVH = 12
export const M_THROW = 13
export const M_SP0 = 14

/** Motions (input.ts MOTIONS). */
export const QCF = 0
export const QCB = 1
export const DP = 2
export const HCB = 3

export interface SpecialDef {
  name: string
  motion: number
  /** 'P' punches (A / B), 'K' kicks (X / Y). B and Y give the heavy version. */
  btn: 'P' | 'K'
}

export interface CharDef {
  name: string
  style: string
  hp: number
  scale: number
  walkF: number
  walkB: number
  jumpVy: number
  jumpVx: number
  grav: number
  /** Half width of the push box. */
  pushW: number
  throwRange: number
  throwDmg: number
  /** Distance the bot likes to keep. */
  pref: number
  moves: MoveDef[]
  specials: SpecialDef[]
}

interface Tweak {
  su: number
  rc: number
  dmg: number
  reach: number
}

/** The 13 normals plus the throw, tweaked per fighter (speed, power, reach). */
function normals(k: Tweak): MoveDef[] {
  const r = (hb: [number, number, number, number]): [number, number, number, number] => [hb[0], Math.round(hb[1] * k.reach), hb[2], hb[3]]
  const t = (p: Partial<MoveDef>): MoveDef => {
    const m = mv(p)
    if (!m.air) {
      m.su = Math.max(3, m.su + (m.heavy ? k.su * 2 : k.su))
      m.rc = Math.max(4, m.rc + (m.heavy ? k.rc * 2 : k.rc))
    }
    m.dmg = Math.round(m.dmg * k.dmg)
    if (m.hb) m.hb = r(m.hb as [number, number, number, number])
    return m
  }
  return [
    t({ pose: 'jab', su: 4, ac: 3, rc: 7, dmg: 30, hs: 13, bs: 10, hb: [8, 26, 40, 50], push: 6, cancel: true, chain: true }),
    t({ pose: 'straight', su: 7, ac: 4, rc: 17, dmg: 90, hs: 19, bs: 15, hb: [8, 33, 38, 50], push: 11, cancel: true, heavy: true }),
    t({ pose: 'snap', su: 5, ac: 4, rc: 9, dmg: 40, hs: 14, bs: 11, hb: [6, 28, 10, 26], push: 7, cancel: true }),
    t({ pose: 'round', su: 9, ac: 5, rc: 19, dmg: 100, hs: 20, bs: 15, hb: [6, 34, 30, 48], push: 12, heavy: true }),
    t({ pose: 'cjab', su: 4, ac: 3, rc: 7, dmg: 25, hs: 12, bs: 9, hb: [8, 26, 24, 34], push: 6, cancel: true, chain: true, crouch: true }),
    t({ pose: 'upper', su: 6, ac: 6, rc: 18, dmg: 85, hs: 19, bs: 14, hb: [2, 22, 30, 64], push: 10, cancel: true, heavy: true, crouch: true }),
    t({ pose: 'ckick', su: 5, ac: 3, rc: 9, dmg: 30, hs: 12, bs: 9, hb: [6, 30, 0, 10], guard: 1, push: 6, cancel: true, chain: true, crouch: true }),
    t({ pose: 'sweep', su: 8, ac: 4, rc: 24, dmg: 90, bs: 14, hb: [6, 36, 0, 10], guard: 1, push: 10, kd: true, heavy: true, crouch: true }),
    t({ pose: 'apunch', su: 4, ac: 10, rc: 0, dmg: 40, hs: 15, bs: 10, hb: [4, 24, 22, 40], guard: 2, push: 5, air: true }),
    t({ pose: 'apunch', su: 6, ac: 6, rc: 0, dmg: 85, hs: 19, bs: 13, hb: [4, 28, 20, 40], guard: 2, push: 8, air: true, heavy: true }),
    t({ pose: 'akick', su: 4, ac: 12, rc: 0, dmg: 40, hs: 15, bs: 10, hb: [4, 28, 10, 30], guard: 2, push: 5, air: true }),
    t({ pose: 'akick', su: 7, ac: 7, rc: 0, dmg: 90, hs: 19, bs: 13, hb: [4, 30, 12, 30], guard: 2, push: 8, air: true, heavy: true }),
    t({ pose: 'axe', su: 18, ac: 4, rc: 14, dmg: 70, hs: 17, bs: 12, hb: [6, 30, 18, 46], guard: 2, push: 8, heavy: true }),
    mv({ pose: 'throw', su: 0, ac: 0, rc: 0, hb: null }),
  ]
}

const KAI: CharDef = {
  name: 'KAI',
  style: 'BALANCED',
  hp: 1000,
  scale: 1,
  walkF: 1.7,
  walkB: 1.35,
  jumpVy: 5.4,
  jumpVx: 2.1,
  grav: 0.26,
  pushW: 11,
  throwRange: 34,
  throwDmg: 120,
  pref: 110,
  moves: [
    ...normals({ su: 0, rc: 0, dmg: 1, reach: 1 }),
    // Rising Crane: an invincible rising strike (DP + P).
    mv({ pose: 'rise', su: 3, ac: 10, rc: 0, dmg: 100, hs: 20, bs: 12, hb: [0, 22, 30, 72], push: 8, kd: true, heavy: true, special: true, vy: 5.5, rvx: 1, inv: 6, land: 16 }),
    mv({ pose: 'rise', su: 3, ac: 12, rc: 0, dmg: 130, hs: 20, bs: 12, hb: [0, 22, 30, 74], push: 8, kd: true, heavy: true, special: true, vy: 6.5, rvx: 1.6, inv: 9, land: 20 }),
    // Spirit Wave: an energy orb (QCF + P).
    mv({ pose: 'wave', su: 13, ac: 1, rc: 32, dmg: 80, chip: 14, hs: 18, bs: 14, push: 10, special: true, proj: { vx: 2.6, ttl: 200, y: 40, kind: 0 } }),
    mv({ pose: 'wave', su: 13, ac: 1, rc: 32, dmg: 90, chip: 16, hs: 18, bs: 14, push: 10, special: true, proj: { vx: 4.2, ttl: 140, y: 40, kind: 0 } }),
    // Gale Step: a travelling spin kick that sails over crouching opponents (QCB + K).
    mv({ pose: 'spin', su: 8, ac: 20, rc: 12, dmg: 80, chip: 10, hs: 18, bs: 12, hb: [4, 30, 40, 54], push: 12, special: true, vx: 2.6 }),
    mv({ pose: 'spin', su: 8, ac: 24, rc: 14, dmg: 100, chip: 12, hs: 18, bs: 12, hb: [4, 30, 40, 54], push: 14, kd: true, heavy: true, special: true, vx: 3.4 }),
  ],
  specials: [
    { name: 'RISING CRANE', motion: DP, btn: 'P' },
    { name: 'SPIRIT WAVE', motion: QCF, btn: 'P' },
    { name: 'GALE STEP', motion: QCB, btn: 'K' },
  ],
}
const BRUNO: CharDef = {
  name: 'BRUNO',
  style: 'GRAPPLER',
  hp: 1150,
  scale: 1.14,
  walkF: 1.2,
  walkB: 0.95,
  jumpVy: 5.0,
  jumpVx: 1.8,
  grav: 0.26,
  pushW: 14,
  throwRange: 38,
  throwDmg: 140,
  pref: 34,
  moves: [
    ...normals({ su: 1, rc: 1, dmg: 1.22, reach: 1.08 }),
    // Ox Slam: command throw, unblockable, close range (half circle back: → ↓ ← + P).
    mv({ pose: 'grab', su: 3, ac: 2, rc: 32, dmg: 190, special: true, grab: 52, heavy: true }),
    mv({ pose: 'grab', su: 3, ac: 2, rc: 34, dmg: 240, special: true, grab: 44, heavy: true }),
    // Stone Rise: a rising headbutt anti-air (DP + P).
    mv({ pose: 'butt', su: 5, ac: 8, rc: 0, dmg: 110, hs: 20, bs: 12, hb: [-2, 20, 36, 66], push: 8, kd: true, heavy: true, special: true, vy: 4.4, rvx: 0.6, inv: 7, land: 20 }),
    mv({ pose: 'butt', su: 5, ac: 9, rc: 0, dmg: 140, hs: 20, bs: 12, hb: [-2, 20, 36, 68], push: 8, kd: true, heavy: true, special: true, vy: 5.2, rvx: 0.8, inv: 10, land: 22 }),
    // Bull Charge: a shoulder rush that absorbs one hit (QCF + K).
    mv({ pose: 'charge', su: 12, ac: 18, rc: 16, dmg: 110, chip: 12, hs: 20, bs: 14, hb: [6, 26, 14, 48], push: 14, special: true, vx: 3.2, armor: 1 }),
    mv({ pose: 'charge', su: 12, ac: 18, rc: 18, dmg: 130, chip: 14, hs: 20, bs: 14, hb: [6, 26, 14, 48], push: 16, kd: true, heavy: true, special: true, vx: 4.4, armor: 1 }),
  ],
  specials: [
    { name: 'OX SLAM', motion: HCB, btn: 'P' },
    { name: 'STONE RISE', motion: DP, btn: 'P' },
    { name: 'BULL CHARGE', motion: QCF, btn: 'K' },
  ],
}

const MIKA: CharDef = {
  name: 'MIKA',
  style: 'SPEED',
  hp: 900,
  scale: 0.94,
  walkF: 2.1,
  walkB: 1.7,
  jumpVy: 5.9,
  jumpVx: 2.5,
  grav: 0.29,
  pushW: 10,
  throwRange: 32,
  throwDmg: 110,
  pref: 75,
  moves: [
    ...normals({ su: -1, rc: -1, dmg: 0.86, reach: 1 }),
    // Petal Spin: a rising spinning kick (DP + K).
    mv({ pose: 'petal', su: 4, ac: 12, rc: 0, dmg: 90, hs: 20, bs: 12, hb: [-6, 22, 24, 62], push: 8, kd: true, heavy: true, special: true, vy: 5, rvx: 1.2, inv: 6, land: 14 }),
    mv({ pose: 'petal', su: 4, ac: 14, rc: 0, dmg: 120, hs: 20, bs: 12, hb: [-6, 22, 24, 64], push: 8, kd: true, heavy: true, special: true, vy: 6, rvx: 1.6, inv: 8, land: 18 }),
    // Wind Needle: a quick short-range projectile (QCF + P).
    mv({ pose: 'needle', su: 9, ac: 1, rc: 22, dmg: 55, chip: 9, hs: 16, bs: 12, push: 8, special: true, proj: { vx: 5, ttl: 26, y: 36, kind: 1 } }),
    mv({ pose: 'needle', su: 9, ac: 1, rc: 22, dmg: 60, chip: 10, hs: 16, bs: 12, push: 8, special: true, proj: { vx: 5.4, ttl: 34, y: 36, kind: 1 } }),
    // Swallow Dash: a flying dash kick across the floor (QCF + K).
    mv({ pose: 'dash', su: 7, ac: 16, rc: 14, dmg: 80, chip: 10, hs: 18, bs: 13, hb: [6, 30, 18, 40], push: 12, special: true, vx: 4.4 }),
    mv({ pose: 'dash', su: 7, ac: 16, rc: 16, dmg: 100, chip: 12, hs: 18, bs: 13, hb: [6, 30, 18, 40], push: 14, kd: true, heavy: true, special: true, vx: 5.8 }),
  ],
  specials: [
    { name: 'PETAL SPIN', motion: DP, btn: 'K' },
    { name: 'WIND NEEDLE', motion: QCF, btn: 'P' },
    { name: 'SWALLOW DASH', motion: QCF, btn: 'K' },
  ],
}

export const CHARS: readonly CharDef[] = [KAI, BRUNO, MIKA]

// Actions (Fighter.act).
export const IDLE = 0
export const WALKF = 1
export const WALKB = 2
export const CROUCH = 3
export const PREJUMP = 4
export const JUMP = 5
export const LAND = 6
export const ATTACK = 7
export const HIT = 8
export const HITC = 9
export const BLOCK = 10
export const BLOCKC = 11
export const AIRHIT = 12
export const DOWN = 13
export const WAKE = 14
export const THROW = 15
export const THROWN = 16
export const KO = 17
export const WIN = 18
export const TLOSE = 19

// Phases.
export const PH_SELECT = 0
export const PH_INTRO = 1
export const PH_FIGHT = 2
export const PH_END = 3
export const PH_OVER = 4

// How a round ended.
export const END_KO = 0
export const END_DKO = 1
export const END_TIME = 2

// View events.
export const EV_HIT_L = 1
export const EV_HIT_H = 2
export const EV_BLOCK = 3
export const EV_PROJ = 4
export const EV_KO = 5
export const EV_ROUND = 6
export const EV_FIGHT = 7
export const EV_THROW = 8
export const EV_SEL = 9
export const EV_LOCK = 10
export const EV_TIME = 11
export const EV_CLASH = 12
export const EV_SPECIAL = 13
export const EV_WHOOSH = 14
export const EV_ARMOR = 15
export const EV_THUD = 16

// Fighter view flags.
export const FL_GUARD = 1
export const FL_FLIP = 2
export const FL_RISING = 4
export const FL_ARMOR = 8
export const FL_TBACK = 16

export const STAGE_W = 512
export const SCREEN_W = 320
export const EDGE = 14
export const TICK_HZ = 60
export const ROUND_SECONDS = 99
export const SELECT_TICKS = 10 * TICK_HZ
export const MAX_ROUNDS = 5
export const WINS_NEEDED = 2
/** Ticks a pressed button stays buffered. */
export const BUFFER = 8
/** Input history length (ticks). */
export const HIST = 32
export const INTRO_TICKS = 75
export const FIGHT_AT = 52
export const END_TICKS = 190
export const THROW_RELEASE = 12
export const THROW_TICKS = 26
export const SLAM_RELEASE = 26
export const SLAM_TICKS = 42
