// Dojo Duel simulation: state, character select, rounds, the per-fighter state machine, physics, hits, throws.
// Pure and deterministic (ctx.random only for the select-screen timeout). The game definition is in logic.ts,
// the bot in bot.ts.
import type { GameSeat } from '../../protocol.ts'
import { GAME_PAD } from '../../protocol.ts'
import type { GameContext, GameOutcome, TickInput } from '../types.ts'
import {
  AIRHIT,
  ATTACK,
  BLOCK,
  BLOCKC,
  BUFFER,
  CHARS,
  CROUCH,
  DOWN,
  EDGE,
  END_DKO,
  END_KO,
  END_TICKS,
  END_TIME,
  EV_ARMOR,
  EV_BLOCK,
  EV_CLASH,
  EV_FIGHT,
  EV_HIT_H,
  EV_HIT_L,
  EV_KO,
  EV_LOCK,
  EV_PROJ,
  EV_ROUND,
  EV_SEL,
  EV_SPECIAL,
  EV_THROW,
  EV_THUD,
  EV_TIME,
  EV_WHOOSH,
  FIGHT_AT,
  HIST,
  HIT,
  HITC,
  IDLE,
  INTRO_TICKS,
  JUMP,
  KO,
  LAND,
  M_CRLP,
  M_JHK,
  M_JHP,
  M_JLK,
  M_JLP,
  M_OVH,
  M_SP0,
  M_STHK,
  M_STHP,
  M_STLK,
  M_STLP,
  M_THROW,
  MAX_ROUNDS,
  PH_END,
  PH_FIGHT,
  PH_INTRO,
  PH_OVER,
  PH_SELECT,
  PREJUMP,
  ROUND_SECONDS,
  SCREEN_W,
  SELECT_TICKS,
  SLAM_RELEASE,
  SLAM_TICKS,
  STAGE_W,
  THROW,
  THROW_RELEASE,
  THROW_TICKS,
  THROWN,
  TICK_HZ,
  TLOSE,
  WAKE,
  WALKB,
  WALKF,
  WIN,
  WINS_NEEDED,
  type MoveDef,
} from './chars.ts'
import { ATTACKS, HEAVIES, KICKS, MOTIONS, PUNCHES, matchMotion, numpad } from './input.ts'

export interface Fighter {
  /** Character (CHARS index), set when the select screen ends. */
  ch: number
  /** Select screen: cursor and whether it's locked in. */
  pick: number
  locked: boolean
  x: number
  y: number
  vx: number
  vy: number
  /** 1 facing right, -1 facing left. */
  face: number
  hp: number
  act: number
  /** Ticks in the current action. */
  t: number
  /** Current move (ATTACK, THROW), -1 none. */
  mv: number
  /** The current move made contact: 0 no, 1 hit, 2 blocked. */
  hit: number
  /** Hitstun / blockstun ticks left. */
  stun: number
  /** Knockdown fall (AIRHIT): lands in DOWN (or KO) instead of on the feet. */
  kd: boolean
  /** Pushback still to slide (signed world px) and whether a wall passes it on to the opponent. */
  pb: number
  pbX: boolean
  /** Invulnerable ticks (strikes and throws), throw-only invulnerable ticks. */
  inv: number
  tinv: number
  armor: number
  jdir: number
  airAtk: boolean
  landLen: number
  /** Throw direction: 1 forward, -1 backward. */
  tdir: number
  /** Directions (numpad, relative to facing) of the last HIST ticks, oldest first; raw held of the last 4. */
  hist: number[]
  rh: number[]
  /** Buffered attack buttons and their age. */
  buf: number
  bufAge: number
  /** Buttons of the normal just started (a special input right after it replaces it). */
  kara: number
  /** Hits of the current combo on the opponent; ticks left to show it. */
  combo: number
  comboShow: number
  guard: boolean
  wins: number
}

export interface Proj {
  o: number
  x: number
  y: number
  vx: number
  ttl: number
  mv: number
  age: number
}

export interface FEvent {
  id: number
  k: number
  x: number
  y: number
  s: number
  at: number
}

export interface BotMem {
  /** Upcoming held masks (absolute buttons), one per tick. */
  plan: number[]
  /** Ticks to keep holding `hold`. */
  wait: number
  hold: number
  /** Opponent attack being reacted to (its start tick), when to block (-1 never) and how. */
  atk: number
  blockAt: number
  low: boolean
  /** Opponent jump: -1 ready to decide, 0 ignore, 1 anti-air done. */
  jump: number
  /** Projectile reacted to (its spawn tick) and the choice (0 ignore, 1 block, 2 jump). */
  proj: number
  pc: number
  /** Opponent attack already considered for a whiff punish. */
  punish: number
  last: number
}

