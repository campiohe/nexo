// Ring Out: the simulation (state, fighter control, physics, hits, stocks, timer). Pure and deterministic:
// randomness only from ctx.random (stage pick, characters), time only from ticks. See data.ts for the units.
import type { GameSeat } from '../../protocol.ts'
import { GAME_PAD } from '../../protocol.ts'
import type { GameContext, TickInput } from '../types.ts'
import {
  ANIMS,
  BUFFER_TICKS,
  CHARS,
  COUNTDOWN_TICKS,
  END_TICKS,
  EV,
  FL,
  MATCH_TICKS,
  MOVES,
  RESPAWN_DELAY,
  RESPAWN_INVULN,
  SHIELD_MAX,
  STAGES,
  STOCKS,
  SUDDEN_DEATH_TICKS,
  type CharDef,
  type MoveDef,
  type StageDef,
} from './data.ts'

const { UP, DOWN, LEFT, RIGHT, A, B, X, Y, L, R } = GAME_PAD
const DIRS = UP | DOWN | LEFT | RIGHT
const JUMP = X | Y
const SHIELD = L | R
/** Mid-air jumps (the double jump). */
const AIR_JUMPS = 1
/** Knockback speed lost per tick in the air (on the ground: KB_DECAY_GROUND). */
const KB_DECAY = 0.3
const KB_DECAY_GROUND = 0.5
/** A KO counts for the last attacker when it happened within this many ticks of their hit. */
const CREDIT_TICKS = 600
const LEDGE_HANG_MAX = 300
const CLIMB_TICKS = 18
const CLIMB_ROLL_TICKS = 26

export interface Fighter {
  seat: number
  ch: number
  x: number
  y: number
  px: number
  py: number
  vx: number
  vy: number
  /** Knockback velocity (decays on its own, on top of vx/vy). */
  kx: number
  ky: number
  face: number
  /** -1 airborne, 0 main platform, i + 1 pass-through platform i. */
  gnd: number
  act: string
  t: number
  /** Current move (act 'atk'). */
  mv: string
  dmg: number
  stocks: number
  left: boolean
  jumps: number
  ubUsed: boolean
  sbUsed: boolean
  dbUsed: boolean
  adUsed: boolean
  ff: boolean
  stun: number
  hitlag: number
  inv: number
  shield: number
  /** Shield stun. */
  ss: number
  drop: number
  ledgeCd: number
  /** -1 / 1: hanging on the left / right ledge. */
  ledge: number
  /** The next ledge grab gives invulnerability (refreshed by landing). */
  lInv: boolean
  climbFrom: number
  climbX: number
  climbY: number
  /** Ticks of the current landing / climb / roll. */
  ll: number
  dir: number
  hitMask: number
  lastHit: number
  lastHitT: number
  bufA: number
  bufB: number
  bufJ: number
  bufS: number
  bufDir: number
  /** The buffered jump came from Up (tap jump): Up + A / B take precedence. */
  bufJup: boolean
  hold: number
  heldBy: number
  holdT: number
  downT: number
  bounced: boolean
  dizzyT: number
  kos: number
  falls: number
  /** Stocks lost without anyone's recent hit. */
  sds: number
}

export interface BrawlEvent {
  id: number
  k: number
  x: number
  y: number
  s: number
  v: number
  tick: number
}

export interface BotMem {
  prev: number
  wait: number
  shieldT: number
  atkCd: number
  /** Ticks left on the current approach / aerial plan. */
  plan: number
  planKind: number
  edgeX: number
}

export interface BrawlState {
  seats: GameSeat[]
  stage: number
  tick: number
  ph: 'cd' | 'play' | 'end' | 'over'
  phT: number
  timer: number
  sd: boolean
  f: Fighter[]
  ev: BrawlEvent[]
  evId: number
  bots: BotMem[]
  winners: number[]
  summary: string
}

/** View sent to everyone: see data.ts F_* for the fighter tuple and EV for event kinds. */
export interface BrawlView {
  /** Stage index. */
  st: number
  /** 0 countdown, 1 fight, 2 game over. */
  ph: number
  sd: number
  /** Seconds left. */
  tm: number
  /** Countdown number (3, 2, 1) or 0. */
  cd: number
  f: number[][]
  /** [id, kind, x, y, seat, value] */
  e: number[][]
  w: number[]
}

// ---------------------------------------------------------------------------------------------
// Setup

export function newFighter(seat: number, ch: number, x: number, face: number): Fighter {
  return {
    seat,
    ch,
    x,
    y: 0,
    px: x,
    py: 0,
    vx: 0,
    vy: 0,
    kx: 0,
    ky: 0,
    face,
    gnd: 0,
    act: 'idle',
    t: 0,
    mv: '',
    dmg: 0,
    stocks: STOCKS,
    left: false,
    jumps: AIR_JUMPS,
    ubUsed: false,
    sbUsed: false,
    dbUsed: false,
    adUsed: false,
    ff: false,
    stun: 0,
    hitlag: 0,
    inv: 0,
    shield: SHIELD_MAX,
    ss: 0,
    drop: 0,
    ledgeCd: 0,
    ledge: 0,
    lInv: true,
    climbFrom: 0,
    climbX: 0,
    climbY: 0,
    ll: 0,
    dir: 0,
    hitMask: 0,
    lastHit: -1,
    lastHitT: -9999,
    bufA: -99,
    bufB: -99,
    bufJ: -99,
    bufS: -99,
    bufDir: 0,
    bufJup: false,
    hold: -1,
    heldBy: -1,
    holdT: 0,
    downT: 0,
    bounced: false,
    dizzyT: 0,
    kos: 0,
    falls: 0,
    sds: 0,
  }
}

