// Color Rush view (shared/games/cards/logic.ts): a pixel card table on a RetroCanvas. Mouse-first (click a card,
// the deck, RUSH!, Catch!); keyboard: ← → pick, Space / Enter play, B draw (or pass), R RUSH, 1–4 suit.
import { useEffect, useRef } from 'react'
import type { GameViewProps } from '../types'
import { RetroCanvas, drawText, eventPlayer, sfx, textWidth } from '../retro'
import {
  DECK_RANK,
  DECK_SUIT,
  R_BLOCK,
  R_FLIP,
  R_PLUS2,
  SUIT_NAMES,
  WILD,
  type CardsEvent,
  type CardsView,
} from '@shared/games/cards/logic'
import { CARD_H, CARD_W, INK, SUIT_COLOR, SUIT_DARK, SUIT_ICONS, box, drawBack, drawFace, drawIcon } from './art'

const W = 320
const H = 180
/** Table center (direction ring) and piles. */
const CX = 158
const CY = 73
const DRAW_X = 108
const PILE_X = 137
const PILE_Y = 58
const BADGE_X = 166
const HAND_Y = 146
const LOG_Y = 104

interface Hit {
  x: number
  y: number
  w: number
  h: number
  on: () => void
}
interface Flight {
  back: boolean
  card: number
  x0: number
  y0: number
  x1: number
  y1: number
  t0: number
  dur: number
}
interface Popup {
  text: string
  x: number
  y: number
  color: string
  t0: number
  dur: number
  scale: number
}
interface Pt {
  x: number
  y: number
}

const snd = {
  play: () => {
    sfx.noise({ ms: 45, volume: 0.5, lowpass: 6000 })
    sfx.tone({ freq: 420, to: 300, ms: 60, volume: 0.35 })
  },
  draw: (k: number) => {
    for (let i = 0; i < Math.min(k, 4); i++) sfx.tone({ freq: 300 + i * 40, to: 520 + i * 40, ms: 50, volume: 0.35, delay: i * 90, type: 'triangle' })
  },
  skip: () => sfx.tone({ freq: 880, to: 180, ms: 220, type: 'sawtooth', volume: 0.3 }),
  flip: () => {
    sfx.tone({ freq: 400, to: 800, ms: 100, volume: 0.4 })
    sfx.tone({ freq: 800, to: 400, ms: 100, volume: 0.4, delay: 100 })
  },
  shuffle: () => {
    for (let i = 0; i < 6; i++) sfx.noise({ ms: 35, volume: 0.35, delay: i * 55, lowpass: 7000 })
  },
  rush: () => {
    sfx.tone({ freq: 660, ms: 70, volume: 0.5 })
    sfx.tone({ freq: 880, ms: 70, volume: 0.5, delay: 70 })
    sfx.tone({ freq: 1320, ms: 180, volume: 0.5, delay: 140 })
  },
  refuse: () => sfx.tone({ freq: 160, ms: 120, volume: 0.35 }),
}

function disc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.fillStyle = color
  for (let dy = -r; dy <= r; dy++) {
    const hw = Math.round(Math.sqrt(r * r - dy * dy))
    ctx.fillRect(cx - hw, cy + dy, hw * 2 + 1, 1)
  }
}

function ellipse(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, color: string) {
  ctx.fillStyle = color
  for (let dy = -ry; dy <= ry; dy++) {
    const hw = Math.round(rx * Math.sqrt(1 - (dy * dy) / (ry * ry)))
    ctx.fillRect(cx - hw, cy + dy, hw * 2, 1)
  }
}

function button(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, label: string, fill: string, text = '#ffffff', hover = false) {
  box(ctx, x, y, w, 12, INK)
  box(ctx, x + 1, y + 1, w - 2, 10, hover ? '#ffffff' : fill)
  drawText(ctx, label, x + w / 2, y + 3, { align: 'center', color: hover ? INK : text })
}

const fit = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '.' : s)

