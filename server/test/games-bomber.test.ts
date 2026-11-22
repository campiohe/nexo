// Blast Arena (shared/games/bomber): the framework contract plus focused rule tests on hand-made arenas.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { GAME_PAD } from '../../shared/protocol.ts'
import { bomber } from '../../shared/games/bomber/logic.ts'
import {
  BREAK_T,
  END_T,
  FIRE_T,
  FUSE,
  H,
  I_BOMB,
  I_NONE,
  I_RANGE,
  INTRO_T,
  PH_END,
  PH_INTRO,
  PH_OVER,
  PH_PLAY,
  PH_RESULT,
  RESULT_T,
  SPAWNS,
  SPIRAL,
  T_BLOCK,
  T_BREAK,
  T_CRATE,
  T_FLOOR,
  T_PILLAR,
  W,
  centerOf,
  idx,
  isPillar,
  tileOf,
  type BomberState,
} from '../../shared/games/bomber/core.ts'
import { assertViewOk, checkGameContract, makeSeats, simulate, type Sim } from './helpers/gameHarness.ts'

/** A match of `humans` people (+ bots) skipped past the intro, on an arena without crates. */
function arena(humans = 2, bots = 0, seed = 1): Sim<BomberState> {
  const sim = simulate(bomber, makeSeats(humans, bots), seed)
  const s = sim.state
  for (let c = 0; c < W * H; c++) {
    if (s.grid[c] === T_CRATE) s.grid[c] = T_FLOOR
    s.hidden[c] = I_NONE
  }
  s.phase = PH_PLAY
  s.phaseT = 0
  return sim
}

function put(s: BomberState, seat: number, x: number, y: number) {
  s.players[seat].x = centerOf(x)
  s.players[seat].y = centerOf(y)
}

function bomb(s: BomberState, x: number, y: number, fuse: number, range: number, owner = 0) {
  s.bombs.push({ id: s.nextBomb++, x: centerOf(x), y: centerOf(y), owner, fuse, range, dx: 0, dy: 0, pass: 0 })
}

/** Holds `buttons` for seat 0 for n ticks. */
function hold(sim: Sim<BomberState>, buttons: number, n: number, seat = 0) {
  for (let i = 0; i < n; i++) {
    sim.input(seat, buttons)
    sim.step()
  }
}

