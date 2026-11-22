// Kart Rally rendering helpers: the track rasterized once into a floor texture (with mipmaps) from the same
// geometry the server uses, a sky panorama, the Mode-7 style perspective floor (one ray per scanline, written
// straight into a Uint32Array), and kart sprites baked from a small voxel model at 16 angles.
import { buildTrack, OFF_W, type Track } from '@shared/games/kart/track'

export const W = 320
export const H = 180
/** Horizon row, focal length (px), camera height and distance behind the kart (world units). */
export const HY = 62
export const FOCAL = 200
export const CAM_H = 24
export const CAM_D = 56
const FOG0 = 320
const FOG1 = 1150

export type RGB = number[]

/** Packs a color for a little-endian RGBA Uint32Array view. */
export const pack = (c: RGB, f = 1): number => {
  const r = Math.max(0, Math.min(255, Math.round(c[0] * f)))
  const g = Math.max(0, Math.min(255, Math.round(c[1] * f)))
  const b = Math.max(0, Math.min(255, Math.round(c[2] * f)))
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
}

export const css = (c: RGB, f = 1, a = 1): string =>
  `rgba(${Math.min(255, Math.round(c[0] * f))},${Math.min(255, Math.round(c[1] * f))},${Math.min(255, Math.round(c[2] * f))},${a})`

export const hexRgb = (hex: string): RGB => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  const n = m ? parseInt(m[1], 16) : 0xffffff
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export interface Level {
  w: number
  h: number
  data: Uint32Array
}

export interface TrackArt {
  track: Track
  /** World position of texel (0, 0). */
  ox: number
  oy: number
  levels: Level[]
  outside: number
  fog: RGB
  fogPacked: number
  /** Sky panorama (PANO_W × HY). */
  sky: Uint32Array
  /** Minimap image and its world → map scale. */
  map: HTMLCanvasElement
  mapScale: number
}

export const PANO_W = Math.round((W * 2 * Math.PI) / (2 * Math.atan(W / 2 / FOCAL)))

const artCache = new Map<number, TrackArt>()

