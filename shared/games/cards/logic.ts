// Color Rush: an original shedding card game (the Crazy Eights family). Four retro suits (Star, Gem, Heart,
// Bolt), numbers 0–9 and action cards (Block, Flip, +2), plus Wild and Wild +4. Match the top card by suit or
// by symbol; the first to empty their hand wins. Play your second-to-last card without calling "RUSH!" and
// anyone may catch you before the next player acts: you draw 2. Pure logic (shared/games/types.ts rules).
import type { GameSeat } from '../../protocol.ts'
import type { GameContext, GameDefinition, GameOutcome } from '../types.ts'

// ---------- cards ----------

export const SUIT_NAMES: readonly string[] = ['Star', 'Gem', 'Heart', 'Bolt']
/** The suit of the two wild cards. */
export const WILD = 4
export const R_BLOCK = 10
export const R_FLIP = 11
export const R_PLUS2 = 12
export const R_WILD = 13
export const R_WILD4 = 14
export const RANK_NAMES: readonly string[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Block', 'Flip', '+2', 'Wild', 'Wild +4']

/** The deck, by card id (ids are 0..DECK_SIZE-1): suit 0–3 or WILD, rank 0–14. */
const DECK = buildDeck()
export const DECK_SUIT: readonly number[] = DECK[0]
export const DECK_RANK: readonly number[] = DECK[1]
export const DECK_SIZE = DECK_SUIT.length

function buildDeck(): [number[], number[]] {
  const suits: number[] = []
  const ranks: number[] = []
  const add = (s: number, r: number) => {
    suits.push(s)
    ranks.push(r)
  }
  for (let s = 0; s < 4; s++) {
    add(s, 0)
    for (let r = 1; r <= R_PLUS2; r++) {
      add(s, r)
      add(s, r)
    }
  }
  for (let i = 0; i < 4; i++) {
    add(WILD, R_WILD)
    add(WILD, R_WILD4)
  }
  return [suits, ranks]
}

export const isCard = (id: unknown): id is number => Number.isInteger(id) && (id as number) >= 0 && (id as number) < DECK_SIZE

export function cardName(id: number): string {
  const s = DECK_SUIT[id]
  const r = DECK_RANK[id]
  return s === WILD ? RANK_NAMES[r] : `${SUIT_NAMES[s]} ${RANK_NAMES[r]}`
}

/** Whether `card` may go on `top` while the suit in play is `suit`. */
export function canPlay(card: number, top: number, suit: number): boolean {
  return DECK_SUIT[card] === WILD || DECK_SUIT[card] === suit || DECK_RANK[card] === DECK_RANK[top]
}

// ---------- timing (ticks at TICK_HZ) ----------

export const TICK_HZ = 10
/** A person's turn. */
export const TURN_TICKS = 200
/** Deciding whether to play the card you just drew. */
export const DRAWN_TICKS = 80
/** Timeouts in a row before a person is played like a bot. */
export const AUTO_AFTER = 3
/** The match always ends: after this many turns the fewest cards win. */
export const MAX_TURNS = 300
export const HAND_SIZE = 7
/** Bots don't catch a forgotten RUSH sooner than this (gives people a moment to call it late). */
const CATCH_GRACE = 5
const KEEP_EVENTS = 10

// ---------- state ----------

export type CardsEventKind = 'deal' | 'play' | 'draw' | 'pass' | 'shuffle' | 'rush' | 'catch' | 'timeout' | 'leave' | 'win'

/**
 * Something that happened (views animate and play sounds from new ids). `s` is the seat it's about; `c` a played
 * card (never a hidden one); `n` a count (cards drawn) or the chosen suit (play); `t` another seat (a play's
 * victim or the skipped seat, a catch's catcher), -1 when none.
 */
export interface CardsEvent {
  id: number
  k: CardsEventKind
  s: number
  c: number
  n: number
  t: number
}

export interface CardsState {
  seats: GameSeat[]
  hands: number[][]
  /** Draw pile (top = last). */
  draw: number[]
  /** Discard pile (top = last). */
  discard: number[]
  /** The suit in play (the top card's, or the one chosen for a wild). */
  suit: number
  turn: number
  /** 1 = seat order (clockwise on screen), -1 = reversed. */
  dir: number
  /** The card the player on turn just drew and may still play (-1: none). */
  drawn: number
  /** Ticks left in this turn, and its length. */
  timer: number
  timerMax: number
  /** Ticks before a bot (or a person on autopilot) on turn acts. */
  think: number
  out: boolean[]
  /** Turn timeouts in a row, by seat (AUTO_AFTER or more: autopilot). */
  timeouts: number[]
  /** RUSH called (holds while at 1 card; reset when drawing). */
  called: boolean[]
  /** The seat that went down to one card without calling RUSH and can be caught (-1: none). */
  rush: number
  rushAge: number
  turns: number
  /** Turns in a row where nothing could be drawn and nothing was played. */
  stuck: number
  events: CardsEvent[]
  eventId: number
  log: string
  winners: number[] | null
  summary: string
}

/** What each recipient gets. */
export interface CardsView {
  /** Your hand (sorted) or null for spectators. */
  hand: number[] | null
  /** Your cards you may play now. */
  ok: number[]
  /** The card you just drew and may still play (-1: none). */
  drawn: number
  counts: number[]
  /** By seat, 1 = left / on autopilot / RUSH called. */
  out: number[]
  auto: number[]
  called: number[]
  /** The top few discards (top last). */
  pile: number[]
  suit: number
  drawN: number
  turn: number
  dir: number
  /** Turn timer: ticks left, ticks in total. */
  tl: number
  tm: number
  /** Catchable seat (-1: none). */
  rush: number
  ev: CardsEvent[]
  log: string
  /** Winners once over (else []). */
  win: number[]
  over: number
}

// ---------- helpers ----------

const nameOf = (s: CardsState, seat: number) => (s.seats[seat]?.name ?? `Player ${seat + 1}`).slice(0, 24)
const isBot = (s: CardsState, seat: number) => s.seats[seat]?.userId === null
const isAuto = (s: CardsState, seat: number) => !isBot(s, seat) && s.timeouts[seat] >= AUTO_AFTER
const active = (s: CardsState) => s.seats.map((_, i) => i).filter((i) => !s.out[i])
const top = (s: CardsState) => s.discard[s.discard.length - 1]
const legal = (s: CardsState, card: number) => canPlay(card, top(s), s.suit)

function shuffle(a: number[], ctx: GameContext): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.random() * (i + 1))
    const t = a[i]
    a[i] = a[j]
    a[j] = t
  }
}