/** Seat positions around the table: you at the bottom, the others clockwise in seat order. */
function seatPositions(n: number, me: number | null): Pt[] {
  const at = (deg: number): Pt => {
    const a = (deg * Math.PI) / 180
    return { x: Math.round(160 - 132 * Math.sin(a)), y: Math.round(70 + 54 * Math.cos(a)) }
  }
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    if (me === null) out.push(at((360 * i) / n))
    else {
      const rel = (i - me + n) % n
      if (rel === 0) out.push({ x: 160, y: HAND_Y + 4 })
      else {
        // Few opponents sit across the table; more spread up to the sides.
        const span = Math.min(220, 60 * (n - 2))
        out.push(at(n === 2 ? 180 : 180 - span / 2 + (span * (rel - 1)) / (n - 2)))
      }
    }
  }
  return out
}

function handLayout(hand: number[]): { id: number; x: number }[] {
  const n = hand.length
  if (n === 0) return []
  const step = n === 1 ? 0 : Math.min(CARD_W + 2, (W - 12 - CARD_W) / (n - 1))
  const total = CARD_W + step * (n - 1)
  const x0 = Math.round(W / 2 - total / 2)
  return hand.map((id, i) => ({ id, x: Math.round(x0 + i * step) }))
}

export default function ColorRushView({ seats, seat, frames, act, lobby }: GameViewProps<CardsView>) {
  const live = useRef({ seat, act })
  live.current = { seat, act }
  const uiRef = useRef<{
    mouse: Pt
    hits: Hit[]
    sel: number
    picker: number
    error: string
    errorAt: number
    busyAt: number
    flights: Flight[]
    popups: Popup[]
    handX: Map<number, number>
    matchId: string | null
    player: ((ev: readonly CardsEvent[] | undefined) => void) | null
    quiet: boolean
    lastTurn: number
    view: CardsView | null
    pos: Pt[]
    me: number | null
    now: number
  } | null>(null)
  if (!uiRef.current) {
    uiRef.current = {
      mouse: { x: -1, y: -1 },
      hits: [],
      sel: -1,
      picker: -1,
      error: '',
      errorAt: 0,
      busyAt: -1e9,
      flights: [],
      popups: [],
      handX: new Map(),
      matchId: null,
      player: null,
      quiet: false,
      lastTurn: -1,
      view: null,
      pos: [],
      me: null,
      now: 0,
    }
  }
  const ui = uiRef.current

  const send = (action: unknown) => {
    const t = performance.now()
    if (t - ui.busyAt < 1500) return
    ui.busyAt = t
    void live.current.act(action).then((err) => {
      ui.busyAt = -1e9
      if (err) {
        ui.error = err
        ui.errorAt = performance.now()
        snd.refuse()
      }
    })
  }

  const playCard = (id: number) => {
    if (DECK_SUIT[id] === WILD) ui.picker = id
    else send({ type: 'play', card: id })
  }

  const drawOrPass = () => {
    const v = ui.view
    if (!v || ui.me === null) return
    send(v.drawn >= 0 ? { type: 'pass' } : { type: 'draw' })
  }

  const callRush = () => send({ type: 'rush' })

  // Effects of each new event (animations + sounds), from frames: never from React renders.
  const onEvent = (e: CardsEvent) => {
    if (ui.quiet) return
    const now = ui.now
    const pos = ui.pos
    const me = ui.me
    const seatPt = (s: number): Pt => (s === me ? { x: W / 2 - CARD_W / 2, y: HAND_Y } : (pos[s] ?? { x: W / 2, y: H / 2 }))
    const pop = (text: string, at: Pt, color: string, delay = 0, scale = 1, dur = 1100) =>
      ui.popups.push({ text, x: at.x, y: at.y - 14, color, t0: now + delay, dur, scale })
    const backs = (from: Pt, to: Pt, k: number, gap: number, delay = 0) => {
      for (let i = 0; i < k; i++) ui.flights.push({ back: true, card: -1, x0: from.x, y0: from.y, x1: to.x, y1: to.y, t0: now + delay + i * gap, dur: 260 })
    }
    const deck: Pt = { x: DRAW_X, y: PILE_Y }
    const pile: Pt = { x: PILE_X, y: PILE_Y }
    switch (e.k) {
      case 'deal': {
        const n = pos.length
        for (let i = 0; i < n; i++) {
          const to = seatPt(i)
          for (let k = 0; k < e.n; k++) ui.flights.push({ back: true, card: -1, x0: deck.x, y0: deck.y, x1: to.x - 11, y1: to.y - 15, t0: now + (k * n + i) * 22, dur: 240 })
        }
        snd.shuffle()
        break
      }
      case 'play': {
        const r = DECK_RANK[e.c]
        const from = e.s === me ? { x: ui.handX.get(e.c) ?? W / 2, y: HAND_Y - 6 } : { x: seatPt(e.s).x - CARD_W / 2, y: seatPt(e.s).y - CARD_H / 2 }
        ui.flights.push({ back: false, card: e.c, x0: from.x, y0: from.y, x1: pile.x, y1: pile.y, t0: now, dur: 260 })
        snd.play()
        if (DECK_SUIT[e.c] === WILD) {
          sfx.powerup()
          pop(`${SUIT_NAMES[e.n]}!`.toUpperCase(), { x: BADGE_X + 17, y: PILE_Y + 2 }, SUIT_COLOR[e.n] ?? '#fff', 250)
        }
        if (e.t >= 0) {
          const at = seatPt(e.t)
          if (r === R_BLOCK || r === R_FLIP) {
            pop('BLOCKED', at, '#ff6b6b', 250)
            snd.skip()
          } else pop(r === R_PLUS2 ? '+2' : '+4', at, '#ffd84a', 250, 2)
        } else if (r === R_FLIP) {
          pop('FLIP!', { x: CX, y: CY + 4 }, '#ffffff', 200, 2)
          snd.flip()
        }
        break
      }
      case 'draw': {
        const to = seatPt(e.s)
        backs(deck, e.s === me ? { x: W - 40, y: HAND_Y } : { x: to.x - 11, y: to.y - 15 }, Math.min(e.n, 6), 110, 120)
        snd.draw(e.n)
        break
      }
      case 'shuffle':
        backs(pile, deck, 8, 45)
        pop('SHUFFLE!', { x: DRAW_X + 11, y: PILE_Y + 6 }, '#ffffff', 0, 1, 900)
        snd.shuffle()
        break
      case 'rush':
        pop('RUSH!', seatPt(e.s), '#ffd84a', 0, 2, 1400)
        snd.rush()
        break
      case 'catch':
        pop('CAUGHT! +2', seatPt(e.s), '#ff5a5f', 0, 1, 1400)
        sfx.hit()
        break
      case 'timeout':
        pop('TIME UP', seatPt(e.s), '#ff9f43')
        sfx.countdown()
        break
      case 'pass':
        pop('PASS', seatPt(e.s), '#b8c4d6', 0, 1, 800)
        break
      case 'leave':
        pop('LEFT', seatPt(e.s), '#b8c4d6')
        break
      case 'win':
        pop('WINNER!', seatPt(e.s), '#ffd84a', 300, 2, 3000)
        sfx.coin()
        break
    }
  }

  const draw = (ctx: CanvasRenderingContext2D, now: number) => {
    const hits: Hit[] = []
    ui.hits = hits
    ui.now = now
    ctx.fillStyle = '#0c0e1c'
    ctx.fillRect(0, 0, W, H)
    ellipse(ctx, 160, 74, 156, 66, '#0b1430')
    ellipse(ctx, 160, 74, 152, 62, '#16224a')
    const f = frames.latest()
    if (!f) {
      drawText(ctx, 'SHUFFLING...', W / 2, 80, { align: 'center', color: '#aab4d4' })
      return
    }
    const v = f.view
    const n = v.counts.length
    const mySeat = live.current.seat
    const me = mySeat !== null && mySeat < n && !v.out[mySeat] && v.hand ? mySeat : null
    const pos = seatPositions(n, me)
    ui.view = v
    ui.pos = pos
    ui.me = me

    // New match: fresh event player; joining mid-match doesn't replay old events.
    if (ui.matchId !== lobby.matchId) {
      ui.matchId = lobby.matchId
      ui.player = eventPlayer<CardsEvent>(onEvent)
      ui.flights = []
      ui.popups = []
      ui.picker = -1
      ui.lastTurn = -1
      ui.quiet = f.tick > 30
    }
    ui.player?.(v.ev)
    if (!ui.quiet && me !== null && v.turn === me && ui.lastTurn !== me && !v.over) sfx.select()
    ui.quiet = false
    ui.lastTurn = v.turn
    const myTurn = me !== null && v.turn === me && !v.over
    if (ui.picker >= 0 && (!myTurn || (v.drawn >= 0 && v.drawn !== ui.picker) || !v.hand?.includes(ui.picker))) ui.picker = -1
    const hover = (x: number, y: number, w: number, h: number) => ui.mouse.x >= x && ui.mouse.x < x + w && ui.mouse.y >= y && ui.mouse.y < y + h

    // Direction ring: a wave of lit dots running the way play goes.
    const DOTS = 30
    const phase = (now / 140) * v.dir
    for (let i = 0; i < DOTS; i++) {
      const a = (i / DOTS) * Math.PI * 2
      const x = Math.round(CX - 64 * Math.sin(a))
      const y = Math.round(CY + 30 * Math.cos(a))
      const k = (((i - phase) % 6) + 6) % 6
      ctx.fillStyle = k < 1 ? '#ffffff' : k < 2 ? '#7f8bc4' : '#2c3a70'
      ctx.fillRect(x, y, k < 1 ? 2 : 1, k < 1 ? 2 : 1)
    }

    // Draw pile.
    const canDraw = myTurn && v.drawn < 0
    const layers = Math.min(4, Math.ceil(v.drawN / 12))
    for (let i = 0; i < layers; i++) drawBack(ctx, DRAW_X - i, PILE_Y - i)
    if (v.drawN === 0) {
      box(ctx, DRAW_X, PILE_Y, CARD_W, CARD_H, '#0f1838')
    }
    const deckHover = hover(DRAW_X - 4, PILE_Y - 4, CARD_W + 4, CARD_H + 4)
    if (me !== null && (canDraw || (myTurn && v.drawn >= 0))) {
      hits.push({ x: DRAW_X - 4, y: PILE_Y - 4, w: CARD_W + 4, h: CARD_H + 14, on: drawOrPass })
      if (deckHover || Math.floor(now / 400) % 2 === 0) {
        ctx.strokeStyle = '#ffd84a'
        ctx.strokeRect(DRAW_X - layers + 0.5, PILE_Y - layers + 0.5, CARD_W - 1 + layers, CARD_H - 1 + layers)
      }
    }
    drawText(ctx, canDraw ? 'DRAW' : String(v.drawN), DRAW_X + 11, PILE_Y + CARD_H + 3, { align: 'center', color: canDraw ? '#ffd84a' : '#7f8bc4' })

    // Discard pile (the top hides while it's still flying in).
    const flying = new Set(ui.flights.filter((fl) => !fl.back && now < fl.t0 + fl.dur).map((fl) => fl.card))
    const shown = v.pile.filter((c, i) => !(i === v.pile.length - 1 && flying.has(c)))
    for (const c of shown) drawFace(ctx, c, PILE_X + ((c * 7) % 5) - 2, PILE_Y + ((c * 3) % 3) - 1)

    // Current suit: big, color + symbol + name.
    const sc = SUIT_COLOR[v.suit] ?? '#fff'
    box(ctx, BADGE_X, PILE_Y - 2, 34, 34, INK)
    box(ctx, BADGE_X + 1, PILE_Y - 1, 32, 32, sc)
    drawIcon(ctx, SUIT_ICONS[v.suit] ?? SUIT_ICONS[0], BADGE_X + 7, PILE_Y + 1, SUIT_DARK[v.suit] ?? INK, 3)
    drawIcon(ctx, SUIT_ICONS[v.suit] ?? SUIT_ICONS[0], BADGE_X + 6, PILE_Y, '#ffffff', 3)
    drawText(ctx, (SUIT_NAMES[v.suit] ?? '').toUpperCase(), BADGE_X + 17, PILE_Y + 23, { align: 'center', color: '#ffffff', shadow: INK })

    // Players around the table (not you).
    for (let i = 0; i < n; i++) {
      if (i === me) continue
      const p = pos[i]
      const st = seats[i]
      const color = st?.color ?? '#ffffff'
      const bx = p.x - 28
      const by = p.y - 11
      const turn = v.turn === i && !v.over
      const out = v.out[i] === 1
      box(ctx, bx - 1, by - 1, 58, 24, turn ? color : '#2b3460')
      box(ctx, bx, by, 56, 22, out ? '#14161f' : '#101734')
      disc(ctx, bx + 7, by + 8, 3, out ? '#3a3f52' : color)
      if (turn) {
        const lit = Math.ceil((12 * v.tl) / Math.max(1, v.tm))
        for (let k = 0; k < 12; k++) {
          const a = -Math.PI / 2 + (k / 12) * Math.PI * 2
          ctx.fillStyle = k < lit ? (v.tl < 50 ? '#ff5a5f' : '#ffffff') : '#2b3460'
          ctx.fillRect(Math.round(bx + 7 + Math.cos(a) * 6), Math.round(by + 8 + Math.sin(a) * 6), 1, 1)
        }
      }
      drawText(ctx, fit(st?.name ?? `P${i + 1}`, 7), bx + 14, by + 3, { color: out ? '#5b6278' : color })
      if (out) {
        drawText(ctx, 'LEFT', bx + 14, by + 12, { color: '#5b6278' })
        continue
      }
      const count = v.counts[i]
      const fan = Math.min(count, 8)
      for (let k = 0; k < fan; k++) drawBack(ctx, bx + 14 + k * 2, by + 11, true)
      drawText(ctx, String(count), bx + 14 + Math.max(0, fan - 1) * 2 + 9, by + 12, { color: count <= 1 ? '#ffd84a' : '#ffffff' })
      if (v.called[i] && count === 1) {
        box(ctx, bx + 30, by + 11, 25, 9, '#ffd84a')
        drawText(ctx, 'RUSH', bx + 31, by + 12, { color: INK })
      } else if (v.auto[i]) drawText(ctx, 'AUTO', bx + 54, by + 12, { align: 'right', color: '#7f8bc4' })
      if (v.rush === i && me !== null) {
        // Catch! covers the lower half of their box (never a neighbour's).
        const cx = bx + 2
        const cy = by + 10
        const hov = hover(cx, cy, 52, 12)
        button(ctx, cx, cy, 52, 'CATCH!', Math.floor(now / 250) % 2 ? '#ff5a5f' : '#c0303a', '#ffffff', hov)
        hits.push({ x: bx - 1, y: by - 1, w: 58, h: 24, on: () => send({ type: 'catch', seat: i }) })
      }
    }

    // Last move.
    const logY = me === null ? 170 : LOG_Y
    if (v.log) drawText(ctx, fit(v.log, 52), W / 2, logY, { align: 'center', color: '#aab4d4' })

    // Your side: status, buttons, hand.
    if (me !== null && v.hand) {
      const hand = v.hand
      if (v.auto[me]) drawText(ctx, 'AUTOPILOT: ACT TO TAKE OVER', 6, 116, { color: '#7f8bc4' })
      else if (myTurn) drawText(ctx, v.drawn >= 0 ? 'PLAY IT OR PASS' : 'YOUR TURN', 6, 116, { color: '#ffd84a' })
      else if (!v.over) {
        const t = seats[v.turn]
        drawText(ctx, `${fit(t?.name ?? '', 10)}'S TURN`, 6, 116, { color: t?.color ?? '#fff' })
      }
      if (myTurn) {
        const frac = Math.max(0, Math.min(1, v.tl / Math.max(1, v.tm)))
        ctx.fillStyle = '#2b3460'
        ctx.fillRect(6, 126, 90, 3)
        ctx.fillStyle = v.tl < 50 ? '#ff5a5f' : '#ffd84a'
        ctx.fillRect(6, 126, Math.round(90 * frac), 3)
      }

      // RUSH! button.
      const rx = 230
      const ry = 114
      const vulnerable = v.rush === me
      const canPreCall = myTurn && hand.length === 2 && !v.called[me]
      const called = v.called[me] === 1 && hand.length <= 2
      if (vulnerable || canPreCall) {
        const hov = hover(rx, ry, 40, 12)
        const blink = Math.floor(now / 200) % 2 === 0
        button(ctx, rx, ry, 40, 'RUSH!', vulnerable ? (blink ? '#ff5a5f' : '#c0303a') : blink ? '#ffd84a' : '#e0a800', vulnerable ? '#ffffff' : INK, hov)
        hits.push({ x: rx, y: ry, w: 40, h: 12, on: callRush })
      } else button(ctx, rx, ry, 40, called ? 'RUSHED' : 'RUSH', called ? '#2f8a5b' : '#262c48', called ? '#ffffff' : '#5b6278')
      if (myTurn && v.drawn >= 0) {
        const px = 274
        const hov = hover(px, ry, 40, 12)
        button(ctx, px, ry, 40, 'PASS', '#3d9cff', '#ffffff', hov)
        hits.push({ x: px, y: ry, w: 40, h: 12, on: () => send({ type: 'pass' }) })
      }

      // Hand: playable cards raised; the hovered (or keyboard-picked) one more.
      const lay = handLayout(hand)
      const ok = new Set(v.ok)
      if (ui.sel >= hand.length) ui.sel = hand.length - 1
      let hovered = -1
      for (let i = lay.length - 1; i >= 0; i--) {
        const w = i === lay.length - 1 ? CARD_W : lay[i + 1].x - lay[i].x
        if (hover(lay[i].x, HAND_Y - 10, w, H - HAND_Y + 10)) {
          hovered = i
          break
        }
      }
      if (hovered >= 0) ui.sel = -1
      const focus = hovered >= 0 ? hovered : ui.sel
      ui.handX.clear()
      lay.forEach(({ id, x }, i) => {
        const playable = myTurn && ok.has(id)
        const y = HAND_Y - (playable ? 6 : 0) - (i === focus ? 4 : 0)
        ui.handX.set(id, x)
        drawFace(ctx, id, x, y)
        if (myTurn && !playable) {
          ctx.fillStyle = 'rgba(8, 8, 22, 0.5)'
          ctx.fillRect(x, y, CARD_W, CARD_H)
        }
        if (id === v.drawn && Math.floor(now / 300) % 2 === 0) {
          ctx.strokeStyle = '#ffd84a'
          ctx.strokeRect(x - 0.5, y - 0.5, CARD_W + 1, CARD_H + 1)
        }
        if (i === focus) {
          ctx.strokeStyle = playable ? '#ffffff' : '#5b6278'
          ctx.strokeRect(x + 0.5, y + 0.5, CARD_W - 1, CARD_H - 1)
        }
      })
      // Hit areas: later cards lie on top (searched from the end).
      lay.forEach(({ id, x }, i) => {
        const w = i === lay.length - 1 ? CARD_W : lay[i + 1].x - x
        hits.push({ x, y: HAND_Y - 10, w, h: H - HAND_Y + 10, on: () => playCard(id) })
      })
    } else if (seat !== null && v.out[seat]) {
      drawText(ctx, "YOU LEFT: YOU'RE WATCHING", W / 2, 150, { align: 'center', color: '#7f8bc4' })
    }

    // Flights.
    ui.flights = ui.flights.filter((fl) => now < fl.t0 + fl.dur)
    for (const fl of ui.flights) {
      const t = (now - fl.t0) / fl.dur
      if (t < 0) continue
      const e = 1 - (1 - t) * (1 - t)
      const x = fl.x0 + (fl.x1 - fl.x0) * e
      const y = fl.y0 + (fl.y1 - fl.y0) * e - Math.sin(Math.PI * t) * 12
      if (fl.back) drawBack(ctx, x, y)
      else drawFace(ctx, fl.card, x, y)
    }

    // Popups.
    ui.popups = ui.popups.filter((p) => now < p.t0 + p.dur)
    for (const p of ui.popups) {
      const t = (now - p.t0) / p.dur
      if (t < 0) continue
      const bounce = t < 0.15 ? Math.sin((t / 0.15) * Math.PI) * 3 : 0
      const x = Math.max(textWidth(p.text, p.scale) / 2 + 2, Math.min(W - textWidth(p.text, p.scale) / 2 - 2, p.x))
      drawText(ctx, p.text, x, p.y - t * 8 - bounce, { align: 'center', color: p.color, scale: p.scale, shadow: INK })
    }

    // Wild: pick a suit.
    if (ui.picker >= 0) {
      ctx.fillStyle = 'rgba(5, 6, 14, 0.7)'
      ctx.fillRect(0, 0, W, H)
      hits.push({ x: 0, y: 0, w: W, h: H, on: () => (ui.picker = -1) })
      box(ctx, 78, 42, 164, 66, INK)
      box(ctx, 79, 43, 162, 64, '#1d2550')
      drawText(ctx, 'PICK A SUIT', W / 2, 47, { align: 'center', color: '#ffffff' })
      const card = ui.picker
      for (let s = 0; s < 4; s++) {
        const x = 84 + s * 39
        const y = 58
        const hov = hover(x, y, 36, 44)
        box(ctx, x, y, 36, 44, hov ? '#ffffff' : INK)
        box(ctx, x + 1, y + 1, 34, 42, SUIT_COLOR[s])
        drawIcon(ctx, SUIT_ICONS[s], x + 12, y + 7, SUIT_DARK[s], 2)
        drawIcon(ctx, SUIT_ICONS[s], x + 11, y + 6, '#ffffff', 2)
        drawText(ctx, SUIT_NAMES[s].toUpperCase(), x + 18, y + 25, { align: 'center', color: '#ffffff', shadow: INK })
        drawText(ctx, String(s + 1), x + 18, y + 34, { align: 'center', color: SUIT_DARK[s] })
        hits.push({
          x,
          y,
          w: 36,
          h: 44,
          on: () => {
            ui.picker = -1
            send({ type: 'play', card, suit: s })
          },
        })
      }
    }

    // A refused move, briefly.
    if (ui.error && now - ui.errorAt < 2200) {
      const text = fit(ui.error, 50)
      const w = textWidth(text) + 10
      box(ctx, W / 2 - w / 2, 40, w, 13, '#5a1020')
      drawText(ctx, text, W / 2, 43, { align: 'center', color: '#ffd0d0' })
    }

    if (v.over && v.win.length > 0) {
      const names = v.win.map((i) => seats[i]?.name ?? `P${i + 1}`).join(' & ')
      const text = fit(`${names} WINS!`, 40)
      const w = textWidth(text, 1) + 12
      box(ctx, W / 2 - w / 2, 40, w, 13, INK)
      drawText(ctx, text, W / 2, 43, { align: 'center', color: '#ffd84a' })
    }
  }

  const onPointer = (e: { type: 'down' | 'move' | 'up'; x: number; y: number }) => {
    ui.mouse = { x: e.x, y: e.y }
    if (e.type !== 'down') return
    for (let i = ui.hits.length - 1; i >= 0; i--) {
      const h = ui.hits[i]
      if (e.x >= h.x && e.x < h.x + h.w && e.y >= h.y && e.y < h.y + h.h) {
        h.on()
        return
      }
    }
  }

  // Keyboard (optional): ← → pick a card, Space / Enter play it, B draw / pass, R RUSH, 1–4 suit, Esc cancel.
  const keys = useRef<(e: KeyboardEvent) => boolean>(() => false)
  keys.current = (e) => {
    const v = ui.view
    if (!v || ui.me === null || !v.hand) return false
    const hand = v.hand
    if (ui.picker >= 0) {
      const d = Number(e.key)
      if (d >= 1 && d <= 4) {
        const card = ui.picker
        ui.picker = -1
        send({ type: 'play', card, suit: d - 1 })
        return true
      }
      if (e.key === 'Escape') {
        ui.picker = -1
        return true
      }
      return false
    }
    switch (e.code) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (hand.length === 0) return true
        const step = e.code === 'ArrowLeft' ? -1 : 1
        ui.sel = ui.sel < 0 ? (step > 0 ? 0 : hand.length - 1) : (ui.sel + step + hand.length) % hand.length
        ui.mouse = { x: -1, y: -1 }
        return true
      }
      case 'Space':
      case 'Enter':
        if (ui.sel >= 0 && ui.sel < hand.length) playCard(hand[ui.sel])
        return true
      case 'KeyB':
      case 'KeyX':
        drawOrPass()
        return true
      case 'KeyR':
        callRush()
        return true
    }
    return false
  }
  useEffect(() => {
    if (seat === null) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.ctrlKey || e.metaKey || e.altKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return
      if (keys.current(e)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [seat])

  return <RetroCanvas width={W} height={H} draw={draw} onPointer={onPointer} />
}
