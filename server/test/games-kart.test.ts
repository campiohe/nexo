// Kart Rally (shared/games/kart): the game contract plus race rules — checkpoints, off-road, items, finish
// order, end conditions, bots finishing on every track, people leaving.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { GAME_PAD } from '../../shared/protocol.ts'
import { kart, lapOf, pickItem } from '../../shared/games/kart/logic.ts'
import type { KartState, KartView } from '../../shared/games/kart/logic.ts'
import { botButtons } from '../../shared/games/kart/bot.ts'
import { buildTrack, CHECKPOINTS, OFF_W, pointAt, trackCount } from '../../shared/games/kart/track.ts'
import {
  AFTER_FIRST,
  CHARGE_1,
  COUNTDOWN,
  EV_FINAL,
  EV_FINISH,
  EV_HIT,
  EV_LAP,
  EV_SHIELD_POP,
  ITEM_BOLT,
  ITEM_NITRO,
  ITEM_NITRO3,
  ITEM_NONE,
  ITEM_SEEKER,
  ITEM_SHIELD,
  ITEM_SLICK,
  LAPS,
  OFF_SPEED,
  OVER_HOLD,
  RACE_CAP,
  ROLL_TICKS,
  VMAX,
} from '../../shared/games/kart/model.ts'
import { assertViewOk, checkGameContract, makeSeats, simulate, type Sim } from './helpers/gameHarness.ts'

const P = GAME_PAD

/** A sim on track `track` (the track is picked by the seed: try seeds until it matches). */
function simOn(track: number, humans: number, bots: number): Sim<KartState> {
  for (let seed = 1; seed < 500; seed++) {
    const sim = simulate(kart, makeSeats(humans, bots), seed)
    if (sim.state.track === track) return sim
  }
  throw new Error(`no seed for track ${track}`)
}

function skipCountdown(sim: Sim<KartState>) {
  while (sim.state.phase === 0) sim.step()
}

/** Moves kart `i` to arc length `s`, `lat` units right of the centerline, facing along the track (a jump: the race tracking isn't told). */
function teleport(sim: Sim<KartState>, i: number, s: number, lat = 0, v = 0) {
  const t = buildTrack(sim.state.track)
  const p = pointAt(t, s, lat)
  const k = sim.state.karts[i]
  k.x = p.x
  k.y = p.y
  k.a = k.m = Math.atan2(p.dy, p.dx)
  k.v = v
  k.px = k.py = 0
}

/** Puts kart `i` there on lap 1 as if it had driven there (checkpoints up to there passed). */
function place(sim: Sim<KartState>, i: number, s: number, lat = 0, v = 0) {
  const t = buildTrack(sim.state.track)
  teleport(sim, i, s, lat, v)
  const k = sim.state.karts[i]
  const p = pointAt(t, s, lat)
  k.seg = p.k
  k.s = ((s % t.total) + t.total) % t.total
  k.u = k.s
  k.passed = t.cpS.filter((c) => c <= k.s).length
}

/** Parks every other kart far away from the action (on the opposite side of the loop). */
function parkOthers(sim: Sim<KartState>, keep: number[], s: number) {
  const t = buildTrack(sim.state.track)
  sim.state.karts.forEach((_, i) => {
    if (!keep.includes(i)) place(sim, i, s + t.total / 2, 0)
  })
}

/** Drives person seat `i` with the bot's own driving (no items) every tick. */
function autopilot(sim: Sim<KartState>, i: number) {
  sim.input(i, botButtons(sim.state, i, sim.ctx) & ~(P.X | P.Y))
}

function events(sim: Sim<KartState>, e: number, seat?: number) {
  return sim.state.events.filter((x) => x.e === e && (seat === undefined || x.s === seat))
}