export function createState(seats: GameSeat[], ctx: GameContext): BrawlState {
  const stage = Math.floor(ctx.random() * STAGES.length) % STAGES.length
  const st = STAGES[stage]
  // Characters: a shuffled cycle, so a table of 3 always has all three.
  const order = [0, 1, 2]
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.random() * (i + 1))
    const tmp = order[i]
    order[i] = order[j]
    order[j] = tmp
  }
  const f = seats.map((_, i) => {
    const x = st.spawns[i % st.spawns.length]
    return newFighter(i, order[i % order.length], x, x < 0 ? 1 : -1)
  })
  return {
    seats,
    stage,
    tick: 0,
    ph: 'cd',
    phT: COUNTDOWN_TICKS,
    timer: MATCH_TICKS,
    sd: false,
    f,
    ev: [],
    evId: 0,
    bots: seats.map(() => ({ prev: 0, wait: 0, shieldT: 0, atkCd: 0, plan: 0, planKind: 0, edgeX: 0 })),
    winners: [],
    summary: '',
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

const approach = (v: number, target: number, step: number) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step))

export const charOf = (f: Fighter): CharDef => CHARS[f.ch]
export const stageOf = (s: BrawlState): StageDef => STAGES[s.stage]
/** Still in the match (has stocks, didn't leave). */
export const isIn = (f: Fighter) => !f.left && f.stocks > 0
/** On the field and hittable in principle (not dead / out). */
export const onField = (f: Fighter) => isIn(f) && f.act !== 'dead'

/** Rounded, never -0 (views must survive a JSON round trip unchanged). */
const int = (v: number) => Math.round(v) || 0

function emit(s: BrawlState, k: number, x: number, y: number, seat: number, v: number) {
  s.ev.push({ id: ++s.evId, k, x: int(x), y: int(y), s: seat, v: int(v), tick: s.tick })
}

function setAct(f: Fighter, act: string) {
  if (f.act !== act) {
    f.act = act
    f.t = 0
  }
  f.mv = ''
}

const hdirOf = (bits: number) => (bits & RIGHT ? 1 : 0) - (bits & LEFT ? 1 : 0)

function has(s: BrawlState, at: number) {
  return s.tick - at <= BUFFER_TICKS
}

/** Total ticks of a move for this fighter (endlag scaled by the character). */
export function moveTotal(f: Fighter, m: MoveDef) {
  return m.s + m.a + Math.round(m.e * charOf(f).lag)
}

/** Can't be hit right now. */
export function untouchable(f: Fighter): boolean {
  if (f.inv > 0) return true
  switch (f.act) {
    case 'dead':
    case 'respawn':
    case 'climb':
      return true
    case 'roll':
      return f.t >= 4 && f.t < 19
    case 'spot':
      return f.t >= 3 && f.t < 16
    case 'adodge':
      return f.t >= 2 && f.t < 17
  }
  return false
}

function counterOpen(f: Fighter) {
  const m = MOVES.ctr
  return f.act === 'atk' && f.mv === 'ctr' && f.t >= m.s && f.t < m.s + m.a
}

function startMove(f: Fighter, mv: string) {
  f.act = 'atk'
  f.mv = mv
  f.t = 0
  f.hitMask = 0
}

/** Lets go of a grab in either direction. */
function releaseGrab(s: BrawlState, f: Fighter) {
  if (f.hold >= 0) {
    const v = s.f[f.hold]
    if (v && v.heldBy === f.seat) {
      v.heldBy = -1
      if (v.act === 'held') setAct(v, v.gnd >= 0 ? 'idle' : 'air')
    }
    f.hold = -1
  }
  if (f.heldBy >= 0) {
    const h = s.f[f.heldBy]
    if (h && h.hold === f.seat) {
      h.hold = -1
      if (h.act === 'hold' || (h.act === 'atk' && h.mv.startsWith('th'))) setAct(h, h.gnd >= 0 ? 'idle' : 'air')
    }
    f.heldBy = -1
  }
}

function surfaceOf(st: StageDef, gnd: number) {
  return gnd === 0 ? st.main : st.plats[gnd - 1]
}

// ---------------------------------------------------------------------------------------------
// Tick

export function stepState(s: BrawlState, input: TickInput): void {
  s.tick++
  if (s.ph === 'over') return
  if (s.ph === 'end') {
    if (--s.phT <= 0) s.ph = 'over'
    pruneEvents(s)
    return
  }
  if (s.ph === 'cd') {
    if (s.phT % 60 === 0) emit(s, EV.COUNT, 0, 0, -1, s.phT / 60)
    if (--s.phT <= 0) {
      s.ph = 'play'
      emit(s, EV.GO, 0, 0, -1, 0)
    }
    pruneEvents(s)
    return
  }

  for (const f of s.f) update(s, f, input.held[f.seat] ?? 0, input.pressed[f.seat] ?? 0)
  resolveHits(s)
  const st = stageOf(s)
  for (const f of s.f) {
    if (!onField(f) || f.act === 'respawn') continue
    const b = st.blast
    if (f.x < b.l || f.x > b.r || f.y > b.b || f.y < b.t) ko(s, f)
  }
  if (!checkEnd(s)) {
    if (--s.timer <= 0) timeUp(s)
  }
  pruneEvents(s)
}

function pruneEvents(s: BrawlState) {
  while (s.ev.length && s.ev[0].tick < s.tick - 30) s.ev.shift()
}

