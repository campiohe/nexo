// Blast Arena view (shared/games/bomber): a 384×216 pixel canvas with the 15×13 arena (16 px tiles) in the middle
// and a side panel per seat (name, round wins, power-ups). Positions are interpolated between frames; sounds come
// from the view's events (played once each). Everything is drawn in code (art.ts).
import { useMemo } from 'react'
import type { GameViewProps } from '../types'
import { RetroCanvas, drawText, eventPlayer, lerp, sfx, textWidth } from '../retro'
import {
  BREAK_T,
  EV_BOOM,
  EV_BURN,
  EV_COUNT,
  EV_DIE,
  EV_DROP,
  EV_GO,
  EV_KICK,
  EV_PICK,
  EV_ROUND,
  EV_SHIELD,
  EV_SUDDEN,
  EV_THUD,
  FALL_T,
  FIRE_T,
  H,
  PF_ALIVE,
  PF_GONE,
  PF_INVULN,
  PF_KICK,
  PF_MOVING,
  PF_SHIELD,
  PF_TRIGGER,
  PH_END,
  PH_INTRO,
  PH_OVER,
  PH_PLAY,
  PH_RESULT,
  ROUND_T,
  TICK_HZ,
  TILE,
  W,
  type BomberView,
} from '@shared/games/bomber/core'
import { BOMB, BOMB_BIG, FLASH_PALETTE, ITEM_COLORS, WALK, bombPalette, botPalette, botSprite, iconSprite, mix, sprite } from './art'

const VW = 384
const VH = 216
const TS = 16
/** Arena origin on the canvas. */
const OX = 72
const OY = 4
/** Sub-tile units per pixel. */
const U = TILE / TS
const BG = '#10131c'
/** Side panels by seat, near each seat's spawn corner. */
const PANELS: readonly [number, number][] = [
  [2, 2],
  [314, 130],
  [314, 2],
  [2, 130],
]
const PANEL_W = 68
const PANEL_H = 84

interface Ev {
  id: number
  k: number
  a: number
  b: number
}

/** Names in the 5×7 font: ASCII letters, digits and a few signs. */
function clean(name: string, max: number): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .!?:\-+'_#*]/g, '')
    .trim()
  const out = s || '???'
  return out.length > max ? out.slice(0, max - 1) + '.' : out
}

function fmtTime(ticks: number): string {
  const secs = Math.max(0, Math.ceil(ticks / TICK_HZ))
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------------------------
// Tiles

function drawFloor(ctx: CanvasRenderingContext2D, g: string) {
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const px = OX + x * TS
      const py = OY + y * TS
      ctx.fillStyle = (x + y) % 2 ? '#2c3d3a' : '#30433f'
      ctx.fillRect(px, py, TS, TS)
      ctx.fillStyle = '#26352f'
      ctx.fillRect(px, py, TS, 1)
      ctx.fillRect(px, py, 1, TS)
      // Shadow cast by a solid tile above.
      const above = g[(y - 1) * W + x]
      if (above === '#' || above === '%' || above === 'X' || above === '*') {
        ctx.fillStyle = 'rgba(8,12,12,0.45)'
        ctx.fillRect(px, py, TS, 4)
      }
    }
  }
}

function drawPillar(ctx: CanvasRenderingContext2D, px: number, py: number, border: boolean) {
  const top = border ? '#4a5368' : '#7a859b'
  const face = border ? '#333a4b' : '#525b70'
  const hi = border ? '#5f6a82' : '#a9b3c7'
  ctx.fillStyle = '#1b1f2a'
  ctx.fillRect(px, py, TS, TS)
  ctx.fillStyle = top
  ctx.fillRect(px, py, TS, 12)
  ctx.fillStyle = face
  ctx.fillRect(px, py + 12, TS, 4)
  ctx.fillStyle = hi
  ctx.fillRect(px, py, TS, 1)
  ctx.fillRect(px, py, 1, 12)
  ctx.fillStyle = border ? '#262c3a' : '#3f4759'
  ctx.fillRect(px + TS - 1, py + 1, 1, 11)
  ctx.fillRect(px, py + 11, TS, 1)
  if (!border) {
    ctx.fillStyle = '#d0d6e3'
    for (const [rx, ry] of [[3, 3], [12, 3], [3, 8], [12, 8]]) ctx.fillRect(px + rx, py + ry, 1, 1)
    ctx.fillStyle = '#5c6579'
    ctx.fillRect(px + 5, py + 5, 6, 2)
  } else {
    ctx.fillStyle = '#3c4457'
    ctx.fillRect(px + 2, py + 4, 12, 1)
    ctx.fillRect(px + 2, py + 8, 12, 1)
  }
}

