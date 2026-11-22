// Ring Out computer players: approach, attack in range, shield sometimes, and above all get back to the stage
// (double jump, side / up special toward the ledge) without walking off edges. They decide every tick from
// the state (deterministic: ctx.random only) and keep a little memory in state.bots.
import { GAME_PAD } from '../../protocol.ts'
import type { GameContext } from '../types.ts'
import { MOVES } from './data.ts'
import { charOf, onField, stageOf, type BrawlState, type Fighter } from './engine.ts'

const { UP, DOWN, LEFT, RIGHT, A, B, X, L } = GAME_PAD

export function botButtons(s: BrawlState, seat: number, ctx: GameContext): number {
  const f = s.f[seat]
  const m = s.bots[seat]
  if (!f || !m) return 0
  if (s.ph !== 'play' || !onField(f)) {
    m.prev = 0
    return 0
  }
  let out = 0
  /** A fresh press: only when not held at the previous tick (else release now, press next tick). */
  const press = (b: number) => {
    if (!(m.prev & b)) out |= b
  }
  const hold = (b: number) => {
    out |= b
  }
  const main = stageOf(s).main
  const c = charOf(f)
  const mid = (main.l + main.r) / 2
  const inward = f.x < mid ? RIGHT : LEFT

  switch (f.act) {
    case 'respawn':
      if (f.t > 25 + ((seat * 17) % 40)) hold(inward)
      break
    case 'ledge':
      if (f.t <= 6) m.planKind = Math.floor(ctx.random() * 5)
      else if (f.t > 10 + m.planKind * 4) {
        if (m.planKind === 0) press(X)
        else if (m.planKind === 1) hold(L)
        else if (m.planKind === 2) press(A)
        else hold(f.face > 0 ? RIGHT : LEFT)
      }
      break
    case 'held':
    case 'dizzy':
      if (s.tick % 2 === 0) hold(A)
      break
    case 'hold':
      // Throw toward the nearer blast zone.
      hold(f.x < mid ? LEFT : RIGHT)
      break
    case 'hurt':
    case 'helpless':
    case 'climb':
    case 'dead':
      hold(inward)
      break
    default:
      if (isOffstage(s, f)) recover(s, f, hold, press)
      else fight(s, f, ctx, hold, press)
  }

  // Never walk off an edge on purpose.
  if (f.gnd === 0 && f.act !== 'atk') {
    const margin = 10 + c.run * 4
    if (f.x < main.l + margin && out & LEFT) out &= ~LEFT
    if (f.x > main.r - margin && out & RIGHT) out &= ~RIGHT
  }
  m.prev = out
  return out
}

function isOffstage(s: BrawlState, f: Fighter) {
  if (f.gnd >= 0) return false
  const main = stageOf(s).main
  return f.x < main.l + 2 || f.x > main.r - 2 || f.y > main.y + 1
}

function recover(s: BrawlState, f: Fighter, hold: (b: number) => void, press: (b: number) => void) {
  const main = stageOf(s).main
  const c = charOf(f)
  const left = f.x < (main.l + main.r) / 2
  const edge = left ? main.l : main.r
  const under = f.x > main.l - c.hw && f.x < main.r + c.hw && f.y > main.y
  const dx = Math.abs(f.x - edge)
  const dy = f.y - main.y
  // Under the stage: get out sideways first; otherwise drift toward the ledge.
  if (under) hold(left ? LEFT : RIGHT)
  else hold(left ? RIGHT : LEFT)
  if (f.act !== 'air') return
  if (f.jumps > 0 && f.vy > -0.5 && (dy > -30 || dx > 60)) return press(X)
  if (f.jumps > 0) return
  if (!f.sbUsed && dx > 75 && dy < 20 && dy > -60 && !under) return press(B)
  if (!f.ubUsed && f.vy > -0.5 && ((dx < 72 && dy > -12) || dy > 35)) {
    if (!under || dx > 40) {
      hold(UP)
      press(B)
    }
  }
}