describe('Blast Arena (bomber)', () => {
  test('passes the game contract', () => {
    checkGameContract(bomber)
  })

  test('arena: border, pillars, clear spawn corners, hidden items', () => {
    const sim = simulate(bomber, makeSeats(4, 0), 5)
    const s = sim.state
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) assert.equal(s.grid[idx(x, y)] === T_PILLAR, isPillar(x, y))
    for (const [x, y] of SPAWNS) {
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!isPillar(x + dx, y + dy)) assert.equal(s.grid[idx(x + dx, y + dy)], T_FLOOR)
      }
    }
    assert.ok(s.hidden.filter((h) => h !== I_NONE).length >= 20)
    s.players.forEach((p, i) => assert.equal(tileOf(p), idx(SPAWNS[i][0], SPAWNS[i][1])))
    assert.equal(s.phase, PH_INTRO)
    assert.equal(s.winsNeeded, 2)
    assert.equal(simulate(bomber, makeSeats(2, 0)).state.winsNeeded, 3)
  })

  test('intro: nobody moves until GO', () => {
    const sim = simulate(bomber, makeSeats(2, 0))
    const x0 = sim.state.players[0].x
    hold(sim, GAME_PAD.RIGHT, INTRO_T - 1)
    assert.equal(sim.state.players[0].x, x0)
    hold(sim, GAME_PAD.RIGHT, 3)
    assert.equal(sim.state.phase, PH_PLAY)
    assert.ok(sim.state.players[0].x > x0)
  })

  test('A drops a bomb on your tile; you can walk off it but not back on', () => {
    const sim = arena()
    const s = sim.state
    put(s, 0, 1, 1)
    put(s, 1, 13, 11)
    hold(sim, GAME_PAD.A, 1)
    assert.equal(s.bombs.length, 1)
    assert.equal(tileOf(s.bombs[0]), idx(1, 1))
    hold(sim, 0, 1)
    hold(sim, GAME_PAD.A, 1) // max 1 bomb
    assert.equal(s.bombs.length, 1)
    hold(sim, GAME_PAD.RIGHT, 8)
    assert.equal(tileOf(s.players[0]), idx(2, 1))
    hold(sim, GAME_PAD.LEFT, 12)
    assert.ok(s.players[0].x >= centerOf(2), 'blocked by the bomb once off it')
  })

  test('a held A press is buffered for a few ticks', () => {
    const sim = arena()
    const s = sim.state
    put(s, 0, 5, 5)
    put(s, 1, 13, 11)
    bomb(s, 1, 9, 2, 1, 0) // seat 0's only bomb, about to go off far away
    sim.input(0, GAME_PAD.A)
    sim.step()
    assert.equal(s.bombs.filter((b) => b.owner === 0 && tileOf(b) === idx(5, 5)).length, 0)
    hold(sim, GAME_PAD.A, 3)
    assert.equal(s.bombs.filter((b) => tileOf(b) === idx(5, 5)).length, 1)
  })

  test('blasts are cross-shaped, stop at pillars and last FIRE_T ticks', () => {
    const sim = arena()
    const s = sim.state
    put(s, 0, 13, 11)
    put(s, 1, 13, 9)
    bomb(s, 3, 1, 1, 3)
    sim.step()
    assert.equal(s.bombs.length, 0)
    for (const [x, y] of [[3, 1], [1, 1], [2, 1], [4, 1], [5, 1], [6, 1], [3, 2], [3, 3], [3, 4]]) {
      assert.ok(s.fire[idx(x, y)] > 0, `fire at ${x},${y}`)
    }
    assert.equal(s.fire[idx(7, 1)], 0)
    assert.equal(s.fire[idx(3, 5)], 0)
    // Pillars stop blasts: a bomb at (2,1) reaches nothing below (2,2).
    bomb(s, 2, 3, 1, 3)
    sim.step()
    assert.equal(s.fire[idx(2, 2)], 0)
    assert.equal(s.fire[idx(2, 4)], 0)
    assert.ok(s.fire[idx(4, 3)] > 0)
    hold(sim, 0, FIRE_T)
    assert.ok(s.fire.every((f) => f === 0))
  })

  test('a blast breaks the first crate only; the crate drops its hidden item', () => {
    const sim = arena()
    const s = sim.state
    put(s, 0, 13, 11)
    put(s, 1, 13, 9)
    s.grid[idx(5, 1)] = T_CRATE
    s.grid[idx(6, 1)] = T_CRATE
    s.hidden[idx(5, 1)] = I_RANGE
    bomb(s, 3, 1, 1, 5)
    sim.step()
    assert.equal(s.grid[idx(5, 1)], T_BREAK)
    assert.equal(s.grid[idx(6, 1)], T_CRATE)
    assert.equal(s.fire[idx(5, 1)], 0)
    hold(sim, 0, BREAK_T)
    assert.equal(s.grid[idx(5, 1)], T_FLOOR)
    assert.equal(s.items[idx(5, 1)], I_RANGE)
    // Walking over it picks it up.
    put(s, 0, 5, 1)
    const range = s.players[0].range
    sim.step()
    assert.equal(s.players[0].range, range + 1)
    assert.equal(s.items[idx(5, 1)], I_NONE)
  })

  test('blasts destroy items in their way', () => {
    const sim = arena()
    const s = sim.state
    put(s, 0, 13, 11)
    put(s, 1, 13, 9)
    s.items[idx(5, 1)] = I_BOMB
    bomb(s, 3, 1, 1, 4)
    sim.step()
    assert.equal(s.items[idx(5, 1)], I_NONE)
    assert.equal(s.fire[idx(6, 1)], 0, 'the item absorbed the blast')
  })

  test('chain reaction: a blast sets off the bombs it reaches in the same tick', () => {
    const sim = arena()
    const s = sim.state
    put(s, 0, 13, 11)
    put(s, 1, 13, 9)
    bomb(s, 1, 1, 1, 4)
    bomb(s, 5, 1, FUSE, 2)
    bomb(s, 5, 3, FUSE, 1)
    sim.step()
    assert.equal(s.bombs.length, 0)
    assert.ok(s.fire[idx(7, 1)] > 0)
    assert.ok(s.fire[idx(6, 3)] > 0)
  })

  test('players in a blast die; the last one standing wins the round', () => {
    const sim = arena()
    const s = sim.state
    put(s, 0, 13, 11)
    put(s, 1, 3, 1)
    bomb(s, 1, 1, 1, 3)
    sim.step()
    assert.equal(s.players[1].alive, false)
    assert.equal(s.players[0].alive, true)
    assert.equal(s.phase, PH_END)
    hold(sim, 0, END_T)
    assert.equal(s.phase, PH_RESULT)
    assert.equal(s.roundWinner, 0)
    assert.equal(s.players[0].wins, 1)
    hold(sim, 0, RESULT_T)
    assert.equal(s.phase, PH_INTRO)
    assert.equal(s.round, 2)
    assert.ok(s.players.every((p) => p.alive && p.range === 2 && p.bombs === 1))
  })

  test('everyone caught at once: a draw', () => {
    const sim = arena(3)
    const s = sim.state
    put(s, 0, 1, 1)
    put(s, 1, 3, 1)
    put(s, 2, 13, 11)
    bomb(s, 2, 1, 1, 2)
    sim.step()
    assert.equal(s.phase, PH_END)
    // The survivor dies before the end wait is over: still a draw.
    bomb(s, 13, 10, 1, 1)
    sim.step()
    hold(sim, 0, END_T)
    assert.equal(s.roundWinner, -1)
    assert.ok(s.players.every((p) => p.wins === 0))
  })

  test('the match ends when someone reaches the wins needed', () => {
    const sim = arena()
    const s = sim.state
    s.players[0].wins = 2
    put(s, 0, 13, 11)
    put(s, 1, 3, 1)
    bomb(s, 1, 1, 1, 3)
    hold(sim, 0, 1 + END_T)
    assert.deepEqual(s.matchWinners, [0])
    assert.equal(sim.result(), null, 'the round result shows first')
    hold(sim, 0, RESULT_T)
    assert.equal(s.phase, PH_OVER)
    assert.deepEqual(sim.result(), { winnerSeats: [0], summary: 'Player 1 wins 3–0' })
  })

  test('shield absorbs one blast', () => {
    const sim = arena()
    const s = sim.state
    put(s, 0, 13, 11)
    put(s, 1, 3, 1)
    s.players[1].shield = true
    bomb(s, 1, 1, 1, 3)
    sim.step()
    assert.equal(s.players[1].alive, true)
    assert.equal(s.players[1].shield, false)
    hold(sim, 0, FIRE_T + 30)
    bomb(s, 1, 1, 1, 3)
    sim.step()
    assert.equal(s.players[1].alive, false)
  })

  test('kick: walking into a bomb sends it sliding until something stops it', () => {
    const sim = arena()
    const s = sim.state
    put(s, 0, 1, 1)
    put(s, 1, 13, 11)
    s.grid[idx(9, 1)] = T_CRATE
    bomb(s, 2, 1, FUSE, 1, 1)
    hold(sim, GAME_PAD.RIGHT, 3)
    assert.equal(s.bombs[0].dx, 0, 'no kick without the power-up')
    assert.equal(tileOf(s.players[0]), idx(1, 1))
    s.players[0].kick = true
    hold(sim, GAME_PAD.RIGHT, 1)
    assert.equal(s.bombs[0].dx, 1)
    hold(sim, 0, 40)
    assert.equal(s.bombs[0].dx, 0)
    assert.equal(s.bombs[0].x, centerOf(8))
    assert.equal(s.bombs[0].y, centerOf(1))
  })

  test('trigger: B sets off your oldest bomb', () => {
    const sim = arena()
    const s = sim.state
    put(s, 0, 13, 11)
    put(s, 1, 13, 9)
    bomb(s, 1, 1, FUSE, 1, 0)
    bomb(s, 5, 5, FUSE, 1, 0)
    hold(sim, GAME_PAD.B, 1)
    assert.equal(s.bombs.length, 2, 'nothing without the power-up')
    hold(sim, 0, 1)
    s.players[0].trigger = true
    hold(sim, GAME_PAD.B, 1)
    assert.equal(s.bombs.length, 1)
    assert.equal(tileOf(s.bombs[0]), idx(5, 5))
  })

  test('corner sliding: pressing into a wall next to a corridor nudges you into it', () => {
    const sim = arena()
    const s = sim.state
    put(s, 1, 13, 11)
    // In tile (2,1) but 12 units toward column 3; below (2,1) is a pillar, below (3,1) a corridor.
    s.players[0].x = centerOf(2) + 12
    s.players[0].y = centerOf(1)
    hold(sim, GAME_PAD.DOWN, 2)
    assert.ok(s.players[0].x > centerOf(2) + 12)
    hold(sim, GAME_PAD.DOWN, 6)
    assert.equal(s.players[0].x, centerOf(3))
    assert.ok(s.players[0].y > centerOf(1))
    // Off-center in an open lane: straightens up while moving on.
    s.players[0].x = centerOf(5)
    s.players[0].y = centerOf(3) + 10
    hold(sim, GAME_PAD.RIGHT, 3)
    assert.equal(s.players[0].y, centerOf(3))
    assert.ok(s.players[0].x > centerOf(5))
  })

  test('sudden death: blocks fall in a spiral and the round always ends', () => {
    const sim = arena()
    const s = sim.state
    put(s, 0, 7, 5)
    put(s, 1, 7, 7)
    s.timeLeft = 1
    sim.step()
    assert.equal(s.sdT, 0)
    let ticks = 0
    while (s.phase !== PH_RESULT && ticks < SPIRAL.length * 3 + 200) {
      sim.step()
      ticks++
    }
    assert.equal(s.phase, PH_RESULT)
    assert.equal(s.grid[SPIRAL[0]], T_BLOCK)
    assert.ok(s.players.some((p) => !p.alive))
  })

  test("a bot doesn't blow itself up next to an idle player", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const sim = simulate(bomber, makeSeats(1, 1), seed)
      const s = sim.state
      let botDied = false
      for (let n = 0; n < 20 * 120 && s.round === 1 && s.phase !== PH_RESULT; n++) {
        sim.step()
        if (!s.players[1].alive && s.players[0].alive) botDied = true
      }
      assert.equal(botDied, false, `seed ${seed}`)
      assert.ok(!s.players[0].alive, `seed ${seed}: the bot should get the idle player within the round`)
    }
  })

  test('leaving: out for good; the last person left wins the match', () => {
    const sim = arena(3)
    const s = sim.state
    sim.leave(2)
    assert.equal(s.players[2].alive, false)
    assert.equal(s.phase, PH_PLAY)
    assertViewOk(sim.view(null), 'after a leave')
    sim.leave(1)
    assert.equal(s.phase, PH_OVER)
    assert.deepEqual(sim.result()?.winnerSeats, [0])
  })

  test('leaving between rounds: the next round starts without them', () => {
    const sim = arena(3)
    const s = sim.state
    sim.leave(2)
    put(s, 0, 13, 11)
    put(s, 1, 3, 1)
    bomb(s, 1, 1, 1, 3)
    hold(sim, 0, 1 + END_T + RESULT_T)
    assert.equal(s.round, 2)
    assert.equal(s.players[2].alive, false)
    assert.equal(s.players[2].gone, true)
    assert.ok(s.players[0].alive && s.players[1].alive)
  })

  test('views are compact', () => {
    const sim = simulate(bomber, makeSeats(1, 3), 3)
    sim.run(20 * 40)
    const v = sim.view(null)
    assertViewOk(v, 'bomber')
    assert.ok(JSON.stringify(v).length < 4000, `view is ${JSON.stringify(v).length} bytes`)
  })
})