function update(s: BrawlState, f: Fighter, held: number, pressed: number) {
  if (f.left) return
  if (pressed & A) {
    f.bufA = s.tick
    f.bufDir = held & DIRS
  }
  if (pressed & B) {
    f.bufB = s.tick
    f.bufDir = held & DIRS
  }
  if (pressed & JUMP) {
    f.bufJ = s.tick
    f.bufJup = false
  } else if (pressed & UP) {
    f.bufJ = s.tick
    f.bufJup = true
  }
  if (pressed & SHIELD) f.bufS = s.tick

  if (f.act === 'dead') {
    if (f.stocks > 0 && ++f.t >= RESPAWN_DELAY) respawn(s, f)
    return
  }
  if (f.act === 'held') {
    f.t++
    if (pressed) f.holdT -= 5
    return
  }
  if (f.hitlag > 0) {
    f.hitlag--
    return
  }
  f.t++
  if (f.inv > 0) f.inv--
  if (f.ledgeCd > 0) f.ledgeCd--
  if (f.drop > 0) f.drop--
  if (f.act !== 'shield' && f.shield < SHIELD_MAX) f.shield = Math.min(SHIELD_MAX, f.shield + 0.08)
  f.px = f.x
  f.py = f.y
  const hd = hdirOf(held)
  const c = charOf(f)
  const st = stageOf(s)

  switch (f.act) {
    case 'respawn':
      if ((f.t > 20 && held & (DIRS | A | B | JUMP | SHIELD)) || f.t > 200) {
        setAct(f, 'air')
        f.inv = RESPAWN_INVULN
        f.vy = 0
      }
      return
    case 'ledge':
      ledgeControl(s, f, held, hd, st)
      return
    case 'climb':
      climbControl(f, st)
      return
    case 'idle':
    case 'run':
    case 'crouch':
      groundControl(s, f, held, hd, c)
      break
    case 'squat':
      if (has(s, f.bufA) && held & UP) {
        f.bufA = -99
        f.bufJ = -99
        startMove(f, 'utilt')
      } else if (has(s, f.bufB) && held & UP) {
        f.bufB = -99
        f.bufJ = -99
        startMove(f, 'ub')
        f.ubUsed = true
      } else if (f.t >= 4) {
        const full = (held & (JUMP | UP)) !== 0
        setAct(f, 'air')
        f.gnd = -1
        f.vy = -(full ? c.jump : c.jump * 0.7)
        f.vx = hd ? hd * Math.max(Math.abs(f.vx), c.air * 0.8) : f.vx * 0.8
        emit(s, EV.JUMP, f.x, f.y, f.seat, 0)
      }
      break
    case 'land':
      f.vx = approach(f.vx, 0, 0.4)
      if (f.t >= f.ll) {
        setAct(f, 'idle')
        groundControl(s, f, held, hd, c)
      }
      break
    case 'shield':
      shieldControl(s, f, held, pressed, c)
      break
    case 'roll':
      f.vx = f.t >= 4 && f.t < 20 ? f.dir * 3.6 : 0
      if (f.t >= 24) {
        f.face = -f.dir
        setAct(f, 'idle')
      }
      break
    case 'spot':
      f.vx = approach(f.vx, 0, 0.5)
      if (f.t >= 20) setAct(f, 'idle')
      break
    case 'air':
      airControl(s, f, held, pressed, hd, c)
      break
    case 'adodge':
      if (f.t === 1) {
        f.vx *= 0.4
        f.vy = Math.min(f.vy, 0) * 0.3
      }
      if (f.t >= 24) setAct(f, 'air')
      break
    case 'helpless':
      drift(f, hd, c, 0.6)
      break
    case 'hurt':
      if (--f.stun <= 0) setAct(f, f.gnd >= 0 ? 'idle' : 'air')
      break
    case 'dizzy':
      if (f.gnd >= 0) {
        f.vx = approach(f.vx, 0, 0.4)
        f.dizzyT -= pressed ? 4 : 1
        if (f.dizzyT <= 0) setAct(f, 'idle')
      }
      break
    case 'hold':
      holdControl(s, f, held, hd)
      break
    case 'atk':
      attackControl(s, f, held, pressed, hd, c)
      break
  }
  physics(s, f, held, c, st)
}

// ---------------------------------------------------------------------------------------------
// Control by state

function drift(f: Fighter, hd: number, c: CharDef, mul = 1) {
  if (hd) f.vx = approach(f.vx, hd * c.air * mul, c.airAcc)
  else f.vx = approach(f.vx, 0, 0.03)
}

function fastFall(f: Fighter, pressed: number) {
  if (pressed & DOWN && f.vy > -1.5 && !f.ff) f.ff = true
}

function groundControl(s: BrawlState, f: Fighter, held: number, hd: number, c: CharDef) {
  if (tryGroundAction(s, f, held)) return
  if (held & DOWN && !hd) {
    if (f.act !== 'crouch') setAct(f, 'crouch')
    f.vx = approach(f.vx, 0, 0.5)
    if (f.gnd > 0 && ++f.downT >= 3) {
      // Drop through the pass-through platform.
      f.gnd = -1
      f.drop = 12
      f.downT = 0
      setAct(f, 'air')
    }
    return
  }
  f.downT = 0
  if (hd) {
    f.face = hd
    if (f.act !== 'run') setAct(f, 'run')
    f.vx = approach(f.vx, hd * c.run, 0.55)
  } else {
    if (f.act !== 'idle') setAct(f, 'idle')
    f.vx = approach(f.vx, 0, 0.45)
  }
}