/** The track's floor texture, sky and minimap (built once per track, ~100 ms). */
export function trackArt(index: number): TrackArt {
  const hit = artCache.get(index)
  if (hit) return hit
  const t = buildTrack(index)
  const th = t.def.theme
  const ox = Math.floor(t.minX)
  const oy = Math.floor(t.minY)
  const tw = Math.ceil(t.maxX) - ox
  const tht = Math.ceil(t.maxY) - oy
  const N = tw * tht
  const E = new Float32Array(N).fill(1e9)
  const S = new Float32Array(N)
  const L = new Float32Array(N)
  const reach = t.maxW + OFF_W + 12
  // Nearest segment (by excess over the half width) for every texel near the track.
  for (let k = 0; k < t.n; k++) {
    const k2 = (k + 1) % t.n
    const ax = t.x[k]
    const ay = t.y[k]
    const ux = t.tx[k]
    const uy = t.ty[k]
    const len = t.len[k]
    const w0 = t.w[k]
    const dw = t.w[k2] - w0
    const x0 = Math.max(0, Math.floor(Math.min(ax, t.x[k2]) - reach - ox))
    const x1 = Math.min(tw - 1, Math.ceil(Math.max(ax, t.x[k2]) + reach - ox))
    const y0 = Math.max(0, Math.floor(Math.min(ay, t.y[k2]) - reach - oy))
    const y1 = Math.min(tht - 1, Math.ceil(Math.max(ay, t.y[k2]) + reach - oy))
    for (let ty = y0; ty <= y1; ty++) {
      const py = ty + oy + 0.5 - ay
      let i = ty * tw + x0
      for (let tx = x0; tx <= x1; tx++, i++) {
        const px = tx + ox + 0.5 - ax
        let f = (px * ux + py * uy) / len
        if (f < 0) f = 0
        else if (f > 1) f = 1
        const dx = px - ux * len * f
        const dy = py - uy * len * f
        const e = Math.sqrt(dx * dx + dy * dy) - (w0 + dw * f)
        if (e < E[i]) {
          E[i] = e
          S[i] = t.s[k] + len * f
          L[i] = -dx * uy + dy * ux
        }
      }
    }
  }
  const road = [pack(th.road), pack(th.road2), pack(th.road, 1.06)]
  const curbA = pack(th.curbA)
  const curbB = pack(th.curbB)
  const off = [pack(th.off), pack(th.off2), pack(th.off, 0.93), pack(th.off2, 1.05)]
  const edge = pack(th.off, 0.78)
  const wallA = pack(th.wall)
  const wallB = pack(th.wall, 1.5)
  const wallTop = pack(th.wall, 0.7)
  const outside = [pack(th.outside), pack(th.outside2)]
  const decor = [pack(th.hills2), pack(th.hills2, 0.75)]
  const white = pack([240, 240, 240])
  const black = pack([24, 24, 28])
  const padA = pack([255, 214, 60])
  const padB = pack([235, 100, 30])
  const rampA = pack([250, 220, 70])
  const rampB = pack([46, 46, 52])
  const lane = pack(th.road, 1.22)
  const data = new Uint32Array(N)
  for (let ty = 0, i = 0; ty < tht; ty++) {
    for (let tx = 0; tx < tw; tx++, i++) {
      const e = E[i]
      const n = hash(tx, ty)
      let c: number
      if (e > OFF_W + 10) {
        const patch = hash(tx >> 3, ty >> 3)
        c = outside[patch < 0.5 ? 0 : 1]
        if (hash(tx >> 2, ty >> 2) < 0.03 && n < 0.8) c = decor[n < 0.4 ? 0 : 1]
      } else if (e > OFF_W + 4) {
        c = e > OFF_W + 8.5 ? wallTop : Math.floor(S[i] / 6) & 1 ? wallA : wallB
      } else if (e > 0) {
        c = e < 1.5 ? edge : off[(hash(tx >> 3, ty >> 3) < 0.5 ? 0 : 1) + (n < 0.15 ? 2 : 0)]
      } else {
        const s = S[i]
        const lat = L[i]
        c = road[n < 0.45 ? 0 : n < 0.9 ? 1 : 2]
        if (e > -3) c = Math.floor(s / 8) & 1 ? curbA : curbB
        else if (Math.abs(lat) < 0.8 && Math.floor(s / 14) % 3 === 0) c = lane
        if (s < 6) c = (Math.floor((lat + 100) / 3) + Math.floor(s / 3)) & 1 ? white : black
        for (const [s0, s1, l0, l1] of t.padZones) {
          let ds = s - s0
          if (ds < 0) ds += t.total
          if (ds <= s1 - s0 && lat >= l0 && lat <= l1) c = (ds + Math.abs(lat - (l0 + l1) / 2)) % 8 < 4 ? padA : padB
        }
        for (const [s0, s1] of t.rampZones) {
          let ds = s - s0
          if (ds < 0) ds += t.total
          if (ds <= s1 - s0) c = Math.floor((lat + 100) / 4) & 1 ? rampA : rampB
        }
      }
      data[i] = c
    }
  }
  const levels: Level[] = [{ w: tw, h: tht, data }]
  for (let l = 1; l < 3; l++) levels.push(halve(levels[l - 1]))

  // Minimap.
  const mapScale = 64 / Math.max(tw, tht)
  const mw = Math.ceil(tw * mapScale)
  const mh = Math.ceil(tht * mapScale)
  const map = document.createElement('canvas')
  map.width = mw
  map.height = mh
  const mctx = map.getContext('2d')
  if (mctx) {
    const img = mctx.createImageData(mw, mh)
    const px = new Uint32Array(img.data.buffer)
    for (let y = 0; y < mh; y++)
      for (let x = 0; x < mw; x++) {
        const e = E[Math.min(tht - 1, Math.floor(y / mapScale)) * tw + Math.min(tw - 1, Math.floor(x / mapScale))]
        if (e <= 4) px[y * mw + x] = pack([235, 235, 245])
        else if (e <= OFF_W + 2) px[y * mw + x] = ((110 << 24) | (20 << 16) | (20 << 8) | 20) >>> 0
      }
    mctx.putImageData(img, 0, 0)
  }

  const art: TrackArt = {
    track: t,
    ox,
    oy,
    levels,
    outside: outside[0],
    fog: th.fog,
    fogPacked: pack(th.fog),
    sky: buildSky(t),
    map,
    mapScale,
  }
  artCache.set(index, art)
  return art
}

