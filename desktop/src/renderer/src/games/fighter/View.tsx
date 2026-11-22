// Dojo Duel view: select screen, the stage, fighters (games/fighter/sprites.ts), projectiles, sparks, the HUD
// (health bars with a damage drain, timer, round markers, combo counter) and announcer banners. Positions are
// interpolated between frames; sounds, sparks and shake come from the view's events (each played once).
import { useMemo, useRef } from 'react'
import type { GameSeat } from '@shared/protocol'
import type { FighterView } from '@shared/games/fighter/logic'
import {
  CHARS,
  END_DKO,
  END_TIME,
  EV_ARMOR,
  EV_BLOCK,
  EV_CLASH,
  EV_FIGHT,
  EV_HIT_H,
  EV_HIT_L,
  EV_KO,
  EV_LOCK,
  EV_PROJ,
  EV_ROUND,
  EV_SEL,
  EV_SPECIAL,
  EV_THROW,
  EV_THUD,
  EV_TIME,
  EV_WHOOSH,
  FIGHT_AT,
  IDLE,
  MAX_ROUNDS,
  PH_END,
  PH_FIGHT,
  PH_INTRO,
  PH_OVER,
  PH_SELECT,
  WINS_NEEDED,
} from '@shared/games/fighter/chars'
import type { GameViewProps } from '../types'
import { RetroCanvas, drawText, eventPlayer, lerp, sfx, textWidth } from '../retro'
import { drawFighter, frameOf } from './sprites'
import { GROUND_Y, VIEW_H, VIEW_W, disc, drawStage } from './stage'

interface Spark {
  k: number
  x: number
  y: number
  at: number
  color: string
  dir: number
}

interface Local {
  /** The match these belong to (the view stays mounted for "play again": event ids restart). */
  match: string | null
  sparks: Spark[]
  shakeUntil: number
  shakeAmp: number
  flashUntil: number
  /** Health shown in the drain segment (per seat) and when it may start falling. */
  drain: number[]
  drainAt: number[]
  lastHp: number[]
  play: (events: readonly Ev[]) => void
}

interface Ev {
  id: number
  e: number[]
}

const FALLBACK = ['#ff5a5f', '#3d9cff']