function drawCrate(ctx: CanvasRenderingContext2D, px: number, py: number) {
  ctx.fillStyle = '#4a2c10'
  ctx.fillRect(px, py, TS, TS)
  ctx.fillStyle = '#b57c3f'
  ctx.fillRect(px + 1, py + 1, TS - 2, 11)
  ctx.fillStyle = '#8a5a2b'
  ctx.fillRect(px + 1, py + 12, TS - 2, 3)
  ctx.fillStyle = '#d9a062'
  ctx.fillRect(px + 1, py + 1, TS - 2, 1)
  ctx.fillStyle = '#7d5226'
  ctx.fillRect(px + 1, py + 5, TS - 2, 1)
  ctx.fillRect(px + 1, py + 9, TS - 2, 1)
  ctx.fillRect(px + 5, py + 2, 1, 3)
  ctx.fillRect(px + 10, py + 6, 1, 3)
  ctx.fillStyle = '#ecd2a0'
  for (const [rx, ry] of [[2, 2], [13, 2], [2, 10], [13, 10]]) ctx.fillRect(px + rx, py + ry, 1, 1)
}

function drawBlock(ctx: CanvasRenderingContext2D, px: number, py: number) {
  ctx.fillStyle = '#16080c'
  ctx.fillRect(px, py, TS, TS)
  ctx.fillStyle = '#6b2232'
  ctx.fillRect(px + 1, py + 1, TS - 2, 11)
  ctx.fillStyle = '#e8b23a'
  for (let i = -12; i < 16; i += 6) {
    for (let k = 0; k < 3; k++) {
      for (let y = 0; y < 11; y++) {
        const x = i + k + y
        if (x >= 0 && x < TS - 2) ctx.fillRect(px + 1 + x, py + 1 + y, 1, 1)
      }
    }
  }
  ctx.fillStyle = '#441520'
  ctx.fillRect(px + 1, py + 12, TS - 2, 3)
  ctx.fillStyle = 'rgba(255,255,255,0.25)'
  ctx.fillRect(px + 1, py + 1, TS - 2, 1)
}

let blockImg: HTMLCanvasElement | null = null
function blockSprite(): HTMLCanvasElement {
  if (!blockImg) {
    blockImg = document.createElement('canvas')
    blockImg.width = TS
    blockImg.height = TS
    drawBlock(blockImg.getContext('2d')!, 0, 0)
  }
  return blockImg
}

function drawDebris(ctx: CanvasRenderingContext2D, px: number, py: number, left: number) {
  const k = 1 - left / BREAK_T
  const alpha = Math.max(0, 1 - k)
  // Smoke
  ctx.fillStyle = `rgba(190,180,165,${0.5 * alpha})`
  const r = 4 + k * 6
  ctx.fillRect(px + 8 - r, py + 8 - r / 2, r * 2, r)
  ctx.fillRect(px + 8 - r / 2, py + 8 - r, r, r * 2)
  // Planks flying out
  const bits: [number, number, string][] = [
    [-1, -1, '#b57c3f'],
    [1, -1, '#d9a062'],
    [-1, 0.4, '#8a5a2b'],
    [1, 0.5, '#b57c3f'],
    [0, -1.3, '#7d5226'],
    [0.3, 1, '#d9a062'],
  ]
  for (const [dx, dy, c] of bits) {
    const x = px + 7 + dx * k * 11
    const y = py + 7 + dy * k * 11 + k * k * 8
    ctx.fillStyle = c
    ctx.globalAlpha = alpha
    ctx.fillRect(Math.round(x), Math.round(y), 3, 2)
    ctx.globalAlpha = 1
  }
}