export interface FighterState {
  seats: { name: string; color: string; bot: boolean }[]
  ph: number
  /** Ticks in the phase. */
  pt: number
  tick: number
  round: number
  timer: number
  cam: number
  f: Fighter[]
  proj: Proj[]
  /** Hitstop ticks left (everything waits). */
  freeze: number
  ev: FEvent[]
  evId: number
  /** Winner seat of each round so far (-1 draw). */
  log: number[]
  /** The round that just ended: winner (-1 draw), how (END_*), perfect. */
  rw: number
  ek: number
  perfect: boolean
  /** Health % of each fighter when the last round ended (tie-break after the round cap). */
  lastPct: number[]
  /** Select screen: tick both were locked in (-1 not yet). */
  lockedAt: number
  gone: boolean[]
  bot: BotMem[]
  result: GameOutcome | null
}

const B = GAME_PAD.B
const Y = GAME_PAD.Y
const A = GAME_PAD.A
const X = GAME_PAD.X

function newFighter(i: number): Fighter {
  return {
    ch: 0,
    pick: i === 0 ? 0 : 2,
    locked: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    face: 1,
    hp: 1000,
    act: IDLE,
    t: 0,
    mv: -1,
    hit: 0,
    stun: 0,
    kd: false,
    pb: 0,
    pbX: false,
    inv: 0,
    tinv: 0,
    armor: 0,
    jdir: 0,
    airAtk: false,
    landLen: 3,
    tdir: 1,
    hist: [],
    rh: [],
    buf: 0,
    bufAge: 0,
    kara: 0,
    combo: 0,
    comboShow: 0,
    guard: false,
    wins: 0,
  }
}

export function newBotMem(): BotMem {
  return { plan: [], wait: 0, hold: 0, atk: -1, blockAt: -1, low: false, jump: -1, proj: -1, pc: 0, punish: -1, last: 0 }
}

export function createState(seats: GameSeat[]): FighterState {
  return {
    seats: seats.map((x) => ({ name: x.name, color: x.color, bot: x.userId === null })),
    ph: PH_SELECT,
    pt: 0,
    tick: 0,
    round: 0,
    timer: ROUND_SECONDS * TICK_HZ,
    cam: (STAGE_W - SCREEN_W) / 2,
    f: [newFighter(0), newFighter(1)],
    proj: [],
    freeze: 0,
    ev: [],
    evId: 0,
    log: [],
    rw: -1,
    ek: END_KO,
    perfect: false,
    lastPct: [100, 100],
    lockedAt: -1,
    gone: [false, false],
    bot: [newBotMem(), newBotMem()],
    result: null,
  }
}

export const moveOf = (f: Fighter): MoveDef | null => (f.mv >= 0 ? CHARS[f.ch].moves[f.mv] : null)
export const scaleOf = (f: Fighter) => CHARS[f.ch].scale
const hpPct = (f: Fighter) => (f.hp / CHARS[f.ch].hp) * 100

function emit(s: FighterState, k: number, x: number, y: number, seat: number) {
  s.ev.push({ id: ++s.evId, k, x, y, s: seat, at: s.tick })
}

function setAct(f: Fighter, act: number) {
  f.act = act
  f.t = 0
  if (act !== ATTACK && act !== THROW) f.mv = -1
  f.guard = false
}

// ---------------------------------------------------------------------------------------------
// Rounds

function startRound(s: FighterState) {
  s.round++
  s.ph = PH_INTRO
  s.pt = 0
  s.timer = ROUND_SECONDS * TICK_HZ
  s.proj = []
  s.freeze = 0
  s.cam = (STAGE_W - SCREEN_W) / 2
  s.f.forEach((f, i) => {
    const c = CHARS[f.ch]
    f.x = STAGE_W / 2 + (i === 0 ? -70 : 70)
    f.y = f.vx = f.vy = 0
    f.face = i === 0 ? 1 : -1
    f.hp = c.hp
    setAct(f, IDLE)
    f.hit = f.stun = f.pb = f.inv = f.tinv = f.armor = f.buf = f.bufAge = f.kara = f.combo = f.comboShow = 0
    f.kd = f.airAtk = false
    f.hist = []
    f.rh = []
  })
  for (const b of s.bot) Object.assign(b, newBotMem())
  emit(s, EV_ROUND, STAGE_W / 2, 90, -1)
}

function endRound(s: FighterState, winner: number, kind: number) {
  s.ph = PH_END
  s.pt = 0
  s.rw = winner
  s.ek = kind
  s.log.push(winner)
  s.lastPct = s.f.map((f) => Math.round(hpPct(f)))
  s.perfect = winner >= 0 && s.f[winner].hp >= CHARS[s.f[winner].ch].hp
  if (winner >= 0) s.f[winner].wins++
  if (kind === END_TIME) emit(s, EV_TIME, STAGE_W / 2, 90, winner)
  else {
    s.freeze = 40
    emit(s, EV_KO, STAGE_W / 2, 90, winner)
  }
}

