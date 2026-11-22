// Dojo Duel computer player. Beatable on purpose: it reacts to attacks after a human-like delay and only
// sometimes blocks, anti-airs about half the jumps, keeps its fighter's favorite distance, zones with
// projectiles, and punishes some whiffs. Its memory lives in the state (deterministic, ctx.random only).
import { GAME_PAD } from '../../protocol.ts'
import type { GameContext } from '../types.ts'
import {
  ATTACK,
  BLOCK,
  BLOCKC,
  CHARS,
  CROUCH,
  DOWN,
  DP,
  HCB,
  IDLE,
  JUMP,
  PH_FIGHT,
  PH_SELECT,
  QCB,
  QCF,
  WAKE,
  WALKB,
  WALKF,
} from './chars.ts'
import { padOf } from './input.ts'
import { moveOf, type FighterState } from './sim.ts'

const { A, B, X, Y } = GAME_PAD

/** Ticks of a motion (numpad directions, relative), the button pressed on the last one. */
function motionPlan(motion: number, btn: number): [number, number][] {
  const dirs = motion === QCF ? [2, 3, 6] : motion === QCB ? [2, 1, 4] : motion === DP ? [6, 2, 3] : [6, 3, 2, 1, 4]
  return [...dirs.map((d, i): [number, number] => [d, i === dirs.length - 1 ? btn : 0]), [5, 0]]
}

