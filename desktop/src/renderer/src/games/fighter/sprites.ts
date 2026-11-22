// Dojo Duel fighter sprites, drawn in code: each animation frame is a pose (7 joints: hip, chest, head, both
// hands, both feet; elbows and knees come from 2-bone IK) rasterized into outlined, two-tone pixel art, with a
// string-grid head per fighter. Poses are interpolated for startup / recovery frames and quantized so every
// distinct frame is rasterized once and cached (per fighter, seat tint and variant).
import {
  AIRHIT,
  ATTACK,
  BLOCK,
  BLOCKC,
  CHARS,
  CROUCH,
  DOWN,
  FL_FLIP,
  FL_GUARD,
  FL_RISING,
  HIT,
  HITC,
  IDLE,
  JUMP,
  KO,
  LAND,
  M_THROW,
  PREJUMP,
  SLAM_RELEASE,
  THROW,
  THROW_RELEASE,
  THROWN,
  TLOSE,
  WAKE,
  WALKB,
  WALKF,
  WIN,
} from '@shared/games/fighter/chars'

/** hip, chest, head, near hand, far hand, near foot, far foot: x forward, y up (unscaled px). */
type Pose = number[]

// prettier-ignore
const P: Record<string, Pose> = {
  stance: [0, 28, 2, 45, 4, 54, 16, 40, 11, 38, 8, 0, -9, 0],
  idle2: [0, 27, 2, 44, 4, 53, 16, 38, 11, 36, 8, 0, -9, 0],
  crouch: [0, 16, 4, 31, 7, 39, 16, 28, 11, 26, 10, 0, -10, 0],
  pre: [0, 22, 3, 38, 5, 47, 14, 32, 9, 30, 8, 0, -8, 0],
  jumpup: [0, 30, 1, 47, 2, 56, 8, 56, 4, 52, 3, 4, -3, 6],
  tuck: [0, 32, 3, 46, 5, 54, 14, 41, 9, 39, 7, 18, -4, 20],
  block: [-1, 28, -1, 45, 1, 53, 8, 50, 6, 47, 6, 0, -10, 0],
  blockc: [-1, 16, 1, 31, 3, 38, 9, 36, 7, 33, 9, 0, -10, 0],
  hit: [-2, 28, -6, 44, -9, 51, -2, 34, -8, 36, 7, 0, -9, 0],
  hitc: [-2, 16, -5, 30, -8, 37, 2, 24, -3, 25, 9, 0, -10, 0],
  airhit: [0, 30, -12, 38, -19, 42, -4, 48, -12, 50, 12, 36, 8, 28],
  lie: [0, 5, -17, 5, -26, 5, -14, 12, -20, 2, 15, 3, 14, 1],
  tlose: [0, 26, 3, 42, 7, 46, 6, 28, 2, 27, 6, 0, -8, 0],
  grabT: [2, 28, 6, 44, 9, 52, 20, 42, 18, 38, 9, 0, -8, 0],
  toss: [-1, 28, -6, 44, -9, 52, -14, 58, -10, 56, 8, 0, -8, 0],
  lift: [0, 28, 0, 46, 1, 55, 6, 64, 2, 62, 8, 0, -8, 0],
  slam: [4, 22, 12, 36, 16, 42, 24, 20, 20, 22, 12, 0, -10, 0],
  jab: [1, 28, 4, 45, 6, 54, 24, 46, 9, 41, 8, 0, -9, 0],
  straight: [3, 28, 9, 44, 11, 52, 30, 45, 4, 38, 12, 0, -10, 0],
  snap: [-1, 28, -3, 45, -2, 54, 8, 44, 4, 40, 24, 18, -8, 0],
  round: [-2, 29, -8, 43, -9, 52, 2, 46, -6, 40, 27, 40, -6, 0],
  cjab: [0, 16, 5, 31, 8, 39, 22, 31, 9, 29, 10, 0, -10, 0],
  upper: [1, 18, 6, 34, 8, 43, 13, 60, 8, 30, 10, 0, -10, 0],
  ckick: [-2, 16, 1, 31, 4, 39, 12, 32, 7, 29, 25, 2, -9, 0],
  sweep: [-2, 12, -5, 26, -3, 34, 8, 20, -12, 4, 31, 2, -4, 0],
  apunch: [0, 30, 4, 45, 6, 53, 22, 36, 8, 42, 4, 16, -6, 18],
  akick: [0, 30, -3, 44, -3, 53, 6, 46, -4, 42, 25, 22, -6, 20],
  axeUp: [0, 28, -4, 45, -4, 54, 6, 46, 0, 42, 12, 56, -8, 0],
  axe: [0, 28, -2, 45, -1, 54, 8, 44, 3, 40, 21, 28, -8, 0],
  waveUp: [-2, 27, -1, 43, 2, 51, -8, 32, -6, 34, 6, 0, -10, 0],
  wave: [2, 26, 7, 41, 10, 49, 26, 38, 25, 42, 13, 0, -10, 0],
  rise: [0, 30, 3, 47, 5, 56, 10, 74, 4, 42, 4, 8, -4, 14],
  butt: [1, 30, 6, 46, 10, 55, 6, 38, -2, 40, 4, 6, -4, 10],
  petal: [0, 30, -6, 44, -7, 53, 2, 48, -6, 44, 26, 36, -2, 16],
  spin: [0, 30, 0, 46, 1, 55, -13, 47, 13, 47, 26, 36, -6, 12],
  dash: [0, 26, -8, 36, -12, 42, -6, 40, -12, 32, 28, 22, 4, 14],
  grab: [2, 26, 7, 42, 10, 50, 24, 44, 22, 38, 10, 0, -9, 0],
  charge: [4, 24, 14, 36, 18, 42, 16, 30, 10, 32, 16, 0, -10, 2],
  needle: [1, 28, 5, 45, 7, 53, 26, 50, 4, 40, 10, 0, -9, 0],
  win0: [0, 28, 1, 46, 2, 55, 6, 68, 7, 40, 6, 0, -7, 0],
  win1: [0, 28, 0, 46, 1, 55, 10, 57, -8, 57, 9, 0, -9, 0],
  win2: [0, 28, 2, 46, 3, 55, 12, 58, -4, 36, 6, 0, -5, 10],
}