/** Text the 5×7 font can draw (uppercase letters, digits, a little punctuation). */
function label(name: string, max = 10): string {
  const s = name
    .toUpperCase()
    .replace(/[^A-Z0-9 .!?'-]/g, '')
    .trim()
  return s.slice(0, max)
}

function newLocal(match: string | null, seats: GameSeat[]): Local {
  const L: Local = {
    match,
    sparks: [],
    shakeUntil: 0,
    shakeAmp: 0,
    flashUntil: 0,
    drain: [1, 1],
    drainAt: [0, 0],
    lastHp: [-1, -1],
    play: () => {},
  }
  L.play = eventPlayer<Ev>(({ e }) => onEvent(L, e, seats))
  return L
}

export default function FighterGame({ lobby, seats, frames }: GameViewProps<FighterView>) {
  const local = useRef<Local | null>(null)
  const match = lobby.matchId ?? null
  if (!local.current || local.current.match !== match) local.current = newLocal(match, seats)
  const names = useMemo(() => [0, 1].map((i) => label(seats[i]?.name ?? `P${i + 1}`) || `P${i + 1}`), [seats])
  const colors = useMemo(() => [0, 1].map((i) => seats[i]?.color ?? FALLBACK[i]), [seats])

  return (
    <RetroCanvas
      width={VIEW_W}
      height={VIEW_H}
      draw={(g, now) => {
        const L = local.current!
        const sample = frames.sample(now)
        if (!sample) {
          drawStage(g, 96, now)
          g.fillStyle = 'rgba(0, 0, 0, 0.5)'
          g.fillRect(0, 0, VIEW_W, VIEW_H)
          drawText(g, 'DOJO DUEL', VIEW_W / 2, 70, { align: 'center', scale: 3, color: '#ffd23f', shadow: '#000' })
          return
        }
        const { a, b, t } = sample
        const v = t < 0.5 ? a.view : b.view
        // Events of everything up to the frame being shown.
        L.play(a.view.e.map((e) => ({ id: e[0], e })))
        if (t >= 0.5) L.play(b.view.e.map((e) => ({ id: e[0], e })))
        drawFrame(g, now, L, a.view, b.view, t, v, names, colors)
      }}
    />
  )
}

function onEvent(L: Local, e: number[], seats: GameSeat[]) {
  const [, k, x, y, seat] = e
  const now = performance.now()
  const color = seats[seat]?.color ?? '#ffffff'
  switch (k) {
    case EV_HIT_L:
      sfx.noise({ ms: 60, volume: 0.6, lowpass: 3500 })
      sfx.tone({ freq: 240, to: 110, ms: 70, volume: 0.45 })
      L.sparks.push({ k, x, y, at: now, color, dir: 0 })
      break
    case EV_HIT_H:
      sfx.hit()
      sfx.tone({ freq: 90, to: 40, ms: 160, type: 'triangle', volume: 0.8 })
      L.sparks.push({ k, x, y, at: now, color, dir: 0 })
      L.shakeUntil = now + 180
      L.shakeAmp = 2
      break
    case EV_BLOCK:
      sfx.tone({ freq: 1100, to: 700, ms: 45, volume: 0.35 })
      sfx.noise({ ms: 40, volume: 0.3, lowpass: 6000 })
      L.sparks.push({ k, x, y, at: now, color: '#9fd8ff', dir: 0 })
      break
    case EV_PROJ:
      sfx.tone({ freq: 220, to: 880, ms: 220, type: 'sawtooth', volume: 0.3 })
      sfx.tone({ freq: 440, to: 1320, ms: 180, volume: 0.2, delay: 30 })
      break
    case EV_SPECIAL:
      sfx.tone({ freq: 330, to: 660, ms: 110, volume: 0.3 })
      break
    case EV_WHOOSH:
      sfx.noise({ ms: 90, volume: 0.18, lowpass: 1400 })
      break
    case EV_THROW:
      sfx.tone({ freq: 160, to: 90, ms: 120, type: 'triangle', volume: 0.6 })
      break
    case EV_THUD:
      sfx.noise({ ms: 160, volume: 0.6, lowpass: 600 })
      L.sparks.push({ k, x, y: 0, at: now, color: '#c8a888', dir: 0 })
      break
    case EV_CLASH:
      sfx.explode()
      L.sparks.push({ k, x, y, at: now, color: '#ffffff', dir: 0 })
      break
    case EV_ARMOR:
      sfx.tone({ freq: 700, to: 500, ms: 120, type: 'square', volume: 0.4 })
      L.sparks.push({ k, x, y, at: now, color: '#ffa040', dir: 0 })
      break
    case EV_KO:
      sfx.explode()
      ;[392, 330, 262, 196, 131].forEach((f, i) => sfx.tone({ freq: f, ms: 200, type: 'square', volume: 0.45, delay: 250 + i * 140 }))
      L.shakeUntil = now + 400
      L.shakeAmp = 3
      L.flashUntil = now + 120
      break
    case EV_ROUND:
      sfx.countdown(false)
      break
    case EV_FIGHT:
      sfx.countdown(true)
      sfx.noise({ ms: 300, volume: 0.25, lowpass: 2000, delay: 60 })
      break
    case EV_TIME:
      ;[523, 523, 392].forEach((f, i) => sfx.tone({ freq: f, ms: 160, volume: 0.5, delay: i * 180 }))
      break
    case EV_SEL:
      sfx.blip()
      break
    case EV_LOCK:
      sfx.select()
      break
  }
  if (L.sparks.length > 24) L.sparks.splice(0, L.sparks.length - 24)
}

// ---------------------------------------------------------------------------------------------

function drawFrame(
  g: CanvasRenderingContext2D,
  now: number,
  L: Local,
  a: FighterView,
  b: FighterView,
  t: number,
  v: FighterView,
  names: string[],
  colors: string[],
) {
  if (v.ph === PH_SELECT) {
    drawSelect(g, now, v, names, colors)
    return
  }
  const same = a.rd === b.rd
  const cam = same ? lerp(a.cam, b.cam, t) : v.cam
  let sx = 0
  let sy = 0
  if (now < L.shakeUntil) {
    sx = Math.round(Math.sin(now * 0.9) * L.shakeAmp)
    sy = Math.round(Math.cos(now * 1.3) * L.shakeAmp * 0.5)
  }
  g.save()
  g.translate(sx, sy)
  drawStage(g, cam, now)
  const toX = (wx: number) => Math.round(wx - cam)
  const toY = (wy: number) => Math.round(GROUND_Y - wy)

  // Shadows.
  g.fillStyle = 'rgba(20, 8, 16, 0.45)'
  for (const f of v.f) {
    const w = Math.max(6, 16 - f[2] / 8) * CHARS[f[0]].scale
    g.fillRect(toX(f[1]) - Math.round(w), GROUND_Y - 1, Math.round(w * 2), 3)
  }
  // Fighters: the one attacking (or the newer action) in front.
  const pos = v.f.map((f, i) => {
    const fa = a.f[i]
    const fb = b.f[i]
    const ok = same && Math.abs(fb[1] - fa[1]) < 48
    return { x: ok ? lerp(fa[1], fb[1], t) : f[1], y: ok ? lerp(fa[2], fb[2], t) : f[2], vy: fb[2] - fa[2] }
  })
  const order = v.f[1][4] === 7 ? [0, 1] : [1, 0]
  for (const i of order) {
    const f = v.f[i]
    const fr = frameOf(f[0], f[4], f[5], f[6], f[8], pos[i].vy)
    if (f[8] & 8 && Math.floor(now / 70) % 2) fr.variant = 2
    drawFighter(g, f[0], colors[i], fr, toX(pos[i].x), toY(pos[i].y), f[3])
  }
  // Projectiles.
  for (const p of v.p) {
    const kind = CHARS[v.f[p[0]][0]].moves[p[3]]?.proj?.kind ?? 0
    const pa = a.p.find((q) => q[0] === p[0] && q[3] === p[3])
    const pb = b.p.find((q) => q[0] === p[0] && q[3] === p[3])
    const px = pa && pb && same ? lerp(pa[1], pb[1], t) : p[1]
    const dir = pa && pb && pb[1] !== pa[1] ? Math.sign(pb[1] - pa[1]) : v.f[p[0]][3]
    drawProjectile(g, kind, toX(px), toY(p[2]), dir, p[4], colors[p[0]], now)
  }
  // Sparks.
  L.sparks = L.sparks.filter((s) => now - s.at < 320)
  for (const s of L.sparks) drawSpark(g, s, now - s.at, toX(s.x), toY(s.y))
  g.restore()

  if (now < L.flashUntil) {
    g.fillStyle = 'rgba(255, 255, 255, 0.55)'
    g.fillRect(0, 0, VIEW_W, VIEW_H)
  }
  drawHud(g, now, L, v, names, colors)
  drawBanners(g, now, v, names, colors)
}

function drawProjectile(g: CanvasRenderingContext2D, kind: number, x: number, y: number, dir: number, age: number, color: string, now: number) {
  if (kind === 1) {
    // Wind Needle: a bright streak with a fading tail.
    const back = dir > 0 ? -1 : 1
    g.fillStyle = color
    g.fillRect(Math.min(x, x + back * 22), y - 1, 22, 1)
    g.fillRect(Math.min(x, x + back * 14), y + 1, 14, 1)
    g.fillStyle = '#ffffff'
    g.fillRect(Math.min(x, x + back * 12), y - 1, 12, 2)
    if (Math.floor(now / 50) % 2) {
      g.fillRect(x, y - 3, 1, 6)
      g.fillRect(x - 2, y, 5, 1)
    }
    return
  }
  const pulse = Math.floor(now / 80) % 2
  for (let k = 3; k >= 1; k--) {
    g.globalAlpha = 0.25 * (4 - k)
    disc(g, x - dir * k * 6, y, 6 - k, color)
  }
  g.globalAlpha = 1
  disc(g, x, y, 8 + pulse, color)
  disc(g, x + dir, y, 6, '#ffffff')
  disc(g, x + dir * 2, y - 1, 3, '#fffbe0')
  if (age < 6) disc(g, x - dir * 4, y, 10 - age, 'rgba(255,255,255,0.5)')
}

function drawSpark(g: CanvasRenderingContext2D, s: Spark, ms: number, x: number, y: number) {
  const k = ms / 320
  if (s.k === EV_THUD) {
    g.fillStyle = `rgba(200, 168, 136, ${0.7 * (1 - k)})`
    for (let i = -2; i <= 2; i++) disc(g, x + i * (6 + k * 10), y - 2 - k * 4, 3 + k * 2, g.fillStyle as string)
    return
  }
  if (s.k === EV_CLASH || s.k === EV_ARMOR) {
    const r = 4 + k * 18
    g.fillStyle = s.color
    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * Math.PI * 2
      g.fillRect(Math.round(x + Math.cos(ang) * r), Math.round(y - Math.sin(ang) * r), 2, 2)
    }
    return
  }
  const heavy = s.k === EV_HIT_H
  const block = s.k === EV_BLOCK
  const rays = heavy ? 10 : block ? 6 : 7
  const len = (heavy ? 16 : block ? 8 : 10) * Math.min(1, k * 3)
  const inner = (heavy ? 6 : 3) * k * 2
  if (k < 0.18) disc(g, x, y, heavy ? 7 : 4, block ? '#e8f6ff' : '#ffffff')
  for (let i = 0; i < rays; i++) {
    const ang = (i / rays) * Math.PI * 2 + (heavy ? 0.2 : 0.5)
    const c = Math.cos(ang)
    const sn = Math.sin(ang)
    for (let d = inner; d < inner + len; d += 1) {
      g.fillStyle = d < inner + len * 0.4 ? '#ffffff' : block ? '#9fd8ff' : heavy ? '#ffb02e' : '#ffe14a'
      g.fillRect(Math.round(x + c * d), Math.round(y - sn * d), 1, 1)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// HUD

const BAR_W = 128
const BAR_Y = 8

function drawHud(g: CanvasRenderingContext2D, now: number, L: Local, v: FighterView, names: string[], colors: string[]) {
  for (let i = 0; i < 2; i++) {
    const f = v.f[i]
    const max = CHARS[f[0]].hp
    const hp = Math.max(0, f[7]) / max
    // Damage drain: follows after a short delay.
    if (hp > L.drain[i] || L.lastHp[i] < 0) L.drain[i] = hp
    if (hp < L.lastHp[i]) L.drainAt[i] = now + 450
    L.lastHp[i] = hp
    if (now > L.drainAt[i] && L.drain[i] > hp) L.drain[i] = Math.max(hp, L.drain[i] - 0.006)
    const x0 = i === 0 ? 12 : VIEW_W - 12 - BAR_W
    g.fillStyle = '#100810'
    g.fillRect(x0 - 2, BAR_Y - 2, BAR_W + 4, 11)
    g.fillStyle = '#5a1220'
    g.fillRect(x0, BAR_Y, BAR_W, 7)
    // Health is anchored at the center (by the timer) and drains toward the outer edge; the drain segment
    // (recent damage) follows it after a moment. `seg(from, to)`: fractions measured from the center.
    const seg = (from: number, to: number, color: string) => {
      const w = Math.round(to * BAR_W) - Math.round(from * BAR_W)
      if (w <= 0) return
      g.fillStyle = color
      if (i === 0) g.fillRect(x0 + BAR_W - Math.round(to * BAR_W), BAR_Y, w, 7)
      else g.fillRect(x0 + Math.round(from * BAR_W), BAR_Y, w, 7)
    }
    seg(hp, L.drain[i], '#ff6a3a')
    const low = hp < 0.25 && Math.floor(now / 200) % 2
    seg(0, hp, low ? '#ff3a2a' : '#ffd23f')
    g.fillStyle = 'rgba(255,255,255,0.35)'
    g.fillRect(x0, BAR_Y, BAR_W, 1)
    // Seat color edge.
    g.fillStyle = colors[i]
    g.fillRect(i === 0 ? x0 - 2 : x0 + BAR_W, BAR_Y - 2, 2, 11)
    // Name and fighter.
    drawText(g, names[i], i === 0 ? x0 : x0 + BAR_W, BAR_Y + 12, { color: colors[i], align: i === 0 ? 'left' : 'right', shadow: '#000' })
    // The fighter's name inside the bar, at the outer end.
    drawText(g, CHARS[f[0]].name, i === 0 ? x0 + 2 : x0 + BAR_W - 2, BAR_Y, { color: '#ffffff', align: i === 0 ? 'left' : 'right', shadow: '#3a0a14' })
    // Round wins.
    for (let k = 0; k < WINS_NEEDED; k++) {
      const mx = i === 0 ? x0 + BAR_W - 8 - k * 9 : x0 + 2 + k * 9
      const my = BAR_Y + 12
      g.fillStyle = '#100810'
      g.fillRect(mx - 1, my - 1, 8, 8)
      g.fillStyle = k < v.w[i] ? '#ffd23f' : '#3a2a3a'
      g.fillRect(mx, my, 6, 6)
      if (k < v.w[i]) {
        g.fillStyle = '#fff6c0'
        g.fillRect(mx + 1, my + 1, 2, 2)
      }
    }
    // Combo counter.
    const combo = f[9]
    if (combo >= 2 && v.ph === PH_FIGHT) {
      const text = `${combo} HITS`
      const y = 46
      drawText(g, text, i === 0 ? 10 : VIEW_W - 10, y, { scale: 2, color: colors[i], align: i === 0 ? 'left' : 'right', shadow: '#000' })
      drawText(g, 'COMBO!', i === 0 ? 10 : VIEW_W - 10, y + 16, { color: '#ffd23f', align: i === 0 ? 'left' : 'right', shadow: '#000' })
    }
  }
  // Timer.
  g.fillStyle = '#100810'
  g.fillRect(VIEW_W / 2 - 13, 3, 26, 20)
  g.fillStyle = '#2a1830'
  g.fillRect(VIEW_W / 2 - 12, 4, 24, 18)
  const tm = String(Math.max(0, Math.min(99, v.tm))).padStart(2, '0')
  const urgent = v.ph === PH_FIGHT && v.tm <= 10 && Math.floor(now / 250) % 2
  drawText(g, tm, VIEW_W / 2, 6, { scale: 2, align: 'center', color: urgent ? '#ff5a3a' : '#ffffff', shadow: '#000' })
}

function banner(g: CanvasRenderingContext2D, text: string, y: number, scale: number, color: string, band = true) {
  const w = textWidth(text, scale)
  if (band) {
    g.fillStyle = 'rgba(16, 8, 16, 0.55)'
    g.fillRect(0, y - 6, VIEW_W, 7 * scale + 12)
    g.fillStyle = color
    g.fillRect(0, y - 6, VIEW_W, 1)
    g.fillRect(0, y + 7 * scale + 5, VIEW_W, 1)
  }
  if (w > VIEW_W - 8) scale = Math.max(1, Math.floor(scale * ((VIEW_W - 8) / w)))
  drawText(g, text, VIEW_W / 2, y, { scale, align: 'center', color, shadow: '#000' })
}

function drawBanners(g: CanvasRenderingContext2D, now: number, v: FighterView, names: string[], colors: string[]) {
  const final = v.rd >= MAX_ROUNDS || (v.w[0] === WINS_NEEDED - 1 && v.w[1] === WINS_NEEDED - 1)
  if (v.ph === PH_INTRO) {
    if (v.pt < FIGHT_AT) banner(g, final ? 'FINAL ROUND' : `ROUND ${v.rd}`, 66, 3, '#ffe9a8')
    else banner(g, 'FIGHT!', 62, 5, '#ff7a3a')
  } else if (v.ph === PH_FIGHT && v.pt < 20) {
    banner(g, 'FIGHT!', 62, 5, '#ff7a3a', false)
  } else if (v.ph === PH_END || v.ph === PH_OVER) {
    const pt = v.ph === PH_OVER ? 999 : v.pt
    if (pt < 80) {
      if (v.ek === END_TIME) banner(g, 'TIME', 62, 5, '#9fd8ff')
      else if (Math.floor(now / 120) % 4 !== 0 || pt > 40) banner(g, v.ek === END_DKO ? 'DOUBLE K.O.' : 'K.O.', 58, v.ek === END_DKO ? 4 : 6, '#ff4a3a')
    } else {
      const overall = v.ph === PH_OVER || v.w.some((w) => w >= WINS_NEEDED)
      if (v.rw >= 0) {
        banner(g, `${names[v.rw]} WINS`, 60, 3, colors[v.rw])
        if (v.pf) drawText(g, 'PERFECT!', VIEW_W / 2, 92, { scale: 3, align: 'center', color: Math.floor(now / 150) % 2 ? '#ffd23f' : '#ffffff', shadow: '#000' })
        else if (overall) drawText(g, 'THE DOJO IS YOURS', VIEW_W / 2, 92, { scale: 1, align: 'center', color: '#ffe9a8', shadow: '#000' })
      } else banner(g, 'DRAW', 60, 4, '#d8c8b0')
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Select screen

function drawSelect(g: CanvasRenderingContext2D, now: number, v: FighterView, names: string[], colors: string[]) {
  drawStage(g, 96, now)
  g.fillStyle = 'rgba(12, 6, 16, 0.72)'
  g.fillRect(0, 0, VIEW_W, VIEW_H)
  drawText(g, 'CHOOSE YOUR FIGHTER', VIEW_W / 2, 8, { scale: 2, align: 'center', color: '#ffd23f', shadow: '#000' })
  drawText(g, String(v.st), VIEW_W - 8, 10, { align: 'right', color: v.st <= 3 ? '#ff5a3a' : '#ffffff', shadow: '#000' })
  const cw = 92
  const ch = 118
  const top = 28
  CHARS.forEach((c, k) => {
    const cx = 60 + k * 100
    const x0 = cx - cw / 2
    const pickers = [0, 1].filter((i) => v.sel[i][0] === k)
    g.fillStyle = '#1c1024'
    g.fillRect(x0, top, cw, ch)
    g.fillStyle = '#2c1a34'
    g.fillRect(x0 + 2, top + 2, cw - 4, 80)
    // A floor line and the fighter in the color of whoever points at it.
    g.fillStyle = '#4a2a3a'
    g.fillRect(x0 + 2, top + 76, cw - 4, 6)
    const tint = pickers.length ? colors[pickers[pickers.length - 1]] : '#8a8f9e'
    const fr = frameOf(k, IDLE, Math.floor(now / 16.7), -1, 0, 0)
    g.save()
    g.beginPath()
    g.rect(x0 + 2, top + 2, cw - 4, 80)
    g.clip()
    drawFighter(g, k, tint, fr, cx, top + 78, 1)
    g.restore()
    drawText(g, c.name, cx, top + 88, { scale: 2, align: 'center', color: '#ffffff', shadow: '#000' })
    drawText(g, c.style, cx, top + 106, { align: 'center', color: '#c8b8d8' })
    pickers.forEach((i, n) => {
      const locked = v.sel[i][1] === 1
      if (!locked && Math.floor(now / 200) % 2 && n === 0 && pickers.length === 1) return
      const inset = n * 3
      g.strokeStyle = colors[i]
      g.lineWidth = locked ? 2 : 1
      g.strokeRect(x0 + inset + 0.5, top + inset + 0.5, cw - inset * 2 - 1, ch - inset * 2 - 1)
      const tag = `${i + 1}P${locked ? ' OK' : ''}`
      drawText(g, tag, i === 0 ? x0 + 4 : x0 + cw - 4, top + 4, { align: i === 0 ? 'left' : 'right', color: colors[i], shadow: '#000' })
    })
  })
  ;[0, 1].forEach((i) => {
    drawText(g, `${i + 1}P ${names[i]}`, i === 0 ? 10 : VIEW_W - 10, 156, { align: i === 0 ? 'left' : 'right', color: colors[i], shadow: '#000' })
  })
  const ready = v.sel.every((s) => s[1] === 1)
  drawText(g, ready ? 'READY!' : 'LEFT / RIGHT  PICK     A  LOCK IN', VIEW_W / 2, 170, { align: 'center', color: ready ? '#ffd23f' : '#9a8aa8' })
}
