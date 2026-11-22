// Dojo Duel (shared/games/fighter): the game contract plus focused checks of the fighting mechanics: lenient
// motion inputs, blocking, chip damage, throws, the round timer, double KO, best of three, the select screen
// and leaving. Run with `node --test test/games-fighter.test.ts` from server/.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { GAME_PAD } from '../../shared/protocol.ts'
import { fighter, fighterView } from '../../shared/games/fighter/logic.ts'
import {
  AIRHIT,
  ATTACK,
  BLOCKC,
  CHARS,
  DOWN,
  END_DKO,
  END_KO,
  END_TIME,
  HIT,
  HITC,
  IDLE,
  M_CRLK,
  M_OVH,
  M_SP0,
  M_STHP,
  M_THROW,
  PH_END,
  PH_FIGHT,
  PH_INTRO,
  PH_OVER,
  PH_SELECT,
  SELECT_TICKS,
  THROW,
  THROWN,
  TICK_HZ,
} from '../../shared/games/fighter/chars.ts'
import { MOTIONS, matchMotion, numpad, padOf } from '../../shared/games/fighter/input.ts'
import type { FighterState } from '../../shared/games/fighter/sim.ts'
import { checkGameContract, makeSeats, simulate, type Sim } from './helpers/gameHarness.ts'

const { UP, DOWN: D, LEFT: L, RIGHT: R, A, B, X, Y } = GAME_PAD
const KAI = 0
const BRUNO = 1
const MIKA = 2

/** Two people; picks fighters on the select screen and runs the intro: returns a sim at the first fight tick. */
function fight(c0 = KAI, c1 = KAI, seed = 1): Sim<FighterState> {
  const sim = simulate(fighter, makeSeats(2, 0), seed)
  const pick = (seat: number, ch: number) => {
    // Cursors start at 0 (seat 0) and 2 (seat 1).
    let cur = seat === 0 ? 0 : 2
    while (cur !== ch) {
      sim.input(seat, R)
      sim.step()
      sim.input(seat, 0)
      sim.step()
      cur = (cur + 1) % CHARS.length
    }
    sim.input(seat, A)
    sim.step()
    sim.input(seat, 0)
  }
  pick(0, c0)
  pick(1, c1)
  for (let n = 0; n < 400 && sim.state.ph !== PH_FIGHT; n++) sim.step()
  assert.equal(sim.state.ph, PH_FIGHT)
  assert.deepEqual(
    sim.state.f.map((f) => f.ch),
    [c0, c1],
  )
  return sim
}

/** Holds `held` for `ticks` ticks (presses register on the first). */
function hold(sim: Sim<FighterState>, seat: number, held: number, ticks = 1) {
  for (let n = 0; n < ticks; n++) {
    sim.input(seat, held)
    sim.step()
  }
}

/** Relative direction (numpad) + buttons for `seat`, given its current facing. */
function rel(sim: Sim<FighterState>, seat: number, dir: number, btn = 0) {
  return padOf(dir, sim.state.f[seat].face) | btn
}

/** Puts both fighters `gap` px apart around the stage center, idle. */
function place(sim: Sim<FighterState>, gap: number) {
  const s = sim.state
  const mid = 256
  s.f[0].x = mid - gap / 2
  s.f[1].x = mid + gap / 2
  s.f[0].face = 1
  s.f[1].face = -1
  for (const f of s.f) {
    f.act = IDLE
    f.t = 0
    f.y = f.vx = f.vy = 0
    f.pb = 0
  }
  s.cam = mid - 160
}

/** Steps until `pred` holds (or fails after `max` ticks). */
function until(sim: Sim<FighterState>, pred: (s: FighterState) => boolean, max = 200, each?: () => void) {
  for (let n = 0; n < max; n++) {
    if (pred(sim.state)) return
    each?.()
    sim.step()
  }
  assert.fail('condition not reached')
}