function tryGroundAction(s: BrawlState, f: Fighter, held: number): boolean {
  const c = charOf(f)
  if (has(s, f.bufJ)) {
    f.bufJ = -99
    setAct(f, 'squat')
    return true
  }
  const d = held & DIRS || f.bufDir
  const hd = hdirOf(d)
  if (has(s, f.bufB)) {
    f.bufB = -99
    if (d & UP) {
      startMove(f, 'ub')
      f.ubUsed = true
    } else if (d & DOWN) {
      if (c.db === 'counter') startMove(f, 'ctr')
      else if (c.db === 'slam') startMove(f, 'slam')
      else {
        startMove(f, 'flip')
        f.dbUsed = true
      }
    } else if (hd) {
      f.face = hd
      startMove(f, 'sb')
    } else startMove(f, 'nb')
    return true
  }
  if (has(s, f.bufA)) {
    f.bufA = -99
    if (held & SHIELD) startMove(f, 'grab')
    else if (d & UP) startMove(f, 'utilt')
    else if (d & DOWN) startMove(f, 'dtilt')
    else if (hd) {
      f.face = hd
      startMove(f, 'ftilt')
    } else startMove(f, 'jab')
    return true
  }
  if (held & SHIELD) {
    setAct(f, 'shield')
    f.ss = 0
    return true
  }
  return false
}

function airControl(s: BrawlState, f: Fighter, held: number, pressed: number, hd: number, c: CharDef) {
  const d = held & DIRS || f.bufDir
  if (has(s, f.bufB)) {
    f.bufB = -99
    if (f.bufJup) f.bufJ = -99
    const side = hdirOf(d)
    if (d & UP) {
      if (!f.ubUsed) {
        f.ubUsed = true
        startMove(f, 'ub')
        return
      }
    } else if (d & DOWN) {
      if (c.db === 'counter') return startMove(f, 'ctr')
      if (c.db === 'slam') return startMove(f, 'slama')
      if (!f.dbUsed) {
        f.dbUsed = true
        return startMove(f, 'flip')
      }
    } else if (side) {
      if (!f.sbUsed) {
        f.sbUsed = true
        f.face = side
        return startMove(f, 'sb')
      }
    } else return startMove(f, 'nb')
  }
  if (has(s, f.bufA)) {
    f.bufA = -99
    if (f.bufJup) f.bufJ = -99
    const side = hdirOf(d)
    if (d & UP) startMove(f, 'uair')
    else if (d & DOWN) startMove(f, 'dair')
    else if (side === f.face) startMove(f, 'fair')
    else if (side) startMove(f, 'bair')
    else startMove(f, 'nair')
    drift(f, hd, c)
    return
  }
  if (has(s, f.bufJ) && (!f.bufJup || s.tick - f.bufJ >= 2)) {
    f.bufJ = -99
    if (f.jumps > 0) {
      f.jumps--
      f.vy = -c.djump
      f.ff = false
      f.vx = hd * c.air
      f.t = 0
      emit(s, EV.JUMP, f.x, f.y, f.seat, 1)
      return
    }
  }
  if (has(s, f.bufS) && !f.adUsed) {
    f.bufS = -99
    f.adUsed = true
    setAct(f, 'adodge')
    return
  }
  drift(f, hd, c)
  fastFall(f, pressed)
}

function shieldControl(s: BrawlState, f: Fighter, held: number, pressed: number, c: CharDef) {
  f.vx = approach(f.vx, 0, 0.4)
  if (f.ss > 0) {
    f.ss--
    return
  }
  f.shield -= 0.13
  if (f.shield <= 0) return breakShield(s, f)
  if (has(s, f.bufJ)) {
    f.bufJ = -99
    return setAct(f, 'squat')
  }
  if (has(s, f.bufA)) {
    f.bufA = -99
    return startMove(f, 'grab')
  }
  const side = hdirOf(pressed)
  if (side) {
    setAct(f, 'roll')
    f.dir = side
    return
  }
  if (pressed & DOWN) return setAct(f, 'spot')
  if (!(held & SHIELD)) {
    setAct(f, 'land')
    f.ll = 6
  }
  void c
}

function breakShield(s: BrawlState, f: Fighter) {
  setAct(f, 'dizzy')
  f.dizzyT = 170
  f.shield = 30
  f.gnd = -1
  f.vy = -5.5
  f.ss = 0
  emit(s, EV.BREAK, f.x, f.y - charOf(f).h / 2, f.seat, 0)
}

function holdControl(s: BrawlState, f: Fighter, held: number, hd: number) {
  f.vx = approach(f.vx, 0, 0.5)
  const v = s.f[f.hold]
  if (!v || v.act !== 'held' || v.heldBy !== f.seat) {
    f.hold = -1
    setAct(f, 'idle')
    return
  }
  placeHeld(f, v)
  if (--v.holdT <= 0) {
    // Broke free.
    v.heldBy = -1
    f.hold = -1
    setAct(v, 'land')
    v.ll = 14
    v.kx = f.face * 2.5
    setAct(f, 'land')
    f.ll = 14
    f.kx = -f.face * 1.5
    return
  }
  if (f.t < 8) return
  let th = ''
  if (held & UP) th = 'thu'
  else if (held & DOWN) th = 'thd'
  else if (hd === f.face) th = 'thf'
  else if (hd === -f.face) th = 'thb'
  else if (has(s, f.bufA) || f.t >= 70) th = 'thf'
  if (th) {
    f.bufA = -99
    startMove(f, th)
  }
}

function placeHeld(f: Fighter, v: Fighter) {
  v.x = f.x + f.face * (charOf(f).hw + charOf(v).hw + 2)
  v.y = f.y
  v.px = v.x
  v.py = v.y
  v.gnd = f.gnd
  v.vx = v.vy = v.kx = v.ky = 0
}