function halve(src: Level): Level {
  const w = src.w >> 1
  const h = src.h >> 1
  const out = new Uint32Array(w * h)
  const d = src.data
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * 2 * src.w + x * 2
      const a = d[i]
      const b = d[i + 1]
      const c = d[i + src.w]
      const e = d[i + src.w + 1]
      const r = ((a & 255) + (b & 255) + (c & 255) + (e & 255)) >> 2
      const g = (((a >> 8) & 255) + ((b >> 8) & 255) + ((c >> 8) & 255) + ((e >> 8) & 255)) >> 2
      const bl = (((a >> 16) & 255) + ((b >> 16) & 255) + ((c >> 16) & 255) + ((e >> 16) & 255)) >> 2
      out[y * w + x] = ((255 << 24) | (bl << 16) | (g << 8) | r) >>> 0
    }
  return { w, h, data: out }
}

function buildSky(t: Track): Uint32Array {
  const th = t.def.theme
  const sky = new Uint32Array(PANO_W * HY)
  const mix = (a: RGB, b: RGB, f: number): RGB => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
  for (let y = 0; y < HY; y++) {
    const f = y / (HY - 1)
    const c = pack(mix(th.skyTop, th.skyBottom, f * f))
    sky.fill(c, y * PANO_W, (y + 1) * PANO_W)
  }
  const TAU = Math.PI * 2
  // Features: clouds, a hazy sun, or stars and a moon.
  if (th.sky === 0) {
    for (let c = 0; c < 9; c++) {
      const cx = hash(c, 7) * PANO_W
      const cy = 8 + hash(c, 9) * 22
      const rw = 18 + hash(c, 11) * 26
      for (let y = Math.floor(cy - 8); y < cy + 8; y++)
        for (let x = Math.floor(cx - rw); x < cx + rw; x++) {
          const nx = (x - cx) / rw
          const ny = (y - cy) / 7
          const bump = 0.2 * Math.sin(nx * 9 + c)
          if (nx * nx + ny * ny < 0.8 + bump && y >= 0 && y < HY) sky[y * PANO_W + ((x + PANO_W) % PANO_W)] = pack([250, 252, 255], y > cy + 2 ? 0.92 : 1)
        }
    }
  } else if (th.sky === 1) {
    const sx = PANO_W * 0.3
    for (let y = 0; y < HY; y++)
      for (let x = Math.floor(sx - 60); x < sx + 60; x++) {
        const d = Math.hypot(x - sx, (y - 34) * 1.2)
        if (d < 15) sky[y * PANO_W + x] = pack([255, 236, 170])
        else if (d < 22 && (y & 1) === 0) sky[y * PANO_W + x] = pack([255, 200, 130])
      }
  } else {
    for (let i = 0; i < 260; i++) {
      const x = Math.floor(hash(i, 3) * PANO_W)
      const y = Math.floor(hash(i, 5) * (HY - 12))
      sky[y * PANO_W + x] = pack([255, 255, 255], 0.6 + hash(i, 8) * 0.4)
    }
    const mx = PANO_W * 0.62
    for (let y = 4; y < 30; y++)
      for (let x = Math.floor(mx - 12); x < mx + 12; x++) {
        const d = Math.hypot(x - mx, y - 16)
        if (d < 9 && Math.hypot(x - mx - 4, y - 14) > 7) sky[y * PANO_W + x] = pack([240, 240, 220])
      }
  }
  // Two layers of hills / dunes / peaks (periodic so the panorama wraps seamlessly).
  const layer = (base: number, amp: number, color: RGB, seed: number, sharp: boolean) => {
    for (let x = 0; x < PANO_W; x++) {
      const p = (x / PANO_W) * TAU
      let h = 0
      for (let k = 1; k <= 5; k++) h += Math.sin(p * (k * 3 + seed) + hash(k, seed) * TAU) / k
      if (sharp) h = Math.abs(h) * 1.4 - 0.4
      const top = Math.round(HY - base - amp * (h * 0.5 + 0.5))
      for (let y = Math.max(0, top); y < HY; y++) {
        const snow = sharp && y < top + 3 && h > 0.5
        sky[y * PANO_W + x] = snow ? pack([240, 244, 255]) : pack(color, 1 - (y - top) * 0.004)
      }
    }
  }
  const peaks = th.sky === 2
  layer(6, 20, th.hills2, 2, peaks)
  layer(2, 10, th.hills, 5, peaks)
  // Haze toward the horizon (matches the floor fog).
  for (let y = HY - 6; y < HY; y++) {
    const f = (y - (HY - 6)) / 6
    for (let x = 0; x < PANO_W; x++) {
      const c = sky[y * PANO_W + x]
      sky[y * PANO_W + x] = pack(mix([c & 255, (c >> 8) & 255, (c >> 16) & 255], th.fog, f * 0.8))
    }
  }
  return sky
}