function finish(s: FighterState, winner: number, summary: string) {
  s.ph = PH_OVER
  s.pt = 0
  s.result = { winnerSeats: winner >= 0 ? [winner] : [], summary }
}

function afterRound(s: FighterState) {
  const [a, b] = s.f
  if (a.wins < WINS_NEEDED && b.wins < WINS_NEEDED && s.round < MAX_ROUNDS) {
    startRound(s)
    return
  }
  let w = a.wins > b.wins ? 0 : b.wins > a.wins ? 1 : -1
  if (w < 0 && s.lastPct[0] !== s.lastPct[1]) w = s.lastPct[0] > s.lastPct[1] ? 0 : 1
  const score = `${Math.max(a.wins, b.wins)}–${Math.min(a.wins, b.wins)}`
  finish(s, w, w >= 0 ? `${s.seats[w].name} wins ${score}` : `Draw game ${score}`)
}

/** A seat's person left: the other one wins (nobody when both are gone). */
export function leaveSeat(s: FighterState, seat: number) {
  if (seat < 0 || seat > 1) return
  s.gone[seat] = true
  if (s.result) return
  const other = 1 - seat
  if (s.gone[other]) finish(s, -1, 'Everyone left')
  else finish(s, other, `${s.seats[other].name} wins (${s.seats[seat].name} left)`)
}

// ---------------------------------------------------------------------------------------------
// Tick

export function tickState(s: FighterState, input: TickInput, ctx: GameContext) {
  if (s.result) return
  s.tick++
  const frozen = s.freeze > 0
  for (let i = 0; i < 2; i++) record(s.f[i], s.gone[i] ? 0 : (input.held[i] ?? 0), s.gone[i] ? 0 : (input.pressed[i] ?? 0), frozen)
  if (s.ph === PH_SELECT) selectTick(s, input, ctx)
  else if (s.ph === PH_INTRO) {
    s.pt++
    for (const f of s.f) {
      f.t++
      f.buf = 0
    }
    if (s.pt === FIGHT_AT) emit(s, EV_FIGHT, STAGE_W / 2, 90, -1)
    if (s.pt >= INTRO_TICKS) {
      s.ph = PH_FIGHT
      s.pt = 0
    }
  } else if (s.ph === PH_FIGHT) fightTick(s)
  else if (s.ph === PH_END) endTick(s)
  if (s.ev.length && s.ev[0].at < s.tick - 30) s.ev = s.ev.filter((e) => e.at >= s.tick - 30)
}

/**
 * Input history and button buffer. During hitstop only direction changes are recorded, so a motion entered
 * before or during the freeze is still in the window when the fight resumes (cancels).
 */
function record(f: Fighter, held: number, pressed: number, frozen: boolean) {
  const d = numpad(held, f.face)
  if (!frozen || f.hist[f.hist.length - 1] !== d) f.hist.push(d)
  if (f.hist.length > HIST) f.hist.shift()
  f.rh.push(held)
  if (f.rh.length > 4) f.rh.shift()
  const b = pressed & ATTACKS
  if (b) {
    f.buf |= b
    f.bufAge = 0
  }
}

function selectTick(s: FighterState, input: TickInput, ctx: GameContext) {
  s.pt++
  for (let i = 0; i < 2; i++) {
    const f = s.f[i]
    if (f.locked) continue
    const p = input.pressed[i] ?? 0
    if (p & (ATTACKS | GAME_PAD.START)) {
      f.locked = true
      emit(s, EV_LOCK, f.pick, 0, i)
    } else if (p & GAME_PAD.LEFT) {
      f.pick = (f.pick + CHARS.length - 1) % CHARS.length
      emit(s, EV_SEL, f.pick, 0, i)
    } else if (p & GAME_PAD.RIGHT) {
      f.pick = (f.pick + 1) % CHARS.length
      emit(s, EV_SEL, f.pick, 0, i)
    }
  }
  if (s.pt >= SELECT_TICKS) {
    for (let i = 0; i < 2; i++) {
      const f = s.f[i]
      if (f.locked) continue
      f.pick = Math.floor(ctx.random() * CHARS.length) % CHARS.length
      f.locked = true
      emit(s, EV_LOCK, f.pick, 0, i)
    }
  }
  if (s.f.every((f) => f.locked)) {
    if (s.lockedAt < 0) s.lockedAt = s.pt
    if (s.pt - s.lockedAt >= 50) {
      for (const f of s.f) f.ch = f.pick
      startRound(s)
    }
  }
}

function fightTick(s: FighterState) {
  s.pt++
  if (s.freeze > 0) {
    s.freeze--
    return
  }
  if (s.timer > 0) s.timer--
  simulate(s, true)
  const [a, b] = s.f
  if (a.hp <= 0 || b.hp <= 0) endRound(s, a.hp <= 0 && b.hp <= 0 ? -1 : a.hp <= 0 ? 1 : 0, a.hp <= 0 && b.hp <= 0 ? END_DKO : END_KO)
  else if (s.timer <= 0) {
    const pa = hpPct(a)
    const pb = hpPct(b)
    endRound(s, Math.abs(pa - pb) < 1e-9 ? -1 : pa > pb ? 0 : 1, END_TIME)
  }
}

