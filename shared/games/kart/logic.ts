// Kart Rally: a pseudo-3D kart racer for 1-8 karts (bots fill seats). 3 laps on one of three original tracks,
// hop-drifts that charge mini-turbos, item boxes with original items (nitro, oil slick, bolt, seeker drone,
// bubble shield), checkpoints so infield cuts don't count. Server-authoritative at 30 Hz; the view
// (desktop games/kart) renders a Mode-7 style chase camera from the compact view below.
import { GAME_PAD } from '../../protocol.ts'
import type { GameSeat } from '../../protocol.ts'
import type { GameContext, GameDefinition, GameOutcome, TickInput } from '../types.ts'
import { buildTrack, CHECKPOINTS, nearest, nearestLocal, newNear, OFF_W, pointAt, trackCount, wrapS } from './track.ts'
import type { Track } from './track.ts'
import {
  ACCEL,
  AFTER_FIRST,
  angleWrap,
  BOOST_SPEED,
  BOX_R,
  BOX_RESPAWN,
  BRAKE,
  CHARGE_1,
  CHARGE_2,
  COAST,
  COUNTDOWN,
  DRIFT_MIN_SPEED,
  DT,
  EV_BOOST,
  EV_BOX,
  EV_BUMP,
  EV_COUNT,
  EV_FINAL,
  EV_FINISH,
  EV_GO,
  EV_HIT,
  EV_ITEM,
  EV_LAP,
  EV_SHIELD_POP,
  EV_USE,
  EV_WALL,
  F_BOOST,
  F_BRAKE,
  F_DRIFT_L,
  F_DRIFT_R,
  F_FIN,
  F_GONE,
  F_OFF,
  F_SHIELD,
  F_SPARK1,
  F_SPARK2,
  F_SPIN,
  F_WRONG,
  ITEM_BOLT,
  ITEM_NITRO,
  ITEM_NITRO3,
  ITEM_NONE,
  ITEM_SEEKER,
  ITEM_SHIELD,
  ITEM_SLICK,
  KART_R,
  LAPS,
  MAX_SLICKS,
  OBJ_BOLT,
  OBJ_SEEKER,
  OBJ_SLICK,
  OFF_SPEED,
  OVER_HOLD,
  RACE_CAP,
  ROLL_TICKS,
  TICK_HZ,
  TURBO_1,
  TURBO_2,
  TURN,
  VMAX,
  VREV,
} from './model.ts'
import type { Kart, KartAi, KartObj, KartState, KartView } from './model.ts'
import { botButtons, ITEM_UNSET } from './bot.ts'

export type { Kart, KartAi, KartEvent, KartObj, KartState, KartView, KartViewKart } from './model.ts'

const P = GAME_PAD
const STEER_BTN = P.LEFT | P.RIGHT
const HOP_BTN = P.R | P.L
const USE_BTN = P.X | P.Y

// Scratch query results (the logic is single-threaded; nothing keeps them across calls).
const qg = newNear()
const ql = newNear()

function emit(s: KartState, e: number, seat: number, v = 0): void {
  s.events.push({ id: ++s.evId, e, s: seat, v, at: s.tick })
  if (s.events.length > 40) s.events.shift()
}

/** Unwrapped race distance of global checkpoint g (0 = the start line, LAPS * CHECKPOINTS = the finish). */
function cpU(t: Track, g: number): number {
  return Math.floor(g / CHECKPOINTS) * t.total + t.cpS[g % CHECKPOINTS]
}

/** Progress for ranking: distance along the race, capped at the next checkpoint not yet passed. */
function progress(t: Track, k: Kart): number {
  if (k.passed > LAPS * CHECKPOINTS) return LAPS * t.total
  return Math.min(k.u, cpU(t, k.passed) - 0.5)
}

export function lapOf(k: Kart): number {
  return Math.max(1, Math.min(LAPS, Math.floor((k.passed - 1) / CHECKPOINTS) + 1))
}

