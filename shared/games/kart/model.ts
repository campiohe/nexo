// Kart Rally: state types and tuning constants shared by the logic, the bots and the view.
import type { GameSeat } from '../../protocol.ts'

export const TICK_HZ = 30
export const DT = 1 / TICK_HZ
export const LAPS = 3

/** Ticks of the 3-2-1 countdown before GO. */
export const COUNTDOWN = 3 * TICK_HZ
/** The race ends this long after the first kart finishes. */
export const AFTER_FIRST = 30 * TICK_HZ
/** Hard cap on race time (then the standings at that moment decide). */
export const RACE_CAP = 6 * 60 * TICK_HZ
/** The match stays in its "over" phase this long (the final standings show) before `result` ends it. */
export const OVER_HOLD = 2 * TICK_HZ

// Driving (units per second / per second², radians per second).
export const VMAX = 105
export const VREV = 34
export const ACCEL = 62
export const BRAKE = 150
export const COAST = 26
export const TURN = 2.25
export const KART_R = 6
/** Off-road: top speed factor. */
export const OFF_SPEED = 0.45
export const BOOST_SPEED = 1.38
export const DRIFT_MIN_SPEED = 42
/** Mini-turbo charge thresholds and the boosts they give (ticks). */
export const CHARGE_1 = 48
export const CHARGE_2 = 110
export const TURBO_1 = 16
export const TURBO_2 = 34

// Items (ids in the view and the state).
export const ITEM_NONE = 0
export const ITEM_NITRO = 1
export const ITEM_NITRO3 = 2
export const ITEM_SLICK = 3
export const ITEM_BOLT = 4
export const ITEM_SEEKER = 5
export const ITEM_SHIELD = 6
export const ITEM_COUNT = 7
/** Item roulette (ticks between touching a box and holding the item). */
export const ROLL_TICKS = 30
export const BOX_RESPAWN = 3 * TICK_HZ
export const BOX_R = 9

// Track objects.
export const OBJ_SLICK = 1
export const OBJ_BOLT = 2
export const OBJ_SEEKER = 3
export const MAX_SLICKS = 14

// Kart flags (view bit field).
export const F_DRIFT_L = 1
export const F_DRIFT_R = 2
export const F_BOOST = 4
export const F_SPIN = 8
export const F_SHIELD = 16
export const F_OFF = 32
export const F_FIN = 64
export const F_GONE = 128
export const F_SPARK1 = 256
export const F_SPARK2 = 512
export const F_WRONG = 1024
export const F_BRAKE = 2048

// Events (sounds / flashes in the view).
export const EV_COUNT = 1
export const EV_GO = 2
export const EV_LAP = 3
export const EV_FINAL = 4
export const EV_FINISH = 5
export const EV_ITEM = 6
export const EV_USE = 7
export const EV_BOOST = 8
export const EV_BUMP = 9
export const EV_WALL = 10
export const EV_HIT = 11
export const EV_SHIELD_POP = 12
export const EV_BOX = 13

export interface Kart {
  x: number
  y: number
  /** Heading (where the nose points) and the direction of motion (lags behind while sliding). */
  a: number
  m: number
  /** Speed along `m` (negative: reversing). */
  v: number
  /** Height above the ground (hops, ramps) and its vertical speed. */
  z: number
  vz: number
  /** Smoothed steering, -1..1. */
  st: number
  /** Bump velocity (decays). */
  px: number
  py: number
  /** 0, -1 (left) or 1 (right) while drifting; the mini-turbo charge. */
  drift: number
  charge: number
  /** Direction chosen while hopping into a drift. */
  hopDir: number
  boost: number
  spin: number
  /** Invulnerable after a spin. */
  inv: number
  shield: number
  off: boolean
  air: boolean
  /** Track tracking: segment, arc length, unwrapped distance along the race, lateral offset. */
  seg: number
  s: number
  u: number
  lat: number
  /** Checkpoints passed (global index: the start line is 0; the finish is LAPS * CHECKPOINTS). */
  passed: number
  /** Race tick of the finish, or -1. */
  fin: number
  /** 1-based position. */
  rank: number
  item: number
  uses: number
  /** Ticks left of the item roulette (0 = none); the item it lands on. */
  roll: number
  rollItem: number
  gone: boolean
  /** Ticks driving the wrong way. */
  wrong: number
  /** Countdown tick when A went down (rocket start), or -1. */
  aAt: number
  /** Ticks since the last wall/bump sound (rate limit). */
  quiet: number
  /** The buttons this tick (for the view's brake lights). */
  btn: number
}

export interface KartObj {
  type: number
  x: number
  y: number
  /** Bolts: velocity. Seekers: `vx` is the lateral offset from the centerline while following the track. */
  vx: number
  vy: number
  /** Ticks to live. */
  life: number
  /** Thrower and how long the thrower is immune to it. */
  owner: number
  grace: number
  /** Seeker: target seat (-1: none), arc length, segment. */
  target: number
  s: number
  seg: number
}

export interface KartAi {
  /** Preferred lateral offset (fraction of the half width) and how sharp the bot is (0..1). */
  pref: number
  skill: number
  /** Ticks stuck / reversing out. */
  stuck: number
  rev: number
  /** Ticks before using the held item. */
  itemWait: number
  /** Rocket start: the countdown tick at which this bot presses A. */
  launch: number
  /** Lateral dodge offset (fraction of the half width) and its timer. */
  dodge: number
  dodgeT: number
  /** Drift intent: direction (0 none) and ticks since it began. */
  dr: number
  drT: number
  /** Ticks off the throttle (a small mistake). */
  slip: number
}

export interface KartEvent {
  id: number
  /** EV_* code. */
  e: number
  /** Seat it concerns (-1 for everyone). */
  s: number
  /** Extra value (lap number, item id, countdown number). */
  v: number
  /** Tick it happened (events older than a second are dropped). */
  at: number
}

export interface KartState {
  seats: GameSeat[]
  track: number
  /** 0 countdown, 1 racing, 2 over (standings show briefly), 3 ended. */
  phase: number
  /** Ticks since the match started, and race ticks since GO. */
  tick: number
  race: number
  karts: Kart[]
  objs: KartObj[]
  /** Respawn ticks per item box (0 = present). */
  boxes: number[]
  ai: KartAi[]
  events: KartEvent[]
  evId: number
  /** Race tick of the first finish (-1 none) and the tick the over phase began. */
  firstFin: number
  overAt: number
  /** Final order (seats) once the race ends. */
  order: number[]
}

/** Per kart in the view: [x*10, y*10, heading mrad, motion mrad, speed, z*10, flags, item, uses or roll, lap, rank, fin tick or -1]. */
export type KartViewKart = number[]

export interface KartView {
  /** Track index. */
  tr: number
  ph: number
  /** Countdown ticks left (ph 0) or race ticks. */
  t: number
  k: KartViewKart[]
  /** Objects: [type, x*10, y*10, extra]. */
  o: number[][]
  /** Bit i set: item box i is present. */
  bx: number
  ev: { id: number; e: number; s: number; v: number }[]
  /** Final order (seats) when over, else []. */
  ord: number[]
  /** Ticks left before the race closes after the first finisher (-1: not running). */
  end: number
}

export const angleWrap = (a: number): number => {
  a = (a + Math.PI) % (2 * Math.PI)
  if (a < 0) a += 2 * Math.PI
  return a - Math.PI
}
