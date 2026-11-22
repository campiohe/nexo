// Ring Out backgrounds and stages, drawn procedurally: a dithered sky (rendered once per stage), parallax
// layers that follow the camera at a fraction of its motion, and the stage itself in world coordinates.
import { STAGES } from '@shared/games/brawl/data'

export const VW = 320
export const VH = 180

export interface Cam {
  x: number
  y: number
  z: number
}

export const sx = (cam: Cam, wx: number) => (wx - cam.x) * cam.z + VW / 2
export const sy = (cam: Cam, wy: number) => (wy - cam.y) * cam.z + VH / 2

/** A world-space rectangle, snapped to whole screen pixels. */
function wrect(ctx: CanvasRenderingContext2D, cam: Cam, x: number, y: number, w: number, h: number, color: string) {
  const x0 = Math.round(sx(cam, x))
  const y0 = Math.round(sy(cam, y))
  const x1 = Math.round(sx(cam, x + w))
  const y1 = Math.round(sy(cam, y + h))
  if (x1 < 0 || y1 < 0 || x0 > VW || y0 > VH) return
  ctx.fillStyle = color
  ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0))
}

/** Deterministic pseudo-random in [0, 1) for decoration. */
const hash = (n: number) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return v - Math.floor(v)
}

// ---------------------------------------------------------------------------------------------
// Sky (static per stage, ordered dithering between palette stops)

