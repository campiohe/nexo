// Color Rush (shared/games/cards/logic.ts): the game contract plus its rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkGameContract, makeSeats, simulate } from './helpers/gameHarness.ts'
import {
  cards,
  DECK_RANK,
  DECK_SIZE,
  DECK_SUIT,
  DRAWN_TICKS,
  R_BLOCK,
  R_FLIP,
  R_PLUS2,
  R_WILD,
  R_WILD4,
  TURN_TICKS,
  WILD,
  type CardsState,
  type CardsView,
} from '../../shared/games/cards/logic.ts'

/** A card id of this suit and rank (the `nth` copy). */
function card(suit: number, rank: number, nth = 0): number {
  let seen = 0
  for (let i = 0; i < DECK_SIZE; i++) if (DECK_SUIT[i] === suit && DECK_RANK[i] === rank && seen++ === nth) return i
  throw new Error(`no card ${suit}/${rank}#${nth}`)
}

/**
 * A table of `humans` people (+ `bots`) with chosen hands: seat 0 on turn, `topCard` face up, every other card
 * in the draw pile (or `draw` on top of it, last = next drawn).
 */
function table(hands: number[][], topCard: number, opts: { bots?: number; draw?: number[]; turn?: number; seed?: number } = {}) {
  const bots = opts.bots ?? 0
  const sim = simulate(cards, makeSeats(hands.length - bots, bots), opts.seed ?? 5)
  const s = sim.state
  const used = new Set([...hands.flat(), topCard, ...(opts.draw ?? [])])
  s.hands = hands.map((h) => [...h])
  s.discard = [topCard]
  s.draw = [...Array.from({ length: DECK_SIZE }, (_, i) => i).filter((i) => !used.has(i)), ...(opts.draw ?? [])]
  s.suit = DECK_SUIT[topCard]
  s.turn = opts.turn ?? 0
  s.dir = 1
  s.drawn = -1
  s.timer = s.timerMax = TURN_TICKS
  s.think = 10
  return sim
}

const totalCards = (s: CardsState) => s.hands.flat().length + s.draw.length + s.discard.length

test('Color Rush keeps the game contract', () => {
  checkGameContract(cards)
})

test('the deck has 108 distinct cards and every hand starts with 7', () => {
  assert.equal(DECK_SIZE, 108)
  const sim = simulate(cards, makeSeats(4, 0), 9)
  const s = sim.state
  assert.ok(s.hands.every((h) => h.length === 7))
  assert.equal(totalCards(s), 108)
  assert.equal(new Set([...s.hands.flat(), ...s.draw, ...s.discard]).size, 108)
  assert.ok(DECK_RANK[s.discard[0]] <= 9, 'the first face-up card is a number')
  assert.equal(DECK_SUIT.filter((x) => x === WILD).length, 8)
})

test('legal and illegal plays', () => {
  const g7 = card(1, 7)
  const s3 = card(0, 3)
  const h7 = card(2, 7)
  const b9 = card(3, 9)
  const sim = table([[s3, h7, b9, card(3, 1)], [card(0, 1), card(0, 2)]], g7)
  assert.match(sim.action(1, { type: 'play', card: card(0, 1) })!, /not your turn/)
  assert.match(sim.action(0, { type: 'play', card: b9 })!, /must match/)
  assert.match(sim.action(0, { type: 'play', card: card(1, 2) })!, /hand/, 'a card not in the hand')
  assert.match(sim.action(0, { type: 'play', card: '3' })!, /hand/)
  assert.equal(sim.action(0, { type: 'play', card: h7 }), null, 'same number')
  assert.equal(sim.state.suit, 2)
  assert.equal(sim.state.turn, 1)
  assert.deepEqual(sim.state.discard.slice(-1), [h7])
  assert.equal(sim.state.hands[0].length, 3)
})

test('Block skips the next player; Flip reverses (and blocks with two players)', () => {
  const sim = table([[card(0, R_BLOCK), card(0, 1)], [card(1, 1)], [card(1, 2)]], card(0, 5))
  assert.equal(sim.action(0, { type: 'play', card: card(0, R_BLOCK) }), null)
  assert.equal(sim.state.turn, 2, 'seat 1 was blocked')

  const flip = table([[card(0, R_FLIP), card(0, 1)], [card(1, 1)], [card(1, 2)]], card(0, 5))
  assert.equal(flip.action(0, { type: 'play', card: card(0, R_FLIP) }), null)
  assert.equal(flip.state.dir, -1)
  assert.equal(flip.state.turn, 2, 'reversed: seat 2 is next')

  const two = table([[card(0, R_FLIP), card(0, 1), card(0, 2)], [card(1, 1)]], card(0, 5))
  assert.equal(two.action(0, { type: 'play', card: card(0, R_FLIP) }), null)
  assert.equal(two.state.turn, 0, 'with two players Flip acts as Block')
})