function endTick(s: FighterState) {
  s.pt++
  if (s.freeze > 0) {
    s.freeze--
    return
  }
  for (const f of s.f) {
    f.buf = 0
    if (f.hist.length) f.hist[f.hist.length - 1] = 5
  }
  simulate(s, false)
  if (s.pt >= 60) {
    s.f.forEach((f, i) => {
      const neutral = f.act === IDLE || f.act === WALKF || f.act === WALKB || f.act === CROUCH
      if (!neutral || f.y > 0) return
      if (i === s.rw) setAct(f, WIN)
      else if (s.ek === END_TIME && s.rw >= 0) setAct(f, TLOSE)
    })
  }
  if (s.pt >= END_TICKS) afterRound(s)
}

/** One tick of fighting: controls, physics, push boxes, camera, projectiles, and (live) hits. */
function simulate(s: FighterState, live: boolean) {
  for (let i = 0; i < 2; i++) control(s, i)
  for (let i = 0; i < 2; i++) physics(s, i)
  separate(s)
  s.cam = Math.max(0, Math.min(STAGE_W - SCREEN_W, (s.f[0].x + s.f[1].x) / 2 - SCREEN_W / 2))
  for (let i = 0; i < 2; i++) {
    const f = s.f[i]
    const o = s.f[1 - i]
    if (f.comboShow > 0) f.comboShow--
    if (o.act !== HIT && o.act !== HITC && o.act !== AIRHIT && o.act !== THROWN) f.combo = 0
    const turn = f.act === IDLE || f.act === WALKF || f.act === WALKB || f.act === CROUCH || f.act === PREJUMP || f.act === LAND || f.act === DOWN || f.act === WAKE || f.act === WIN
    if (turn && f.y <= 0 && Math.abs(o.x - f.x) > 2) f.face = o.x > f.x ? 1 : -1
  }
  projectiles(s, live)
  if (live) hits(s)
}

// ---------------------------------------------------------------------------------------------
// Fighter state machine

function neutralAct(f: Fighter) {
  const d = f.hist[f.hist.length - 1] ?? 5
  setAct(f, d <= 3 ? CROUCH : IDLE)
}

function control(s: FighterState, i: number) {
  const f = s.f[i]
  const o = s.f[1 - i]
  const c = CHARS[f.ch]
  const d = f.hist[f.hist.length - 1] ?? 5
  f.t++
  if (f.buf && ++f.bufAge > BUFFER) f.buf = 0
  if (f.inv > 0 && f.act !== THROWN) f.inv--
  if (f.tinv > 0) f.tinv--
  switch (f.act) {
    case IDLE:
    case WALKF:
    case WALKB:
    case CROUCH:
      neutral(s, i, d)
      break
    case PREJUMP:
      if (f.t >= 3) {
        const h = d % 3 === 0 ? 1 : d % 3 === 1 ? -1 : 0
        setAct(f, JUMP)
        f.jdir = h
        f.vy = c.jumpVy
        f.vx = h * f.face * c.jumpVx
        f.airAtk = false
      }
      break
    case JUMP:
      if (f.buf && !f.airAtk) {
        const b = f.buf
        f.buf = 0
        f.airAtk = true
        startMove(s, i, b & B ? M_JHP : b & Y ? M_JHK : b & A ? M_JLP : M_JLK)
      }
      break
    case LAND:
      if (f.t >= f.landLen) {
        neutralAct(f)
        neutral(s, i, d)
      }
      break
    case ATTACK:
      attackStep(s, i, d)
      break
    case HIT:
    case HITC:
    case BLOCK:
    case BLOCKC:
      if (--f.stun <= 0) {
        neutralAct(f)
        // A moment of throw invulnerability: no free throws right after hit / blockstun.
        f.tinv = 6
      } else if (f.act === BLOCK || f.act === BLOCKC) f.act = d <= 3 ? BLOCKC : BLOCK
      break
    case DOWN:
      if (f.t >= 36) {
        setAct(f, WAKE)
        f.inv = 0
      }
      break
    case WAKE:
      if (f.t >= 18) {
        neutralAct(f)
        f.tinv = 10
      }
      break
    case THROW:
      throwStep(s, i)
      break
    case THROWN:
      if (o.act !== THROW) {
        f.inv = 0
        airhit(f, -f.face * 1.2, 2.5, false)
      }
      break
  }
}