/** The pose a move holds while active (the move table's `pose`), and an optional wind-up pose. */
const WINDUP: Record<string, string> = { axe: 'axeUp', wave: 'waveUp', needle: 'waveUp', charge: 'pre', grab: 'pre' }

const lerpPose = (a: Pose, b: Pose, k: number): Pose => a.map((v, i) => v + (b[i] - v) * k)
const q4 = (k: number) => Math.round(Math.min(1, Math.max(0, k)) * 4) / 4

export interface Frame {
  pose: Pose
  /** Rotation (radians, counter-clockwise in pose space) around the body center, in 1/8 turns. */
  rot: number
  mirror: boolean
  /** 0 normal, 1 white flash (just hit), 2 armor glow. */
  variant: number
}

/** The animation frame of a fighter from its view tuple fields. */
export function frameOf(ch: number, act: number, t: number, mv: number, flags: number, vy: number): Frame {
  const c = CHARS[ch]
  const f: Frame = { pose: P.stance, rot: 0, mirror: false, variant: 0 }
  switch (act) {
    case IDLE:
      f.pose = Math.floor(t / 18) % 2 ? P.idle2 : P.stance
      break
    case WALKF:
    case WALKB: {
      if (flags & FL_GUARD) {
        f.pose = P.block
        break
      }
      const ph = Math.floor((t / 26) * 8) % 8
      const s = Math.sin(((act === WALKB ? 8 - ph : ph) / 8) * Math.PI * 2)
      const cs = Math.cos(((act === WALKB ? 8 - ph : ph) / 8) * Math.PI * 2)
      const p = [...P.stance]
      p[10] = 1 + 9 * s
      p[11] = cs > 0 ? 3 * cs : 0
      p[12] = -1 - 9 * s
      p[13] = cs < 0 ? -3 * cs : 0
      p[1] = 28 - Math.abs(s)
      p[3] = 45 - Math.abs(s)
      p[5] = 54 - Math.abs(s)
      f.pose = p
      break
    }
    case CROUCH:
      f.pose = flags & FL_GUARD ? P.blockc : t < 2 ? lerpPose(P.stance, P.crouch, 0.5) : P.crouch
      break
    case PREJUMP:
    case LAND:
      f.pose = P.pre
      break
    case JUMP: {
      if (flags & FL_FLIP) {
        const air = (2 * c.jumpVy) / c.grav
        const k = Math.min(1, Math.max(0, (t - 3) / (air - 10)))
        f.pose = k <= 0 || k >= 1 ? P.jumpup : P.tuck
        f.rot = -Math.round(k * 8) % 8
      } else f.pose = flags & FL_RISING && t < 10 ? P.jumpup : vy < 0 && t > 26 ? lerpPose(P.tuck, P.jumpup, 0.5) : P.tuck
      break
    }
    case ATTACK: {
      const m = mv >= 0 ? c.moves[mv] : null
      if (!m) break
      const base = m.air ? P.tuck : m.crouch ? P.crouch : P.stance
      const active = P[m.pose] ?? P.jab
      const wind = WINDUP[m.pose] ? P[WINDUP[m.pose]] : null
      if (t < m.su) f.pose = wind ? lerpPose(base, wind, q4((t + 1) / m.su)) : lerpPose(base, active, q4(((t + 1) / m.su) * 0.6))
      else if (t < m.su + m.ac) f.pose = active
      else if (m.vy) f.pose = lerpPose(active, P.tuck, 0.5)
      else f.pose = lerpPose(active, base, q4((t - m.su - m.ac + 1) / Math.max(1, m.rc)))
      if ((m.pose === 'spin' || m.pose === 'petal') && t >= m.su && t < m.su + m.ac) f.mirror = Math.floor((t - m.su) / 3) % 2 === 1
      break
    }
    case HIT:
      f.pose = t < 10 ? P.hit : lerpPose(P.hit, P.stance, 0.5)
      if (t < 3) f.variant = 1
      break
    case HITC:
      f.pose = P.hitc
      if (t < 3) f.variant = 1
      break
    case BLOCK:
      f.pose = P.block
      break
    case BLOCKC:
      f.pose = P.blockc
      break
    case AIRHIT:
      f.pose = P.airhit
      f.rot = t < 8 ? 0 : vy < 0 ? 1 : 0
      if (t < 3) f.variant = 1
      break
    case DOWN:
    case KO:
      f.pose = P.lie
      break
    case WAKE:
      f.pose = lerpPose(P.lie, P.crouch, q4(t / 16))
      break
    case THROW: {
      const slam = mv !== M_THROW
      if (slam) f.pose = t < 4 ? P.grab : t < SLAM_RELEASE ? P.lift : P.slam
      else f.pose = t < THROW_RELEASE - 4 ? P.grabT : P.toss
      break
    }
    case THROWN:
      f.pose = P.airhit
      f.rot = Math.min(4, Math.floor(t / 4))
      break
    case WIN:
      f.pose = Math.floor(t / 20) % 2 ? P[`win${ch}`] : lerpPose(P.stance, P[`win${ch}`], 0.75)
      break
    case TLOSE:
      f.pose = P.tlose
      break
  }
  return f
}