function emit(s: CardsState, k: CardsEventKind, seat: number, c = -1, n = 0, t = -1): void {
  s.events.push({ id: ++s.eventId, k, s: seat, c, n, t })
  if (s.events.length > KEEP_EVENTS) s.events.shift()
}

function nextSeat(s: CardsState, from: number): number {
  const n = s.seats.length
  for (let i = 1; i <= n; i++) {
    const seat = (((from + s.dir * i) % n) + n) % n
    if (!s.out[seat]) return seat
  }
  return from
}

function finish(s: CardsState, winners: number[], summary: string): void {
  s.winners = winners
  s.summary = summary.slice(0, 120)
  s.rush = -1
  s.drawn = -1
  if (winners.length > 0) emit(s, 'win', winners[0])
}

/** Fewest cards win (turn limit, or nobody can draw nor play). */
function endByCount(s: CardsState, why: string): void {
  const seats = active(s)
  const least = Math.min(...seats.map((i) => s.hands[i].length))
  const best = seats.filter((i) => s.hands[i].length === least)
  const cards = `${least} card${least === 1 ? '' : 's'}`
  const who =
    best.length === 1
      ? `${nameOf(s, best[0])} wins with ${cards} left`
      : best.length === 2
        ? `${nameOf(s, best[0])} and ${nameOf(s, best[1])} tie with ${cards}`
        : `${best.length} players tie with ${cards}`
  s.log = `${why}: ${who}`
  finish(s, best, `${why}: ${who}`)
}

/** Draws up to `k` cards for `seat` (reshuffling the discards when the pile runs out). Returns them. */
function drawCards(s: CardsState, seat: number, k: number, ctx: GameContext): number[] {
  const got: number[] = []
  for (let i = 0; i < k; i++) {
    if (s.draw.length === 0 && s.discard.length > 1) {
      const keep = s.discard.pop()!
      s.draw = s.discard
      s.discard = [keep]
      shuffle(s.draw, ctx)
      emit(s, 'shuffle', seat)
    }
    const c = s.draw.pop()
    if (c === undefined) break
    s.hands[seat].push(c)
    got.push(c)
  }
  if (got.length > 0) {
    s.called[seat] = false
    if (s.rush === seat) s.rush = -1
    emit(s, 'draw', seat, -1, got.length)
  }
  return got
}

function startTurn(s: CardsState, seat: number, ctx: GameContext, think = 8 + Math.floor(ctx.random() * 8)): void {
  s.turn = seat
  s.drawn = -1
  s.timer = s.timerMax = TURN_TICKS
  s.think = think
  s.turns++
  if (s.turns > MAX_TURNS) endByCount(s, 'Turn limit')
}