function newKart(t: Track, s: number, lat: number): Kart {
  const p = pointAt(t, s, lat)
  const a = Math.atan2(p.dy, p.dx)
  return {
    x: p.x,
    y: p.y,
    a,
    m: a,
    v: 0,
    z: 0,
    vz: 0,
    st: 0,
    px: 0,
    py: 0,
    drift: 0,
    charge: 0,
    hopDir: 0,
    boost: 0,
    spin: 0,
    inv: 0,
    shield: 0,
    off: false,
    air: false,
    seg: p.k,
    s: wrapS(t, s),
    u: wrapS(t, s) - t.total,
    lat,
    passed: 0,
    fin: -1,
    rank: 1,
    item: ITEM_NONE,
    uses: 0,
    roll: 0,
    rollItem: ITEM_NONE,
    gone: false,
    wrong: 0,
    aAt: -1,
    quiet: 0,
    btn: 0,
  }
}

function create(seats: GameSeat[], ctx: GameContext): KartState {
  const track = Math.min(trackCount() - 1, Math.floor(ctx.random() * trackCount()))
  const t = buildTrack(track)
  // Grid order: shuffled; two columns, staggered, behind the start line.
  const order = seats.map((x) => x.seat)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.random() * (i + 1))
    const tmp = order[i]
    order[i] = order[j]
    order[j] = tmp
  }
  const karts: Kart[] = seats.map(() => newKart(t, 0, 0))
  order.forEach((seat, slot) => {
    const row = Math.floor(slot / 2)
    const col = slot % 2
    const s = t.total - 14 - row * 22 - col * 11
    const hw = pointAt(t, s, 0).w
    const k = newKart(t, s, (col === 0 ? -1 : 1) * hw * 0.42)
    k.rank = slot + 1
    karts[seat] = k
  })
  const ai: KartAi[] = seats.map(() => ({
    pref: (ctx.random() - 0.5) * 0.6,
    skill: 0.35 + ctx.random() * 0.65,
    stuck: 0,
    rev: 0,
    itemWait: ITEM_UNSET,
    launch: 2 + Math.floor(ctx.random() * 22),
    dodge: 0,
    dodgeT: 0,
    dr: 0,
    drT: 0,
    slip: 0,
  }))
  const s: KartState = {
    seats,
    track,
    phase: 0,
    tick: 0,
    race: 0,
    karts,
    objs: [],
    boxes: t.boxes.map(() => 0),
    ai,
    events: [],
    evId: 0,
    firstFin: -1,
    overAt: -1,
    order: [],
  }
  emit(s, EV_COUNT, -1, 3)
  return s
}

// ---------------------------------------------------------------------------------------------
// Items

/** The item a box gives at race position `rank` of `n` karts (`r`: a random number in [0, 1)). */
export function pickItem(rank: number, n: number, r: number): number {
  const frac = n <= 1 ? 0 : (rank - 1) / (n - 1)
  const table: [number, number][] =
    rank === 1 || frac < 0.25
      ? [
          [ITEM_SLICK, 40],
          [ITEM_BOLT, 30],
          [ITEM_SHIELD, 20],
          [ITEM_NITRO, 10],
        ]
      : frac < 0.65
        ? [
            [ITEM_NITRO, 22],
            [ITEM_BOLT, 26],
            [ITEM_SEEKER, 22],
            [ITEM_SLICK, 14],
            [ITEM_SHIELD, 16],
          ]
        : [
            [ITEM_NITRO, 20],
            [ITEM_NITRO3, 32],
            [ITEM_SEEKER, 32],
            [ITEM_SHIELD, 10],
            [ITEM_BOLT, 6],
          ]
  let total = 0
  for (const [, w] of table) total += w
  let x = r * total
  for (const [item, w] of table) {
    x -= w
    if (x < 0) return item
  }
  return table[0][0]
}

function addObj(s: KartState, o: Omit<KartObj, 'vx' | 'vy' | 'target' | 's' | 'seg'> & Partial<KartObj>): void {
  s.objs.push({ vx: 0, vy: 0, target: -1, s: 0, seg: 0, ...o })
}