describe('kart', () => {
  test('passes the game contract', () => {
    checkGameContract(kart)
  })

  test('a person driving well completes 3 laps through every checkpoint and finishes', () => {
    const sim = simOn(0, 1, 0)
    const seen = new Set<number>()
    const laps: number[] = []
    let finals = 0
    let finish = 0
    sim.run(20000, (s) => {
      autopilot(s, 0)
      for (const e of s.state.events) {
        if (seen.has(e.id)) continue
        seen.add(e.id)
        if (e.e === EV_LAP) laps.push(e.v)
        if (e.e === EV_FINAL) finals++
        if (e.e === EV_FINISH) finish++
      }
    })
    const k = sim.state.karts[0]
    assert.ok(k.fin > 0, 'finished')
    assert.equal(k.passed, LAPS * CHECKPOINTS + 1)
    assert.deepEqual(laps, [2])
    assert.equal(finals, 1)
    assert.equal(finish, 1)
    const r = sim.result()
    assert.ok(r)
    assert.deepEqual(r.winnerSeats, [0])
    assert.match(r.summary, /^Player 1 wins · \d:\d\d\.\d$/)
  })

  test('checkpoints cannot be skipped: jumping ahead to the finish line does not count a lap', () => {
    const sim = simOn(0, 1, 0)
    const t = buildTrack(0)
    skipCountdown(sim)
    while (sim.state.karts[0].passed < 3) {
      autopilot(sim, 0)
      sim.step()
    }
    // Cut across to just before the line and drive over it.
    teleport(sim, 0, t.total - 40, 0, 80)
    for (let n = 0; n < 60; n++) {
      sim.input(0, P.A)
      sim.step()
    }
    const k = sim.state.karts[0]
    assert.ok(k.s < t.total / 4, 'drove over the line')
    assert.equal(lapOf(k), 1, 'still lap 1')
    assert.ok(k.passed <= 3, 'no checkpoint counted after the cut')
    assert.equal(events(sim, EV_LAP).length, 0)
  })

  test('driving backwards over a checkpoint takes it back', () => {
    const sim = simOn(1, 1, 0)
    skipCountdown(sim)
    while (sim.state.karts[0].passed < 2) {
      autopilot(sim, 0)
      sim.step()
    }
    const passed = sim.state.karts[0].passed
    const t = buildTrack(1)
    const k = sim.state.karts[0]
    place(sim, 0, t.cpS[passed - 1] + 6, 0, 0)
    k.a = k.m = k.a + Math.PI
    for (let n = 0; n < 40; n++) {
      sim.input(0, P.A)
      sim.step()
    }
    assert.equal(sim.state.karts[0].passed, passed - 1)
  })

  test('off-road slows the kart down', () => {
    const sim = simOn(0, 2, 0)
    const t = buildTrack(0)
    skipCountdown(sim)
    const hw = pointAt(t, 30, 0).w
    place(sim, 0, 30, -hw * 0.3, VMAX)
    place(sim, 1, 30, -(hw + OFF_W / 2), VMAX)
    for (let n = 0; n < 45; n++) {
      sim.input(0, P.A)
      sim.input(1, P.A)
      sim.step()
    }
    const [road, off] = sim.state.karts
    assert.equal(road.off, false)
    assert.equal(off.off, true)
    assert.ok(road.v > VMAX * 0.95, `road speed ${road.v}`)
    assert.ok(off.v <= VMAX * OFF_SPEED + 1, `off-road speed ${off.v}`)
  })

  test('walls keep karts on the track', () => {
    const sim = simOn(2, 1, 0)
    const t = buildTrack(2)
    skipCountdown(sim)
    place(sim, 0, 200, 0, VMAX)
    let worst = -Infinity
    for (let n = 0; n < 300; n++) {
      sim.input(0, P.A | P.RIGHT)
      sim.step()
      const k = sim.state.karts[0]
      worst = Math.max(worst, Math.abs(k.lat) - pointAt(t, k.s, 0).w)
    }
    assert.ok(worst <= OFF_W + 0.5, `went ${worst} past the road edge`)
  })

  test('a held drift charges a mini-turbo released as a boost', () => {
    const sim = simOn(0, 1, 0)
    skipCountdown(sim)
    // The start straight; hop right, then hold the drift while steering out of it (a wide arc).
    place(sim, 0, 20, -25, VMAX)
    const k = sim.state.karts[0]
    let maxCharge = 0
    for (let n = 0; n < 62; n++) {
      sim.input(0, P.A | P.R | (n < 2 ? P.RIGHT : n < 10 ? 0 : P.LEFT))
      sim.step()
      if (n > 12) assert.equal(k.drift, 1, `drifting right at ${n}`)
      maxCharge = Math.max(maxCharge, k.charge)
    }
    assert.ok(maxCharge >= CHARGE_1, `charge ${maxCharge}`)
    assert.equal(k.boost, 0)
    sim.input(0, P.A)
    sim.step()
    assert.equal(k.drift, 0)
    assert.ok(k.boost > 0, 'mini-turbo')
  })

  test('items: nitro, bolt, shield, oil slick and seeker', () => {
    const sim = simOn(0, 2, 0)
    skipCountdown(sim)
    const [a, b] = sim.state.karts
    // Nitro: faster than top speed.
    place(sim, 0, 100, 0, VMAX)
    place(sim, 1, 100 + 1000, 0, 0)
    a.item = ITEM_NITRO
    a.uses = 1
    sim.input(0, P.A | P.X)
    sim.step()
    assert.equal(a.item, ITEM_NONE)
    for (let n = 0; n < 15; n++) {
      sim.input(0, P.A)
      sim.step()
    }
    assert.ok(a.v > VMAX * 1.2, `boosted ${a.v}`)

    // Bolt: hits the kart ahead.
    place(sim, 0, 40, 0, 0)
    place(sim, 1, 120, 0, 0)
    a.item = ITEM_BOLT
    a.uses = 1
    sim.input(0, 0)
    sim.step()
    sim.input(0, P.X)
    sim.step()
    for (let n = 0; n < 30 && b.spin === 0; n++) sim.step()
    assert.ok(b.spin > 0, 'bolt hit')
    assert.ok(events(sim, EV_HIT, 1).length > 0)

    // Shield: absorbs a bolt.
    while (b.spin > 0 || b.inv > 0) sim.step()
    place(sim, 0, 40, 0, 0)
    place(sim, 1, 120, 0, 0)
    b.item = ITEM_SHIELD
    b.uses = 1
    sim.input(1, P.X)
    sim.step()
    assert.ok(b.shield > 0)
    a.item = ITEM_BOLT
    a.uses = 1
    sim.input(0, 0)
    sim.step()
    sim.input(0, P.X)
    sim.step()
    for (let n = 0; n < 30 && b.shield > 0; n++) sim.step()
    assert.equal(b.shield, 0, 'shield popped')
    assert.equal(b.spin, 0, 'no spin through a shield')
    assert.ok(events(sim, EV_SHIELD_POP, 1).length > 0)

    // Oil slick: dropped behind, spins the kart driving over it.
    sim.input(1, 0)
    place(sim, 0, 300, 0, 0)
    place(sim, 1, 230, 0, 60)
    a.item = ITEM_SLICK
    a.uses = 1
    sim.input(0, 0)
    sim.step()
    sim.input(0, P.X)
    sim.step()
    assert.equal(sim.state.objs.filter((o) => o.type === 1).length, 1)
    for (let n = 0; n < 60 && b.spin === 0; n++) {
      sim.input(1, P.A)
      sim.step()
    }
    assert.ok(b.spin > 0, 'slick spun the kart')
    assert.equal(sim.state.objs.length, 0)

    // Seeker: chases the kart one place ahead.
    while (b.spin > 0 || b.inv > 0) sim.step()
    place(sim, 0, 300, 0, 0)
    place(sim, 1, 700, 0, 0)
    sim.input(0, 0)
    sim.input(1, 0)
    sim.step()
    assert.equal(b.rank, 1)
    a.item = ITEM_SEEKER
    a.uses = 1
    sim.input(0, P.X)
    sim.step()
    assert.equal(sim.state.objs[0]?.target, 1)
    for (let n = 0; n < 200 && b.spin === 0; n++) sim.step()
    assert.ok(b.spin > 0, 'seeker hit its target')
  })

  test('item boxes give an item after the roulette, better ones for karts at the back', () => {
    const sim = simOn(0, 2, 0)
    const t = buildTrack(0)
    skipCountdown(sim)
    parkOthers(sim, [0], 0)
    const k = sim.state.karts[0]
    const s0 = t.def.boxes[0] * t.total
    place(sim, 0, s0 - 20, -0.62 * pointAt(t, s0, 0).w, 40)
    for (let n = 0; n < 30 && k.roll === 0; n++) {
      sim.input(0, P.A)
      sim.step()
    }
    assert.ok(k.roll > 0, 'rolling')
    assert.ok(sim.state.boxes[0] > 0, 'the box is gone for a while')
    for (let n = 0; n <= ROLL_TICKS; n++) sim.step()
    assert.notEqual(k.item, ITEM_NONE)

    const count = (rank: number) => {
      const c = new Array(7).fill(0)
      for (let n = 0; n < 1000; n++) c[pickItem(rank, 8, n / 1000)]++
      return c
    }
    const first = count(1)
    const last = count(8)
    assert.equal(first[ITEM_SEEKER] + first[ITEM_NITRO3], 0, 'no seeker / triple nitro for the leader')
    assert.ok(last[ITEM_SEEKER] + last[ITEM_NITRO3] > 500, 'mostly strong items at the back')
    assert.equal(last[ITEM_SLICK], 0)
  })

  test('finish order decides the result; the race ends when every person has finished', () => {
    const sim = simOn(1, 2, 2)
    const finishes: number[] = []
    sim.run(20000, (s) => {
      autopilot(s, 0)
      autopilot(s, 1)
      for (const e of s.state.events) if (e.e === EV_FINISH && !finishes.includes(e.s)) finishes.push(e.s)
    })
    const r = sim.result()
    assert.ok(r)
    const st = sim.state
    const people = [0, 1].map((i) => st.karts[i])
    assert.ok(people.every((k) => k.fin >= 0), 'both people finished')
    assert.equal(r.winnerSeats[0], st.order[0])
    assert.equal(r.winnerSeats[0], finishes[0])
    // The finished karts lead the order, sorted by time.
    const fins = st.order.filter((i) => st.karts[i].fin >= 0).map((i) => st.karts[i].fin)
    assert.deepEqual(fins, [...fins].sort((x, y) => x - y))
    assert.deepEqual(st.order.slice(0, fins.length).sort(), st.karts.flatMap((k, i) => (k.fin >= 0 ? [i] : [])).sort())
    // It ended right after the last person crossed the line (plus the standings hold).
    const lastPerson = Math.max(...people.map((k) => k.fin))
    assert.equal(st.race, lastPerson)
    assert.equal(st.tick, COUNTDOWN + st.race + OVER_HOLD)
  })

  test('the race closes 30 s after the first finisher', () => {
    const sim = simOn(0, 1, 3)
    const r = sim.run(20000)
    assert.ok(r)
    const st = sim.state
    assert.ok(st.firstFin > 0)
    assert.equal(st.karts[0].fin, -1, 'the idle person never finished')
    assert.equal(st.race, st.firstFin + AFTER_FIRST)
    assert.notDeepEqual(r.winnerSeats, [0])
    assert.match(r.summary, /^CPU \d wins · /)
  })

  test('the race always ends at the time cap', () => {
    const sim = simOn(2, 1, 0)
    const r = sim.run(COUNTDOWN + RACE_CAP + OVER_HOLD + 5)
    assert.ok(r)
    assert.equal(sim.state.race, RACE_CAP)
    assert.deepEqual(r.winnerSeats, [0])
    assert.equal(r.summary, 'Player 1 leads at the time limit')
  })

  for (let track = 0; track < trackCount(); track++) {
    test(`bots complete a race on track ${track} (${buildTrack(track).def.name})`, () => {
      const sim = simOn(track, 1, 7)
      // The person drives too, so the race runs until everyone is done.
      sim.run(20000, (s) => autopilot(s, 0))
      const st = sim.state
      assert.ok(sim.result())
      assert.ok(st.karts.every((k) => k.fin > 0), `all finished: ${st.karts.map((k) => k.fin).join(',')}`)
      const worst = Math.max(...st.karts.map((k) => k.fin))
      assert.ok(worst < 3 * 60 * 30, `slowest ${worst} ticks`)
    })
  }

  test('people leaving: their kart is out and never wins; everyone gone ends the race', () => {
    const sim = simOn(0, 2, 2)
    skipCountdown(sim)
    sim.run(30)
    sim.leave(1)
    const v = sim.view(null) as KartView
    assert.ok(v.k[1][6] & 128, 'gone flag')
    sim.run(20000, (s) => autopilot(s, 0))
    const r = sim.result()
    assert.ok(r)
    assert.ok(!r.winnerSeats.includes(1))
    assert.equal(sim.state.order[sim.state.order.length - 1], 1, 'gone kart ranks last')

    const empty = simOn(0, 1, 3)
    skipCountdown(empty)
    empty.run(30)
    empty.leave(0)
    assert.ok(empty.run(OVER_HOLD + 2), 'ends once nobody is left racing')
  })

  test('views stay small with 8 karts and a track full of objects', () => {
    const sim = simOn(1, 1, 7)
    skipCountdown(sim)
    sim.run(200)
    for (let n = 0; n < 30; n++) {
      sim.state.objs.push({ type: 1 + (n % 3), x: 1234.56, y: 987.65, vx: 1, vy: 1, life: 900, owner: 0, grace: 0, target: 3, s: 0, seg: 0 })
    }
    for (let n = 0; n < 40; n++) sim.state.events.push({ id: 100000 + n, e: 9, s: n % 8, v: 7, at: sim.state.tick })
    assertViewOk(sim.view(null), 'busy view')
    assert.ok(JSON.stringify(sim.view(0)).length < 8 * 1024)
  })
})