// ---------------------------------------------------------------------------------------------
// Looks

interface Look {
  /** Limb radii (unscaled). */
  thigh: number
  shin: number
  upper: number
  fore: number
  fist: number
  torso: number
  pelvis: number
  skin: string
  hair: string
  /** Colors by part: 'seat' is the seat color. */
  top: string
  sleeve: string
  pants: string
  belt: string
  feet: string
  hands: string
  head: string[]
}

// Head grids (facing right): s skin, S skin shade, h hair, H hair shade, e eye / mouth, w white, r seat color.
const LOOKS: Look[] = [
  {
    thigh: 4.3,
    shin: 3.7,
    upper: 3.3,
    fore: 2.8,
    fist: 3.1,
    torso: 6.3,
    pelvis: 5.6,
    skin: '#e2a873',
    hair: '#2b201c',
    top: 'seat',
    sleeve: 'seat',
    pants: 'seat',
    belt: '#1a1414',
    feet: 'skin',
    hands: 'skin',
    // prettier-ignore
    head: [
      '....h.h.h...',
      '..hhhhhhhh..',
      '.hhhhhhhhhh.',
      'wwwwwwwwwww.',
      'w.hhsssssss.',
      'w..hsssswes.',
      '...hssssssss',
      '....sssssss.',
      '....Ssssse..',
      '.....SSSSS..',
      '......SSS...',
    ],
  },
  {
    thigh: 5.3,
    shin: 4.5,
    upper: 4.5,
    fore: 3.9,
    fist: 3.9,
    torso: 8.6,
    pelvis: 7.2,
    skin: '#c08055',
    hair: '#5a3a26',
    top: 'skin',
    sleeve: 'skin',
    pants: 'seat',
    belt: '#e6b93a',
    feet: '#3b2b25',
    hands: '#e6b93a',
    // prettier-ignore
    head: [
      '............',
      '...SSSSSS...',
      '..Sssssssss.',
      '.Ssssssssss.',
      '.SsssssHHHs.',
      '.Sssssswess.',
      '.Ssssssssss',
      '.HhhhhHssss.',
      '.Hhhhhhhhhh.',
      '..Hhhhhhhh..',
      '...HhhhhH...',
      '.....HH.....',
    ],
  },
  {
    thigh: 3.7,
    shin: 3.2,
    upper: 2.8,
    fore: 2.4,
    fist: 2.6,
    torso: 5.3,
    pelvis: 4.9,
    skin: '#f1c69c',
    hair: '#4a2a5a',
    top: 'seat',
    sleeve: 'skin',
    pants: '#2b3150',
    belt: 'seat',
    feet: '#eeeeee',
    hands: 'seat',
    // prettier-ignore
    head: [
      '....hhhhh...',
      '..hhhhhhhh..',
      '.hhhhhhhhhh.',
      'hhrhhhhhhhh.',
      'hhhhhhsssss.',
      'hh.hssssews.',
      'hh.hssssssss',
      'Hh..sssssss.',
      'Hh..ssssse..',
      'HH...SSSS...',
      '.H....SS....',
    ],
  },
]