function useItem(s: KartState, i: number, btn: number): void {
  const k = s.karts[i]
  const item = k.item
  const t = buildTrack(s.track)
  const fx = Math.cos(k.a)
  const fy = Math.sin(k.a)
  const back = (btn & P.DOWN) !== 0
  if (item === ITEM_NITRO || item === ITEM_NITRO3) {
    k.boost = Math.max(k.boost, 40)
    emit(s, EV_BOOST, i, 1)
  } else if (item === ITEM_SLICK) {
    const fwd = (btn & P.UP) !== 0
    const d = fwd ? 70 : -(KART_R + 9)
    let slicks = 0
    for (const o of s.objs) if (o.type === OBJ_SLICK) slicks++
    if (slicks >= MAX_SLICKS) {
      const first = s.objs.findIndex((o) => o.type === OBJ_SLICK)
      if (first >= 0) s.objs.splice(first, 1)
    }
    addObj(s, { type: OBJ_SLICK, x: k.x + fx * d, y: k.y + fy * d, life: 45 * TICK_HZ, owner: i, grace: fwd ? 0 : 20 })
  } else if (item === ITEM_BOLT) {
    const dir = back ? -1 : 1
    const speed = back ? VMAX * 1.3 : VMAX * 2 + Math.max(0, k.v) * 0.5
    addObj(s, {
      type: OBJ_BOLT,
      x: k.x + fx * dir * (KART_R + 6),
      y: k.y + fy * dir * (KART_R + 6),
      vx: fx * dir * speed,
      vy: fy * dir * speed,
      life: Math.round(2.6 * TICK_HZ),
      owner: i,
      grace: 8,
    })
  } else if (item === ITEM_SEEKER) {
    let target = -1
    for (let j = 0; j < s.karts.length; j++) {
      const o = s.karts[j]
      if (j !== i && !o.gone && o.rank === k.rank - 1) target = j
    }
    addObj(s, {
      type: OBJ_SEEKER,
      x: k.x + fx * (KART_R + 6),
      y: k.y + fy * (KART_R + 6),
      vx: k.lat,
      life: 12 * TICK_HZ,
      owner: i,
      grace: 20,
      target,
      s: wrapS(t, k.s + 8),
      seg: k.seg,
    })
  } else if (item === ITEM_SHIELD) {
    k.shield = 8 * TICK_HZ
  } else return
  emit(s, EV_USE, i, item)
  k.uses--
  if (k.uses <= 0) {
    k.item = ITEM_NONE
    k.uses = 0
  }
}

/** A kart is hit by a hazard: the shield pops, or it spins out. */
function hitKart(s: KartState, i: number, spin: number, pop: number, kind: number): void {
  const k = s.karts[i]
  if (k.shield > 0) {
    k.shield = 0
    k.inv = 10
    emit(s, EV_SHIELD_POP, i)
    return
  }
  if (k.inv > 0 || k.spin > 0) return
  k.spin = spin
  k.inv = spin + 20
  k.drift = 0
  k.charge = 0
  k.boost = 0
  k.v *= 0.5
  if (pop > 0 && k.z <= 0) k.vz = pop
  emit(s, EV_HIT, i, kind)
}

// ---------------------------------------------------------------------------------------------
// Driving