function drawItem(ctx: CanvasRenderingContext2D, px: number, py: number, item: number, now: number) {
  const color = ITEM_COLORS[item] ?? '#ffffff'
  const blink = Math.floor(now / 220) % 2 === 0
  ctx.fillStyle = '#0b0d14'
  ctx.fillRect(px + 1, py + 2, 14, 13)
  ctx.fillStyle = color
  ctx.fillRect(px + 2, py + 2, 12, 12)
  ctx.fillStyle = mix(color, '#ffffff', 0.4)
  ctx.fillRect(px + 2, py + 2, 12, 1)
  ctx.fillStyle = mix(color, '#000000', 0.35)
  ctx.fillRect(px + 2, py + 13, 12, 1)
  if (blink) {
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1
    ctx.strokeRect(px + 1.5, py + 1.5, 13, 13)
  }
  ctx.drawImage(iconSprite(item), px + 4, py + 4)
}

// ---------------------------------------------------------------------------------------------
// Blasts: per burning tile, bands toward burning neighbors (outer orange, yellow, white core).

function drawFire(ctx: CanvasRenderingContext2D, f: string, t: number, now: number) {
  const layers: [string, number][] = [
    ['#ff4d1a', 1],
    ['#ffb21f', 0.66],
    ['#fff5d1', 0.3],
  ]
  const on = (x: number, y: number) => x > 0 && y > 0 && x < W - 1 && y < H - 1 && f[y * W + x] !== '.'
  for (const [color, scale] of layers) {
    ctx.fillStyle = color
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const ch = f[y * W + x]
        if (ch === '.') continue
        const left = Math.max(0, ch.charCodeAt(0) - 96 - t)
        const life = left / FIRE_T
        const flick = (Math.floor(now / 60) + x * 3 + y) % 3 === 0 ? 1 : 0
        const full = life > 0.85 ? 10 + ((1 - life) / 0.15) * 4 : 3 + (life / 0.85) * 11
        const w = Math.max(1, Math.round((full + flick) * scale))
        const cx = OX + x * TS + 8
        const cy = OY + y * TS + 8
        const h0 = Math.floor(w / 2)
        ctx.fillRect(cx - h0, cy - h0, w, w)
        if (on(x - 1, y)) ctx.fillRect(OX + x * TS, cy - h0, 8, w)
        if (on(x + 1, y)) ctx.fillRect(cx, cy - h0, 8, w)
        if (on(x, y - 1)) ctx.fillRect(cx - h0, OY + y * TS, w, 8)
        if (on(x, y + 1)) ctx.fillRect(cx - h0, cy, w, 8)
        if (scale === 1 && w > 5) {
          // Flickering tongues along the flame's edges.
          const ph = (Math.floor(now / 70) + x + y * 2) % 4
          const horiz = on(x - 1, y) || on(x + 1, y)
          if (horiz) {
            ctx.fillRect(OX + x * TS + 2 + ph * 3, cy - h0 - 1, 2, 1)
            ctx.fillRect(OX + x * TS + 12 - ph * 3, cy - h0 + w, 2, 1)
          }
          if (on(x, y - 1) || on(x, y + 1) || !horiz) {
            ctx.fillRect(cx - h0 - 1, OY + y * TS + 2 + ph * 3, 1, 2)
            ctx.fillRect(cx - h0 + w, OY + y * TS + 12 - ph * 3, 1, 2)
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// HUD

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, edge: string) {
  ctx.fillStyle = '#181c28'
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = edge
  ctx.fillRect(x, y, w, 2)
  ctx.fillStyle = '#262c3d'
  ctx.fillRect(x, y + h - 1, w, 1)
}

function banner(ctx: CanvasRenderingContext2D, text: string, y: number, scale: number, color: string, sub?: string) {
  const cx = OX + (W * TS) / 2
  const w = Math.max(textWidth(text, scale), sub ? textWidth(sub) : 0) + 16
  const h = 7 * scale + (sub ? 14 : 0) + 10
  ctx.fillStyle = 'rgba(8,10,16,0.78)'
  ctx.fillRect(Math.round(cx - w / 2), y - 5, Math.round(w), h)
  ctx.fillStyle = color
  ctx.fillRect(Math.round(cx - w / 2), y - 5, Math.round(w), 1)
  ctx.fillRect(Math.round(cx - w / 2), y - 5 + h - 1, Math.round(w), 1)
  drawText(ctx, text, cx, y, { align: 'center', scale, color, shadow: '#000000' })
  if (sub) drawText(ctx, sub, cx, y + 7 * scale + 5, { align: 'center', color: '#c9d1e4', shadow: '#000000' })
}

// ---------------------------------------------------------------------------------------------

export default function BomberView({ seats, seat, frames, lobby }: GameViewProps<BomberView>) {
  const onEvents = useMemo(() => {
    let primed = false
    let lastBoom = 0
    let lastThud = 0
    const play = eventPlayer<Ev>((e) => {
      if (!primed) return
      const now = performance.now()
      switch (e.k) {
        case EV_DROP:
          sfx.tone({ freq: 240, to: 150, ms: 70, volume: e.a === seat ? 0.45 : 0.25 })
          break
        case EV_BOOM:
          if (now - lastBoom > 70) sfx.explode()
          lastBoom = now
          break
        case EV_PICK:
          if (e.a === seat) sfx.powerup()
          else sfx.tone({ freq: 990, ms: 50, volume: 0.25 })
          break
        case EV_DIE:
          sfx.hit()
          sfx.tone({ freq: 660, to: 110, ms: 420, type: 'triangle', volume: 0.5, delay: 60 })
          break
        case EV_KICK:
          sfx.tone({ freq: 520, to: 260, ms: 60, volume: 0.45 })
          break
        case EV_SHIELD:
          sfx.tone({ freq: 1400, to: 500, ms: 220, type: 'triangle', volume: 0.55 })
          break
        case EV_COUNT:
          sfx.countdown(false)
          break
        case EV_GO:
          sfx.countdown(true)
          break
        case EV_SUDDEN:
          for (let i = 0; i < 6; i++) sfx.tone({ freq: i % 2 ? 660 : 880, ms: 120, volume: 0.45, delay: i * 130 })
          break
        case EV_THUD:
          if (now - lastThud > 100) sfx.noise({ ms: 90, volume: 0.35, lowpass: 900 })
          lastThud = now
          break
        case EV_ROUND:
          if (e.a === seat && seat !== null) sfx.coin()
          else if (e.a < 0) sfx.tone({ freq: 330, to: 220, ms: 300, type: 'triangle', volume: 0.5 })
          break
        case EV_BURN:
          sfx.noise({ ms: 60, volume: 0.2, lowpass: 2000 })
          break
      }
    })
    return (events: number[][] | undefined) => {
      if (events) play(events.map((e) => ({ id: e[0], k: e[1], a: e[2], b: e[3] })))
      primed = true
    }
    // A new match restarts event ids.
  }, [lobby.matchId, seat])

  const names = useMemo(() => seats.map((s) => clean(s.name, 10)), [seats])

  const draw = (ctx: CanvasRenderingContext2D, now: number) => {
    ctx.fillStyle = BG
    ctx.fillRect(0, 0, VW, VH)
    const smp = frames.sample(now)
    if (!smp) {
      drawText(ctx, 'GET READY...', VW / 2, VH / 2 - 4, { align: 'center', color: '#ffd23f' })
      return
    }
    const A = smp.a.view
    const B = smp.b.view
    const t = smp.t
    const rt = smp.a.tick + (smp.b.tick - smp.a.tick) * t
    onEvents(B.e)

    // Arena frame and tiles.
    ctx.fillStyle = '#05060a'
    ctx.fillRect(OX - 2, OY - 2, W * TS + 4, H * TS + 4)
    drawFloor(ctx, A.g)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ch = A.g[y * W + x]
        const px = OX + x * TS
        const py = OY + y * TS
        if (ch === '#') drawPillar(ctx, px, py, x === 0 || y === 0 || x === W - 1 || y === H - 1)
        else if (ch === '%') drawCrate(ctx, px, py)
        else if (ch === 'X') drawBlock(ctx, px, py)
        else if (ch >= '1' && ch <= '6') drawItem(ctx, px, py, ch.charCodeAt(0) - 48, now)
      }
    }
    for (let k = 0; k + 1 < A.br.length; k += 2) {
      const c = A.br[k]
      drawDebris(ctx, OX + (c % W) * TS, OY + Math.floor(c / W) * TS, Math.max(0, A.br[k + 1] - t))
    }

    // Bombs (by id, interpolated while sliding).
    for (const b of B.b) {
      const prev = A.b.find((o) => o[0] === b[0])
      const x = prev ? lerp(prev[1], b[1], t) : b[1]
      const y = prev ? lerp(prev[2], b[2], t) : b[2]
      const fuse = prev ? lerp(prev[3], b[3], t) : b[3]
      const hot = fuse < 14 && Math.floor(fuse / 2) % 2 === 0
      const owner = seats[b[4]]?.color ?? '#ffffff'
      const pulse = Math.floor(now / 180) % 2 === 1
      const img = sprite(`bomb:${owner}:${hot ? 1 : 0}:${pulse ? 1 : 0}`, pulse ? BOMB_BIG : BOMB, bombPalette(owner, hot))
      const px = Math.round(OX + x / U - 6)
      const py = Math.round(OY + y / U - 5)
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.fillRect(px + 2, py + 11, 8, 2)
      ctx.drawImage(img, px, py)
      // Fuse spark
      if (Math.floor(now / 50) % 2 === 0) {
        ctx.fillStyle = Math.floor(now / 100) % 2 ? '#fff27a' : '#ff8a3d'
        ctx.fillRect(px + 6, py - 1, 2, 2)
      }
    }

    // Players, back to front.
    const order = B.p.map((_, i) => i).sort((i, j) => B.p[i][1] - B.p[j][1])
    for (const i of order) {
      const pb = B.p[i]
      const pa = A.p[i] ?? pb
      const color = seats[i]?.color ?? '#ffffff'
      const jump = Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) > TILE * 2
      const x = jump ? pb[0] : lerp(pa[0], pb[0], t)
      const y = jump ? pb[1] : lerp(pa[1], pb[1], t)
      const px = OX + x / U
      const py = OY + y / U
      const flags = pb[3]
      const alive = (flags & PF_ALIVE) !== 0
      if (!alive) {
        if (pb[4] < 0) continue
        const e = rt - pb[4]
        if (e > 36) continue
        if (flags & PF_GONE && e > 12) continue
        // Death: flash, rise and fade, then a puff.
        const rise = Math.max(0, e - 8) * 0.6
        if (e < 24) {
          const pal = e < 8 && Math.floor(e) % 2 === 0 ? FLASH_PALETTE : botPalette(mix(color, '#8892a6', 0.5), '#555555')
          const key = pal === FLASH_PALETTE ? 'flash' : `dead${color}`
          ctx.globalAlpha = e < 8 ? 1 : Math.max(0, 1 - (e - 8) / 16)
          ctx.drawImage(botSprite(1, 0, pal, key), Math.round(px - 6 + (e < 8 ? (Math.floor(e) % 2) * 2 - 1 : 0)), Math.round(py - 9 - rise))
          ctx.globalAlpha = 1
        }
        if (e > 6) {
          const k = (e - 6) / 30
          ctx.fillStyle = `rgba(200,205,220,${Math.max(0, 0.6 - k * 0.6)})`
          const r = Math.round(3 + k * 8)
          ctx.fillRect(Math.round(px - r), Math.round(py - 2 - k * 6), r * 2, r)
          ctx.fillRect(Math.round(px - r / 2), Math.round(py - 2 - r / 2 - k * 6), r, r * 2)
        }
        continue
      }
      const invuln = (flags & PF_INVULN) !== 0
      if (invuln && Math.floor(now / 70) % 2 === 0) continue
      const moving = (flags & PF_MOVING) !== 0
      const step = moving ? WALK[Math.floor((px + py) / 5) % 4] : 0
      const bob = step ? -1 : 0
      const light = Math.floor(now / 400 + i) % 4 === 0 ? '#ff8a3d' : '#fff27a'
      const img = botSprite(pb[2], step, botPalette(color, light), `${color}${light}`)
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.fillRect(Math.round(px - 5), Math.round(py + 5), 10, 2)
      ctx.drawImage(img, Math.round(px - 6), Math.round(py - 9 + bob))
      if (flags & PF_SHIELD) {
        ctx.strokeStyle = Math.floor(now / 150) % 2 ? 'rgba(80,220,255,0.9)' : 'rgba(180,245,255,0.7)'
        ctx.lineWidth = 1
        ctx.strokeRect(Math.round(px - 8) + 0.5, Math.round(py - 11) + 0.5, 15, 18)
      }
      if (i === seat) {
        // "That's you": a bobbing arrow over your head.
        const ay = Math.round(py - 17 + Math.sin(now / 160) * 1.5)
        const ax = Math.round(px)
        ctx.fillStyle = '#0b0d14'
        ctx.fillRect(ax - 4, ay - 1, 9, 2)
        ctx.fillRect(ax - 3, ay + 1, 7, 2)
        ctx.fillRect(ax - 2, ay + 3, 5, 1)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(ax - 3, ay, 7, 1)
        ctx.fillRect(ax - 2, ay + 1, 5, 1)
        ctx.fillRect(ax - 1, ay + 2, 3, 1)
        ctx.fillRect(ax, ay + 3, 1, 1)
      }
    }

    drawFire(ctx, A.f, t, now)

    // Sudden-death blocks: a growing shadow, then the block drops in.
    for (let k = 0; k + 1 < A.fl.length; k += 2) {
      const c = A.fl[k]
      const left = Math.max(0, A.fl[k + 1] - t)
      const px = OX + (c % W) * TS
      const py = OY + Math.floor(c / W) * TS
      const k01 = 1 - left / FALL_T
      ctx.fillStyle = `rgba(0,0,0,${0.15 + k01 * 0.45})`
      const s = Math.round(4 + k01 * 12)
      ctx.fillRect(px + 8 - s / 2, py + 8 - s / 2, s, s)
      // Seen from above: the block comes down big and shrinks onto its tile.
      const size = Math.round(TS * (1 + (left / FALL_T) * 0.9))
      ctx.globalAlpha = Math.min(1, 0.35 + k01)
      ctx.drawImage(blockSprite(), Math.round(px + 8 - size / 2), Math.round(py + 8 - size / 2 - (left / FALL_T) * 8), size, size)
      ctx.globalAlpha = 1
    }

    // Side panels.
    for (let i = 0; i < 4; i++) {
      const [x, y] = PANELS[i]
      const color = seats[i]?.color ?? '#3a4152'
      panel(ctx, x, y, PANEL_W, PANEL_H, color)
      const pv = B.p[i]
      if (!pv || !seats[i]) {
        drawText(ctx, '---', x + PANEL_W / 2, y + 38, { align: 'center', color: '#3a4152' })
        continue
      }
      const alive = (pv[3] & PF_ALIVE) !== 0
      const gone = (pv[3] & PF_GONE) !== 0
      ctx.drawImage(botSprite(1, 0, botPalette(alive ? color : '#5a6070'), alive ? color : 'grey'), x + 3, y + 5)
      drawText(ctx, names[i], x + 18, y + 6, { color, shadow: '#000000' })
      drawText(ctx, i === seat ? 'YOU' : seats[i].userId ? 'PLAYER' : 'CPU', x + 18, y + 15, { color: i === seat ? '#ffffff' : '#7d879b' })
      // Round wins
      for (let w = 0; w < B.wn; w++) {
        const wx = x + 18 + w * 9
        ctx.fillStyle = '#0b0d14'
        ctx.fillRect(wx, y + 25, 7, 7)
        ctx.fillStyle = w < pv[5] ? '#ffd23f' : '#2c3243'
        ctx.fillRect(wx + 1, y + 26, 5, 5)
        if (w < pv[5]) {
          ctx.fillStyle = '#fff6c2'
          ctx.fillRect(wx + 1, y + 26, 2, 1)
        }
      }
      // Power-ups
      const stat = (item: number, n: string, sx: number, sy: number) => {
        ctx.fillStyle = ITEM_COLORS[item]
        ctx.fillRect(sx, sy, 10, 10)
        ctx.drawImage(iconSprite(item), sx + 1, sy + 1)
        drawText(ctx, n, sx + 13, sy + 2, { color: '#e6ebf5' })
      }
      stat(1, String(pv[6]), x + 4, y + 38)
      stat(2, String(pv[7]), x + 36, y + 38)
      stat(3, String(pv[8]), x + 4, y + 52)
      let ex = x + 4
      for (const [flag, item] of [[PF_KICK, 4], [PF_SHIELD, 5], [PF_TRIGGER, 6]] as const) {
        if (pv[3] & flag) {
          ctx.fillStyle = ITEM_COLORS[item]
          ctx.fillRect(ex, y + 66, 10, 10)
          ctx.drawImage(iconSprite(item), ex + 1, y + 67)
          ex += 13
        }
      }
      if (!alive) {
        ctx.fillStyle = 'rgba(16,19,28,0.6)'
        ctx.fillRect(x, y + 2, PANEL_W, PANEL_H - 2)
        drawText(ctx, gone ? 'LEFT' : 'OUT', x + PANEL_W / 2, y + 66, { align: 'center', color: gone ? '#7d879b' : '#ff5a5f', shadow: '#000000' })
      }
    }

    // Timer and round.
    const midY = 90
    panel(ctx, 2, midY, PANEL_W, 36, '#3a4152')
    if (B.tl > 0) {
      drawText(ctx, 'TIME', 36, midY + 6, { align: 'center', color: '#7d879b' })
      const low = B.tl <= 15 * TICK_HZ && Math.floor(now / 300) % 2 === 0
      drawText(ctx, fmtTime(B.tl), 36, midY + 16, { align: 'center', scale: 2, color: low ? '#ff5a5f' : '#ffffff' })
    } else {
      const flash = Math.floor(now / 250) % 2 === 0
      drawText(ctx, 'SUDDEN', 36, midY + 9, { align: 'center', color: flash ? '#ff5a5f' : '#ffd23f' })
      drawText(ctx, 'DEATH', 36, midY + 19, { align: 'center', color: flash ? '#ff5a5f' : '#ffd23f' })
    }
    panel(ctx, 314, midY, PANEL_W, 36, '#3a4152')
    drawText(ctx, `ROUND ${B.rd}`, 348, midY + 8, { align: 'center', color: '#ffffff' })
    drawText(ctx, `FIRST TO ${B.wn}`, 348, midY + 20, { align: 'center', color: '#7d879b' })

    // Banners.
    const nameOf = (i: number) => clean(seats[i]?.name ?? `P${i + 1}`, 12)
    if (B.ph === PH_INTRO) {
      banner(ctx, `ROUND ${B.rd}`, 70, 2, '#ffd23f', seat === null ? 'YOU ARE WATCHING' : 'GET READY')
      const n = Math.max(1, Math.ceil(B.pt / TICK_HZ))
      const cx = OX + (W * TS) / 2
      const pop = (B.pt % TICK_HZ) / TICK_HZ > 0.8 ? 1 : 0
      ctx.fillStyle = 'rgba(8,10,16,0.78)'
      ctx.fillRect(cx - 16, 106, 32, 38)
      drawText(ctx, String(n), cx, 111 - pop, { align: 'center', scale: 4, color: '#ffffff' })
    } else if (B.ph === PH_PLAY && B.tl > ROUND_T - 16) {
      banner(ctx, 'GO!', 90, 4, '#3ee6b0')
    } else if ((B.ph === PH_PLAY || B.ph === PH_END) && B.sd >= 0 && B.sd < 50) {
      if (Math.floor(now / 200) % 2 === 0) banner(ctx, 'SUDDEN DEATH!', 94, 2, '#ff5a5f', 'THE ARENA IS CLOSING IN')
    } else if (B.ph === PH_RESULT || B.ph === PH_OVER) {
      if (B.mw.length === 1) {
        const w = B.mw[0]
        banner(ctx, `${nameOf(w)} WINS!`, 88, 2, seats[w]?.color ?? '#ffffff', 'MATCH OVER')
      } else if (B.ph === PH_OVER || B.mw.length > 1) {
        banner(ctx, 'DRAW', 88, 3, '#ffd23f', 'MATCH OVER')
      } else if (B.rw >= 0) {
        banner(ctx, `${nameOf(B.rw)} WINS`, 88, 2, seats[B.rw]?.color ?? '#ffffff', `ROUND ${B.rd}`)
      } else if (B.rw === -1) {
        banner(ctx, 'DRAW!', 88, 3, '#ffd23f', 'NOBODY SCORES')
      }
    }
  }

  return <RetroCanvas width={VW} height={VH} draw={draw} />
}