function threatened(s: FighterState, i: number): boolean {
  const f = s.f[i]
  const o = s.f[1 - i]
  const m = moveOf(o)
  if (o.act === ATTACK && m && (m.hb || m.grab) && o.t < m.su + m.ac && Math.abs(o.x - f.x) < 120) return true
  return s.proj.some((p) => p.o !== i && Math.abs(p.x - f.x) < 110 && Math.sign(p.vx) === Math.sign(f.x - p.x))
}

function neutral(s: FighterState, i: number, d: number) {
  const f = s.f[i]
  const c = CHARS[f.ch]
  if (f.buf && tryAttack(s, i, d)) return
  if (d >= 7) {
    setAct(f, PREJUMP)
    return
  }
  if (d <= 3) {
    if (f.act !== CROUCH) setAct(f, CROUCH)
    f.guard = d === 1 && threatened(s, i)
    return
  }
  if (d === 6) {
    if (f.act !== WALKF) setAct(f, WALKF)
    f.x += f.face * c.walkF
    return
  }
  if (d === 4) {
    if (f.act !== WALKB) setAct(f, WALKB)
    f.guard = threatened(s, i)
    if (!f.guard) f.x -= f.face * c.walkB
    return
  }
  if (f.act !== IDLE) setAct(f, IDLE)
}

/** A special for buttons `btns` whose motion is in the history. Returns whether one started. */
function trySpecial(s: FighterState, i: number, btns: number): boolean {
  const f = s.f[i]
  const c = CHARS[f.ch]
  for (let k = 0; k < c.specials.length; k++) {
    const sp = c.specials[k]
    const b = btns & (sp.btn === 'P' ? PUNCHES : KICKS)
    if (!b || !matchMotion(f.hist, MOTIONS[sp.motion])) continue
    const idx = M_SP0 + k * 2 + (b & HEAVIES ? 1 : 0)
    if (c.moves[idx].proj && s.proj.some((p) => p.o === i)) continue
    f.buf = 0
    f.kara = 0
    f.hist.fill(5)
    startMove(s, i, idx)
    emit(s, EV_SPECIAL, f.x, f.y + 40, i)
    return true
  }
  return false
}

function canThrow(s: FighterState, i: number, range: number): boolean {
  const f = s.f[i]
  const o = s.f[1 - i]
  if (o.y > 0 || f.y > 0 || o.inv > 0 || o.tinv > 0 || Math.abs(o.x - f.x) > range) return false
  if (o.act === ATTACK) {
    const m = moveOf(o)
    return !!m && !m.vy && !m.air && !(m.inv && o.t < m.inv)
  }
  return o.act === IDLE || o.act === WALKF || o.act === WALKB || o.act === CROUCH || o.act === LAND || o.act === PREJUMP
}

function tryAttack(s: FighterState, i: number, d: number): boolean {
  const f = s.f[i]
  const c = CHARS[f.ch]
  const b = f.buf
  if (trySpecial(s, i, b)) return true
  if (b & B && (d === 6 || d === 4) && canThrow(s, i, c.throwRange)) {
    f.buf = 0
    startThrow(s, i, M_THROW, d === 6 ? 1 : -1)
    return true
  }
  f.buf = 0
  if (b & Y && d === 6) {
    startMove(s, i, M_OVH)
  } else {
    const btn = b & B ? M_STHP : b & Y ? M_STHK : b & A ? M_STLP : M_STLK
    startMove(s, i, (d <= 3 ? M_CRLP : 0) + btn)
  }
  f.kara = b
  return true
}

function startMove(s: FighterState, i: number, idx: number) {
  const f = s.f[i]
  const m = CHARS[f.ch].moves[idx]
  const air = f.y > 0 || f.act === JUMP
  setAct(f, ATTACK)
  f.mv = idx
  f.hit = 0
  f.kara = 0
  f.armor = m.armor
  if (!air) f.vx = 0
  // No somersault after an air attack.
  else f.jdir = 0
  if (m.heavy && !m.special && !m.air) emit(s, EV_WHOOSH, f.x, f.y + 40, i)
}

function attackStep(s: FighterState, i: number, d: number) {
  const f = s.f[i]
  const c = CHARS[f.ch]
  const m = c.moves[f.mv]
  const sc = c.scale
  const end = m.su + m.ac + m.rc
  // A special input right after a normal started (pressed a hair early) replaces it.
  if (f.kara && f.t <= 2 && !m.special && !m.air && trySpecial(s, i, f.kara)) return
  if (f.t > 2) f.kara = 0
  // Cancels: on contact, a normal cancels into a special; lights chain into lights.
  if (f.hit && f.buf && f.t < end) {
    if (m.cancel && trySpecial(s, i, f.buf)) return
    if (m.chain && f.buf & (A | X) && f.t >= m.su + 1) {
      const b = f.buf
      f.buf = 0
      startMove(s, i, (d <= 3 ? M_CRLP : 0) + (b & A ? M_STLP : M_STLK))
      return
    }
  }
  if (m.vx && f.t < m.su + m.ac && !f.hit) f.x += f.face * m.vx
  if (m.vy && f.t === m.su) {
    f.vy = m.vy
    f.vx = f.face * m.rvx
    f.y = Math.max(f.y, 0.01)
  }
  if (m.proj && f.t === m.su) {
    s.proj.push({ o: i, x: f.x + f.face * 24 * sc, y: f.y + m.proj.y * sc, vx: f.face * m.proj.vx, ttl: m.proj.ttl, mv: f.mv, age: 0 })
    emit(s, EV_PROJ, f.x + f.face * 24 * sc, f.y + m.proj.y * sc, i)
  }
  if (m.grab && f.t === m.su && canThrow(s, i, m.grab * sc)) {
    startThrow(s, i, f.mv, 1)
    return
  }
  if (f.t >= end) {
    if (m.air) {
      if (f.y > 0) {
        setAct(f, JUMP)
        f.t = 20
      } else neutralAct(f)
    } else if (!(m.vy && f.y > 0)) neutralAct(f)
  }
}

