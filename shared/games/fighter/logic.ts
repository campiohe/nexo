// Dojo Duel: a one-on-one 2D fighting game (original fighters, moves and stage). Pick a fighter, best of three
// rounds of 99 seconds, motion-input specials, cancels, throws, knockdowns. The simulation is in sim.ts, the
// fighters and frame data in chars.ts, the motion reader in input.ts, the computer player in bot.ts. The view
// is desktop/src/renderer/src/games/fighter.
import type { GameDefinition } from '../types.ts'
import { ATTACK, FL_ARMOR, FL_FLIP, FL_GUARD, FL_RISING, FL_TBACK, PH_SELECT, SELECT_TICKS, THROW, TICK_HZ } from './chars.ts'
import { botInput } from './bot.ts'
import { createState, leaveSeat, moveOf, tickState, type FighterState } from './sim.ts'

export type { FighterState } from './sim.ts'

/**
 * What everyone sees (one view for all). Fighters: [ch, x, y, face, act, t, mv, hp, flags, combo].
 * Projectiles: [owner, x, y, move, age]. Events: [id, kind, x, y, seat].
 */
export interface FighterView {
  ph: number
  pt: number
  rd: number
  /** Round timer (seconds). */
  tm: number
  cam: number
  /** Rounds won, round winners so far (-1 draw). */
  w: number[]
  lg: number[]
  /** Last round: winner, how it ended, perfect (1). */
  rw: number
  ek: number
  pf: number
  /** Select screen: [cursor, locked] per seat and the seconds left. */
  sel: number[][]
  st: number
  f: number[][]
  p: number[][]
  e: number[][]
  fz: number
}

const r1 = (n: number) => Math.round(n)

export function fighterView(s: FighterState): FighterView {
  return {
    ph: s.ph,
    pt: Math.min(s.pt, 9999),
    rd: s.round,
    tm: Math.ceil(s.timer / TICK_HZ),
    cam: r1(s.cam),
    w: s.f.map((f) => f.wins),
    lg: [...s.log],
    rw: s.rw,
    ek: s.ek,
    pf: s.perfect ? 1 : 0,
    sel: s.f.map((f) => [f.pick, f.locked ? 1 : 0]),
    st: s.ph === PH_SELECT ? Math.max(0, Math.ceil((SELECT_TICKS - s.pt) / TICK_HZ)) : 0,
    f: s.f.map((f) => {
      const m = moveOf(f)
      let flags = 0
      if (f.guard) flags |= FL_GUARD
      if (f.jdir !== 0) flags |= FL_FLIP
      if (f.vy > 0) flags |= FL_RISING
      if (f.act === ATTACK && m && f.armor > 0 && f.t < m.su + m.ac) flags |= FL_ARMOR
      if (f.act === THROW && f.tdir < 0) flags |= FL_TBACK
      return [f.ch, r1(f.x), r1(f.y), f.face, f.act, Math.min(f.t, 999), f.mv, f.hp, flags, f.comboShow > 0 ? f.combo : 0]
    }),
    p: s.proj.map((p) => [p.o, r1(p.x), r1(p.y), p.mv, Math.min(p.age, 999)]),
    e: s.ev.map((e) => [e.id, e.k, r1(e.x), r1(e.y), e.s]),
    fz: s.freeze,
  }
}

export const fighter: GameDefinition<FighterState> = {
  id: 'fighter',
  name: 'Dojo Duel',
  tagline: 'One on one at the dojo. Read your rival, land combos and special moves.',
  minPlayers: 2,
  maxPlayers: 2,
  bots: true,
  controls: 'pad',
  help: [
    ['Arrows', 'Walk, ↑ jump, ↓ crouch. Hold back to block (down-back blocks low)'],
    ['A', 'Light punch'],
    ['B', 'Heavy punch (close + toward/away + B: throw)'],
    ['X', 'Light kick'],
    ['Y', 'Heavy kick (toward + Y: overhead)'],
    ['↓↘→ +P', 'Spirit Wave (Kai), Wind Needle (Mika)'],
    ['→↓↘ +P', 'Rising Crane (Kai), Stone Rise (Bruno)'],
    ['→↓↘ +K', 'Petal Spin (Mika)'],
    ['↓↘→ +K', 'Bull Charge (Bruno), Swallow Dash (Mika)'],
    ['↓↙← +K', 'Gale Step (Kai)'],
    ['→↓← +P', 'Ox Slam (Bruno, command throw)'],
    ['Combos', 'Cancel a punch or light kick into a special when it connects. Lights chain into lights'],
  ],
  tickHz: TICK_HZ,
  frameEvery: 2,
  perSeatView: false,
  create: (seats) => createState(seats),
  tick: (s, input, ctx) => tickState(s, input, ctx),
  bot: (s, seat, ctx) => botInput(s, seat, ctx),
  leave: (s, seat) => leaveSeat(s, seat),
  view: (s) => fighterView(s),
  result: (s) => s.result,
}