function attackControl(s: BrawlState, f: Fighter, held: number, pressed: number, hd: number, c: CharDef) {
  const m = MOVES[f.mv]
  const air = f.gnd < 0
  const active = f.t >= m.s && f.t < m.s + m.a
  switch (f.mv) {
    case 'sb':
      if (f.t < m.s) {
        f.vx *= 0.8
        if (air) f.vy = Math.min(f.vy, 0.5)
      } else if (active) {
        f.vx = f.face * c.sb
        f.vy = 0
      } else f.vx = approach(f.vx, 0, air ? 0.12 : 0.4)
      break
    case 'ub':
      if (f.t < m.s) {
        f.vx *= 0.5
        f.vy = 0
      } else {
        if (f.t === m.s) {
          f.vy = -c.ub
          f.gnd = -1
        }
        f.vx = approach(f.vx, hd * c.air * 1.15, 0.25)
      }
      break
    case 'slama':
      if (f.t < m.s) {
        f.vx *= 0.7
        f.vy = Math.min(f.vy, 0)
      } else {
        f.vx = 0
        f.vy = 9
      }
      break
    case 'flip':
      if (f.t === m.s) {
        f.vy = -6.6
        f.vx = f.face * 1.6
        f.gnd = -1
      } else if (air) drift(f, hd, c, 0.8)
      break
    case 'thf':
    case 'thb':
    case 'thu':
    case 'thd': {
      const v = f.hold >= 0 ? s.f[f.hold] : null
      if (v && v.act === 'held' && v.heldBy === f.seat) {
        placeHeld(f, v)
        if (f.t >= m.s) {
          v.heldBy = -1
          f.hold = -1
          const lag = launch(s, v, f.seat, Math.round(m.dmg * c.power), m.bkb, m.kbg, m.ang, f.face, c.power, v.x, v.y - charOf(v).h / 2)
          f.hitlag = lag
        }
      }
      f.vx = approach(f.vx, 0, 0.5)
      break
    }
    default:
      if (air) {
        if (m.air || f.mv === 'nb' || f.mv === 'ctr' || f.mv === 'ctrs') drift(f, hd, c, m.air ? 1 : 0.5)
        if (m.air) fastFall(f, pressed)
      } else f.vx = approach(f.vx, 0, 0.45)
  }
  if (f.act === 'atk' && f.t >= moveTotal(f, m)) {
    if (f.mv === 'ub') setAct(f, 'helpless')
    else setAct(f, f.gnd >= 0 ? 'idle' : 'air')
  }
  void held
}

function ledgeControl(s: BrawlState, f: Fighter, held: number, hd: number, st: StageDef) {
  f.vx = f.vy = f.kx = f.ky = 0
  if (f.t > LEDGE_HANG_MAX) return letGo(f)
  if (f.t < 6) return
  const c = charOf(f)
  const edge = f.ledge < 0 ? st.main.l : st.main.r
  if (has(s, f.bufJ)) {
    f.bufJ = -99
    f.ledge = 0
    f.ledgeCd = 30
    setAct(f, 'air')
    f.y = st.main.y + 2
    f.vy = -c.jump
    f.vx = f.face * 1.2
    emit(s, EV.JUMP, f.x, f.y, f.seat, 0)
    return
  }
  let dest = 0
  let ticks = CLIMB_TICKS
  let attack = false
  if (has(s, f.bufA) || has(s, f.bufB)) {
    f.bufA = f.bufB = -99
    dest = c.hw + 6
    attack = true
  } else if (hd === f.face) dest = c.hw + 4
  else if (held & SHIELD) {
    dest = 42
    ticks = CLIMB_ROLL_TICKS
  } else if (hd === -f.face || held & DOWN) return letGo(f)
  if (!dest) return
  f.ledge = 0
  f.ledgeCd = 30
  setAct(f, 'climb')
  f.mv = attack ? 'lga' : ''
  f.ll = ticks
  f.climbFrom = f.x
  f.climbY = f.y
  f.climbX = edge + f.face * dest
}

function letGo(f: Fighter) {
  f.ledge = 0
  f.ledgeCd = 30
  f.x -= f.face * 2
  setAct(f, 'air')
}

function climbControl(f: Fighter, st: StageDef) {
  const k = f.t / f.ll
  f.y = f.climbY + (st.main.y - f.climbY) * Math.min(1, k * 2)
  f.x = f.climbFrom + (f.climbX - f.climbFrom) * Math.max(0, k * 2 - 1)
  if (f.t >= f.ll) {
    f.x = f.climbX
    f.y = st.main.y
    f.gnd = 0
    f.vx = f.vy = 0
    const attack = f.mv === 'lga'
    setAct(f, 'idle')
    if (attack) startMove(f, 'lga')
  }
}

// ---------------------------------------------------------------------------------------------
// Physics

function gravityApplies(f: Fighter) {
  if (f.act !== 'atk') return true
  const m = MOVES[f.mv]
  if (f.mv === 'sb') return !(f.t >= m.s && f.t < m.s + m.a)
  if (f.mv === 'ub') return f.t >= m.s
  if (f.mv === 'slama') return false
  return true
}