const SKIES: string[][] = [
  ['#120a2a', '#25134a', '#46195c', '#7a2663', '#b8405e', '#e86d4c', '#f6a35c'],
  ['#2457ad', '#2f6fc6', '#4a8edb', '#73afe8', '#a5d3f2', '#d9ecf2', '#ffe6b8'],
]
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]
const skyCache = new Map<number, HTMLCanvasElement>()

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function sky(stage: number): HTMLCanvasElement {
  let c = skyCache.get(stage)
  if (c) return c
  c = document.createElement('canvas')
  c.width = VW
  c.height = VH
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(VW, VH)
  const stops = (SKIES[stage] ?? SKIES[0]).map(rgb)
  for (let y = 0; y < VH; y++) {
    const f = Math.min(1, y / (VH * 0.78)) * (stops.length - 1)
    const i = Math.min(stops.length - 2, Math.floor(f))
    const frac = f - i
    for (let x = 0; x < VW; x++) {
      const col = frac * 16 > BAYER[y & 3][x & 3] ? stops[i + 1] : stops[i]
      const o = (y * VW + x) * 4
      img.data[o] = col[0]
      img.data[o + 1] = col[1]
      img.data[o + 2] = col[2]
      img.data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  skyCache.set(stage, c)
  return c
}

// ---------------------------------------------------------------------------------------------
// Parallax layers

/** Screen position of a layer point (u, v) for a layer moving at `p` of the camera's speed. */
const lx = (cam: Cam, u: number, p: number) => VW / 2 + u - cam.x * p * cam.z
const ly = (cam: Cam, v: number, p: number) => VH / 2 + v - cam.y * p * cam.z

function forEachRepeat(cam: Cam, p: number, period: number, draw: (u: number, index: number) => void) {
  const shift = cam.x * p * cam.z
  const first = Math.floor((shift - VW / 2 - period) / period)
  for (let k = first; k <= first + Math.ceil(VW / period) + 2; k++) draw(k * period, k)
}

export function drawBackground(ctx: CanvasRenderingContext2D, stage: number, cam: Cam, now: number) {
  ctx.drawImage(sky(stage), 0, 0)
  if (stage === 1) drawSea(ctx, cam, now)
  else drawDusk(ctx, cam, now)
}

function drawDusk(ctx: CanvasRenderingContext2D, cam: Cam, now: number) {
  // Stars.
  for (let i = 0; i < 70; i++) {
    const x = Math.round(lx(cam, hash(i) * 420 - 210, 0.03))
    const y = Math.round(ly(cam, hash(i + 99) * 80 - 92, 0.03))
    const on = hash(i + 7) > 0.3 || Math.floor(now / 400 + i) % 5 !== 0
    if (!on) continue
    ctx.fillStyle = hash(i + 3) > 0.8 ? '#ffe7b0' : '#cfc6ff'
    ctx.fillRect(x, y, 1, 1)
  }
  // Distant floating islands.
  forEachRepeat(cam, 0.12, 170, (u, k) => {
    const w = 30 + Math.floor(hash(k * 3) * 40)
    const top = -30 + Math.floor(hash(k * 5) * 40)
    const x0 = Math.round(lx(cam, u, 0.12))
    const y0 = Math.round(ly(cam, top, 0.12))
    for (let r = 0; r < 22; r++) {
      const inset = Math.floor((r * r) / 22)
      if (w - inset * 2 <= 0) break
      ctx.fillStyle = r < 2 ? '#5b2d6e' : '#341a4c'
      ctx.fillRect(x0 + inset, y0 + r, w - inset * 2, 1)
    }
    // A tiny glowing window.
    if (hash(k * 11) > 0.5) {
      ctx.fillStyle = '#ffb35c'
      ctx.fillRect(x0 + Math.floor(w / 2), y0 + 3, 1, 2)
    }
  })
  // Cloud banks.
  forEachRepeat(cam, 0.3, 120, (u, k) => {
    const x0 = Math.round(lx(cam, u, 0.3))
    const y0 = Math.round(ly(cam, 40 + hash(k * 7) * 30, 0.3))
    const w = 50 + Math.floor(hash(k * 13) * 50)
    ctx.fillStyle = '#9c3f66'
    ctx.fillRect(x0 + 6, y0, w - 12, 2)
    ctx.fillRect(x0, y0 + 2, w, 5)
    ctx.fillStyle = '#d06a72'
    ctx.fillRect(x0 + 8, y0, w - 20, 1)
    ctx.fillStyle = '#6e2c5c'
    ctx.fillRect(x0 + 3, y0 + 7, w - 6, 2)
  })
  // Embers drifting up.
  for (let i = 0; i < 24; i++) {
    const period = 6000 + hash(i) * 5000
    const k = ((now + hash(i + 50) * period) % period) / period
    const x = Math.round(lx(cam, hash(i + 20) * 360 - 180 + Math.sin(k * 6 + i) * 6, 0.5))
    const y = Math.round(ly(cam, 120 - k * 260, 0.5))
    ctx.fillStyle = k < 0.7 ? '#ffb35c' : '#c0573e'
    ctx.fillRect(x, y, 1, 1)
  }
}

function drawSea(ctx: CanvasRenderingContext2D, cam: Cam, now: number) {
  // Sun.
  const sunX = Math.round(lx(cam, 80, 0.02))
  const sunY = Math.round(ly(cam, -50, 0.02))
  ctx.fillStyle = '#fff1c9'
  for (let dy = -9; dy <= 9; dy++) {
    const w = Math.round(Math.sqrt(81 - dy * dy))
    ctx.fillRect(sunX - w, sunY + dy, w * 2, 1)
  }
  // Mountains.
  const horizon = Math.round(ly(cam, 26, 0.15))
  ctx.fillStyle = '#6a97c4'
  for (let x = 0; x < VW; x++) {
    const u = x + cam.x * 0.08 * cam.z
    const h = 10 + Math.sin(u / 37) * 7 + Math.sin(u / 13 + 1) * 3 + Math.sin(u / 91) * 9
    ctx.fillRect(x, horizon - Math.max(2, Math.round(h)), 1, Math.max(2, Math.round(h)))
  }
  // Sea.
  const bands = ['#3f86c4', '#2f74b3', '#2563a0', '#1d548c', '#17477a']
  for (let i = 0; i < bands.length; i++) {
    ctx.fillStyle = bands[i]
    const y = horizon + i * i * 4
    ctx.fillRect(0, y, VW, VH - y)
  }
  ctx.fillStyle = '#d7f0ff'
  for (let i = 0; i < 40; i++) {
    const depth = hash(i + 5)
    const y = horizon + 2 + Math.round(depth * depth * 70)
    const speed = 0.004 + depth * 0.01
    const x = Math.round((((hash(i) * VW * 2 + now * speed - cam.x * (0.15 + depth * 0.3) * cam.z) % (VW + 20)) + VW + 20) % (VW + 20)) - 10
    if (Math.floor(now / 300 + i) % 4 === 0) continue
    ctx.fillRect(x, y, 2 + Math.round(depth * 4), 1)
  }
  // Ruined pillars standing in the water.
  forEachRepeat(cam, 0.35, 95, (u, k) => {
    if (hash(k * 17) < 0.35) return
    const w = 8 + Math.floor(hash(k * 3) * 6)
    const h = 26 + Math.floor(hash(k * 5) * 40)
    const x0 = Math.round(lx(cam, u, 0.35))
    const base = Math.round(ly(cam, 48, 0.35))
    ctx.fillStyle = '#a99168'
    ctx.fillRect(x0, base - h, w, h)
    ctx.fillStyle = '#8a7350'
    ctx.fillRect(x0 + w - 2, base - h, 2, h)
    ctx.fillStyle = '#c9b287'
    ctx.fillRect(x0 - 1, base - h, w + 2, 2)
    // Broken top.
    ctx.fillStyle = '#a99168'
    ctx.fillRect(x0 + 1, base - h - 3, Math.floor(w / 2), 3)
    ctx.fillStyle = '#2f74b3'
    ctx.fillRect(x0 - 1, base - 2, w + 2, 2)
  })
}

// ---------------------------------------------------------------------------------------------
// The stage (world coordinates)

export function drawStage(ctx: CanvasRenderingContext2D, stage: number, cam: Cam, now: number) {
  const st = STAGES[stage] ?? STAGES[0]
  const { l, r, y, d } = st.main
  const w = r - l
  if (stage === 1) {
    // Columns under the ruins (decoration), then the sandstone block with a mossy top.
    for (const cx of [l + 18, (l + r) / 2, r - 18]) {
      wrect(ctx, cam, cx - 8, y + d, 16, 140, '#9c8659')
      wrect(ctx, cam, cx + 4, y + d, 4, 140, '#7f6a43')
      for (let k = 0; k < 6; k++) wrect(ctx, cam, cx - 8, y + d + 12 + k * 22, 16, 2, '#b8a173')
    }
    wrect(ctx, cam, l, y, w, d, '#d6bd86')
    for (let row = 0; row * 9 < d; row++) {
      wrect(ctx, cam, l, y + 4 + row * 9, w, 1, '#b39a64')
      for (let bx = l + (row % 2 ? 6 : 0); bx < r; bx += 18) wrect(ctx, cam, bx, y + 4 + row * 9, 1, 9, '#b39a64')
    }
    wrect(ctx, cam, l, y + d - 3, w, 3, '#a68b58')
    wrect(ctx, cam, l - 2, y, w + 4, 3, '#79b65a')
    wrect(ctx, cam, l - 2, y, w + 4, 1, '#a7dc7c')
    for (let i = 0; i < 18; i++) {
      const vx = l + hash(i + 40) * w
      wrect(ctx, cam, vx, y + 3, 2, 2 + Math.floor(hash(i) * 6), '#5f9a45')
    }
    for (const p of st.plats) {
      wrect(ctx, cam, p.l, p.y, p.r - p.l, 4, '#e3cd99')
      wrect(ctx, cam, p.l, p.y, p.r - p.l, 1, '#f5e6bf')
      wrect(ctx, cam, p.l + 2, p.y + 4, p.r - p.l - 4, 2, '#a8905f')
      wrect(ctx, cam, p.l + 6, p.y + 6, 3, 6, '#a8905f')
      wrect(ctx, cam, p.r - 9, p.y + 6, 3, 6, '#a8905f')
    }
    return
  }
  // Sky Forge: a riveted metal deck on a dark stone block with glowing seams and hanging lanterns.
  const glow = 0.6 + Math.sin(now / 300) * 0.25
  for (let i = 0; i < 4; i++) {
    const cx = l + 24 + i * ((w - 48) / 3)
    wrect(ctx, cam, cx, y + d, 1, 16 + (i % 2) * 8, '#2a2236')
    wrect(ctx, cam, cx - 2, y + d + 16 + (i % 2) * 8, 5, 5, glow > 0.6 ? '#ffb35c' : '#e8893f')
  }
  wrect(ctx, cam, l, y, w, d, '#3b3048')
  for (let row = 0; row * 8 < d; row++) {
    wrect(ctx, cam, l, y + 4 + row * 8, w, 1, '#2b2236')
    for (let bx = l + (row % 2 ? 7 : 0); bx < r; bx += 14) wrect(ctx, cam, bx, y + 4 + row * 8, 1, 8, '#2b2236')
  }
  for (let i = 0; i < 7; i++) {
    const vx = l + 14 + hash(i + 1) * (w - 28)
    wrect(ctx, cam, vx, y + 6, 1, d - 10, `rgba(255, 140, 60, ${(glow * (0.5 + hash(i) * 0.5)).toFixed(2)})`)
  }
  wrect(ctx, cam, l + 4, y + d, w - 8, 3, '#2b2236')
  wrect(ctx, cam, l - 3, y, w + 6, 4, '#b8c1ce')
  wrect(ctx, cam, l - 3, y, w + 6, 1, '#f2f5f8')
  wrect(ctx, cam, l - 3, y + 4, w + 6, 1, '#6c7484')
  for (let bx = l + 4; bx < r; bx += 16) wrect(ctx, cam, bx, y + 2, 1, 1, '#6c7484')
  for (const p of st.plats) {
    const pw = p.r - p.l
    wrect(ctx, cam, p.l + 4, p.y + 4, pw - 8, 3, `rgba(255, 170, 90, ${(glow * 0.35).toFixed(2)})`)
    wrect(ctx, cam, p.l, p.y, pw, 3, '#a2abba')
    wrect(ctx, cam, p.l, p.y, pw, 1, '#e7ecf2')
    wrect(ctx, cam, p.l + 1, p.y + 3, pw - 2, 1, '#5d6576')
    for (let bx = p.l + 3; bx < p.r; bx += 10) wrect(ctx, cam, bx, p.y + 1, 1, 1, '#5d6576')
  }
}

/** The surface right under (x, y) within `range`, for the drop shadow. */
export function groundBelow(stage: number, x: number, y: number, range = 160): number | null {
  const st = STAGES[stage] ?? STAGES[0]
  let best: number | null = null
  const consider = (l: number, r: number, top: number) => {
    if (x >= l && x <= r && top >= y - 0.5 && top - y < range && (best === null || top < best)) best = top
  }
  consider(st.main.l, st.main.r, st.main.y)
  for (const p of st.plats) consider(p.l, p.r, p.y)
  return best
}