function startThrow(s: FighterState, i: number, idx: number, tdir: number) {
  const f = s.f[i]
  const o = s.f[1 - i]
  setAct(f, THROW)
  f.mv = idx
  f.tdir = tdir
  f.hit = 1
  f.vx = 0
  setAct(o, THROWN)
  o.vx = o.vy = o.y = 0
  o.pb = 0
  o.inv = 999
  o.face = -f.face
  emit(s, EV_THROW, (f.x + o.x) / 2, 40, i)
}

function throwStep(s: FighterState, i: number) {
  const f = s.f[i]
  const o = s.f[1 - i]
  const slam = f.mv !== M_THROW
  const sc = scaleOf(f)
  const rel = slam ? SLAM_RELEASE : THROW_RELEASE
  const total = slam ? SLAM_TICKS : THROW_TICKS
  if (o.act === THROWN && f.t < rel) {
    if (slam) {
      const k = f.t / rel
      o.x = f.x + f.face * (20 - 6 * Math.sin(k * Math.PI)) * sc
      o.y = 44 * Math.sin(Math.min(1, k * 1.4) * Math.PI * 0.9) * sc
    } else {
      o.x = f.x + f.face * 18 * sc
      o.y = Math.min(6, f.t)
    }
  }
  if (f.t === rel && o.act === THROWN) {
    // A throw finishing after the round ended (time) only lets go.
    const dmg = s.ph !== PH_FIGHT ? 0 : slam ? CHARS[f.ch].moves[f.mv].dmg : CHARS[f.ch].throwDmg
    o.hp = Math.max(0, o.hp - dmg)
    o.inv = 0
    f.combo = 1
    if (slam) {
      o.x = f.x + f.face * 20 * sc
      o.y = 0.5
      airhit(o, f.face * 1.4, 3, true)
      s.freeze = Math.max(s.freeze, 12)
      emit(s, EV_HIT_H, o.x, 12, i)
    } else {
      const dir = f.face * f.tdir
      o.x = f.x + dir * 22 * sc
      o.y = 8
      airhit(o, dir * 2.6, 3.4, true)
      emit(s, EV_HIT_L, o.x, 30, i)
    }
    clampX(s, o)
  }
  if (f.t >= total) neutralAct(f)
}

function airhit(f: Fighter, vx: number, vy: number, kd: boolean) {
  setAct(f, AIRHIT)
  f.vx = vx
  f.vy = vy
  f.kd = kd || f.hp <= 0
  f.pb = 0
  f.stun = 0
  f.y = Math.max(f.y, 0.5)
}

// ---------------------------------------------------------------------------------------------
// Physics

function bounds(s: FighterState): [number, number] {
  return [Math.max(EDGE, s.cam + EDGE), Math.min(STAGE_W - EDGE, s.cam + SCREEN_W - EDGE)]
}

function clampX(s: FighterState, f: Fighter): number {
  const [lo, hi] = bounds(s)
  const before = f.x
  f.x = Math.max(lo, Math.min(hi, f.x))
  return before - f.x
}

function physics(s: FighterState, i: number) {
  const f = s.f[i]
  const o = s.f[1 - i]
  const c = CHARS[f.ch]
  if (f.act === THROWN) return
  if (f.pb !== 0) {
    let step = f.pb * 0.3
    if (Math.abs(step) < 0.5) step = Math.abs(f.pb) < 0.5 ? f.pb : Math.sign(f.pb) * 0.5
    f.pb -= step
    if (Math.abs(f.pb) < 0.05) f.pb = 0
    f.x += step
    const lost = clampX(s, f)
    if (lost && f.pbX && o.y <= 0) o.x -= lost
  }
  if (f.y > 0 || f.vy > 0) {
    f.x += f.vx
    f.y += f.vy
    f.vy -= c.grav
    if (f.y <= 0) {
      f.y = 0
      f.vy = 0
      f.vx = 0
      land(s, i)
    }
  }
  clampX(s, f)
}