function drive(s: KartState, i: number, btn: number, pressed: number, mult: number): void {
  const k = s.karts[i]
  const t = buildTrack(s.track)
  k.btn = btn
  if (k.quiet > 0) k.quiet--
  if (k.boost > 0) k.boost--
  if (k.inv > 0) k.inv--
  if (k.shield > 0) k.shield--
  const spinning = k.spin > 0
  if (spinning) k.spin--
  const grounded = k.z <= 0 && k.vz <= 0
  let steer = (btn & P.RIGHT ? 1 : 0) - (btn & P.LEFT ? 1 : 0)
  if (spinning) steer = 0
  k.st += (steer - k.st) * 0.45
  if (Math.abs(k.st) < 0.01) k.st = 0

  // Hop into a drift: the direction is the one steered while in the air.
  let hopping = !grounded && !k.air
  if (pressed & HOP_BTN && grounded && !spinning && k.drift === 0) {
    k.vz = 72
    k.hopDir = steer
    hopping = true
  }
  if (hopping && steer !== 0) k.hopDir = steer
  const sp = Math.abs(k.v)
  if (k.drift !== 0) {
    if (!(btn & HOP_BTN) || sp < DRIFT_MIN_SPEED * 0.8 || spinning) {
      if (!spinning && k.charge >= CHARGE_1) {
        k.boost = Math.max(k.boost, k.charge >= CHARGE_2 ? TURBO_2 : TURBO_1)
        emit(s, EV_BOOST, i, k.charge >= CHARGE_2 ? 3 : 2)
      }
      k.drift = 0
      k.charge = 0
    } else {
      k.charge += (1 + Math.max(0, k.st * k.drift)) * (k.off ? 0.4 : 1)
    }
  }

  // Turning.
  let turn: number
  if (k.drift !== 0) turn = k.drift * TURN * Math.max(0.14, 0.62 + 0.48 * k.st * k.drift)
  else turn = k.st * TURN * Math.min(1, sp / 28) * (1 - 0.18 * Math.min(1, sp / VMAX))
  if (k.v < 0) turn = -turn
  if (k.air) turn *= 0.35
  if (spinning) turn = 0
  k.a = angleWrap(k.a + turn * DT)

  // Speed.
  let vmax = VMAX * mult
  if (k.boost > 0) vmax = VMAX * BOOST_SPEED * mult * (k.off && !k.air ? 0.88 : 1)
  else if (k.off && !k.air) vmax *= OFF_SPEED
  if (k.drift !== 0) vmax *= 0.97
  if (spinning) k.v *= 0.9
  else if (k.boost > 0) k.v = Math.min(vmax, k.v + 260 * DT)
  else if (btn & P.A && !(btn & P.B)) {
    if (k.v < 0) k.v = Math.min(0, k.v + BRAKE * DT)
    else if (k.v < vmax) k.v = Math.min(vmax, k.v + ACCEL * DT * (1.15 - 0.6 * (k.v / vmax)))
  } else if (btn & P.B) {
    if (k.v > 1) k.v = Math.max(0, k.v - BRAKE * DT)
    else if (grounded) k.v = Math.max(-VREV, k.v - ACCEL * 0.6 * DT)
  } else {
    if (k.v > 0) k.v = Math.max(0, k.v - COAST * DT)
    else k.v = Math.min(0, k.v + COAST * 2 * DT)
  }
  if (k.v > vmax && !spinning) k.v = Math.max(vmax, k.v - (k.off && !k.air ? 170 : 55) * DT)

  // Motion direction trails the heading (grip).
  const grip = spinning ? 0.06 : k.air ? 0.05 : k.drift !== 0 ? 0.12 : k.off ? 0.3 : 0.42
  k.m = angleWrap(k.m + angleWrap(k.a - k.m) * grip)
  if (k.v < 0) k.m = k.a

  k.x += (Math.cos(k.m) * k.v + k.px) * DT
  k.y += (Math.sin(k.m) * k.v + k.py) * DT
  k.px *= 0.8
  k.py *= 0.8
  if (Math.abs(k.px) < 0.5) k.px = 0
  if (Math.abs(k.py) < 0.5) k.py = 0

  // Height.
  if (k.z > 0 || k.vz > 0) {
    k.vz -= 430 * DT
    k.z += k.vz * DT
    if (k.z <= 0) {
      k.z = 0
      k.vz = 0
      k.air = false
      if (hopping && btn & HOP_BTN && k.hopDir !== 0 && sp > DRIFT_MIN_SPEED && !spinning) {
        k.drift = k.hopDir
        k.charge = 0
      }
    }
  }

  // Surface and walls.
  nearest(t, k.x, k.y, qg)
  k.off = qg.e > 0
  if (qg.e > OFF_W) {
    const d = qg.e - OFF_W
    k.x -= qg.nx * d
    k.y -= qg.ny * d
    let vx = Math.cos(k.m) * k.v
    let vy = Math.sin(k.m) * k.v
    const vn = vx * qg.nx + vy * qg.ny
    if (vn > 0) {
      vx -= qg.nx * vn * 1.3
      vy -= qg.ny * vn * 1.3
      if (k.v >= 0) {
        const nv = Math.hypot(vx, vy)
        if (nv > 1) k.m = Math.atan2(vy, vx)
        k.v = nv * 0.95
      } else k.v *= 0.3
      if (vn > 30 && k.quiet === 0) {
        emit(s, EV_WALL, i)
        k.quiet = 10
      }
    }
    const pn = k.px * qg.nx + k.py * qg.ny
    if (pn > 0) {
      k.px -= qg.nx * pn * 1.5
      k.py -= qg.ny * pn * 1.5
    }
    nearest(t, k.x, k.y, qg)
  }

  // Follow the kart along the loop (a big jump to another part of the track is a "snap": it never passes checkpoints).
  nearestLocal(t, k.x, k.y, k.seg, 8, ql)
  const snap = qg.e < ql.e - 6
  const q = snap ? qg : ql
  let delta = q.s - k.s
  if (delta > t.total / 2) delta -= t.total
  else if (delta < -t.total / 2) delta += t.total
  const uPrev = k.u
  k.u += delta
  k.seg = q.k
  k.s = q.s
  k.lat = q.lat
  const continuous = !snap && Math.abs(delta) < 30

  // Pads and ramps.
  if (!k.air && grounded) {
    for (const [s0, s1, l0, l1] of t.padZones) {
      const ds = wrapS(t, k.s - s0)
      if (ds <= s1 - s0 && k.lat >= l0 && k.lat <= l1) {
        if (k.boost < 20) emit(s, EV_BOOST, i, 0)
        k.boost = Math.max(k.boost, 30)
      }
    }
    if (qg.e <= 0 && k.v > 40) {
      for (const [s0, s1] of t.rampZones) {
        if (wrapS(t, k.s - s0) <= s1 - s0) {
          k.vz = 90 + k.v * 0.45
          k.air = true
          k.drift = 0
          k.charge = 0
          k.boost = Math.max(k.boost, 8)
        }
      }
    }
  }

  // Wrong way?
  const dot = Math.cos(k.a) * t.tx[k.seg] + Math.sin(k.a) * t.ty[k.seg]
  k.wrong = dot < -0.3 && Math.abs(k.v) > 8 && k.fin < 0 ? k.wrong + 1 : 0

  // Checkpoints and laps.
  if (continuous && k.fin < 0) {
    const last = LAPS * CHECKPOINTS
    while (k.passed <= last && uPrev < cpU(t, k.passed) && k.u >= cpU(t, k.passed)) {
      const g = k.passed
      k.passed++
      if (g % CHECKPOINTS === 0 && g > 0) {
        if (g === last) {
          k.fin = s.race
          if (s.firstFin < 0) s.firstFin = s.race
          k.item = ITEM_NONE
          k.uses = 0
          k.roll = 0
          k.drift = 0
          emit(s, EV_FINISH, i, k.rank)
        } else {
          const lap = g / CHECKPOINTS + 1
          emit(s, lap === LAPS ? EV_FINAL : EV_LAP, i, lap)
        }
      }
    }
    if (k.passed > 0 && k.u < cpU(t, k.passed - 1) - 1) k.passed--
  }
}