export function botInput(s: FighterState, seat: number, ctx: GameContext): number {
  const mem = s.bot[seat]
  const me = s.f[seat]
  const op = s.f[1 - seat]
  const r = () => ctx.random()

  if (s.ph === PH_SELECT) {
    if (me.locked) return 0
    if (mem.wait === 0) mem.wait = 40 + Math.floor(r() * 70)
    // Browse a little, then lock in (a press needs a release before it).
    const out = s.pt >= mem.wait ? (mem.last === A ? 0 : A) : s.pt % 14 === 0 && r() < 0.6 ? GAME_PAD.RIGHT : 0
    mem.last = out
    return out
  }
  if (s.ph !== PH_FIGHT) {
    mem.plan = []
    mem.wait = 0
    mem.last = 0
    return 0
  }
  if (mem.plan.length) {
    mem.last = mem.plan.shift() ?? 0
    return mem.last
  }
  // Hitstop: keep what's held (motions and buffered presses continue after it).
  if (s.freeze > 0) return mem.last & ~(A | B | X | Y)

  const face = me.face
  const P = (dir: number, btn = 0) => padOf(dir, face) | btn
  const plan = (steps: [number, number][]) => {
    mem.plan = steps.map(([d, b]) => P(d, b))
    mem.wait = 0
    mem.last = mem.plan.shift() ?? 0
    return mem.last
  }
  const c = CHARS[me.ch]
  const sc = c.scale
  const dist = Math.abs(op.x - me.x)
  const free = me.act === IDLE || me.act === WALKF || me.act === WALKB || me.act === CROUCH
  const blocking = me.act === BLOCK || me.act === BLOCKC
  const special = (k: number) => c.specials[k]
  const findSpecial = (motion: number, btn?: 'P' | 'K') => c.specials.findIndex((x) => x.motion === motion && (!btn || x.btn === btn))

  // --- Defense: react to the opponent's attack after a delay, sometimes. ---
  const om = moveOf(op)
  if (op.act === ATTACK && om && (om.hb || om.grab)) {
    const start = s.tick - op.t
    if (mem.atk !== start) {
      mem.atk = start
      mem.blockAt = !om.grab && r() < 0.58 ? 6 + Math.floor(r() * 9) : -1
      mem.low = om.guard === 1 ? r() < 0.75 : om.guard === 2 ? r() < 0.2 : r() < 0.5
    }
    const reach = ((om.hb ? om.hb[1] : 30) + 30) * CHARS[op.ch].scale + om.vx * (om.su + om.ac)
    if (mem.blockAt >= 0 && op.t >= mem.blockAt && dist < reach && (free || blocking) && op.t < om.su + om.ac + 4) {
      mem.last = P(mem.low ? 1 : 4)
      return mem.last
    }
  }
  if (blocking) {
    mem.last = P(mem.low ? 1 : 4)
    return mem.last
  }

  // --- Projectiles coming at us. ---
  const incoming = s.proj.find((p) => p.o !== seat && Math.sign(p.vx) === Math.sign(me.x - p.x) && Math.abs(p.x - me.x) < 150)
  if (incoming && free) {
    const born = s.tick - incoming.age
    const pd = Math.abs(incoming.x - me.x)
    if (mem.proj !== born) {
      mem.proj = born
      const x = r()
      mem.pc = x < 0.4 ? 1 : x < 0.65 ? 2 : 0
    }
    if (mem.pc === 2 && pd < 110 && pd > 50) {
      mem.pc = 0
      return plan([[9, 0], [9, 0], [9, 0], [9, 0]])
    }
    if (mem.pc === 1 && pd < 90) {
      mem.last = P(4)
      return mem.last
    }
  }

  // --- Anti-air. ---
  if (op.y <= 0) mem.jump = -1
  else if (mem.jump === -1 && op.vy < 0 && op.y < 50 && dist < 80 && (op.act === JUMP || op.act === ATTACK) && free) {
    mem.jump = r() < 0.5 ? 1 : 0
    if (mem.jump === 1) {
      const k = findSpecial(DP)
      if (k >= 0 && r() < 0.7) return plan(motionPlan(DP, special(k).btn === 'P' ? (r() < 0.5 ? B : A) : r() < 0.5 ? Y : X))
      return plan([[2, B], [2, 0], [2, 0]])
    }
  }

  // --- Whiff punish. ---
  if (op.act === ATTACK && om && !op.hit && free && op.y <= 0) {
    const start = s.tick - op.t
    const left = om.su + om.ac + om.rc - op.t
    if (mem.punish !== start && op.t >= om.su + om.ac && left >= 10 && dist < 75 * sc) {
      mem.punish = start
      if (r() < 0.45) {
        const grab = findSpecial(HCB)
        if (grab >= 0 && dist < 46) return plan(motionPlan(HCB, B))
        const follow = me.ch === 0 ? QCF : me.ch === 2 ? QCF : -1
        const fbtn = me.ch === 2 ? X : A
        const steps: [number, number][] = [[5, B], [5, 0]]
        if (follow >= 0) steps.push(...motionPlan(follow, fbtn))
        return plan(steps)
      }
    }
  }

  if (!free) {
    mem.last = 0
    return 0
  }

  // --- Neutral game. ---
  if (op.act === DOWN || op.act === WAKE) {
    mem.last = dist > c.pref + 10 ? P(6) : 0
    return mem.last
  }
  if (mem.wait > 0) {
    mem.wait--
    mem.last = mem.hold
    return mem.last
  }
  const hold = (dir: number, ticks: number) => {
    mem.hold = P(dir)
    mem.wait = ticks
    mem.last = mem.hold
    return mem.last
  }
  const ownProj = s.proj.some((p) => p.o === seat)
  const x = r()
  // Zoning and fighter-specific tools.
  if (me.ch === 0 && dist > 130 && !ownProj && x < 0.3) return plan(motionPlan(QCF, r() < 0.5 ? A : B))
  if (me.ch === 0 && dist > 60 && dist < 110 && x < 0.05) return plan(motionPlan(QCB, r() < 0.5 ? X : Y))
  if (me.ch === 2 && dist > 90 && dist < 170 && x < 0.12) return plan(motionPlan(QCF, r() < 0.6 ? X : Y))
  if (me.ch === 2 && dist > 60 && dist < 140 && !ownProj && x < 0.2) return plan(motionPlan(QCF, A))
  if (me.ch === 1 && dist > 90 && dist < 170 && x < 0.08) return plan(motionPlan(QCF, r() < 0.5 ? X : Y))
  if (me.ch === 1 && dist < 50 * sc && op.y <= 0 && x < 0.2) return plan(motionPlan(HCB, r() < 0.5 ? A : B))
  if (dist < c.throwRange && op.y <= 0 && x < 0.15) return plan([[6, B], [6, 0]])
  // Spacing.
  if (dist > c.pref + 25) {
    if (dist > 80 && dist < 150 && r() < 0.08) return plan([[9, 0], [9, 0], [9, 0], [9, 0], ...Array.from({ length: 18 }, (): [number, number] => [5, 0]), [5, Y], [5, 0]])
    return hold(6, 8 + Math.floor(r() * 14))
  }
  if (dist < c.pref - 20 && r() < 0.6) return hold(4, 6 + Math.floor(r() * 10))
  // In range: poke, sweep, overhead, or wait.
  const y = r()
  if (dist < 50 * sc) {
    if (y < 0.25) return plan([[2, X], [2, 0], [2, A], [2, 0]])
    if (y < 0.35) return plan([[5, A], [5, 0], [5, A], [5, 0]])
    if (y < 0.42) return plan([[2, Y], [2, 0]])
    if (y < 0.47) return plan([[6, Y], [6, 0]])
    if (y < 0.55) return plan([[5, B], [5, 0], ...(me.ch === 0 ? motionPlan(QCF, A) : [])])
  } else if (dist < 60 * sc) {
    if (y < 0.18) return plan([[5, Y], [5, 0]])
    if (y < 0.3) return plan([[2, X], [2, 0]])
  }
  return hold(y < 0.5 ? 5 : y < 0.75 ? 4 : 6, 4 + Math.floor(r() * 10))
}