export interface Camera {
  x: number
  y: number
  a: number
  /** Height above the ground. */
  h: number
}

/** Sky (scrolled by heading) and the perspective floor into `buf` (W × H). */
export function drawWorld(buf: Uint32Array, art: TrackArt, cam: Camera): void {
  const off = Math.floor(((((cam.a / (2 * Math.PI)) % 1) + 1) % 1) * PANO_W)
  const sky = art.sky
  for (let y = 0; y < HY; y++) {
    const row = y * W
    const prow = y * PANO_W
    for (let x = 0; x < W; x++) {
      let px = x + off
      if (px >= PANO_W) px -= PANO_W
      buf[row + x] = sky[prow + px]
    }
  }
  const ca = Math.cos(cam.a)
  const sa = Math.sin(cam.a)
  const fr = art.fog[0]
  const fg = art.fog[1]
  const fb = art.fog[2]
  const outside = art.outside
  for (let y = HY; y < H; y++) {
    const z = (cam.h * FOCAL) / (y - HY + 0.5)
    const step = z / FOCAL
    const level = step < 1.4 ? 0 : step < 2.8 ? 1 : 2
    const lv = art.levels[level]
    const scale = 1 / (1 << level)
    const du = -sa * step * scale
    const dv = ca * step * scale
    let u = (cam.x + ca * z - art.ox) * scale - du * (W / 2 - 0.5)
    let v = (cam.y + sa * z - art.oy) * scale - dv * (W / 2 - 0.5)
    const fog = z <= FOG0 ? 0 : z >= FOG1 ? 256 : Math.round(((z - FOG0) / (FOG1 - FOG0)) * 256)
    const row = y * W
    const lw = lv.w
    const lh = lv.h
    const d = lv.data
    if (fog >= 256) {
      buf.fill(art.fogPacked, row, row + W)
      continue
    }
    const keep = 256 - fog
    const fR = fr * fog
    const fG = fg * fog
    const fB = fb * fog
    for (let x = 0; x < W; x++) {
      const tx = u | 0
      const ty = v | 0
      let c = u >= 0 && v >= 0 && tx < lw && ty < lh ? d[ty * lw + tx] : outside
      if (fog > 0) {
        const r = ((c & 255) * keep + fR) >> 8
        const g = (((c >> 8) & 255) * keep + fG) >> 8
        const b = (((c >> 16) & 255) * keep + fB) >> 8
        c = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0
      }
      buf[row + x] = c
      u += du
      v += dv
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Kart sprites: a voxel model rendered at 16 angles (orthographic, ~24° from above), outlined.

export const SPRITE_W = 40
export const SPRITE_H = 36
/** Sprite pixel → world units, and where the kart's ground center sits in the sprite. */
export const SPRITE_UNIT = 0.375
export const SPRITE_AX = 20
export const SPRITE_AY = 26
export const KART_FRAMES = 16

type Voxel = [number, number, number, number]

function kartModel(): Voxel[] {
  const v: Voxel[] = []
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: number) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) v.push([x, y, z, c])
  }
  // Palette: 1 body, 2 body dark, 3 body light, 4 tire, 5 hub, 6 metal, 7 suit, 8 helmet, 9 visor, 10 dark, 11 bumper.
  for (const [x0, x1] of [
    [1, 3],
    [11, 13],
  ]) {
    for (const [y0, y1] of [
      [0, 1],
      [8, 9],
    ]) {
      box(x0, x1, y0, y1, 0, 2, 4)
    }
  }
  v.push([2, 0, 1, 5], [2, 9, 1, 5], [12, 0, 1, 5], [12, 9, 1, 5])
  box(1, 14, 2, 7, 1, 1, 1)
  box(4, 10, 1, 1, 1, 2, 2)
  box(4, 10, 8, 8, 1, 2, 2)
  box(12, 14, 3, 6, 2, 2, 1)
  box(15, 15, 2, 7, 1, 1, 11)
  box(9, 11, 3, 6, 2, 3, 3)
  box(8, 8, 4, 5, 4, 4, 10)
  box(3, 3, 3, 6, 2, 5, 10)
  box(4, 6, 3, 6, 2, 4, 7)
  v.push([7, 3, 3, 7], [7, 6, 3, 7])
  box(4, 6, 3, 6, 5, 7, 8)
  box(6, 6, 3, 6, 6, 6, 9)
  box(0, 2, 3, 6, 2, 3, 6)
  v.push([0, 3, 4, 10], [0, 6, 4, 10])
  return v
}