function collideKarts(s: KartState): void {
  const ks = s.karts
  const R2 = KART_R * 2
  for (let i = 0; i < ks.length; i++) {
    const a = ks[i]
    if (a.gone) continue
    for (let j = i + 1; j < ks.length; j++) {
      const b = ks[j]
      if (b.gone || Math.abs(a.z - b.z) > 8) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d2 = dx * dx + dy * dy
      if (d2 >= R2 * R2) continue
      const d = Math.sqrt(d2) || 0.01
      const nx = d2 > 0 ? dx / d : 1
      const ny = d2 > 0 ? dy / d : 0
      const wa = 1 + (a.shield > 0 ? 1.5 : 0) + (a.boost > 0 ? 0.6 : 0)
      const wb = 1 + (b.shield > 0 ? 1.5 : 0) + (b.boost > 0 ? 0.6 : 0)
      const fa = wb / (wa + wb)
      const fb = wa / (wa + wb)
      const over = R2 - d
      a.x -= nx * over * fa
      a.y -= ny * over * fa
      b.x += nx * over * fb
      b.y += ny * over * fb
      const va = (Math.cos(a.m) * a.v + a.px) * nx + (Math.sin(a.m) * a.v + a.py) * ny
      const vb = (Math.cos(b.m) * b.v + b.px) * nx + (Math.sin(b.m) * b.v + b.py) * ny
      const closing = va - vb
      const imp = Math.max(28, closing * 1.1)
      a.px -= nx * imp * fa * 2
      a.py -= ny * imp * fa * 2
      b.px += nx * imp * fb * 2
      b.py += ny * imp * fb * 2
      a.v *= 1 - 0.05 * fa
      b.v *= 1 - 0.05 * fb
      if (closing > 12 && a.quiet === 0 && b.quiet === 0) {
        emit(s, EV_BUMP, i, j)
        a.quiet = b.quiet = 8
      }
    }
  }
}

