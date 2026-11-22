// Dojo Duel stage: an open-air dojo veranda at dusk, drawn procedurally. Static layers (sky, mountains, hills
// with a pagoda, the veranda's pillars and roof) are rendered once to offscreen canvases and scrolled with
// parallax; lanterns, clouds, drifting petals and the floor's perspective planks are drawn every frame.
import { SCREEN_W, STAGE_W } from '@shared/games/fighter/chars'

export const VIEW_W = 320
export const VIEW_H = 180
/** Screen y of the fighters' feet. */
export const GROUND_Y = 164
const FLOOR_TOP = 146
const SCROLL = STAGE_W - SCREEN_W

function layer(w: number, h: number, paint: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const g = cv.getContext('2d')
  if (g) {
    g.imageSmoothingEnabled = false
    paint(g)
  }
  return cv
}

/** A filled pixel circle. */
export function disc(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  g.fillStyle = color
  const x0 = Math.round(cx)
  const y0 = Math.round(cy)
  for (let dy = -Math.floor(r); dy <= Math.floor(r); dy++) {
    const w = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)))
    g.fillRect(x0 - w, y0 + dy, w * 2 + 1, 1)
  }
}

/** Deterministic hash noise in [0, 1). */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

let layers: { sky: HTMLCanvasElement; mountains: HTMLCanvasElement; hills: HTMLCanvasElement; veranda: HTMLCanvasElement } | null = null

const SKY = ['#1d1438', '#2b1a4a', '#3d1f57', '#58265e', '#7a2d5f', '#9d3a5a', '#c04d52', '#db6849', '#ee8a46', '#f6aa52', '#fac46a']
const MOUNT_W = VIEW_W + Math.ceil(SCROLL * 0.15)
const HILL_W = VIEW_W + Math.ceil(SCROLL * 0.35)
const VER_W = VIEW_W + Math.ceil(SCROLL * 0.8)