// Palette indices.
const OUT = 1
const SKIN = 2
const TOP = 4
const PANTS = 6
const BELT = 8
const HAIR = 10
const FEET = 12
const HANDS = 14
const WHITE = 16
const EYE = 17
const SEAT = 18
// Each color index c has its shade at c + 1 (SEAT's shade is 19).

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return hex.length === 4
    ? [((n >> 8) & 15) * 17, ((n >> 4) & 15) * 17, (n & 15) * 17]
    : [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const shade = ([r, g, b]: [number, number, number], k: number): [number, number, number] => [r * k, g * k, b * k].map(Math.round) as [number, number, number]

function palette(ch: number, seatColor: string, variant: number): [number, number, number][] {
  const L = LOOKS[ch]
  const seat = rgb(seatColor)
  const pick = (c: string) => (c === 'seat' ? seat : c === 'skin' ? rgb(L.skin) : rgb(c))
  const pal: [number, number, number][] = []
  const set = (i: number, c: [number, number, number]) => {
    pal[i] = c
    pal[i + 1] = shade(c, 0.66)
  }
  pal[0] = [0, 0, 0]
  pal[OUT] = variant === 2 ? [255, 140, 40] : [24, 14, 20]
  set(SKIN, rgb(L.skin))
  set(TOP, pick(L.top))
  set(PANTS, pick(L.pants))
  set(BELT, pick(L.belt))
  set(HAIR, rgb(L.hair))
  set(FEET, pick(L.feet))
  set(HANDS, pick(L.hands))
  pal[WHITE] = [240, 240, 236]
  pal[EYE] = [24, 14, 20]
  set(SEAT, seat)
  if (variant === 1) for (let i = 2; i < pal.length; i++) pal[i] = [255, 255, 255]
  return pal
}

const colorIndex = (c: string): number => (c === 'seat' ? SEAT : c === 'skin' ? SKIN : -1)

// ---------------------------------------------------------------------------------------------
// Rasterizer

export const SPR_W = 128
export const SPR_H = 120
/** Where the feet (the fighter's x, y) are in the sprite. */
export const SPR_OX = 64
export const SPR_OY = 108

type Pt = [number, number]

function ik(a: Pt, c: Pt, l1: number, l2: number, sign: number): Pt {
  const dx = c[0] - a[0]
  const dy = c[1] - a[1]
  let d = Math.hypot(dx, dy)
  if (d < 0.001) return [a[0] + l1 * sign, a[1]]
  const ux = dx / d
  const uy = dy / d
  if (d >= l1 + l2) return [a[0] + ux * l1, a[1] + uy * l1]
  d = Math.max(d, Math.abs(l1 - l2) + 0.01)
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x))
  return [a[0] + ux * x - uy * h * sign, a[1] + uy * x + ux * h * sign]
}

class Raster {
  idx = new Uint8Array(SPR_W * SPR_H)
  layer = new Uint8Array(SPR_W * SPR_H)

