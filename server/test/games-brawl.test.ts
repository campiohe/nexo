// Ring Out (shared/games/brawl): the game contract plus the fighting rules: knockback, blast zones, respawn,
// shields, platforms, the timer, bots recovering, people leaving.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { GAME_PAD } from '../../shared/protocol.ts'
import { brawl } from '../../shared/games/brawl/logic.ts'
import { COUNTDOWN_TICKS, END_TICKS, RESPAWN_DELAY, STAGES, SUDDEN_DEATH_TICKS } from '../../shared/games/brawl/data.ts'
import type { BrawlState, BrawlView, Fighter } from '../../shared/games/brawl/engine.ts'
import { checkGameContract, makeSeats, simulate, type Sim } from './helpers/gameHarness.ts'

const { UP, DOWN, LEFT, RIGHT, A, L } = GAME_PAD

/** A match of `humans` people + `bots` bots, past the countdown, on stage 0 with everyone idle on the ground. */
function fightAt(humans: number, bots = 0, seed = 1): Sim<BrawlState> {
  const sim = simulate(brawl, makeSeats(humans, bots), seed)
  sim.state.stage = 0
  sim.run(COUNTDOWN_TICKS)
  assert.equal(sim.state.ph, 'play')
  sim.state.f.forEach((f, i) => place(sim, f, STAGES[0].spawns[i]))
  return sim
}

function place(sim: Sim<BrawlState>, f: Fighter, x: number, face = 1) {
  Object.assign(f, { x, y: 0, px: x, py: 0, vx: 0, vy: 0, kx: 0, ky: 0, gnd: 0, act: 'idle', t: 0, mv: '', face, inv: 0, hitlag: 0 })
  void sim
}

/** Holds `buttons` for one tick (a fresh press), then releases. */
function tap(sim: Sim<BrawlState>, seat: number, buttons: number, after = 1) {
  sim.input(seat, buttons)
  sim.step()
  sim.input(seat, 0)
  for (let i = 1; i < after; i++) sim.step()
}

/** p0 at x=0 hits p1 standing right in front with a forward tilt; returns p1's launch speed. */
function ftiltLaunch(p1Damage: number): { speed: number; victim: Fighter } {
  const sim = fightAt(2)
  const [p0, p1] = sim.state.f
  p0.ch = p1.ch = 0
  place(sim, p0, 0, 1)
  place(sim, p1, 16, -1)
  p1.dmg = p1Damage
  sim.input(0, RIGHT | A)
  for (let i = 0; i < 12 && p1.act !== 'hurt'; i++) sim.step()
  assert.equal(p1.act, 'hurt', 'the forward tilt connects')
  return { speed: Math.hypot(p1.kx, p1.ky), victim: p1 }
}