const MODEL = kartModel()
const spriteCache = new Map<string, HTMLCanvasElement[]>()

/** 16 frames of the kart in `color`: frame f shows the kart turned f·22.5° to the right of facing away. */
export function kartSprites(color: string): HTMLCanvasElement[] {
  const hit = spriteCache.get(color)
  if (hit) return hit
  const body = hexRgb(color)
  const pal: number[] = [
    0,
    pack(body),
    pack(body, 0.62),
    pack(body.map((c) => c + (255 - c) * 0.35)),
    pack([30, 30, 36]),
    pack([150, 150, 160]),
    pack([110, 110, 124]),
    pack([236, 236, 240]),
    pack(body.map((c) => c + (255 - c) * 0.55)),
    pack([30, 44, 80]),
    pack([44, 40, 48]),
    pack([210, 210, 220]),
  ]
  const occupied = new Set(MODEL.map(([x, y, z]) => `${x},${y},${z}`))
  const frames: HTMLCanvasElement[] = []
  const kz = 2 * Math.cos((24 * Math.PI) / 180)
  const kd = 2 * Math.sin((24 * Math.PI) / 180)
  for (let f = 0; f < KART_FRAMES; f++) {
    const phi = (f / KART_FRAMES) * Math.PI * 2
    const sp = Math.sin(phi)
    const cp = Math.cos(phi)
    const px = new Uint32Array(SPRITE_W * SPRITE_H)
    const list = MODEL.map(([x, y, z, c]) => {
      const fx = x - 7.5
      const ly = y - 4.5
      const r = fx * sp + ly * cp
      const d = fx * cp - ly * sp
      return { r, d, z, c, top: !occupied.has(`${x},${y},${z + 1}`) }
    })
    list.sort((a, b) => b.d - a.d || a.z - b.z)
    for (const vx of list) {
      const sx = Math.floor(SPRITE_AX + vx.r * 2)
      const sy = Math.floor(SPRITE_AY - (vx.z + 0.5) * kz - vx.d * kd)
      const col = pal[vx.c]
      const top = vx.top ? lighten(col) : col
      for (let yy = -1; yy <= 1; yy++)
        for (let xx = -1; xx <= 0; xx++) {
          const X = sx + xx
          const Y = sy + yy
          if (X >= 0 && Y >= 0 && X < SPRITE_W && Y < SPRITE_H) px[Y * SPRITE_W + X] = yy < 0 ? top : col
        }
    }
    // Dark outline.
    const out = px.slice()
    const ink = pack([16, 14, 22])
    for (let y = 0; y < SPRITE_H; y++)
      for (let x = 0; x < SPRITE_W; x++) {
        if (px[y * SPRITE_W + x]) continue
        const n =
          (x > 0 && px[y * SPRITE_W + x - 1]) ||
          (x < SPRITE_W - 1 && px[y * SPRITE_W + x + 1]) ||
          (y > 0 && px[(y - 1) * SPRITE_W + x]) ||
          (y < SPRITE_H - 1 && px[(y + 1) * SPRITE_W + x])
        if (n) out[y * SPRITE_W + x] = ink
      }
    const canvas = document.createElement('canvas')
    canvas.width = SPRITE_W
    canvas.height = SPRITE_H
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const img = ctx.createImageData(SPRITE_W, SPRITE_H)
      new Uint32Array(img.data.buffer).set(out)
      ctx.putImageData(img, 0, 0)
    }
    frames.push(canvas)
  }
  spriteCache.set(color, frames)
  return frames
}

function lighten(c: number): number {
  const r = Math.min(255, (c & 255) * 1.25 + 12)
  const g = Math.min(255, ((c >> 8) & 255) * 1.25 + 12)
  const b = Math.min(255, ((c >> 16) & 255) * 1.25 + 12)
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
}