function build() {
  const sky = layer(VIEW_W, FLOOR_TOP, (g) => {
    const band = FLOOR_TOP / SKY.length
    SKY.forEach((c, i) => {
      g.fillStyle = c
      g.fillRect(0, Math.floor(i * band), VIEW_W, Math.ceil(band) + 1)
      // Dithered seam between bands.
      if (i > 0) {
        g.fillStyle = SKY[i - 1]
        for (let x = (i % 2) * 2; x < VIEW_W; x += 4) g.fillRect(x, Math.floor(i * band), 2, 1)
      }
    })
    // Stars in the top bands.
    g.fillStyle = '#e8d8ff'
    for (let i = 0; i < 40; i++) g.fillRect(Math.floor(hash(i) * VIEW_W), Math.floor(hash(i + 99) * 34), 1, 1)
    // The setting sun with retro stripes.
    const sx = 214
    const sy = 104
    disc(g, sx, sy, 27, '#ffb860')
    disc(g, sx, sy, 24, '#ffd27a')
    disc(g, sx, sy, 20, '#ffe39a')
    g.fillStyle = SKY[8]
    for (let k = 0; k < 6; k++) g.fillRect(sx - 30, sy + 4 + k * 4 + k, 60, 1 + Math.floor(k / 2))
  })
  const ridge = (g: CanvasRenderingContext2D, w: number, base: number, amp: number, seed: number, color: string, h: number) => {
    g.fillStyle = color
    for (let x = 0; x < w; x++) {
      const y = base - amp * (0.55 * Math.sin(x * 0.021 + seed) + 0.3 * Math.sin(x * 0.057 + seed * 2.1) + 0.15 * Math.sin(x * 0.13 + seed * 3.7))
      g.fillRect(x, Math.round(y), 1, h - Math.round(y))
    }
  }
  const mountains = layer(MOUNT_W, FLOOR_TOP, (g) => {
    ridge(g, MOUNT_W, 92, 26, 1.3, '#5a2a5e', FLOOR_TOP)
    // Snow caps catching the light.
    g.fillStyle = '#c87a8a'
    for (let x = 0; x < MOUNT_W; x++) {
      const y = 92 - 26 * (0.55 * Math.sin(x * 0.021 + 1.3) + 0.3 * Math.sin(x * 0.057 + 2.73) + 0.15 * Math.sin(x * 0.13 + 4.81))
      if (y < 76) g.fillRect(x, Math.round(y), 1, 2)
    }
    ridge(g, MOUNT_W, 108, 16, 4.2, '#46214f', FLOOR_TOP)
  })
  const hills = layer(HILL_W, FLOOR_TOP, (g) => {
    ridge(g, HILL_W, 122, 10, 2.2, '#2e1838', FLOOR_TOP)
    // Pine silhouettes.
    g.fillStyle = '#231230'
    for (let i = 0; i < 26; i++) {
      const x = Math.floor(hash(i * 3.3) * HILL_W)
      const h = 10 + Math.floor(hash(i * 7.1) * 14)
      const base = 124
      for (let k = 0; k < h; k++) {
        const w = Math.max(1, Math.floor(((k + 1) / h) * (h / 3)) + (k % 3 === 0 ? 1 : 0))
        g.fillRect(x - w, base - h + k, w * 2 + 1, 1)
      }
    }
    // A pagoda on the hill.
    const px = Math.floor(HILL_W * 0.3)
    g.fillStyle = '#231230'
    for (let tier = 0; tier < 4; tier++) {
      const y = 116 - tier * 9
      const w = 18 - tier * 3
      g.fillRect(px - w, y, w * 2, 2)
      g.fillRect(px - w - 2, y - 1, 3, 1)
      g.fillRect(px + w - 1, y - 1, 3, 1)
      g.fillRect(px - w + 4, y + 2, (w - 4) * 2, 7)
    }
    g.fillRect(px, 76, 1, 6)
    g.fillStyle = '#ffcf7a'
    for (let tier = 0; tier < 4; tier++) g.fillRect(px - 2, 120 - tier * 9, 1, 2)
  })
  const veranda = layer(VER_W, FLOOR_TOP + 6, (g) => {
    // Roof eave across the top.
    g.fillStyle = '#1a0f14'
    g.fillRect(0, 0, VER_W, 22)
    g.fillStyle = '#2c1a1c'
    g.fillRect(0, 14, VER_W, 6)
    g.fillStyle = '#4a2c26'
    g.fillRect(0, 20, VER_W, 3)
    g.fillStyle = '#6b3f2e'
    g.fillRect(0, 23, VER_W, 1)
    // Rafter ends.
    for (let x = 4; x < VER_W; x += 12) {
      g.fillStyle = '#3a2420'
      g.fillRect(x, 16, 6, 4)
      g.fillStyle = '#8a5a3a'
      g.fillRect(x, 16, 6, 1)
    }
    // Pillars.
    for (let x = 18; x < VER_W; x += 96) {
      g.fillStyle = '#3a2018'
      g.fillRect(x, 24, 10, FLOOR_TOP - 24)
      g.fillStyle = '#5c3324'
      g.fillRect(x + 1, 24, 3, FLOOR_TOP - 24)
      g.fillStyle = '#7a2a22'
      g.fillRect(x - 1, 24, 12, 3)
    }
    // Low railing.
    g.fillStyle = '#3a2018'
    g.fillRect(0, 124, VER_W, 3)
    g.fillRect(0, 136, VER_W, 2)
    g.fillStyle = '#6b3f2e'
    g.fillRect(0, 124, VER_W, 1)
    for (let x = 6; x < VER_W; x += 16) {
      g.fillStyle = '#2e1a14'
      g.fillRect(x, 127, 3, 19)
    }
    // A gong between two pillars.
    disc(g, 250, 96, 13, '#7a5418')
    disc(g, 250, 96, 11, '#c89a3a')
    disc(g, 250, 96, 5, '#e8c060')
    g.fillStyle = '#2e1a14'
    g.fillRect(234, 78, 32, 3)
    g.fillRect(236, 78, 2, 46)
    g.fillRect(262, 78, 2, 46)
  })
  layers = { sky, mountains, hills, veranda }
}