// ---------- moves ----------

type Move =
  | { type: 'play'; card: number; suit?: number; rush?: boolean }
  | { type: 'draw' }
  | { type: 'pass' }
  | { type: 'rush' }
  | { type: 'catch'; seat?: number }

function play(s: CardsState, p: number, card: number, suit: number, rush: boolean, ctx: GameContext): void {
  const hand = s.hands[p]
  hand.splice(hand.indexOf(card), 1)
  s.discard.push(card)
  const cs = DECK_SUIT[card]
  const r = DECK_RANK[card]
  s.suit = cs === WILD ? suit : cs
  s.drawn = -1
  s.stuck = 0
  const name = nameOf(s, p)
  const cn = cardName(card)

  if (hand.length === 0) {
    emit(s, 'play', p, card, s.suit)
    s.log = `${name} played ${cn} and is out!`
    finish(s, [p], `${name} wins with a ${cn}!`)
    return
  }
  if (rush) s.called[p] = true
  if (hand.length > 1) s.called[p] = false

  const next = nextSeat(s, p)
  const two = active(s).length === 2
  let victim = -1
  let after = next
  let text = `${name} played ${cn}`
  if (r === R_BLOCK || (r === R_FLIP && two)) {
    victim = next
    after = nextSeat(s, next)
    text = `${name} blocked ${nameOf(s, next)} with ${cn}`
  } else if (r === R_FLIP) {
    s.dir = -s.dir
    after = nextSeat(s, p)
    text = `${name} flipped the direction`
  } else if (r === R_PLUS2 || r === R_WILD4) {
    victim = next
    after = nextSeat(s, next)
    text = `${name} played ${cn} on ${nameOf(s, next)}`
  }
  if (cs === WILD) text += `: ${SUIT_NAMES[s.suit]}`
  emit(s, 'play', p, card, s.suit, victim)
  s.log = text

  if (hand.length === 1) {
    if (s.called[p]) emit(s, 'rush', p)
    else {
      s.rush = p
      s.rushAge = 0
    }
  }
  if (r === R_PLUS2 || r === R_WILD4) drawCards(s, victim, r === R_PLUS2 ? 2 : 4, ctx)
  startTurn(s, after, ctx)
}

/** The player on turn ends it without playing. */
function endTurn(s: CardsState, p: number, ctx: GameContext): void {
  startTurn(s, nextSeat(s, p), ctx)
}

function drawMove(s: CardsState, p: number, ctx: GameContext): void {
  const name = nameOf(s, p)
  const got = drawCards(s, p, 1, ctx)
  if (got.length === 0) {
    s.log = `${name} can't draw and passes`
    emit(s, 'pass', p)
    if (++s.stuck >= active(s).length) {
      endByCount(s, 'No cards left')
      return
    }
    endTurn(s, p, ctx)
    return
  }
  s.stuck = 0
  if (legal(s, got[0])) {
    s.drawn = got[0]
    s.timer = s.timerMax = DRAWN_TICKS
    s.think = 4 + Math.floor(ctx.random() * 5)
    s.log = `${name} drew a card`
    return
  }
  s.log = `${name} drew a card and passed`
  endTurn(s, p, ctx)
}

/** Validates and applies a move (no autopilot bookkeeping). */
function apply(s: CardsState, p: number, raw: unknown, ctx: GameContext): string | null {
  if (s.winners) return 'The match is over'
  if (!Number.isInteger(p) || p < 0 || p >= s.seats.length || s.out[p]) return "You're not playing"
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Invalid move'
  const a = raw as Record<string, unknown>
  const type = a.type
  const hand = s.hands[p]

  if (type === 'rush') {
    if (s.called[p]) return 'You already called RUSH'
    if (hand.length === 1 || (hand.length === 2 && s.turn === p)) {
      s.called[p] = true
      if (s.rush === p) s.rush = -1
      emit(s, 'rush', p)
      s.log = `${nameOf(s, p)}: RUSH!`
      return null
    }
    return 'Call RUSH when you play your second-to-last card'
  }

  if (type === 'catch') {
    if (s.rush < 0) return 'Nobody to catch'
    if (s.rush === p) return 'Call RUSH instead!'
    if (a.seat !== undefined && a.seat !== s.rush) return "They're safe"
    const target = s.rush
    s.rush = -1
    emit(s, 'catch', target, -1, 2, p)
    drawCards(s, target, 2, ctx)
    s.log = `${nameOf(s, p)} caught ${nameOf(s, target)}: +2 cards`
    return null
  }

  if (type !== 'play' && type !== 'draw' && type !== 'pass') return 'Unknown move'
  if (s.turn !== p) return "It's not your turn"

  if (type === 'play') {
    const card = a.card
    if (!isCard(card) || !hand.includes(card)) return 'Pick a card from your hand'
    if (s.drawn >= 0 && card !== s.drawn) return 'You can only play the card you drew'
    if (!legal(s, card)) return `It must match ${SUIT_NAMES[s.suit]} or ${RANK_NAMES[DECK_RANK[top(s)]]}`
    let suit = -1
    if (DECK_SUIT[card] === WILD) {
      if (!Number.isInteger(a.suit) || (a.suit as number) < 0 || (a.suit as number) > 3) return 'Pick a suit for the wild'
      suit = a.suit as number
    }
    s.rush = -1
    play(s, p, card, suit, a.rush === true, ctx)
    return null
  }
  if (type === 'draw') {
    if (s.drawn >= 0) return 'You already drew: play it or pass'
    s.rush = -1
    drawMove(s, p, ctx)
    return null
  }
  // pass
  if (s.drawn < 0) return 'Draw a card first'
  s.rush = -1
  s.log = `${nameOf(s, p)} kept the card`
  emit(s, 'pass', p)
  endTurn(s, p, ctx)
  return null
}