function physics(s: BrawlState, f: Fighter, held: number, c: CharDef, st: StageDef) {
  if (f.act === 'hold' || f.act === 'held') {
    if (f.gnd >= 0) return
  }
  if (f.gnd >= 0) {
    f.vy = 0
    if (f.ky < -0.5) f.gnd = -1
    else f.ky = 0
  }
  if (f.gnd < 0 && gravityApplies(f)) {
    const max = f.ff ? c.ffall : c.fall
    f.vy = f.ff ? Math.max(f.vy + c.grav, max) : Math.min(f.vy + c.grav, max)
    if (f.ff && f.vy > max) f.vy = max
  }
  f.x += f.vx + f.kx
  f.y += f.vy + f.ky
  const mag = Math.hypot(f.kx, f.ky)
  if (mag > 0) {
    const next = Math.max(0, mag - (f.gnd >= 0 ? KB_DECAY_GROUND : KB_DECAY))
    f.kx = (f.kx * next) / mag
    f.ky = (f.ky * next) / mag
  }

  if (f.gnd >= 0) {
    const sf = surfaceOf(st, f.gnd)
    f.y = sf.y
    if (f.x < sf.l || f.x > sf.r) {
      const walksOff = f.act === 'idle' || f.act === 'run' || f.act === 'crouch' || f.act === 'hurt' || f.act === 'dizzy' || f.act === 'land'
      if (walksOff) {
        f.gnd = -1
        if (f.act !== 'hurt' && f.act !== 'dizzy') setAct(f, 'air')
      } else {
        f.x = Math.max(sf.l, Math.min(sf.r, f.x))
        if (f.act === 'roll') f.vx = 0
      }
    }
    return
  }

  // Airborne: land on the main platform or a pass-through one, bump into the main block's sides / bottom.
  const main = st.main
  if (f.y >= f.py) {
    if (f.py <= main.y && f.y >= main.y && f.x >= main.l - 1 && f.x <= main.r + 1) return land(s, f, 0, main.y)
    const through = f.drop > 0 || (f.ff && held & DOWN)
    if (!through) {
      for (let i = 0; i < st.plats.length; i++) {
        const p = st.plats[i]
        if (f.py <= p.y && f.y >= p.y && f.x >= p.l && f.x <= p.r) return land(s, f, i + 1, p.y)
      }
    }
  }
  const top = main.y
  const bottom = main.y + main.d
  if (f.x + c.hw > main.l && f.x - c.hw < main.r && f.y > top && f.y - c.h < bottom) {
    if (f.py - c.h >= bottom - 1) {
      f.y = bottom + c.h
      if (f.vy < 0) f.vy = 0
      if (f.ky < 0) f.ky = -f.ky * 0.4
    } else {
      f.x = f.x < (main.l + main.r) / 2 ? main.l - c.hw : main.r + c.hw
      f.vx = 0
      f.kx = -f.kx * 0.4
    }
  }
  tryLedge(s, f, c, st)
}

function land(s: BrawlState, f: Fighter, gnd: number, y: number) {
  const impact = f.vy + f.ky
  f.y = y
  if (f.act === 'hurt' && !f.bounced && impact > 3.2) {
    // Hard knockback into the floor: bounce once.
    f.ky = -impact * 0.55
    f.vy = 0
    f.kx *= 0.7
    f.y = y - 0.5
    f.bounced = true
    emit(s, EV.LAND, f.x, y, f.seat, 1)
    return
  }
  f.gnd = gnd
  f.vy = 0
  f.ky = 0
  f.ff = false
  f.jumps = AIR_JUMPS
  f.ubUsed = f.sbUsed = f.dbUsed = f.adUsed = false
  f.lInv = true
  const lag = (n: number) => {
    setAct(f, 'land')
    f.ll = n
  }
  switch (f.act) {
    case 'air':
      return lag(3)
    case 'adodge':
      return lag(8)
    case 'helpless':
      return lag(12)
    case 'hurt':
      if (f.stun > 0) {
        f.stun = 0
        return lag(16)
      }
      return lag(3)
    case 'atk': {
      const m = MOVES[f.mv]
      if (f.mv === 'slama') {
        f.mv = 'slam'
        f.t = MOVES.slam.s - 1
        f.hitMask = 0
        return
      }
      if (f.mv === 'sb' && f.t < m.s + m.a) return
      if (f.mv === 'ctr' || f.mv === 'ctrs' || f.mv.startsWith('th')) return
      if (m.air || f.t < moveTotal(f, m)) return lag(m.ll ?? 8)
      return lag(3)
    }
  }
}

function tryLedge(s: BrawlState, f: Fighter, c: CharDef, st: StageDef) {
  if (f.ledgeCd > 0 || f.gnd >= 0) return
  const ok =
    ((f.act === 'air' || f.act === 'adodge') && f.vy + f.ky >= -2) ||
    f.act === 'helpless' ||
    (f.act === 'atk' && (f.mv === 'ub' || f.mv === 'sb' || f.mv === 'flip'))
  if (!ok) return
  const main = st.main
  if (f.y < main.y + 2 || f.y > main.y + c.h + 16) return
  let side = 0
  if (f.x >= main.l - c.hw - 14 && f.x <= main.l + 3) side = -1
  else if (f.x <= main.r + c.hw + 14 && f.x >= main.r - 3) side = 1
  if (!side) return
  if (s.f.some((o) => o !== f && o.ledge === side && o.act === 'ledge')) return
  setAct(f, 'ledge')
  f.ledge = side
  f.face = -side
  f.x = side < 0 ? main.l - c.hw : main.r + c.hw
  f.y = main.y + c.h - 4
  f.vx = f.vy = f.kx = f.ky = 0
  f.ff = false
  f.jumps = AIR_JUMPS
  f.ubUsed = f.sbUsed = f.dbUsed = f.adUsed = false
  if (f.lInv) {
    f.inv = Math.max(f.inv, 30)
    f.lInv = false
  }
}

// ---------------------------------------------------------------------------------------------
// Hits

function circleRect(cx: number, cy: number, r: number, x0: number, y0: number, x1: number, y1: number) {
  const nx = Math.max(x0, Math.min(cx, x1))
  const ny = Math.max(y0, Math.min(cy, y1))
  return (cx - nx) ** 2 + (cy - ny) ** 2 <= r * r
}

interface PendingHit {
  a: Fighter
  v: Fighter
  m: MoveDef
  x: number
  y: number
}

/** World position of a move's hitbox circle for fighter f. */
export function hitboxAt(f: Fighter, hb: [number, number, number]): [number, number, number] {
  const r = charOf(f).reach
  return [f.x + hb[0] * r * f.face, f.y + hb[1] * r, hb[2] * r]
}