function fight(s: BrawlState, f: Fighter, ctx: GameContext, hold: (b: number) => void, press: (b: number) => void) {
  const m = s.bots[f.seat]
  const main = stageOf(s).main
  const c = charOf(f)
  let target: Fighter | null = null
  let best = 1e9
  for (const o of s.f) {
    if (o === f || !onField(o) || o.act === 'respawn') continue
    const d = Math.hypot(o.x - f.x, (o.y - f.y) * 1.5)
    if (d < best) {
      best = d
      target = o
    }
  }
  if (m.atkCd > 0) m.atkCd--
  if (!target) {
    if (Math.abs(f.x - (main.l + main.r) / 2) > 40) hold(f.x < 0 ? RIGHT : LEFT)
    return
  }
  const tc = charOf(target)
  const dx = target.x - f.x
  const dy = target.y - f.y
  const adx = Math.abs(dx)
  const dirT = dx >= 0 ? RIGHT : LEFT
  const facing = (dx >= 0 ? 1 : -1) === f.face
  const range = 20 * c.reach + tc.hw
  const targetOff = target.x < main.l || target.x > main.r || target.y > main.y + 4

  // Shield an attack that is coming (sometimes).
  if (f.gnd >= 0 && m.shieldT <= 0) {
    for (const o of s.f) {
      if (o === f || !onField(o) || o.act !== 'atk') continue
      const mv = MOVES[o.mv]
      if (o.t < mv.s && Math.abs(o.x - f.x) < 42 && Math.abs(o.y - f.y) < 30 && ctx.random() < 0.07) {
        m.shieldT = 10 + Math.floor(ctx.random() * 14)
      }
    }
  }
  if (m.shieldT > 0) {
    m.shieldT--
    if (f.gnd >= 0 && (f.act === 'shield' || f.act === 'idle' || f.act === 'run' || f.act === 'crouch' || f.act === 'land')) {
      hold(L)
      if (adx < range && m.shieldT < 4 && ctx.random() < 0.3) press(A)
      return
    }
  }

  if (f.gnd >= 0) {
    const ready = f.act === 'idle' || f.act === 'run' || f.act === 'crouch'
    if (targetOff) {
      // Edge guard: wait near the ledge, hit them if they come close.
      const stop = target.x < main.l ? main.l + 22 : main.r - 22
      if (Math.abs(stop - f.x) > 6) hold(stop > f.x ? RIGHT : LEFT)
      if (ready && m.atkCd === 0 && adx < range + 6 && Math.abs(dy) < 26) {
        if (!facing) hold(dirT)
        else {
          if (dy > 8) hold(DOWN)
          press(A)
        }
        m.atkCd = 14 + Math.floor(ctx.random() * 16)
      }
      return
    }
    if (adx < range && dy > -26 && dy < 14) {
      if (!ready || m.atkCd > 0) return
      const r = ctx.random()
      if (target.dmg > 85 && r < 0.3) {
        if (facing) press(B)
        else hold(dirT)
      } else if (r < 0.4) {
        hold(dirT)
        press(A)
      } else if (r < 0.52) {
        if (facing) press(A)
        else hold(dirT)
      } else if (r < 0.66) {
        hold(DOWN)
        press(A)
      } else if (r < 0.76) {
        hold(L)
        press(A)
      } else if (r < 0.88) {
        hold(UP)
        press(A)
      } else {
        hold(DOWN)
        press(B)
      }
      m.atkCd = 6 + Math.floor(ctx.random() * 24)
      return
    }
    if (dy < -28 && adx < 60) {
      if (ready && ctx.random() < 0.1) press(X)
      if (adx > 8) hold(dirT)
      return
    }
    if (dy > 20 && f.gnd > 0) {
      hold(DOWN)
      return
    }
    hold(dirT)
    // Close the distance faster with a dash strike now and then.
    if (ready && adx > 70 && adx < 110 && Math.abs(dy) < 10 && ctx.random() < 0.01) press(B)
    return
  }

  // In the air above the stage.
  if (adx > 6) hold(dirT)
  if (f.act === 'air' && m.atkCd === 0 && adx < range + 6 && Math.abs(dy) < 32) {
    if (dy < -14) {
      hold(UP)
      press(A)
    } else if (dy > 14) {
      hold(DOWN)
      press(A)
    } else press(A)
    m.atkCd = 10 + Math.floor(ctx.random() * 18)
  } else if (f.act === 'air' && f.vy > 0 && dy < -24 && f.jumps > 0 && ctx.random() < 0.05) press(X)
  // Don't drift off the stage while chasing.
  if (f.x < main.l + 16) hold(RIGHT)
  if (f.x > main.r - 16) hold(LEFT)
}