function updateObjects(s: KartState): void {
  const t = buildTrack(s.track)
  const ks = s.karts
  const keep: KartObj[] = []
  for (const o of s.objs) {
    o.life--
    if (o.grace > 0) o.grace--
    let dead = o.life <= 0
    if (!dead && o.type === OBJ_BOLT) {
      o.x += o.vx * DT
      o.y += o.vy * DT
      if (nearest(t, o.x, o.y, qg).e > OFF_W + 2) dead = true
    } else if (!dead && o.type === OBJ_SEEKER) {
      const speed = VMAX * 1.6
      const tk = o.target >= 0 ? ks[o.target] : null
      const homing = tk && !tk.gone && Math.hypot(tk.x - o.x, tk.y - o.y) < 90
      if (tk && homing) {
        const dx = tk.x - o.x
        const dy = tk.y - o.y
        const d = Math.hypot(dx, dy) || 1
        o.x += (dx / d) * speed * DT
        o.y += (dy / d) * speed * DT
      } else {
        o.s = wrapS(t, o.s + speed * DT)
        o.vx *= 0.94
        const p = pointAt(t, o.s, o.vx)
        o.x = p.x
        o.y = p.y
        o.seg = p.k
      }
    }
    if (!dead && (o.type === OBJ_BOLT || o.type === OBJ_SEEKER)) {
      // Projectiles burst on oil slicks.
      for (const x of s.objs) {
        if (x.type !== OBJ_SLICK || x.life <= 0) continue
        if (Math.hypot(x.x - o.x, x.y - o.y) < 10) {
          x.life = 0
          dead = true
          break
        }
      }
    }
    if (!dead) {
      const reach = o.type === OBJ_SLICK ? KART_R + 6 : KART_R + 4
      for (let i = 0; i < ks.length; i++) {
        const k = ks[i]
        if (k.gone || (i === o.owner && o.grace > 0)) continue
        if (k.z > (o.type === OBJ_SLICK ? 3 : 10)) continue
        if (Math.hypot(k.x - o.x, k.y - o.y) >= reach) continue
        if (o.type === OBJ_SLICK) hitKart(s, i, 30, 0, OBJ_SLICK)
        else if (o.type === OBJ_BOLT) hitKart(s, i, 40, 80, OBJ_BOLT)
        else hitKart(s, i, 48, 120, OBJ_SEEKER)
        dead = true
        break
      }
    }
    if (!dead) keep.push(o)
  }
  s.objs = keep.filter((o) => o.life > 0)
}

function updateBoxes(s: KartState, ctx: GameContext): void {
  const t = buildTrack(s.track)
  const n = s.karts.filter((k) => !k.gone).length
  for (let b = 0; b < s.boxes.length; b++) {
    if (s.boxes[b] > 0) {
      s.boxes[b]--
      continue
    }
    const [bx, by] = t.boxes[b]
    for (let i = 0; i < s.karts.length; i++) {
      const k = s.karts[i]
      if (k.gone || k.fin >= 0 || k.z > 12) continue
      if (Math.hypot(k.x - bx, k.y - by) >= KART_R + BOX_R) continue
      s.boxes[b] = BOX_RESPAWN
      emit(s, EV_BOX, i, b)
      if (k.item === ITEM_NONE && k.roll === 0) {
        k.roll = ROLL_TICKS
        k.rollItem = pickItem(k.rank, n, ctx.random())
      }
      break
    }
  }
  for (let i = 0; i < s.karts.length; i++) {
    const k = s.karts[i]
    if (k.roll > 0 && --k.roll === 0 && !k.gone && k.fin < 0) {
      k.item = k.rollItem
      k.uses = k.item === ITEM_NITRO3 ? 3 : 1
      emit(s, EV_ITEM, i, k.item)
    }
  }
}