describe('Dojo Duel', () => {
  test('passes the game contract (a full match against the bot ends, views are small, deterministic)', () => {
    checkGameContract(fighter)
  })

  test('bot vs bot matches always end with a sane result', () => {
    for (const seed of [1, 2, 3, 4]) {
      const sim = simulate(fighter, makeSeats(0, 2), seed)
      const r = sim.run(15 * 60 * TICK_HZ)
      assert.ok(r, `seed ${seed}: match ended`)
      assert.ok(r.summary.length > 0)
      assert.ok(sim.state.round >= 2 && sim.state.round <= 5)
    }
  })

  describe('motion inputs', () => {
    const qcf = MOTIONS[0]
    const dp = MOTIONS[2]
    test('numpad directions are relative to facing', () => {
      assert.equal(numpad(R, 1), 6)
      assert.equal(numpad(R, -1), 4)
      assert.equal(numpad(D | L, -1), 3)
      assert.equal(numpad(UP | R, 1), 9)
      assert.equal(numpad(L | R, 1), 5)
      assert.equal(padOf(3, -1), D | L)
    })
    test('quarter circle forward: clean, without the diagonal, slow-ish, and with junk in between', () => {
      assert.ok(matchMotion([5, 2, 3, 6], qcf))
      assert.ok(matchMotion([5, 2, 2, 6, 6], qcf), 'diagonal optional')
      assert.ok(matchMotion([2, 5, 5, 5, 5, 5, 5, 5, 5, 3], qcf), 'loose timing within the window')
      assert.ok(matchMotion([2, 1, 2, 5, 3, 6], qcf), 'junk between steps')
      assert.ok(!matchMotion([6, 3, 2], qcf), 'backwards is not a QCF')
      assert.ok(!matchMotion([2, ...Array(20).fill(5), 6], qcf), 'too slow')
    })
    test('dragon punch motion needs forward, down, down-forward', () => {
      assert.ok(matchMotion([6, 2, 3], dp))
      assert.ok(matchMotion([6, 5, 1, 2, 3], dp))
      assert.ok(!matchMotion([2, 3, 6], dp))
    })
    test('a special comes out from a real QCF+P in the sim, even pressed a tick early', () => {
      const sim = fight(KAI, KAI)
      place(sim, 150)
      hold(sim, 0, rel(sim, 0, 2), 2)
      hold(sim, 0, rel(sim, 0, 3, A), 1) // pressed on the diagonal, before reaching forward
      hold(sim, 0, rel(sim, 0, 6, A), 1)
      const f = sim.state.f[0]
      assert.equal(f.act, ATTACK)
      assert.ok(CHARS[KAI].moves[f.mv].proj, 'Spirit Wave started')
      hold(sim, 0, 0, 20)
      assert.equal(sim.state.proj.length, 1)
    })
    test('a press during the motion is buffered (special after a late finishing direction)', () => {
      const sim = fight(MIKA, KAI)
      place(sim, 150)
      // ↓ then the kick a tick before → arrives (buffered), Mika's Swallow Dash.
      hold(sim, 0, rel(sim, 0, 2), 2)
      hold(sim, 0, rel(sim, 0, 2, X), 1)
      hold(sim, 0, rel(sim, 0, 6, X), 1)
      const f = sim.state.f[0]
      assert.equal(f.act, ATTACK)
      assert.equal(CHARS[MIKA].moves[f.mv].pose, 'dash')
    })
    test('light normal cancels into a special on contact', () => {
      const sim = fight(KAI, KAI)
      place(sim, 40)
      hold(sim, 0, rel(sim, 0, 2, X), 1) // crouching light kick
      assert.equal(sim.state.f[0].mv, M_CRLK)
      hold(sim, 0, rel(sim, 0, 2), 2)
      hold(sim, 0, rel(sim, 0, 3), 1)
      hold(sim, 0, rel(sim, 0, 6, B), 1)
      until(sim, (s) => s.f[0].hit > 0 || (s.f[0].act === ATTACK && s.f[0].mv >= M_SP0))
      until(sim, (s) => s.f[0].mv >= M_SP0, 30)
      assert.ok(sim.state.f[1].hp < CHARS[KAI].hp)
    })
  })

  describe('blocking', () => {
    test('a mid is blocked holding back, no damage from a normal', () => {
      const sim = fight(KAI, KAI)
      place(sim, 40)
      sim.input(1, rel(sim, 1, 4))
      hold(sim, 0, B, 1)
      hold(sim, 0, 0, 12)
      const d = sim.state.f[1]
      assert.equal(d.hp, CHARS[KAI].hp)
      assert.equal(sim.state.f[0].hit, 2, 'blocked')
    })
    test('without holding back it hits', () => {
      const sim = fight(KAI, KAI)
      place(sim, 40)
      hold(sim, 0, B, 1)
      hold(sim, 0, 0, 12)
      assert.ok(sim.state.f[1].hp < CHARS[KAI].hp)
      assert.ok([HIT, HITC].includes(sim.state.f[1].act) || sim.state.freeze >= 0)
    })
    test('a low (crouching kick) beats a standing block, a crouching block stops it', () => {
      const sim = fight(KAI, KAI)
      place(sim, 40)
      sim.input(1, rel(sim, 1, 4))
      hold(sim, 0, D | R | X, 1)
      hold(sim, 0, D, 12)
      assert.ok(sim.state.f[1].hp < CHARS[KAI].hp, 'standing block fails against a low')
      const sim2 = fight(KAI, KAI)
      place(sim2, 40)
      sim2.input(1, rel(sim2, 1, 1))
      hold(sim2, 0, D | X, 1)
      hold(sim2, 0, D, 12)
      assert.equal(sim2.state.f[1].hp, CHARS[KAI].hp)
      assert.equal(sim2.state.f[1].act, BLOCKC)
    })
    test('the overhead beats a crouching block', () => {
      const sim = fight(KAI, KAI)
      place(sim, 40)
      sim.input(1, rel(sim, 1, 1))
      hold(sim, 0, R | Y, 1)
      assert.equal(sim.state.f[0].mv, M_OVH)
      hold(sim, 0, 0, 30)
      assert.ok(sim.state.f[1].hp < CHARS[KAI].hp)
    })
    test('holding back a tick late still blocks (input grace)', () => {
      const sim = fight(KAI, KAI)
      place(sim, 40)
      hold(sim, 0, B, 1)
      // The defender held back two ticks ago and let go: still a block.
      until(sim, (s) => s.f[0].t >= CHARS[KAI].moves[M_STHP].su - 3, 20)
      hold(sim, 1, rel(sim, 1, 4), 1)
      sim.input(1, 0)
      hold(sim, 0, 0, 10)
      assert.equal(sim.state.f[1].hp, CHARS[KAI].hp)
    })
    test('specials do chip damage through a block', () => {
      const sim = fight(KAI, KAI)
      place(sim, 120)
      sim.input(1, rel(sim, 1, 4))
      hold(sim, 0, rel(sim, 0, 2), 2)
      hold(sim, 0, rel(sim, 0, 3), 1)
      hold(sim, 0, rel(sim, 0, 6, B), 1)
      sim.input(0, 0)
      until(sim, (s) => s.proj.length === 0 && s.f[0].act === IDLE, 200, () => sim.input(1, rel(sim, 1, 4)))
      const d = sim.state.f[1]
      const wave = CHARS[KAI].moves.find((m) => m.proj && m.proj.vx > 4)!
      assert.equal(d.hp, CHARS[KAI].hp - wave.chip)
    })
  })

  describe('jumping', () => {
    /** Seat 0 jumps toward seat 1 and presses Y on the way down. */
    function jumpIn(sim: Sim<FighterState>, each?: () => void) {
      hold(sim, 0, rel(sim, 0, 9), 4)
      sim.input(0, 0)
      until(sim, (s) => s.f[0].vy < 0 && s.f[0].y < 42, 80, each)
      hold(sim, 0, Y, 1)
      sim.input(0, 0)
    }
    test('a jump-in attack beats a crouching block (block it standing)', () => {
      const sim = fight(KAI, KAI)
      place(sim, 80)
      sim.input(1, rel(sim, 1, 1))
      jumpIn(sim, () => sim.input(1, rel(sim, 1, 1)))
      hold(sim, 0, 0, 12)
      assert.ok(sim.state.f[1].hp < CHARS[KAI].hp, 'crouch block fails')
      const sim2 = fight(KAI, KAI)
      place(sim2, 80)
      jumpIn(sim2, () => sim2.input(1, rel(sim2, 1, 4)))
      sim2.input(1, rel(sim2, 1, 4))
      hold(sim2, 0, 0, 12)
      assert.equal(sim2.state.f[1].hp, CHARS[KAI].hp, 'standing block holds')
    })
    test('the rising strike (→↓↘ + P) is invincible at the start and beats a jump-in', () => {
      const sim = fight(KAI, KAI)
      place(sim, 80)
      hold(sim, 0, rel(sim, 0, 9), 4)
      sim.input(0, 0)
      until(sim, (s) => s.f[0].vy < 0 && s.f[0].y < 50, 80)
      sim.input(0, Y)
      for (const [d, b] of [[6, 0], [2, 0], [3, B]]) hold(sim, 1, rel(sim, 1, d, b), 1)
      sim.input(0, 0)
      sim.input(1, 0)
      until(sim, (s) => s.f[0].act === AIRHIT, 30)
      assert.equal(sim.state.f[1].hp, CHARS[KAI].hp)
      until(sim, (s) => s.f[0].act === DOWN, 120)
    })
    test('fighters turn to face each other after crossing sides', () => {
      const sim = fight(KAI, KAI)
      place(sim, 60)
      sim.state.f[0].x = 300
      sim.state.f[1].x = 220
      hold(sim, 0, 0, 2)
      assert.equal(sim.state.f[0].face, -1)
      assert.equal(sim.state.f[1].face, 1)
    })
  })

  describe('throws', () => {
    test('close + forward + B throws (unblockable) and knocks down', () => {
      const sim = fight(KAI, KAI)
      place(sim, 28)
      sim.input(1, rel(sim, 1, 4)) // blocking doesn't help
      hold(sim, 0, rel(sim, 0, 6, B), 1)
      assert.equal(sim.state.f[0].act, THROW)
      assert.equal(sim.state.f[0].mv, M_THROW)
      assert.equal(sim.state.f[1].act, THROWN)
      until(sim, (s) => s.f[1].act === DOWN, 120)
      assert.equal(sim.state.f[1].hp, CHARS[KAI].hp - CHARS[KAI].throwDmg)
    })
    test('B out of throw range is a heavy punch', () => {
      const sim = fight(KAI, KAI)
      place(sim, 70)
      hold(sim, 0, rel(sim, 0, 6, B), 1)
      assert.equal(sim.state.f[0].act, ATTACK)
      assert.equal(sim.state.f[0].mv, M_STHP)
    })
    test("Bruno's half-circle command throw grabs from further away", () => {
      const sim = fight(BRUNO, KAI)
      place(sim, 48)
      for (const d of [6, 3, 2, 1]) hold(sim, 0, rel(sim, 0, d), 1)
      hold(sim, 0, rel(sim, 0, 4, A), 1)
      sim.input(0, 0)
      until(sim, (s) => s.f[0].act === THROW, 10)
      until(sim, (s) => s.f[1].act === DOWN, 120)
      assert.equal(sim.state.f[1].hp, CHARS[KAI].hp - CHARS[BRUNO].moves[M_SP0].dmg)
    })
    test('a jumping opponent cannot be thrown', () => {
      const sim = fight(KAI, KAI)
      place(sim, 28)
      hold(sim, 1, UP, 6)
      hold(sim, 0, rel(sim, 0, 6, B), 1)
      assert.notEqual(sim.state.f[0].act, THROW)
    })
  })

  describe('knockdowns', () => {
    test('a sweep knocks down; the fighter is invulnerable on the ground and while waking up', () => {
      const sim = fight(KAI, KAI)
      place(sim, 40)
      hold(sim, 0, D | Y, 1)
      until(sim, (s) => s.f[1].act === AIRHIT, 30)
      until(sim, (s) => s.f[1].act === DOWN, 60)
      // Hitting a downed fighter does nothing.
      const hp = sim.state.f[1].hp
      sim.state.f[0].act = IDLE
      sim.state.f[0].x = sim.state.f[1].x - 30
      hold(sim, 0, D | X, 1)
      hold(sim, 0, 0, 14)
      assert.equal(sim.state.f[1].hp, hp)
      until(sim, (s) => s.f[1].act === IDLE, 120)
    })
  })

  describe('rounds', () => {
    test('time out: more health wins the round', () => {
      const sim = fight(KAI, KAI)
      sim.state.f[1].hp -= 100
      sim.state.timer = 3
      until(sim, (s) => s.ph === PH_END, 10)
      assert.equal(sim.state.ek, END_TIME)
      assert.equal(sim.state.rw, 0)
      assert.deepEqual(sim.state.log, [0])
    })
    test('time out with equal health is a draw round', () => {
      const sim = fight(KAI, BRUNO)
      sim.state.timer = 2
      until(sim, (s) => s.ph === PH_END, 10)
      assert.equal(sim.state.rw, -1)
      assert.deepEqual(
        sim.state.f.map((f) => f.wins),
        [0, 0],
      )
    })
    test('double KO is a draw round', () => {
      const sim = fight(KAI, KAI)
      place(sim, 40)
      sim.state.f[0].hp = 10
      sim.state.f[1].hp = 10
      // Both throw a heavy punch on the same tick: they trade.
      sim.input(0, B)
      sim.input(1, B)
      sim.step()
      sim.input(0, 0)
      sim.input(1, 0)
      until(sim, (s) => s.ph === PH_END, 30)
      assert.equal(sim.state.ek, END_DKO)
      assert.equal(sim.state.rw, -1)
    })
    test('KO ends the round; best of three ends the match', () => {
      const sim = fight(KAI, KAI)
      for (let round = 1; round <= 2; round++) {
        assert.equal(sim.state.round, round)
        place(sim, 40)
        sim.state.f[1].hp = 20
        hold(sim, 0, B, 1)
        sim.input(0, 0)
        until(sim, (s) => s.ph === PH_END, 30)
        assert.equal(sim.state.ek, END_KO)
        assert.equal(sim.state.rw, 0)
        assert.equal(fighterView(sim.state).w[0], round)
        if (round === 1) until(sim, (s) => s.ph === PH_FIGHT, 400)
      }
      until(sim, (s) => s.ph === PH_OVER, 400)
      const r = sim.result()
      assert.ok(r)
      assert.deepEqual(r.winnerSeats, [0])
      assert.match(r.summary, /Player 1 wins 2–0/)
    })
    test('draws are capped: after five rounds the match is decided (or drawn)', () => {
      const sim = fight(KAI, KAI)
      for (let n = 0; n < 5; n++) {
        sim.state.timer = 1
        until(sim, (s) => s.ph === PH_END, 5)
        if (n < 4) until(sim, (s) => s.ph === PH_FIGHT, 400)
      }
      until(sim, (s) => s.ph === PH_OVER, 400)
      assert.equal(sim.state.round, 5)
      assert.deepEqual(sim.result()?.winnerSeats, [])
      assert.match(sim.result()!.summary, /Draw/)
    })
  })

  describe('select screen', () => {
    test('times out with a random pick for whoever did not choose', () => {
      const sim = simulate(fighter, makeSeats(2, 0), 5)
      assert.equal(sim.state.ph, PH_SELECT)
      hold(sim, 0, R, 1)
      hold(sim, 0, A, 1)
      assert.ok(sim.state.f[0].locked)
      assert.ok(!sim.state.f[1].locked)
      sim.run(SELECT_TICKS + 10)
      assert.ok(sim.state.f[1].locked)
      until(sim, (s) => s.ph === PH_INTRO, 120)
      assert.equal(sim.state.f[0].ch, 1)
      assert.ok(sim.state.f[1].ch >= 0 && sim.state.f[1].ch < CHARS.length)
    })
    test('the bot picks on its own', () => {
      const sim = simulate(fighter, makeSeats(1, 1), 9)
      hold(sim, 0, A, 1)
      until(sim, (s) => s.ph === PH_INTRO, SELECT_TICKS)
    })
  })

  describe('leaving', () => {
    test('the one who stays wins', () => {
      const sim = fight(KAI, MIKA)
      sim.run(100)
      sim.leave(0)
      const r = sim.result()
      assert.ok(r)
      assert.deepEqual(r.winnerSeats, [1])
      assert.match(r.summary, /left/)
    })
    test('leaving on the select screen ends it too', () => {
      const sim = simulate(fighter, makeSeats(2, 0), 2)
      sim.leave(1)
      assert.deepEqual(sim.result()?.winnerSeats, [0])
    })
  })

  test('views stay small mid-fight', () => {
    const sim = fight(KAI, MIKA)
    sim.run(600)
    assert.ok(JSON.stringify(sim.view(null)).length < 2000)
  })
})