function resolveHits(s: BrawlState) {
  const hits: PendingHit[] = []
  for (const a of s.f) {
    if (a.act !== 'atk' || !onField(a)) continue
    const m = MOVES[a.mv]
    if (!m.hb.length || a.t < m.s || a.t >= m.s + m.a) continue
    for (const v of s.f) {
      if (v === a || !onField(v) || a.hitMask & (1 << v.seat) || untouchable(v)) continue
      if (m.grab && (v.gnd < 0 || v.act === 'held' || v.act === 'hold' || v.act === 'ledge')) continue
      const vc = charOf(v)
      for (const hb of m.hb) {
        const [hx, hy, hr] = hitboxAt(a, hb)
        if (circleRect(hx, hy, hr, v.x - vc.hw, v.y - vc.h, v.x + vc.hw, v.y)) {
          a.hitMask |= 1 << v.seat
          hits.push({ a, v, m, x: (hx + v.x) / 2, y: (hy + v.y - vc.h / 2) / 2 })
          break
        }
      }
    }
  }
  for (const h of hits) applyHit(s, h)
}

function applyHit(s: BrawlState, { a, v, m, x, y }: PendingHit) {
  if (!onField(v) || !onField(a)) return
  const c = charOf(a)
  if (m.grab) {
    if (a.act !== 'atk' || a.mv !== 'grab' || v.act === 'held' || v.heldBy >= 0) return
    releaseGrab(s, v)
    setAct(a, 'hold')
    a.hold = v.seat
    setAct(v, 'held')
    v.heldBy = a.seat
    v.holdT = Math.min(160, 50 + v.dmg * 0.5)
    v.face = -a.face
    v.ss = 0
    v.ledge = 0
    placeHeld(a, v)
    emit(s, EV.GRAB, x, y, v.seat, 0)
    return
  }
  if (counterOpen(v)) {
    const inc = Math.round(m.dmg * c.power)
    startMove(v, 'ctrs')
    v.inv = 26
    v.face = a.x >= v.x ? 1 : -1
    const vc = charOf(v)
    const lag = launch(s, a, v.seat, Math.max(8, Math.round(inc * 1.3)), MOVES.ctrs.bkb, MOVES.ctrs.kbg, MOVES.ctrs.ang, v.face, vc.power, x, y)
    v.hitlag = lag + 2
    emit(s, EV.COUNTER, v.x, v.y - vc.h / 2, v.seat, 0)
    return
  }
  const dmg = Math.max(1, Math.round(m.dmg * c.power))
  if (v.act === 'shield') {
    v.shield -= dmg * 1.15
    const lag = 3 + Math.floor(dmg / 4)
    a.hitlag = Math.max(a.hitlag, lag)
    v.hitlag = lag
    if (v.shield <= 0) breakShield(s, v)
    else {
      v.ss = 4 + Math.round(dmg * 0.6)
      v.kx = a.face * (0.8 + dmg * 0.12)
      emit(s, EV.BLOCK, x, y, v.seat, dmg)
    }
    return
  }
  // Facing the attacker's direction of travel for moves that hit behind (bair) is in the angle (145°).
  const lag = launch(s, v, a.seat, dmg, m.bkb, m.kbg, m.ang, a.face, c.power, x, y)
  a.hitlag = Math.max(a.hitlag, lag)
}

/**
 * Damage + knockback: K = (base + growth × damage after the hit) × power / weight, launched at `ang` (relative
 * to `face`). Hitstun grows with K. Returns the hitlag (freeze) both sides get.
 */
export function launch(
  s: BrawlState,
  v: Fighter,
  from: number,
  dmg: number,
  bkb: number,
  kbg: number,
  ang: number,
  face: number,
  power: number,
  ex: number,
  ey: number,
): number {
  releaseGrab(s, v)
  v.dmg = Math.min(999, v.dmg + dmg)
  const k = ((bkb + kbg * v.dmg) * power) / charOf(v).weight
  const rad = (ang * Math.PI) / 180
  v.kx = Math.cos(rad) * k * face
  v.ky = -Math.sin(rad) * k
  if (v.gnd >= 0) {
    if (v.ky > -1.2) {
      if (k < 4.5) v.ky = 0
      else {
        v.ky = -Math.max(1.5, Math.abs(v.ky) * 0.8)
        v.gnd = -1
      }
    } else v.gnd = -1
  }
  if (v.act === 'ledge') v.gnd = -1
  v.vx = v.vy = 0
  setAct(v, 'hurt')
  v.t = 0
  v.stun = Math.max(10, Math.round(k * 3.4))
  v.ff = false
  v.bounced = false
  v.ledge = 0
  v.ss = 0
  v.face = -face
  v.lastHit = from
  v.lastHitT = s.tick
  const lag = Math.min(12, 3 + Math.floor(dmg / 3))
  v.hitlag = lag
  emit(s, k >= 10 ? EV.HEAVY : EV.HIT, ex, ey, v.seat, k * 10)
  return lag
}

// ---------------------------------------------------------------------------------------------
// Stocks, respawn, end

function ko(s: BrawlState, f: Fighter) {
  const b = stageOf(s).blast
  releaseGrab(s, f)
  const side = f.x < b.l ? 0 : f.x > b.r ? 1 : f.y < b.t ? 2 : 3
  emit(s, EV.KO, Math.max(b.l, Math.min(b.r, f.x)), Math.max(b.t, Math.min(b.b, f.y)), f.seat, side)
  f.stocks--
  f.falls++
  f.dmg = 0
  if (f.lastHit >= 0 && s.tick - f.lastHitT <= CREDIT_TICKS && s.f[f.lastHit]) s.f[f.lastHit].kos++
  else f.sds++
  setAct(f, 'dead')
  f.vx = f.vy = f.kx = f.ky = 0
  f.hitlag = 0
  f.ledge = 0
  f.gnd = -1
  f.lastHit = -1
}