// ---------- bots ----------

/** A sensible move for `seat` on turn (bots and people on autopilot). */
export function botMove(s: CardsState, seat: number, rnd: () => number): Move {
  const hand = s.hands[seat]
  const rush = hand.length === 2
  const suitFor = (card: number) => {
    const n = [0, 0, 0, 0]
    for (const c of hand) if (c !== card && DECK_SUIT[c] !== WILD) n[DECK_SUIT[c]]++
    let best = Math.floor(rnd() * 4)
    for (let i = 0; i < 4; i++) if (n[i] > n[best]) best = i
    return best
  }
  const playCard = (card: number): Move =>
    DECK_SUIT[card] === WILD ? { type: 'play', card, suit: suitFor(card), rush } : { type: 'play', card, rush }
  if (s.drawn >= 0) return legal(s, s.drawn) ? playCard(s.drawn) : { type: 'pass' }
  const options = hand.filter((c) => legal(s, c))
  if (options.length === 0) return { type: 'draw' }
  const nextCount = s.hands[nextSeat(s, seat)]?.length ?? 7
  const threat = nextCount <= 2 ? 8 : nextCount <= 4 ? 2 : 0
  let best = options[0]
  let bestScore = -Infinity
  for (const c of options) {
    const r = DECK_RANK[c]
    let score = rnd() * 1.5
    if (r === R_WILD4) score += threat > 0 ? threat + 2 : -6
    else if (r === R_WILD) score -= hand.length <= 2 ? 0 : 4
    else {
      score += hand.filter((x) => DECK_SUIT[x] === DECK_SUIT[c]).length * 0.5
      if (r >= R_BLOCK) score += 1 + threat
      else score += r * 0.1
    }
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return playCard(best)
}

// ---------- the game ----------

export const cards: GameDefinition<CardsState> = {
  id: 'cards',
  name: 'Color Rush',
  tagline: 'Match the suit or the symbol, shout RUSH! on your last card, and empty your hand first.',
  minPlayers: 2,
  maxPlayers: 8,
  bots: true,
  controls: 'actions',
  help: [
    ['Click a card', 'Play it: same suit or same symbol (wilds go on anything)'],
    ['Deck', "Draw a card (play it right away if it fits, or keep it)"],
    ['RUSH!', 'Call it when you play your second-to-last card'],
    ['Catch!', 'Click a player who forgot RUSH before the next move: they draw 2'],
    ['← → Space', 'Pick and play a card (B: draw, R: RUSH)'],
  ],
  tickHz: TICK_HZ,
  perSeatView: true,

  create(seats, ctx) {
    const n = seats.length
    const draw = Array.from({ length: DECK_SIZE }, (_, i) => i)
    shuffle(draw, ctx)
    const hands: number[][] = seats.map(() => [])
    for (let k = 0; k < HAND_SIZE; k++) for (let i = 0; i < n; i++) hands[i].push(draw.pop()!)
    // The first face-up card is a number (others go to the bottom).
    let first = draw.pop()!
    while (DECK_RANK[first] > 9) {
      draw.unshift(first)
      first = draw.pop()!
    }
    const s: CardsState = {
      seats: seats.map((x) => ({ ...x })),
      hands,
      draw,
      discard: [first],
      suit: DECK_SUIT[first],
      turn: 0,
      dir: 1,
      drawn: -1,
      timer: TURN_TICKS,
      timerMax: TURN_TICKS,
      think: 0,
      out: seats.map(() => false),
      timeouts: seats.map(() => 0),
      called: seats.map(() => false),
      rush: -1,
      rushAge: 0,
      turns: 0,
      stuck: 0,
      events: [],
      eventId: 0,
      log: '',
      winners: null,
      summary: '',
    }
    emit(s, 'deal', -1, first, HAND_SIZE)
    const startSeat = Math.floor(ctx.random() * n)
    startTurn(s, startSeat, ctx, 20 + Math.floor(ctx.random() * 6))
    s.log = `${nameOf(s, startSeat)} goes first`
    return s
  },

  tick(s, _input, ctx) {
    if (s.winners) return
    if (s.rush >= 0) s.rushAge++
    if (s.think > 0) s.think--
    if (s.timer > 0) s.timer--
    const p = s.turn
    if (isAuto(s, p)) {
      if (s.think <= 0) apply(s, p, botMove(s, p, ctx.random), ctx)
      return
    }
    if (s.timer > 0) return
    // Out of time: keep a drawn card, or draw one and pass.
    if (!isBot(s, p)) s.timeouts[p]++
    s.rush = -1
    emit(s, 'timeout', p)
    const name = nameOf(s, p)
    if (s.drawn < 0) drawCards(s, p, 1, ctx)
    s.log = `${name} ran out of time${isAuto(s, p) ? ' (autopilot on)' : ''}`
    endTurn(s, p, ctx)
  },

  action(s, seat, raw, ctx) {
    const err = apply(s, seat, raw, ctx)
    if (err === null && s.timeouts[seat] !== undefined) s.timeouts[seat] = 0
    return err
  },

  botAction(s, seat, ctx) {
    if (s.winners || s.out[seat]) return null
    const catchable = s.rush >= 0 && s.rush !== seat && s.rushAge >= CATCH_GRACE
    if (seat !== s.turn) return catchable && ctx.random() < 0.03 ? { type: 'catch', seat: s.rush } : null
    if (s.think > 0) return null
    if (catchable && ctx.random() < 0.5) return { type: 'catch', seat: s.rush }
    return botMove(s, seat, ctx.random)
  },

  leave(s, seat, ctx) {
    if (s.winners || s.out[seat] || seat < 0 || seat >= s.seats.length) return
    s.out[seat] = true
    // Their cards go under the draw pile.
    s.draw.unshift(...s.hands[seat])
    s.hands[seat] = []
    s.called[seat] = false
    if (s.rush === seat) s.rush = -1
    emit(s, 'leave', seat)
    s.log = `${nameOf(s, seat)} left the table`
    const left = active(s)
    if (left.length === 0) {
      finish(s, [], 'Everyone left')
      return
    }
    if (left.length === 1) {
      finish(s, [left[0]], `${nameOf(s, left[0])} wins: everyone else left`)
      return
    }
    if (s.turn === seat) endTurn(s, seat, ctx)
  },

  view(s, seat): CardsView {
    const mine = seat !== null && seat >= 0 && seat < s.seats.length && !s.out[seat] ? seat : null
    const hand =
      mine === null
        ? null
        : [...s.hands[mine]].sort((a, b) => DECK_SUIT[a] - DECK_SUIT[b] || DECK_RANK[a] - DECK_RANK[b] || a - b)
    const myTurn = mine !== null && s.turn === mine && !s.winners
    const ok = !myTurn || !hand ? [] : s.drawn >= 0 ? (legal(s, s.drawn) ? [s.drawn] : []) : hand.filter((c) => legal(s, c))
    return {
      hand,
      ok,
      drawn: myTurn ? s.drawn : -1,
      counts: s.hands.map((h) => h.length),
      out: s.out.map((o) => (o ? 1 : 0)),
      auto: s.seats.map((_, i) => (isAuto(s, i) ? 1 : 0)),
      called: s.called.map((c, i) => (c && s.hands[i].length <= 2 ? 1 : 0)),
      pile: s.discard.slice(-3),
      suit: s.suit,
      drawN: s.draw.length,
      turn: s.turn,
      dir: s.dir,
      tl: s.timer,
      tm: s.timerMax,
      rush: s.rush,
      ev: s.events.slice(-8).map((e) => ({ ...e })),
      log: s.log,
      win: s.winners ? [...s.winners] : [],
      over: s.winners ? 1 : 0,
    }
  },

  result(s): GameOutcome | null {
    return s.winners ? { winnerSeats: [...s.winners], summary: s.summary } : null
  },
}