function land(s: FighterState, i: number) {
  const f = s.f[i]
  const m = moveOf(f)
  f.airAtk = false
  if (f.act === AIRHIT) {
    if (f.kd) {
      setAct(f, f.hp <= 0 ? KO : DOWN)
      f.inv = f.hp <= 0 ? 0 : 999
      emit(s, EV_THUD, f.x, 0, i)
    } else {
      setAct(f, LAND)
      f.landLen = 6
    }
    return
  }
  if (f.act === KO || f.act === WIN || f.act === THROWN) return
  const len = f.act === ATTACK && m && m.vy ? m.land : 3
  setAct(f, LAND)
  f.landLen = len
}

/** Push boxes: grounded (or low) fighters don't overlap. */
function separate(s: FighterState) {
  const [a, b] = s.f
  if (a.act === THROWN || b.act === THROWN) return
  const min = (CHARS[a.ch].pushW * CHARS[a.ch].scale + CHARS[b.ch].pushW * CHARS[b.ch].scale) | 0
  if (Math.abs(a.y - b.y) >= 44) return
  const dx = b.x - a.x
  if (Math.abs(dx) >= min) return
  const dir = dx !== 0 ? Math.sign(dx) : a.face
  const over = min - Math.abs(dx)
  a.x -= (dir * over) / 2
  b.x += (dir * over) / 2
  const la = clampX(s, a)
  const lb = clampX(s, b)
  if (la) b.x -= la
  if (lb) a.x -= lb
  clampX(s, a)
  clampX(s, b)
}

// ---------------------------------------------------------------------------------------------
// Hits

type Box = [number, number, number, number]

function overlap(p: Box, q: Box): boolean {
  return p[0] < q[1] && q[0] < p[1] && p[2] < q[3] && q[2] < p[3]
}

export function isCrouching(f: Fighter): boolean {
  if (f.act === CROUCH || f.act === BLOCKC || f.act === HITC) return true
  const m = moveOf(f)
  return f.act === ATTACK && !!m && m.crouch
}

function hurtbox(f: Fighter): Box | null {
  if (f.inv > 0) return null
  if (f.act === AIRHIT || f.act === DOWN || f.act === WAKE || f.act === THROWN || f.act === KO) return null
  const m = moveOf(f)
  if (f.act === ATTACK && m && m.inv && f.t < m.inv) return null
  const sc = scaleOf(f)
  const hw = 11 * sc
  const air = f.y > 0
  const top = isCrouching(f) ? 38 : air ? 52 : 58
  return [f.x - hw, f.x + hw, f.y + (air ? 6 * sc : 0), f.y + top * sc]
}

function hitbox(f: Fighter, m: MoveDef): Box | null {
  if (!m.hb) return null
  const sc = scaleOf(f)
  const x0 = f.x + f.face * m.hb[0] * sc
  const x1 = f.x + f.face * m.hb[1] * sc
  return [Math.min(x0, x1), Math.max(x0, x1), f.y + m.hb[2] * sc, f.y + m.hb[3] * sc]
}

/** The attacking limb is hittable from its first active tick to the end of recovery (whiff punishes). */
function limbbox(f: Fighter): Box | null {
  const m = moveOf(f)
  if (f.act !== ATTACK || !m || !m.hb || m.special || f.t < m.su) return null
  const b = hitbox(f, m)
  if (!b) return null
  // A little shorter than the hitbox so trading isn't automatic.
  const shrink = (b[1] - b[0]) * 0.2
  return f.face > 0 ? [b[0], b[1] - shrink, b[2], b[3]] : [b[0] + shrink, b[1], b[2], b[3]]
}

function activeHitbox(f: Fighter): Box | null {
  const m = moveOf(f)
  if (f.act !== ATTACK || !m || f.hit || f.t < m.su || f.t >= m.su + m.ac) return null
  return hitbox(f, m)
}

function hurtFor(f: Fighter, box: Box): boolean {
  const h = hurtbox(f)
  if (!h) return false
  if (overlap(box, h)) return true
  const l = limbbox(f)
  return !!l && overlap(box, l)
}

function hits(s: FighterState) {
  // Both fighters' hits are found first, then applied: simultaneous hits trade.
  const landed: { i: number; m: MoveDef; box: Box }[] = []
  for (let i = 0; i < 2; i++) {
    const f = s.f[i]
    const box = activeHitbox(f)
    if (box && hurtFor(s.f[1 - i], box)) landed.push({ i, m: CHARS[f.ch].moves[f.mv], box })
  }
  for (const { i, m, box } of landed) {
    const f = s.f[i]
    const hx = f.face > 0 ? box[1] - 4 : box[0] + 4
    resolveHit(s, i, m, f.x, hx, (box[2] + box[3]) / 2, false)
  }
}

