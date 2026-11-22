// Kart Rally bots: follow the track's racing line (each with its own lateral preference and skill), drift through
// long bends, back out when stuck, dodge oil slicks and use items when they make sense. Also the autopilot that
// drives a person's kart after the finish line.
import { GAME_PAD } from '../../protocol.ts'
import type { GameContext } from '../types.ts'
import { buildTrack, pointAt, SEG_LEN } from './track.ts'
import {
  angleWrap,
  COUNTDOWN,
  ITEM_BOLT,
  ITEM_NITRO,
  ITEM_NITRO3,
  ITEM_NONE,
  ITEM_SEEKER,
  ITEM_SHIELD,
  ITEM_SLICK,
  OBJ_SLICK,
  TICK_HZ,
} from './model.ts'
import type { KartState } from './model.ts'

const P = GAME_PAD
/** `ai.itemWait` when no item decision is pending. */
export const ITEM_UNSET = 1_000_000

/** The buttons bot (or autopilot) `i` holds this tick. Mutates only its own `ai` memory. */
export function botButtons(s: KartState, i: number, ctx: GameContext): number {
  const k = s.karts[i]
  const ai = s.ai[i]
  if (!k || !ai || k.gone) return 0
  if (s.phase === 0) return COUNTDOWN - s.tick <= ai.launch ? P.A : 0
  const t = buildTrack(s.track)

  // Occasionally drift the preferred line a little, and make a small mistake now and then.
  if (ctx.random() < 0.01) ai.pref = Math.max(-0.35, Math.min(0.35, ai.pref + (ctx.random() - 0.5) * 0.3))
  if (ai.slip > 0) ai.slip--
  else if (ctx.random() < 0.0025 * (1 - ai.skill)) ai.slip = 6 + Math.floor(ctx.random() * 10)
  if (ai.dodgeT > 0) ai.dodgeT--

  const ahead = 24 + Math.max(0, k.v) * 0.5
  const c = pointAt(t, k.s + ahead, 0)
  let lat = t.line[c.k] * (0.45 + 0.55 * ai.skill) + ai.pref * 0.5 + (ai.dodgeT > 0 ? ai.dodge : 0)
  lat = Math.max(-0.75, Math.min(0.75, lat)) * c.w
  const p = pointAt(t, k.s + ahead, lat)
  const want = Math.atan2(p.y - k.y, p.x - k.x)
  const diff = angleWrap(want - k.a)

  // Stuck against something: back out.
  if (s.phase === 1 && Math.abs(k.v) < 6 && k.spin === 0 && k.fin < 0) ai.stuck++
  else ai.stuck = Math.max(0, ai.stuck - 2)
  if (ai.stuck > 40) {
    ai.stuck = 0
    ai.rev = 26
  }
  if (ai.rev > 0) {
    ai.rev--
    return P.B | (diff > 0 ? P.LEFT : P.RIGHT)
  }

  let btn = ai.slip > 0 ? 0 : P.A
  // Upcoming bend: heading change over the next ~100 units.
  let bend = 0
  for (let j = 2; j < 15; j++) bend += t.curv[(k.seg + j) % t.n] * SEG_LEN

  if (ai.dr !== 0) {
    ai.drT++
    btn |= P.R
    if (k.drift !== 0) {
      const rel = diff * k.drift
      if (rel > 0.1) btn |= k.drift > 0 ? P.RIGHT : P.LEFT
      else if (rel < -0.04) btn |= k.drift > 0 ? P.LEFT : P.RIGHT
      if (rel < -0.3 || bend * k.drift < 0.25 || k.v < 50) ai.dr = 0
    } else {
      btn |= ai.dr > 0 ? P.RIGHT : P.LEFT
      if (ai.drT > 14) ai.dr = 0
    }
  } else {
    if (diff > 0.05) btn |= P.RIGHT
    else if (diff < -0.05) btn |= P.LEFT
    if (
      k.drift === 0 &&
      k.z <= 0 &&
      ai.skill > 0.45 &&
      k.v > 78 &&
      Math.abs(bend) > 0.85 &&
      bend * diff > 0 &&
      Math.abs(diff) > 0.12 &&
      !k.off
    ) {
      ai.dr = bend > 0 ? 1 : -1
      ai.drT = 0
      btn |= P.R
    }
  }
  const ad = Math.abs(diff)
  if (ad > 1.0 && k.v > 55) btn &= ~P.A
  if (ad > 1.5 && k.v > 35) btn |= P.B

  // Dodge oil slicks on the way.
  const fx = Math.cos(k.a)
  const fy = Math.sin(k.a)
  for (const o of s.objs) {
    if (o.type !== OBJ_SLICK) continue
    const dx = o.x - k.x
    const dy = o.y - k.y
    const along = dx * fx + dy * fy
    const side = -dx * fy + dy * fx
    if (along > 6 && along < 70 && Math.abs(side) < 15 && ctx.random() < 0.3 + 0.6 * ai.skill) {
      ai.dodge = side > 0 ? -0.55 : 0.55
      ai.dodgeT = 22
    }
  }

  // Items (racing only; never after the finish).
  if (k.item !== ITEM_NONE && k.roll === 0 && k.fin < 0 && s.phase === 1 && s.seats[i]?.userId === null) {
    if (ai.itemWait >= ITEM_UNSET) ai.itemWait = 15 + Math.floor(ctx.random() * 60)
    if (--ai.itemWait <= 0) {
      let use = ai.itemWait < -6 * TICK_HZ
      let extra = 0
      if (k.item === ITEM_NITRO || k.item === ITEM_NITRO3) use ||= ad < 0.25 || k.off
      else if (k.item === ITEM_SLICK) {
        for (const o of s.karts) {
          if (o === k || o.gone) continue
          if (o.u < k.u - 8 && o.u > k.u - 90 && Math.hypot(o.x - k.x, o.y - k.y) < 100) use = true
        }
      } else if (k.item === ITEM_BOLT) {
        for (const o of s.karts) {
          if (o === k || o.gone) continue
          const dx = o.x - k.x
          const dy = o.y - k.y
          const along = dx * fx + dy * fy
          const side = -dx * fy + dy * fx
          if (along > 12 && along < 200 && Math.abs(side) < 12) use = true
          else if (along < -12 && along > -60 && Math.abs(side) < 10) {
            use = true
            extra = P.DOWN
          }
        }
      } else if (k.item === ITEM_SEEKER || k.item === ITEM_SHIELD) use = true
      if (use && !(k.btn & (P.X | P.Y))) {
        btn |= P.X | extra
        ai.itemWait = k.item === ITEM_NITRO3 && k.uses > 1 ? 10 + Math.floor(ctx.random() * 25) : ITEM_UNSET
      }
    }
  } else ai.itemWait = ITEM_UNSET
  return btn
}