test('+2 and Wild +4 make the next player draw and lose their turn', () => {
  const sim = table([[card(0, R_PLUS2), card(0, 1), card(0, 2)], [card(1, 1)], [card(1, 2)]], card(0, 5))
  assert.equal(sim.action(0, { type: 'play', card: card(0, R_PLUS2) }), null)
  assert.equal(sim.state.hands[1].length, 3)
  assert.equal(sim.state.turn, 2)
  const v = sim.view(1) as CardsView
  assert.ok(v.ev.some((e) => e.k === 'play' && e.t === 1))

  const w4 = card(WILD, R_WILD4)
  const sim4 = table([[w4, card(0, 1), card(0, 2)], [card(1, 1)], [card(1, 2)]], card(3, 5))
  assert.match(sim4.action(0, { type: 'play', card: w4 })!, /suit/)
  assert.match(sim4.action(0, { type: 'play', card: w4, suit: 4 })!, /suit/)
  assert.match(sim4.action(0, { type: 'play', card: w4, suit: 1.5 })!, /suit/)
  assert.equal(sim4.action(0, { type: 'play', card: w4, suit: 1 }), null)
  assert.equal(sim4.state.hands[1].length, 5)
  assert.equal(sim4.state.turn, 2)
  assert.equal(sim4.state.suit, 1)
})

test('a wild goes on anything and sets the chosen suit', () => {
  const w = card(WILD, R_WILD)
  const sim = table([[w, card(2, 4), card(0, 1)], [card(1, 1), card(2, 8)]], card(3, 5))
  assert.equal(sim.action(0, { type: 'play', card: w, suit: 2 }), null)
  assert.equal(sim.state.suit, 2)
  assert.match(sim.action(1, { type: 'play', card: card(1, 1) })!, /must match Heart/)
  assert.equal(sim.action(1, { type: 'play', card: card(2, 8) }), null)
})

test('draw: an unplayable card passes the turn, a playable one may be played or kept', () => {
  const sim = table([[card(1, 1)], [card(1, 2)]], card(0, 5), { draw: [card(3, 3)] })
  assert.equal(sim.action(0, { type: 'draw' }), null)
  assert.equal(sim.state.hands[0].length, 2)
  assert.equal(sim.state.turn, 1, 'Bolt 3 does not fit Star 5: turn passes')

  const fit = card(0, 8)
  const sim2 = table([[card(1, 1), card(1, 4)], [card(1, 2)]], card(0, 5), { draw: [fit] })
  assert.match(sim2.action(0, { type: 'pass' })!, /Draw/)
  assert.equal(sim2.action(0, { type: 'draw' }), null)
  assert.equal(sim2.state.turn, 0)
  assert.equal(sim2.state.drawn, fit)
  assert.equal(sim2.state.timer, DRAWN_TICKS)
  assert.deepEqual((sim2.view(0) as CardsView).ok, [fit])
  assert.match(sim2.action(0, { type: 'draw' })!, /already drew/)
  assert.match(sim2.action(0, { type: 'play', card: card(1, 1) })!, /hand|drew/)
  assert.equal(sim2.action(0, { type: 'play', card: fit }), null)
  assert.equal(sim2.state.turn, 1)

  const sim3 = table([[card(1, 1), card(1, 4)], [card(1, 2)]], card(0, 5), { draw: [fit] })
  sim3.action(0, { type: 'draw' })
  assert.equal(sim3.action(0, { type: 'pass' }), null)
  assert.equal(sim3.state.turn, 1)
  assert.ok(sim3.state.hands[0].includes(fit))
})

test('the discards are reshuffled into an empty draw pile', () => {
  const sim = table([[card(1, 1)], [card(1, 2)]], card(0, 5))
  const s = sim.state
  // Everything but the hands and the top card sits in the discard pile.
  s.discard = [...s.draw, card(0, 5)]
  s.draw = []
  const before = totalCards(s)
  assert.equal(sim.action(0, { type: 'draw' }), null)
  assert.equal(s.discard.length, 1)
  assert.equal(s.discard[0], card(0, 5), 'the top card stays')
  assert.equal(s.hands[0].length, 2)
  assert.equal(totalCards(s), before)
  assert.ok((sim.view(0) as CardsView).ev.some((e) => e.k === 'shuffle'))
})