  capsule(a: Pt, b: Pt, r: number, col: number, dark: boolean) {
    const [ax, ay] = a
    const [bx, by] = b
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1))
    const x1 = Math.min(SPR_W - 1, Math.ceil(Math.max(ax, bx) + r + 1))
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1))
    const y1 = Math.min(SPR_H - 1, Math.ceil(Math.max(ay, by) + r + 1))
    const ex = bx - ax
    const ey = by - ay
    const len2 = ex * ex + ey * ey || 1
    const r2 = r * r
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const cx = px + 0.5
        const cy = py + 0.5
        const k = Math.max(0, Math.min(1, ((cx - ax) * ex + (cy - ay) * ey) / len2))
        const dx = cx - (ax + ex * k)
        const dy = cy - (ay + ey * k)
        if (dx * dx + dy * dy > r2) continue
        this.layer[py * SPR_W + px] = dark || dy > r * 0.35 ? col + 1 : col
      }
    }
  }

  grid(rows: string[], cx: number, cy: number, dark: boolean) {
    const map: Record<string, number> = { s: SKIN, S: SKIN + 1, h: HAIR, H: HAIR + 1, e: EYE, w: WHITE, r: SEAT }
    const ox = Math.round(cx) - 6
    const oy = Math.round(cy) - 6
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        const v = map[row[rx]]
        if (v === undefined) continue
        const x = ox + rx
        const y = oy + ry
        if (x < 0 || y < 0 || x >= SPR_W || y >= SPR_H) continue
        this.layer[y * SPR_W + x] = dark && v !== EYE && v !== WHITE ? (v === SKIN || v === HAIR || v === SEAT ? v + 1 : v) : v
      }
    })
  }

  /** Puts the layer on the sprite with a 1 px outline around it (also over what's below: inner outlines). */
  flush() {
    const { idx, layer } = this
    for (let y = 0; y < SPR_H; y++) {
      for (let x = 0; x < SPR_W; x++) {
        const i = y * SPR_W + x
        if (layer[i]) idx[i] = layer[i]
        else if ((x > 0 && layer[i - 1]) || (x < SPR_W - 1 && layer[i + 1]) || (y > 0 && layer[i - SPR_W]) || (y < SPR_H - 1 && layer[i + SPR_W])) idx[i] = OUT
      }
    }
    // Clear in a second pass (neighbors were needed above).
    layer.fill(0)
  }
}