/** Draws the stage for a camera position (world x of the screen's left edge); `ms` animates it. */
export function drawStage(g: CanvasRenderingContext2D, cam: number, ms: number) {
  if (!layers) build()
  const L = layers!
  const k = SCROLL > 0 ? Math.max(0, Math.min(1, cam / SCROLL)) : 0
  g.drawImage(L.sky, 0, 0)
  // Drifting cloud streaks.
  for (let i = 0; i < 4; i++) {
    const w = 40 + i * 14
    const x = ((ms / (90 + i * 40) + i * 97) % (VIEW_W + w)) - w
    const y = 40 + i * 13
    g.fillStyle = i % 2 ? '#a24766' : '#c45e66'
    g.fillRect(Math.round(x), y, w, 2)
    g.fillRect(Math.round(x) + 6, y - 1, w - 14, 1)
  }
  g.drawImage(L.mountains, -Math.round(k * (MOUNT_W - VIEW_W)), 0)
  g.drawImage(L.hills, -Math.round(k * (HILL_W - VIEW_W)), 0)
  const vx = -Math.round(k * (VER_W - VIEW_W))
  g.drawImage(L.veranda, vx, 0)
  // Lanterns swaying under the eave.
  for (let x = 66; x < VER_W; x += 96) {
    const sway = Math.round(Math.sin(ms / 700 + x) * 1.5)
    const lx = vx + x + sway
    g.fillStyle = '#1a0f14'
    g.fillRect(vx + x + 2, 24, 1, 8)
    g.fillStyle = '#7a1e1e'
    g.fillRect(lx - 3, 32, 11, 13)
    g.fillStyle = '#d23a2a'
    g.fillRect(lx - 2, 33, 9, 11)
    const flick = 0.8 + 0.2 * Math.sin(ms / 90 + x)
    g.fillStyle = flick > 0.9 ? '#ffd27a' : '#ffb44a'
    g.fillRect(lx, 35, 5, 7)
    g.fillStyle = '#1a0f14'
    g.fillRect(lx - 3, 32, 11, 1)
    g.fillRect(lx - 3, 44, 11, 1)
    g.fillRect(lx + 2, 45, 1, 3)
  }
  // Floor: perspective planks.
  const rows = [FLOOR_TOP, 149, 153, 158, 164, 171, VIEW_H]
  for (let r = 0; r < rows.length - 1; r++) {
    const y0 = rows[r]
    const y1 = rows[r + 1]
    g.fillStyle = r === 0 ? '#3a2018' : r % 2 ? '#7a4a30' : '#6c4029'
    g.fillRect(0, y0, VIEW_W, y1 - y0)
    if (r > 0) {
      g.fillStyle = '#9a6440'
      g.fillRect(0, y0, VIEW_W, 1)
    }
    const d = 0.7 + (0.6 * ((y0 + y1) / 2 - FLOOR_TOP)) / (VIEW_H - FLOOR_TOP)
    g.fillStyle = '#4a2a1c'
    for (let wx = (r * 23) % 56; wx < STAGE_W + 56; wx += 56) {
      const sx = Math.round(VIEW_W / 2 + (wx - cam - VIEW_W / 2) * d)
      if (sx >= -1 && sx <= VIEW_W) g.fillRect(sx, y0 + 1, 1, y1 - y0 - 1)
    }
  }
  // Sunset sheen on the floor.
  g.fillStyle = 'rgba(255, 190, 110, 0.10)'
  g.fillRect(0, FLOOR_TOP + 3, VIEW_W, 8)
  // Petals drifting across.
  for (let i = 0; i < 14; i++) {
    const speed = 0.012 + hash(i) * 0.02
    const x = (hash(i + 5) * (VIEW_W + 40) - ms * speed) % (VIEW_W + 40)
    const px = x < 0 ? x + VIEW_W + 40 : x
    const y = (hash(i + 9) * 150 + ms * (0.01 + hash(i + 3) * 0.012)) % 170
    const wob = Math.sin(ms / 400 + i) * 3
    g.fillStyle = i % 3 ? '#ffb3c8' : '#ff8fb0'
    g.fillRect(Math.round(px - 20 + wob), Math.round(y), 2, 1)
  }
}