/** Seats in race order: finished by time, then by progress; karts whose person left come last. */
function standings(s: KartState): number[] {
  const t = buildTrack(s.track)
  const prog = s.karts.map((k) => progress(t, k))
  return s.karts
    .map((_, i) => i)
    .sort((i, j) => {
      const a = s.karts[i]
      const b = s.karts[j]
      if (a.gone !== b.gone) return a.gone ? 1 : -1
      const af = a.fin >= 0
      const bf = b.fin >= 0
      if (af !== bf) return af ? -1 : 1
      if (af && a.fin !== b.fin) return a.fin - b.fin
      if (prog[i] !== prog[j]) return prog[j] - prog[i]
      return i - j
    })
}

function tick(s: KartState, input: TickInput, ctx: GameContext): void {
  if (s.phase === 3) return
  s.tick++
  const t = buildTrack(s.track)
  const ks = s.karts

  if (s.phase === 0) {
    const left = COUNTDOWN - s.tick
    for (let i = 0; i < ks.length; i++) {
      const held = ks[i].gone ? 0 : input.held[i] ?? 0
      ks[i].btn = held
      if (held & P.A) {
        if (ks[i].aAt < 0) ks[i].aAt = left
      } else ks[i].aAt = -1
    }
    if (left === 2 * TICK_HZ || left === TICK_HZ) emit(s, EV_COUNT, -1, left / TICK_HZ)
    if (left <= 0) {
      s.phase = 1
      emit(s, EV_GO, -1)
      // Rocket start: A pressed in the last half second of the countdown.
      for (let i = 0; i < ks.length; i++) {
        const k = ks[i]
        if (!k.gone && k.aAt >= 1 && k.aAt <= TICK_HZ / 2) {
          k.boost = 24
          emit(s, EV_BOOST, i, 4)
        }
      }
    }
    pruneEvents(s)
    return
  }

  if (s.phase === 1) s.race++

  // Rubber band (light): bots behind the best person are a little faster, those far ahead a little slower.
  let bestHuman = -Infinity
  for (let i = 0; i < ks.length; i++) if (s.seats[i]?.userId !== null && !ks[i].gone) bestHuman = Math.max(bestHuman, progress(t, ks[i]))

  for (let i = 0; i < ks.length; i++) {
    const k = ks[i]
    if (k.gone) continue
    const human = s.seats[i]?.userId !== null
    let btn = input.held[i] ?? 0
    let pressed = input.pressed[i] ?? 0
    if (human && (k.fin >= 0 || s.phase === 2)) {
      // Autopilot after the finish line.
      btn = botButtons(s, i, ctx) & ~USE_BTN
      pressed = btn & ~k.btn
    }
    let mult = 1
    if (!human) {
      mult = 0.955 + 0.045 * s.ai[i].skill
      if (bestHuman > -Infinity) mult *= 1 + Math.max(-0.05, Math.min(0.06, (bestHuman - progress(t, k)) / 1600))
    }
    if (s.phase === 1 && k.fin < 0 && pressed & USE_BTN && k.item !== ITEM_NONE && k.roll === 0 && k.spin === 0) useItem(s, i, btn)
    drive(s, i, btn & (P.A | P.B | STEER_BTN | HOP_BTN | P.UP | P.DOWN | USE_BTN), pressed, mult)
  }
  collideKarts(s)
  updateObjects(s)
  updateBoxes(s, ctx)

  const order = standings(s)
  order.forEach((seat, r) => (ks[seat].rank = r + 1))

  if (s.phase === 1) {
    let people = 0
    let racing = 0
    for (let i = 0; i < ks.length; i++) {
      if (s.seats[i]?.userId === null || ks[i].gone) continue
      people++
      if (ks[i].fin < 0) racing++
    }
    const over =
      people === 0 ||
      racing === 0 ||
      (s.firstFin >= 0 && s.race - s.firstFin >= AFTER_FIRST) ||
      s.race >= RACE_CAP
    if (over) {
      s.phase = 2
      s.overAt = s.tick
      s.order = order
      s.objs = []
    }
  } else if (s.phase === 2 && s.tick - s.overAt >= OVER_HOLD) s.phase = 3
  pruneEvents(s)
}