function respawn(s: BrawlState, f: Fighter) {
  const st = stageOf(s)
  // The respawn point farthest from everyone on the field.
  let best = st.respawns[f.seat % st.respawns.length]
  let bestD = -1
  for (const p of st.respawns) {
    let d = 1e9
    for (const o of s.f) if (o !== f && onField(o)) d = Math.min(d, Math.hypot(o.x - p[0], o.y - p[1]))
    if (d > bestD + 1) {
      bestD = d
      best = p
    }
  }
  f.x = f.px = best[0]
  f.y = f.py = best[1]
  setAct(f, 'respawn')
  f.dmg = 0
  f.vx = f.vy = f.kx = f.ky = 0
  f.jumps = AIR_JUMPS
  f.ubUsed = f.sbUsed = f.dbUsed = f.adUsed = false
  f.ff = false
  f.shield = SHIELD_MAX
  f.face = f.x <= 0 ? 1 : -1
  f.gnd = -1
  f.lInv = true
  emit(s, EV.RESPAWN, f.x, f.y, f.seat, 0)
}

const nameOf = (s: BrawlState, seat: number) => s.seats[seat]?.name ?? `P${seat + 1}`

function finish(s: BrawlState, winners: number[], summary: string) {
  s.ph = 'end'
  s.phT = END_TICKS
  s.winners = winners
  s.summary = summary.slice(0, 120)
  emit(s, EV.GAME, 0, 0, winners.length === 1 ? winners[0] : -1, 0)
}

/** Ends the match when at most one fighter is left. Returns whether it ended. */
function checkEnd(s: BrawlState): boolean {
  if (s.ph !== 'play' && s.ph !== 'cd') return s.ph === 'end' || s.ph === 'over'
  const inn = s.f.filter(isIn)
  if (inn.length > 1) return false
  if (inn.length === 1) {
    const w = inn[0]
    const n = w.stocks
    finish(s, [w.seat], s.sd ? `${nameOf(s, w.seat)} wins in sudden death` : `${nameOf(s, w.seat)} wins with ${n} stock${n === 1 ? '' : 's'} left`)
  } else finish(s, [], 'Nobody is left: no winner')
  return true
}

function timeUp(s: BrawlState) {
  const inn = s.f.filter(isIn).sort((p, q) => q.stocks - p.stocks || Math.floor(p.dmg) - Math.floor(q.dmg) || p.seat - q.seat)
  const best = inn[0]
  const tied = inn.filter((f) => f.stocks === best.stocks && Math.floor(f.dmg) === Math.floor(best.dmg))
  if (tied.length === 1) {
    finish(s, [best.seat], s.sd ? `${nameOf(s, best.seat)} wins: least damage in sudden death` : `Time! ${nameOf(s, best.seat)} wins`)
    return
  }
  if (s.sd) {
    finish(s, [], 'Sudden death ran out: a draw')
    return
  }
  // Sudden death: the tied fighters, one stock each, already at 150%.
  s.sd = true
  const st = stageOf(s)
  let n = 0
  for (const f of s.f) {
    releaseGrab(s, f)
    if (!tied.includes(f)) {
      if (isIn(f)) {
        f.stocks = 0
        setAct(f, 'dead')
      }
      continue
    }
    const x = st.spawns[n++ % st.spawns.length]
    Object.assign(f, newFighter(f.seat, f.ch, x, x < 0 ? 1 : -1), { stocks: 1, dmg: 150, kos: f.kos, falls: f.falls, sds: f.sds })
  }
  s.ph = 'cd'
  s.phT = COUNTDOWN_TICKS
  s.timer = SUDDEN_DEATH_TICKS
  emit(s, EV.SUDDEN, 0, 0, -1, 0)
}

export function leaveSeat(s: BrawlState, seat: number) {
  const f = s.f[seat]
  if (!f || f.left) return
  releaseGrab(s, f)
  f.left = true
  f.stocks = 0
  setAct(f, 'dead')
  if (s.ph === 'play' || s.ph === 'cd') checkEnd(s)
}

// ---------------------------------------------------------------------------------------------
// View

const ANIM_INDEX: Record<string, number> = Object.fromEntries(ANIMS.map((a, i) => [a, i]))

export function buildView(s: BrawlState): BrawlView {
  return {
    st: s.stage,
    ph: s.ph === 'cd' ? 0 : s.ph === 'play' ? 1 : 2,
    sd: s.sd ? 1 : 0,
    tm: Math.max(0, Math.ceil(s.timer / 60)),
    cd: s.ph === 'cd' ? Math.ceil(s.phT / 60) : 0,
    f: s.f.map((f) => {
      let fl = 0
      if (untouchable(f) && f.act !== 'dead') fl |= FL.INV
      if (f.act === 'shield') fl |= FL.SHIELD
      if (f.act === 'helpless') fl |= FL.HELPLESS
      if (!isIn(f)) fl |= FL.OUT
      if (f.act === 'dizzy') fl |= FL.DIZZY
      if (f.act === 'respawn') fl |= FL.HALO
      if (f.hitlag > 0) fl |= FL.HITLAG
      if (counterOpen(f)) fl |= FL.COUNTER
      if (f.vy + f.ky < 0) fl |= FL.RISING
      if (f.ff) fl |= FL.FASTFALL
      const anim = f.act === 'atk' ? ANIM_INDEX[f.mv] : ANIM_INDEX[f.act]
      return [
        int(f.x * 10),
        int(f.y * 10),
        f.face,
        anim ?? 0,
        Math.min(f.t, 999),
        Math.floor(f.dmg),
        f.stocks,
        fl,
        f.ch,
        int(f.shield),
        int(Math.hypot(f.kx, f.ky) * 10),
        f.kos,
      ]
    }),
    e: s.ev.map((e) => [e.id, e.k, e.x, e.y, e.s, e.v]),
    w: s.ph === 'end' || s.ph === 'over' ? s.winners : [],
  }
}