describe('brawl (Ring Out)', () => {
  test('passes the game contract', () => {
    checkGameContract(brawl)
  })

  test('metadata: 2–4 players, bots, pad controls, 60 Hz with every other tick sent', () => {
    assert.equal(brawl.id, 'brawl')
    assert.equal(brawl.name, 'Ring Out')
    assert.equal(brawl.minPlayers, 2)
    assert.equal(brawl.maxPlayers, 4)
    assert.equal(brawl.bots, true)
    assert.equal(brawl.controls, 'pad')
    assert.equal(brawl.tickHz, 60)
    assert.equal(brawl.frameEvery, 2)
  })

  test('a countdown freezes everyone, then the fight starts', () => {
    const sim = simulate(brawl, makeSeats(2, 0), 4)
    const x = sim.state.f[0].x
    sim.input(0, RIGHT)
    sim.run(COUNTDOWN_TICKS - 1)
    assert.equal(sim.state.ph, 'cd')
    assert.equal(sim.state.f[0].x, x)
    sim.run(5)
    assert.equal(sim.state.ph, 'play')
    assert.ok(sim.state.f[0].x > x, 'runs once the fight is on')
  })

  test('damage adds up and knockback grows with damage', () => {
    const low = ftiltLaunch(0)
    const high = ftiltLaunch(120)
    assert.ok(low.victim.dmg > 0 && high.victim.dmg > 120)
    assert.ok(high.speed > low.speed * 2, `knockback ${low.speed} -> ${high.speed}`)
    assert.ok(high.victim.stun > low.victim.stun, 'hitstun grows with knockback')
  })

  test('heavier fighters fly less far', () => {
    const sim = fightAt(2)
    const [p0, p1] = sim.state.f
    const speedAgainst = (ch: number) => {
      place(sim, p0, 0, 1)
      place(sim, p1, 16, -1)
      p0.ch = 0
      p1.ch = ch
      p1.dmg = 80
      p0.bufA = -99
      sim.input(0, RIGHT | A)
      for (let i = 0; i < 12 && p1.act !== 'hurt'; i++) sim.step()
      sim.input(0, 0)
      return Math.hypot(p1.kx, p1.ky)
    }
    const light = speedAgainst(1)
    sim.run(40)
    const heavy = speedAgainst(2)
    assert.ok(light > heavy, `light ${light} > heavy ${heavy}`)
  })

  test('leaving a blast zone takes a stock; the fighter respawns invulnerable on a floating spot', () => {
    const sim = fightAt(2)
    const [p0, p1] = sim.state.f
    const blast = STAGES[0].blast
    Object.assign(p1, { x: blast.r + 4, gnd: -1, act: 'air', dmg: 77 })
    sim.step()
    assert.equal(p1.stocks, 2)
    assert.equal(p1.act, 'dead')
    const ko = (sim.view(null) as BrawlView).e.find((e) => e[1] === 5)
    assert.ok(ko, 'a KO event for the blast effect')
    sim.run(RESPAWN_DELAY + 2)
    assert.equal(p1.act, 'respawn')
    assert.equal(p1.dmg, 0)
    assert.ok(p1.y < STAGES[0].main.y - 50, 'above the stage')
    // Leave the halo: invulnerable for a while; an attack goes right through.
    sim.input(1, DOWN)
    sim.run(25)
    sim.input(1, 0)
    assert.ok(p1.inv > 0, 'invulnerable after leaving the halo')
    Object.assign(p0, { x: p1.x - 14, y: p1.y, px: p1.x - 14, py: p1.y, gnd: -1, act: 'air', face: 1, vy: p1.vy, vx: 0 })
    sim.input(0, A)
    sim.run(10)
    assert.equal(p1.dmg, 0, 'no damage while invulnerable')
    assert.notEqual(p1.act, 'hurt')
  })

  test('losing every stock is out; the last one standing wins', () => {
    const sim = fightAt(3)
    const blast = STAGES[0].blast
    for (const seat of [1, 2]) {
      const f = sim.state.f[seat]
      f.stocks = 1
      Object.assign(f, { y: blast.b + 5, gnd: -1, act: 'air' })
    }
    sim.step()
    assert.equal(sim.state.ph, 'end')
    assert.equal(sim.result(), null, '"GAME!" shows a moment first')
    sim.run(END_TICKS + 1)
    const r = sim.result()
    assert.deepEqual(r?.winnerSeats, [0])
    assert.match(r!.summary, /Player 1 wins with 3 stocks left/)
  })

  test('a shield blocks the damage (and shrinks); breaking it leaves you dizzy', () => {
    const sim = fightAt(2)
    const [p0, p1] = sim.state.f
    place(sim, p0, 0, 1)
    place(sim, p1, 16, -1)
    sim.input(1, L)
    sim.step()
    assert.equal(p1.act, 'shield')
    const before = p1.shield
    sim.input(0, RIGHT | A)
    sim.run(12)
    sim.input(0, 0)
    assert.equal(p1.dmg, 0, 'no damage through the shield')
    assert.ok(p1.shield < before - 5, 'the hit shrank the shield')
    assert.equal(p1.act, 'shield')
    // Held long enough the shield breaks on its own.
    let broke = false
    for (let i = 0; i < 600 && !broke; i++) {
      sim.step()
      broke = (p1.act as string) === 'dizzy'
    }
    assert.ok(broke)
  })

  test('a shield + direction rolls, invulnerable in the middle', () => {
    const sim = fightAt(2)
    const p1 = sim.state.f[1]
    place(sim, p1, 0, 1)
    sim.input(1, L)
    sim.step()
    sim.input(1, L | LEFT)
    sim.run(8)
    assert.equal(p1.act, 'roll')
    assert.ok((sim.view(null) as BrawlView).f[1][7] & 1, 'intangible flag')
    sim.input(1, 0)
    sim.run(30)
    assert.ok(p1.x < -40, `rolled left (x=${p1.x})`)
  })

  test('pass-through platforms: jump up through, land on top, drop down with Down', () => {
    const sim = fightAt(2)
    const p0 = sim.state.f[0]
    const plat = STAGES[0].plats[0]
    place(sim, p0, (plat.l + plat.r) / 2)
    tap(sim, 0, UP | GAME_PAD.X)
    sim.input(0, GAME_PAD.X)
    let above = false
    for (let i = 0; i < 80; i++) {
      sim.step()
      if (p0.y < plat.y - 5) above = true
      if (above && p0.gnd > 0) break
    }
    sim.input(0, 0)
    assert.ok(above, 'went up through the platform')
    assert.equal(p0.gnd, 1, 'standing on the platform')
    assert.equal(p0.y, plat.y)
    sim.run(10)
    sim.input(0, DOWN)
    sim.run(6)
    assert.equal(p0.gnd, -1, 'dropped through')
    sim.input(0, 0)
    sim.run(60)
    assert.equal(p0.gnd, 0, 'back on the main platform')
  })

  test('jumps: a double jump in the air, then no more', () => {
    const sim = fightAt(2)
    const p0 = sim.state.f[0]
    place(sim, p0, 0)
    tap(sim, 0, GAME_PAD.X, 10)
    assert.equal(p0.act, 'air')
    tap(sim, 0, GAME_PAD.X, 2)
    assert.equal(p0.jumps, 0)
    assert.ok(p0.vy < 0, 'rising again')
    const vy = p0.vy
    tap(sim, 0, GAME_PAD.X, 2)
    assert.ok(p0.vy > vy, 'no third jump')
  })

  test('a press shortly before an attack ends still comes out (input buffer)', () => {
    const sim = fightAt(2)
    const p0 = sim.state.f[0]
    place(sim, p0, 0)
    tap(sim, 0, A, 12) // jab: 16 ticks; press again 4 ticks before it ends
    assert.equal(p0.mv, 'jab')
    tap(sim, 0, RIGHT | A)
    for (let i = 0; i < 12 && (p0.mv as string) !== 'ftilt'; i++) sim.step()
    assert.equal(p0.mv as string, 'ftilt')
  })

  test('falling next to the stage grabs the ledge; toward the stage climbs up', () => {
    const sim = fightAt(2)
    const p0 = sim.state.f[0]
    const main = STAGES[0].main
    Object.assign(p0, { x: main.r + 10, y: main.y + 2, gnd: -1, act: 'air', vy: 1, vx: 0 })
    sim.run(4)
    assert.equal(p0.act, 'ledge')
    assert.ok(p0.inv > 0, 'ledge invulnerability')
    sim.input(0, LEFT)
    sim.run(40)
    sim.input(0, 0)
    assert.equal(p0.gnd, 0)
    assert.ok(p0.x < main.r)
  })

  test('time-out: most stocks wins, then lowest damage; a full tie goes to sudden death, then a draw', () => {
    const timeout = (setup: (f: Fighter[]) => void) => {
      const sim = fightAt(3)
      setup(sim.state.f)
      sim.state.timer = 1
      sim.step()
      return sim
    }
    let sim = timeout((f) => {
      f[0].stocks = 1
      f[1].stocks = 2
      f[2].stocks = 1
    })
    sim.run(END_TICKS + 2)
    assert.deepEqual(sim.result()?.winnerSeats, [1])

    sim = timeout((f) => {
      f[0].dmg = 80
      f[1].dmg = 40
      f[2].dmg = 30.5
    })
    sim.run(END_TICKS + 2)
    assert.deepEqual(sim.result()?.winnerSeats, [2])

    sim = timeout((f) => {
      f[0].dmg = 20
      f[1].dmg = 20.4
      f[2].dmg = 90
    })
    assert.equal(sim.state.sd, true)
    assert.equal(sim.state.ph, 'cd')
    assert.deepEqual(
      sim.state.f.map((f) => f.stocks),
      [1, 1, 0],
    )
    assert.equal(sim.state.f[0].dmg, 150)
    sim.run(COUNTDOWN_TICKS + 2)
    assert.equal(sim.state.ph, 'play')
    sim.state.timer = 1
    sim.step()
    sim.run(END_TICKS + 2)
    assert.deepEqual(sim.result()?.winnerSeats, [], 'sudden death ran out tied: a draw')
    assert.match(sim.result()!.summary, /draw/)
  })

  test('the 4-minute timer always ends a match of idle people', () => {
    const sim = simulate(brawl, makeSeats(4, 0), 2)
    const r = sim.run(60 * 60 * 6)
    assert.ok(r, 'ended')
    assert.deepEqual(r.winnerSeats, [], 'everyone untouched: sudden death, then a draw')
  })

  test('bots get back to the stage from off it', () => {
    const main = STAGES[0].main
    const spots: [number, number][] = [
      [main.r + 70, -10],
      [main.l - 70, -10],
      [main.r + 40, 40],
      [main.l - 30, 50],
      [main.r + 110, -60],
      [0, main.y + main.d + 20],
    ]
    for (const [seed, [x, y]] of spots.entries()) {
      const sim = fightAt(1, 1, seed + 1)
      const [p0, bot] = sim.state.f
      place(sim, p0, main.l + 20)
      Object.assign(bot, { x, y, px: x, py: y, gnd: -1, act: 'air', vx: 0, vy: 1, jumps: 1, ch: seed % 3 })
      for (let i = 0; i < 300 && !(bot.gnd === 0 || bot.act === 'ledge'); i++) sim.step()
      assert.equal(bot.stocks, 3, `bot from (${x}, ${y}) survived`)
      assert.ok(bot.gnd === 0 || bot.act === 'ledge', `bot from (${x}, ${y}) made it back (${bot.act} at ${bot.x.toFixed(0)}, ${bot.y.toFixed(0)})`)
    }
  })

  test("bots fight each other without throwing themselves off the stage", () => {
    let falls = 0
    let selfDestructs = 0
    for (let seed = 1; seed <= 6; seed++) {
      const sim = simulate(brawl, makeSeats(0, 4), seed)
      const r = sim.run(60 * 60 * 6)
      assert.ok(r && r.winnerSeats.length === 1, 'a bot wins')
      for (const f of sim.state.f) {
        falls += f.falls
        selfDestructs += f.sds
      }
    }
    assert.ok(falls > 30, 'they knock each other out')
    assert.ok(selfDestructs <= falls * 0.1, `${selfDestructs} self-destructs of ${falls} stocks lost`)
  })

  test('people leaving: they are out; the last one left wins; a held fighter is let go', () => {
    const sim = fightAt(3)
    const [p0, p1, p2] = sim.state.f
    place(sim, p0, 0, 1)
    place(sim, p1, 16, -1)
    sim.input(0, L | A)
    for (let i = 0; i < 12 && p1.act !== 'held'; i++) sim.step()
    sim.input(0, 0)
    assert.equal(p1.act, 'held')
    sim.leave(0)
    assert.notEqual(p1.act, 'held', 'let go when the grabber leaves')
    assert.equal(sim.result(), null)
    assert.equal((sim.view(null) as BrawlView).f[0][7] & 8, 8, 'shown as out')
    sim.leave(2)
    assert.equal(p2.stocks, 0)
    const r = sim.run(END_TICKS + 2)
    assert.deepEqual(r?.winnerSeats, [1])
  })

  test('views are compact', () => {
    const sim = simulate(brawl, makeSeats(1, 3), 9)
    let max = 0
    sim.run(60 * 60, (s) => {
      if (s.tick % 2 === 0) max = Math.max(max, JSON.stringify(s.view(null)).length)
    })
    assert.ok(max < 3000, `largest frame ${max} bytes`)
  })
})