function projectiles(s: FighterState, live: boolean) {
  for (const p of s.proj) {
    p.x += p.vx
    p.ttl--
    p.age++
  }
  // Two projectiles of different owners cancel out.
  for (let a = 0; a < s.proj.length; a++) {
    for (let b = a + 1; b < s.proj.length; b++) {
      const p = s.proj[a]
      const q = s.proj[b]
      if (p.o !== q.o && p.ttl > 0 && q.ttl > 0 && Math.abs(p.x - q.x) < 14 && Math.abs(p.y - q.y) < 14) {
        p.ttl = q.ttl = 0
        emit(s, EV_CLASH, (p.x + q.x) / 2, (p.y + q.y) / 2, -1)
      }
    }
  }
  if (live) {
    for (const p of s.proj) {
      if (p.ttl <= 0) continue
      const d = s.f[1 - p.o]
      const box: Box = [p.x - 7, p.x + 7, p.y - 6, p.y + 6]
      if (hurtFor(d, box)) {
        p.ttl = 0
        resolveHit(s, p.o, CHARS[s.f[p.o].ch].moves[p.mv], p.x - p.vx * 4, p.x, p.y, true)
      }
    }
  }
  const [lo, hi] = [s.cam - 40, s.cam + SCREEN_W + 40]
  s.proj = s.proj.filter((p) => p.ttl > 0 && p.x > lo && p.x < hi)
}

/** Whether `f` blocks an attack coming from x = `srcX` with `guard` (0 not blocking, 1 standing, 2 crouching). */
function blocking(f: Fighter, srcX: number, guard: number): number {
  if (f.y > 0) return 0
  if (f.act !== IDLE && f.act !== WALKF && f.act !== WALKB && f.act !== CROUCH && f.act !== BLOCK && f.act !== BLOCKC) return 0
  const away = srcX > f.x || (srcX === f.x && f.face > 0) ? GAME_PAD.LEFT : GAME_PAD.RIGHT
  // Holding away now or within the last 3 ticks (late or jittery input still blocks).
  let ok = false
  for (let k = f.rh.length - 1; k >= 0 && k >= f.rh.length - 3; k--) if (f.rh[k] & away) ok = true
  if (!ok) return 0
  const low = ((f.rh[f.rh.length - 1] ?? 0) & GAME_PAD.DOWN) !== 0 || f.act === CROUCH || f.act === BLOCKC
  if (guard === 1 && !low) return 0
  if (guard === 2 && low) return 0
  return low ? 2 : 1
}

function resolveHit(s: FighterState, ai: number, m: MoveDef, srcX: number, hx: number, hy: number, isProj: boolean) {
  const a = s.f[ai]
  const d = s.f[1 - ai]
  const away = d.x > srcX ? 1 : d.x < srcX ? -1 : a.face
  // Armor absorbs a hit (half damage, no stun).
  const dm = moveOf(d)
  if (d.act === ATTACK && dm && d.armor > 0 && d.t < dm.su + dm.ac) {
    d.armor--
    d.hp = Math.max(0, d.hp - Math.round(m.dmg / 2))
    if (!isProj) a.hit = 1
    s.freeze = Math.max(s.freeze, 8)
    emit(s, EV_ARMOR, hx, hy, ai)
    if (d.hp <= 0) airhit(d, away * 2.2, 4, true)
    return
  }
  const blk = blocking(d, srcX, m.guard)
  if (blk) {
    setAct(d, blk === 2 ? BLOCKC : BLOCK)
    d.stun = m.bs
    if (m.chip) d.hp = Math.max(0, d.hp - m.chip)
    d.pb = away * m.push
    d.pbX = !isProj
    if (!isProj) a.hit = 2
    s.freeze = Math.max(s.freeze, 4)
    emit(s, EV_BLOCK, hx, hy, ai)
    if (d.hp <= 0) airhit(d, away * 2.2, 4, true)
    return
  }
  const comboing = d.act === HIT || d.act === HITC
  a.combo = comboing ? a.combo + 1 : 1
  const scale = Math.max(0.4, 1 - 0.1 * Math.max(0, a.combo - 2))
  d.hp = Math.max(0, d.hp - Math.max(1, Math.round(m.dmg * scale)))
  if (!isProj) a.hit = 1
  if (a.combo >= 2) a.comboShow = 90
  const crouching = isCrouching(d)
  if (d.hp <= 0 || d.y > 0 || m.kd) {
    airhit(d, away * (m.kd || d.hp <= 0 ? 2.2 : 1.6), d.y > 0 ? 3 : 4, m.kd || d.hp <= 0)
  } else {
    setAct(d, crouching ? HITC : HIT)
    d.stun = m.hs
    d.pb = away * m.push
    d.pbX = !isProj
    d.vx = 0
  }
  s.freeze = Math.max(s.freeze, m.heavy ? 10 : 6)
  emit(s, m.heavy ? EV_HIT_H : EV_HIT_L, hx, hy, ai)
}