function rasterize(ch: number, fr: Frame): Uint8Array {
  const L = LOOKS[ch]
  const sc = CHARS[ch].scale
  const rot = (fr.rot * Math.PI) / 4
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const pt = (i: number): Pt => {
    let x = fr.pose[i * 2]
    let y = fr.pose[i * 2 + 1]
    if (rot) {
      const dx = x
      const dy = y - 32
      x = dx * cos - dy * sin
      y = 32 + dx * sin + dy * cos
    }
    return [SPR_OX + x * sc, SPR_OY - y * sc]
  }
  const hip = pt(0)
  const chest = pt(1)
  const head = pt(2)
  const hands = [pt(3), pt(4)]
  const feet = [pt(5), pt(6)]
  const R = new Raster()
  // Body direction (for shoulders / hips offsets).
  const bx = chest[0] - hip[0]
  const by = chest[1] - hip[1]
  const bl = Math.hypot(bx, by) || 1
  const nx = -by / bl
  const ny = bx / bl
  const side = (p: Pt, k: number): Pt => [p[0] - nx * k * sc, p[1] - ny * k * sc]
  const thighL = 15 * sc
  const shinL = 15 * sc
  const upL = 10 * sc
  const foreL = 10.5 * sc
  const c = (s: string, fallback: number) => {
    const i = colorIndex(s)
    return i >= 0 ? i : fallback
  }
  const sleeveCol = c(L.sleeve, TOP)
  const handCol = c(L.hands, HANDS)
  const feetCol = c(L.feet, FEET)
  const pantsCol = c(L.pants, PANTS)
  const topCol = c(L.top, TOP)
  const beltCol = c(L.belt, BELT)

  const arm = (near: boolean) => {
    const sh = side(chest, near ? -1.5 : 1.5)
    sh[1] += 1.5 * sc
    const hand = hands[near ? 0 : 1]
    const el = ik(sh, hand, upL, foreL, -1)
    const dark = !near
    R.capsule(sh, el, L.upper * sc, sleeveCol, dark)
    R.capsule(el, hand, L.fore * sc, SKIN, dark)
    R.capsule(hand, hand, L.fist * sc, handCol, dark)
    R.flush()
  }
  const leg = (near: boolean) => {
    const hp = side(hip, near ? -1.5 : 1.5)
    const foot = feet[near ? 0 : 1]
    const knee = ik(hp, foot, thighL, shinL, 1)
    const dark = !near
    R.capsule(hp, knee, L.thigh * sc, pantsCol, dark)
    const mid: Pt = [knee[0] + (foot[0] - knee[0]) * 0.72, knee[1] + (foot[1] - knee[1]) * 0.72]
    R.capsule(knee, mid, L.shin * sc, pantsCol, dark)
    // Foot: points forward on the ground, along the shin when kicking.
    const sx = foot[0] - knee[0]
    const sy = foot[1] - knee[1]
    const sl = Math.hypot(sx, sy) || 1
    const flat = sy / sl > 0.75
    const tip: Pt = flat ? [foot[0] + 4.5 * sc, foot[1]] : [foot[0] + (sx / sl) * 3.5 * sc, foot[1] + (sy / sl) * 3.5 * sc]
    R.capsule(mid, foot, L.shin * 0.85 * sc, feetCol, dark)
    R.capsule(foot, tip, 2 * sc, feetCol, dark)
    R.flush()
  }
  arm(false)
  leg(false)
  // Torso: pelvis, body, belt.
  R.capsule(hip, hip, L.pelvis * sc, pantsCol, false)
  const waist: Pt = [hip[0] + bx * 0.25, hip[1] + by * 0.25]
  R.capsule(waist, chest, L.torso * sc, topCol, false)
  R.capsule([hip[0] + bx * 0.2 + nx * L.pelvis * sc * 0.9, hip[1] + by * 0.2 + ny * L.pelvis * sc * 0.9], [hip[0] + bx * 0.2 - nx * L.pelvis * sc * 0.9, hip[1] + by * 0.2 - ny * L.pelvis * sc * 0.9], 1.4 * sc, beltCol, false)
  if (ch === 1) {
    // Bruno's chest strap.
    R.capsule([chest[0] + nx * 5 * sc, chest[1] + ny * 5 * sc], [waist[0] - nx * 5 * sc, waist[1] - ny * 5 * sc], 1.2 * sc, SEAT, false)
  }
  R.flush()
  leg(true)
  R.capsule([chest[0] + (head[0] - chest[0]) * 0.3, chest[1] + (head[1] - chest[1]) * 0.3], [chest[0] + (head[0] - chest[0]) * 0.7, chest[1] + (head[1] - chest[1]) * 0.7], 2.6 * sc, SKIN, false)
  R.grid(L.head, head[0], head[1], false)
  R.flush()
  arm(true)
  return R.idx
}

const cache = new Map<string, HTMLCanvasElement>()

/** The sprite canvas (SPR_W × SPR_H, feet at SPR_OX, SPR_OY, facing right) of a frame, tinted for a seat. */
export function sprite(ch: number, seatColor: string, fr: Frame): HTMLCanvasElement {
  const key = `${ch}|${seatColor}|${fr.variant}|${fr.rot}|${fr.pose.map((v) => Math.round(v * 2)).join(',')}`
  let cv = cache.get(key)
  if (cv) return cv
  if (cache.size > 900) cache.clear()
  const idx = rasterize(ch, fr)
  const pal = palette(ch, seatColor, fr.variant)
  cv = document.createElement('canvas')
  cv.width = SPR_W
  cv.height = SPR_H
  const g = cv.getContext('2d')
  if (g) {
    const img = g.createImageData(SPR_W, SPR_H)
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i]
      if (!v) continue
      const c = pal[v] ?? [255, 0, 255]
      img.data[i * 4] = c[0]
      img.data[i * 4 + 1] = c[1]
      img.data[i * 4 + 2] = c[2]
      img.data[i * 4 + 3] = 255
    }
    g.putImageData(img, 0, 0)
  }
  cache.set(key, cv)
  return cv
}

/** Draws a fighter with its feet at (x, y) on the screen. */
export function drawFighter(ctx: CanvasRenderingContext2D, ch: number, seatColor: string, fr: Frame, x: number, y: number, face: number) {
  const cv = sprite(ch, seatColor, fr)
  const flip = (face < 0) !== fr.mirror
  ctx.save()
  ctx.translate(Math.round(x), Math.round(y))
  if (flip) ctx.scale(-1, 1)
  ctx.drawImage(cv, -SPR_OX, -SPR_OY)
  ctx.restore()
}