test('RUSH: called with the play, called late, or caught', () => {
  // Called with the play: safe.
  const a = table([[card(0, 1), card(0, 2)], [card(1, 1), card(1, 2)], [card(2, 3)]], card(0, 5))
  assert.equal(a.action(0, { type: 'play', card: card(0, 1), rush: true }), null)
  assert.equal(a.state.rush, -1)
  assert.match(a.action(1, { type: 'catch', seat: 0 })!, /Nobody/)
  assert.equal((a.view(2) as CardsView).called[0], 1)

  // Called before the play (2 cards, on turn).
  const b = table([[card(0, 1), card(0, 2)], [card(1, 1), card(1, 2)], [card(2, 3)]], card(0, 5))
  assert.match(b.action(1, { type: 'rush' })!, /RUSH/)
  assert.equal(b.action(0, { type: 'rush' }), null)
  assert.equal(b.action(0, { type: 'play', card: card(0, 1) }), null)
  assert.equal(b.state.rush, -1)

  // Forgot, then caught by someone who isn't next: draws 2.
  const c = table([[card(0, 1), card(0, 2)], [card(1, 1), card(1, 2)], [card(2, 3)]], card(0, 5))
  assert.equal(c.action(0, { type: 'play', card: card(0, 1) }), null)
  assert.equal(c.state.rush, 0)
  assert.equal((c.view(1) as CardsView).rush, 0)
  assert.match(c.action(0, { type: 'catch', seat: 0 })!, /RUSH/)
  assert.match(c.action(2, { type: 'catch', seat: 1 })!, /safe/)
  assert.equal(c.action(2, { type: 'catch', seat: 0 }), null)
  assert.equal(c.state.hands[0].length, 3)
  assert.equal(c.state.rush, -1)
  assert.match(c.action(1, { type: 'catch', seat: 0 })!, /Nobody/)

  // Forgot, then called it late (before anyone caught them): safe.
  const d = table([[card(0, 1), card(0, 2)], [card(1, 1), card(1, 2)], [card(2, 3)]], card(0, 5))
  d.action(0, { type: 'play', card: card(0, 1) })
  assert.equal(d.action(0, { type: 'rush' }), null)
  assert.match(d.action(1, { type: 'catch' })!, /Nobody/)
  assert.equal(d.state.hands[0].length, 1)

  // Forgot, but the next player acted: too late to catch.
  const e = table([[card(0, 1), card(0, 2)], [card(0, 3), card(1, 2), card(1, 3)], [card(2, 3)]], card(0, 5))
  e.action(0, { type: 'play', card: card(0, 1) })
  assert.equal(e.action(1, { type: 'play', card: card(0, 3) }), null)
  assert.match(e.action(2, { type: 'catch', seat: 0 })!, /Nobody/)
})

test('bots call RUSH and catch people who forget', () => {
  // Bot on turn with 2 cards: it plays with RUSH.
  const sim = table([[card(1, 1), card(1, 2)], [card(0, 1), card(0, 2)]], card(0, 5), { bots: 1, turn: 1 })
  sim.run(30, (x) => assert.equal(x.state.rush, -1))
  assert.equal(sim.state.hands[1].length, 1)
  assert.equal(sim.state.called[1], true)

  // A person forgets: a bot catches them sooner or later (over several tries).
  let caught = 0
  for (let seed = 1; seed <= 10; seed++) {
    const t = table([[card(0, 1), card(0, 2)], [card(2, 1), card(2, 2), card(2, 3)], [card(3, 1), card(3, 2)]], card(0, 5), { bots: 2, seed })
    t.state.think = 0
    t.action(0, { type: 'play', card: card(0, 1) })
    t.run(40)
    if (t.state.hands[0].length >= 3) caught++
  }
  assert.ok(caught > 0, 'bots catch a forgotten RUSH')
})

test('the turn timer auto-draws and passes; three timeouts in a row turn on autopilot', () => {
  const sim = table([[card(1, 1)], [card(1, 2)]], card(0, 5), { draw: [card(0, 9)] })
  sim.run(TURN_TICKS - 1)
  assert.equal(sim.state.turn, 0)
  sim.run(2)
  assert.equal(sim.state.turn, 1)
  assert.equal(sim.state.hands[0].length, 2, 'drew one (even a playable one) and passed')
  assert.equal(sim.state.timeouts[0], 1)

  // Seat 1 acts in time; seat 0 keeps timing out.
  for (let i = 0; i < 2; i++) {
    sim.action(1, { type: 'draw' })
    if (sim.state.turn === 1) sim.action(1, { type: 'pass' })
    sim.run(TURN_TICKS + 1)
  }
  assert.equal(sim.state.timeouts[0], 3)
  assert.equal((sim.view(1) as CardsView).auto[0], 1)
  // On autopilot, seat 0 moves fast like a bot.
  sim.action(1, { type: 'draw' })
  if (sim.state.turn === 1) sim.action(1, { type: 'pass' })
  assert.equal(sim.state.turn, 0)
  sim.run(25)
  assert.notEqual(sim.state.turn, 0)
  // Acting again turns autopilot off.
  sim.action(1, { type: 'draw' })
  if (sim.state.turn === 1) sim.action(1, { type: 'pass' })
  assert.equal(sim.action(0, { type: 'draw' }), null)
  assert.equal(sim.state.timeouts[0], 0)
})