function pruneEvents(s: KartState): void {
  while (s.events.length > 0 && s.events[0].at < s.tick - TICK_HZ) s.events.shift()
}

function leave(s: KartState, seat: number): void {
  const k = s.karts[seat]
  if (!k || k.gone) return
  k.gone = true
  k.item = ITEM_NONE
  k.uses = 0
  k.roll = 0
  k.v = 0
  k.drift = 0
}

/** Rounded, never -0 (which JSON turns into 0). */
const ri = (x: number) => Math.round(x) + 0
const r10 = (x: number) => ri(x * 10)

function view(s: KartState): KartView {
  let bx = 0
  s.boxes.forEach((b, i) => {
    if (b === 0) bx |= 1 << i
  })
  return {
    tr: s.track,
    ph: s.phase,
    t: s.phase === 0 ? Math.max(0, COUNTDOWN - s.tick) : s.race,
    k: s.karts.map((k) => {
      let f = 0
      if (k.drift < 0) f |= F_DRIFT_L
      if (k.drift > 0) f |= F_DRIFT_R
      if (k.boost > 0) f |= F_BOOST
      if (k.spin > 0) f |= F_SPIN
      if (k.shield > 0) f |= F_SHIELD
      if (k.off && !k.air) f |= F_OFF
      if (k.fin >= 0) f |= F_FIN
      if (k.gone) f |= F_GONE
      if (k.drift !== 0 && k.charge >= CHARGE_2) f |= F_SPARK2
      else if (k.drift !== 0 && k.charge >= CHARGE_1) f |= F_SPARK1
      if (k.wrong > TICK_HZ) f |= F_WRONG
      if (k.btn & P.B && k.v > 2) f |= F_BRAKE
      return [
        r10(k.x),
        r10(k.y),
        ri(k.a * 1000),
        ri(k.m * 1000),
        ri(k.v),
        r10(k.z),
        f,
        k.item,
        k.uses,
        k.roll,
        lapOf(k),
        k.rank,
        k.fin,
      ]
    }),
    o: s.objs.map((o) => [o.type, r10(o.x), r10(o.y), o.type === OBJ_SEEKER ? o.target : o.life]),
    bx,
    ev: s.events.map((e) => ({ id: e.id, e: e.e, s: e.s, v: e.v })),
    ord: s.phase >= 2 ? s.order : [],
    end: s.phase === 1 && s.firstFin >= 0 ? Math.max(0, AFTER_FIRST - (s.race - s.firstFin)) : -1,
  }
}

/** "1:23.4" from race ticks. */
export function formatRaceTime(ticks: number): string {
  const tenths = Math.floor((ticks * 10) / TICK_HZ)
  const m = Math.floor(tenths / 600)
  const sec = Math.floor((tenths % 600) / 10)
  return `${m}:${sec < 10 ? '0' : ''}${sec}.${tenths % 10}`
}

function result(s: KartState): GameOutcome | null {
  if (s.phase !== 3) return null
  const w = s.order.find((i) => !s.karts[i].gone)
  if (w === undefined) return { winnerSeats: [], summary: 'Race abandoned' }
  const name = s.seats[w]?.name ?? `Kart ${w + 1}`
  const k = s.karts[w]
  const summary = k.fin >= 0 ? `${name} wins · ${formatRaceTime(k.fin)}` : `${name} leads at the time limit`
  return { winnerSeats: [w], summary: summary.slice(0, 120) }
}

export const kart: GameDefinition<KartState> = {
  id: 'kart',
  name: 'Kart Rally',
  tagline: 'Drift, boost and bolt your way around three twisty tracks.',
  minPlayers: 1,
  maxPlayers: 8,
  bots: true,
  controls: 'pad',
  help: [
    ['A', 'Accelerate'],
    ['B', 'Brake / reverse'],
    ['Arrows', 'Steer left / right'],
    ['R', 'Hop / drift (hold while steering for a mini-turbo)'],
    ['X', 'Use item (hold ↓ to fire or drop behind)'],
  ],
  tickHz: TICK_HZ,
  frameEvery: 1,
  perSeatView: false,
  create,
  tick,
  bot: (s, seat, ctx) => botButtons(s, seat, ctx),
  leave: (s, seat) => leave(s, seat),
  view: (s) => view(s),
  result,
}