test('views hide other hands; spectators see no hand', () => {
  const sim = simulate(cards, makeSeats(3, 0), 4)
  const s = sim.state
  const publicIds = (v: CardsView) => new Set<number>([...v.pile, ...v.ev.map((e) => e.c)])
  for (let seat = 0; seat < 3; seat++) {
    const v = sim.view(seat) as CardsView
    assert.deepEqual([...v.hand!].sort((a, b) => a - b), [...s.hands[seat]].sort((a, b) => a - b))
    const ids = publicIds(v)
    for (const c of s.hands.flatMap((h, i) => (i === seat ? [] : h))) assert.ok(!ids.has(c), `seat ${seat} sees card ${c} of another hand`)
    assert.deepEqual(v.counts, [7, 7, 7])
  }
  const spec = sim.view(null) as CardsView
  assert.equal(spec.hand, null)
  assert.deepEqual(spec.ok, [])
  for (const c of s.hands.flat()) assert.ok(!publicIds(spec).has(c))
  // A drawn card never shows in the others' views.
  const p = s.turn
  sim.action(p, { type: 'draw' })
  const drawnId = s.hands[p][s.hands[p].length - 1]
  for (const seat of [null, (p + 1) % 3, (p + 2) % 3]) {
    const v = sim.view(seat) as CardsView
    assert.equal(v.drawn, -1)
    assert.ok(!publicIds(v).has(drawnId))
  }
  // Someone who left gets the spectator view.
  sim.leave(1)
  assert.equal((sim.view(1) as CardsView).hand, null)
})

test('leaving: cards go under the draw pile, play continues; the last one wins', () => {
  const sim = table([[card(0, 1), card(0, 2)], [card(1, 1), card(1, 2), card(1, 3)], [card(2, 3)]], card(0, 5), { turn: 1 })
  const s = sim.state
  const before = totalCards(s)
  sim.leave(1)
  assert.deepEqual(s.draw.slice(0, 3), [card(1, 1), card(1, 2), card(1, 3)])
  assert.equal(s.hands[1].length, 0)
  assert.equal(totalCards(s), before)
  assert.equal(s.turn, 2, 'the turn moves on')
  assert.equal(sim.result(), null)
  assert.equal(sim.action(1, { type: 'draw' }), "You're not playing")
  sim.action(2, { type: 'draw' })
  if (s.turn === 2) sim.action(2, { type: 'pass' })
  assert.equal(s.turn, 0, 'seat 1 is skipped')
  sim.leave(2)
  const r = sim.result()
  assert.ok(r)
  assert.deepEqual(r.winnerSeats, [0])
})

test('emptying your hand wins the match', () => {
  const w = card(WILD, R_WILD)
  const sim = table([[w], [card(1, 1)]], card(0, 5))
  assert.equal(sim.action(0, { type: 'play', card: w, suit: 0 }), null)
  const r = sim.result()
  assert.ok(r)
  assert.deepEqual(r.winnerSeats, [0])
  assert.equal(r.summary, 'Player 1 wins with a Wild!')
  assert.match(sim.action(1, { type: 'draw' })!, /over/)
  assert.deepEqual((sim.view(null) as CardsView).win, [0])
})

test('the match always ends: the turn limit gives it to the fewest cards', () => {
  const sim = table([[card(1, 1), card(1, 2)], [card(1, 3)]], card(0, 5))
  sim.state.turns = 10_000
  sim.action(0, { type: 'draw' })
  if (!sim.result()) sim.action(0, { type: 'pass' })
  const r = sim.result()
  assert.ok(r)
  assert.deepEqual(r.winnerSeats, [1])
  assert.match(r.summary, /Turn limit/)
})

test('all-bot matches end for every table size', () => {
  for (let n = 2; n <= 8; n++) {
    for (let seed = 1; seed <= 3; seed++) {
      const sim = simulate(cards, makeSeats(0, n), seed)
      const r = sim.run(15 * 60 * cards.tickHz)
      assert.ok(r, `${n} bots, seed ${seed}`)
      assert.equal(r.winnerSeats.length, 1)
      const s = sim.state
      assert.equal(totalCards(s), 108, 'no card is lost or duplicated')
    }
  }
})
