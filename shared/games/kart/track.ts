// Kart Rally tracks: closed loops given as control points (x, y, half width) through which a Catmull-Rom spline
// runs, resampled every SEG_LEN units into a polyline. Both the server (physics, progress) and the desktop view
// (it rasterizes the same geometry into its floor texture and minimap) build them from here, so they agree.
//
// World: x right, y down, angles in radians with heading (cos a, sin a); increasing an angle turns right.
// Surface at a point = its "excess" e = (distance to the nearest centerline point) - (half width there):
// e <= 0 road, 0 < e <= OFF_W off-road (slow), beyond OFF_W a wall keeps the kart's center back.

export const SEG_LEN = 8
/** Width of the off-road band between the road edge and the barrier. */
export const OFF_W = 22
/** Control points are given on a smaller canvas and scaled up by this. */
const SCALE = 1.25
/** The grid cell size of the segment lookup. */
const CELL = 64

export interface TrackTheme {
  road: number[]
  road2: number[]
  curbA: number[]
  curbB: number[]
  off: number[]
  off2: number[]
  wall: number[]
  outside: number[]
  outside2: number[]
  skyTop: number[]
  skyBottom: number[]
  hills: number[]
  hills2: number[]
  fog: number[]
  /** 0 clouds, 1 sun haze, 2 stars. */
  sky: number
}

export interface TrackDef {
  name: string
  /** Control points: x, y, half width. */
  pts: [number, number, number][]
  /** Boost pads: position along the lap (0..1), lateral center (-1..1 of the half width), length in units. */
  pads: [number, number, number][]
  /** Ramps across the whole road: position along the lap (0..1). */
  ramps: number[]
  /** Rows of item boxes: position along the lap (0..1). */
  boxes: number[]
  theme: TrackTheme
}

// prettier-ignore
export const TRACK_DEFS: TrackDef[] = [
  {
    name: 'Meadow Loop',
    pts: [
      [145, 500, 34], [170, 300, 32], [290, 170, 30], [470, 150, 30], [590, 240, 28],
      [580, 380, 28], [660, 480, 30], [810, 470, 30], [880, 330, 30], [980, 200, 32], [1100, 250, 32],
      [1120, 450, 32], [1030, 640, 34], [820, 740, 36], [560, 760, 36], [330, 750, 36], [170, 660, 34],
    ],
    pads: [[0.33, 0, 26], [0.74, -0.45, 26], [0.9, 0.4, 26]],
    ramps: [0.56],
    boxes: [0.16, 0.66],
    theme: {
      road: [92, 94, 104], road2: [84, 86, 96], curbA: [235, 235, 235], curbB: [214, 60, 60],
      off: [72, 160, 64], off2: [62, 144, 56], wall: [70, 54, 40], outside: [44, 120, 52], outside2: [38, 108, 46],
      skyTop: [60, 130, 230], skyBottom: [170, 215, 250], hills: [70, 140, 80], hills2: [50, 110, 66],
      fog: [176, 212, 236], sky: 0,
    },
  },
  {
    name: 'Dune Run',
    pts: [
      [130, 420, 36], [180, 230, 34], [340, 120, 32], [520, 170, 30], [640, 110, 30], [820, 90, 32],
      [1000, 160, 32], [1060, 330, 30], [930, 430, 28], [800, 470, 28], [800, 600, 30], [960, 700, 32],
      [860, 820, 34], [620, 820, 36], [430, 730, 34], [300, 620, 30], [180, 600, 32],
    ],
    pads: [[0.1, 0, 26], [0.45, 0.4, 26], [0.8, 0, 26]],
    ramps: [0.27],
    boxes: [0.2, 0.62],
    theme: {
      road: [140, 116, 92], road2: [130, 106, 84], curbA: [250, 220, 120], curbB: [200, 110, 40],
      off: [222, 190, 120], off2: [210, 176, 108], wall: [120, 80, 46], outside: [232, 200, 130], outside2: [220, 186, 116],
      skyTop: [70, 60, 140], skyBottom: [250, 170, 110], hills: [180, 110, 80], hills2: [140, 84, 66],
      fog: [246, 186, 130], sky: 1,
    },
  },
  {
    name: 'Frost Pass',
    pts: [
      [180, 420, 31], [200, 340, 30], [150, 170, 30], [320, 90, 30], [480, 180, 28],
      [450, 360, 28], [570, 470, 30], [720, 400, 30], [690, 220, 30], [840, 100, 32], [1030, 170, 32],
      [1060, 380, 30], [920, 500, 30], [1000, 660, 32], [820, 790, 34], [560, 720, 34], [400, 800, 34],
      [220, 700, 34], [140, 520, 32],
    ],
    pads: [[0.04, 0, 26], [0.52, 0, 26], [0.83, -0.4, 26]],
    ramps: [0.7],
    boxes: [0.12, 0.6],
    theme: {
      road: [70, 78, 98], road2: [62, 70, 90], curbA: [240, 248, 255], curbB: [60, 120, 220],
      off: [226, 234, 244], off2: [206, 218, 234], wall: [90, 100, 120], outside: [200, 214, 232], outside2: [186, 200, 222],
      skyTop: [10, 14, 40], skyBottom: [50, 70, 130], hills: [120, 140, 180], hills2: [90, 104, 144],
      fog: [60, 76, 128], sky: 2,
    },
  },
]

export interface Track {
  index: number
  def: TrackDef
  /** Polyline samples (n of them; segment k goes from sample k to k+1, wrapping). */
  n: number
  x: Float64Array
  y: Float64Array
  /** Half width at each sample. */
  w: Float64Array
  /** Arc length at each sample, and the length of segment k. */
  s: Float64Array
  len: Float64Array
  /** Unit tangent of segment k. */
  tx: Float64Array
  ty: Float64Array
  /** Signed curvature (radians per unit, + = turning right), smoothed. */
  curv: Float64Array
  /** Racing line: lateral offset as a fraction of the half width (+ = right). */
  line: Float64Array
  total: number
  /** Checkpoint segment indices (K of them, the first at 0 = the start line) and their arc lengths. */
  cps: number[]
  cpS: number[]
  minX: number
  minY: number
  maxX: number
  maxY: number
  maxW: number
  /** Segment lookup grid. */
  gx: number
  gy: number
  gw: number
  gh: number
  grid: number[][]
  /** World positions of every item box (rows of 4). */
  boxes: [number, number][]
  /** Pads and ramps resolved to arc length ranges: [s0, s1, lat0, lat1] (lat in units). */
  padZones: [number, number, number, number][]
  rampZones: [number, number][]
}

export const CHECKPOINTS = 16

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

const cache: (Track | undefined)[] = []

export function trackCount(): number {
  return TRACK_DEFS.length
}

/** The built track (memoized; pure). */
export function buildTrack(index: number): Track {
  const hit = cache[index]
  if (hit) return hit
  const def = TRACK_DEFS[index]
  const P = def.pts.map(([px, py, pw]) => [px * SCALE, py * SCALE, pw])
  const m = P.length
  // Dense spline samples.
  const dx: number[] = []
  const dy: number[] = []
  const dw: number[] = []
  const SUB = 40
  for (let i = 0; i < m; i++) {
    const a = P[(i - 1 + m) % m]
    const b = P[i]
    const c = P[(i + 1) % m]
    const d = P[(i + 2) % m]
    for (let j = 0; j < SUB; j++) {
      const t = j / SUB
      dx.push(catmull(a[0], b[0], c[0], d[0], t))
      dy.push(catmull(a[1], b[1], c[1], d[1], t))
      dw.push(b[2] + (c[2] - b[2]) * (t * t * (3 - 2 * t)))
    }
  }
  const dn = dx.length
  const acc: number[] = [0]
  for (let i = 1; i <= dn; i++) acc.push(acc[i - 1] + Math.hypot(dx[i % dn] - dx[i - 1], dy[i % dn] - dy[i - 1]))
  const denseTotal = acc[dn]
  const n = Math.max(16, Math.round(denseTotal / SEG_LEN))
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const w = new Float64Array(n)
  let j = 0
  for (let k = 0; k < n; k++) {
    const target = (k / n) * denseTotal
    while (j < dn - 1 && acc[j + 1] < target) j++
    const f = (target - acc[j]) / Math.max(1e-9, acc[j + 1] - acc[j])
    const j2 = (j + 1) % dn
    x[k] = dx[j] + (dx[j2] - dx[j]) * f
    y[k] = dy[j] + (dy[j2] - dy[j]) * f
    w[k] = dw[j] + (dw[j2] - dw[j]) * f
  }
  const s = new Float64Array(n)
  const len = new Float64Array(n)
  const tx = new Float64Array(n)
  const ty = new Float64Array(n)
  let total = 0
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n
    const l = Math.hypot(x[k2] - x[k], y[k2] - y[k])
    s[k] = total
    len[k] = l
    tx[k] = (x[k2] - x[k]) / l
    ty[k] = (y[k2] - y[k]) / l
    total += l
  }
  // Curvature (heading change per unit), smoothed over ±3 segments.
  const raw = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const p = (k - 1 + n) % n
    const cross = tx[p] * ty[k] - ty[p] * tx[k]
    const dot = tx[p] * tx[k] + ty[p] * ty[k]
    raw[k] = Math.atan2(cross, dot) / SEG_LEN
  }
  const curv = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    let sum = 0
    for (let d = -3; d <= 3; d++) sum += raw[(k + d + n) % n]
    curv[k] = sum / 7
  }
  // Racing line: hug the inside of upcoming bends (a window ahead weighs more), smoothed.
  const want = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    let sum = 0
    for (let d = -4; d <= 10; d++) sum += curv[(k + d + n) % n]
    want[k] = Math.max(-0.6, Math.min(0.6, (sum / 15) * 90))
  }
  const line = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    let sum = 0
    for (let d = -6; d <= 6; d++) sum += want[(k + d + n) % n]
    line[k] = sum / 13
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxW = 0
  for (let k = 0; k < n; k++) {
    minX = Math.min(minX, x[k])
    minY = Math.min(minY, y[k])
    maxX = Math.max(maxX, x[k])
    maxY = Math.max(maxY, y[k])
    maxW = Math.max(maxW, w[k])
  }
  const reach = maxW + OFF_W + 24
  minX -= reach
  minY -= reach
  maxX += reach
  maxY += reach
  const gw = Math.ceil((maxX - minX) / CELL)
  const gh = Math.ceil((maxY - minY) / CELL)
  const grid: number[][] = []
  for (let i = 0; i < gw * gh; i++) grid.push([])
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n
    const x0 = Math.floor((Math.min(x[k], x[k2]) - reach - minX) / CELL)
    const x1 = Math.floor((Math.max(x[k], x[k2]) + reach - minX) / CELL)
    const y0 = Math.floor((Math.min(y[k], y[k2]) - reach - minY) / CELL)
    const y1 = Math.floor((Math.max(y[k], y[k2]) + reach - minY) / CELL)
    for (let cy = Math.max(0, y0); cy <= Math.min(gh - 1, y1); cy++)
      for (let cx = Math.max(0, x0); cx <= Math.min(gw - 1, x1); cx++) grid[cy * gw + cx].push(k)
  }
  const cps: number[] = []
  const cpS: number[] = []
  for (let i = 0; i < CHECKPOINTS; i++) {
    const k = Math.round((i / CHECKPOINTS) * n) % n
    cps.push(k)
    cpS.push(s[k])
  }
  const t: Track = {
    index,
    def,
    n,
    x,
    y,
    w,
    s,
    len,
    tx,
    ty,
    curv,
    line,
    total,
    cps,
    cpS,
    minX,
    minY,
    maxX,
    maxY,
    maxW,
    gx: minX,
    gy: minY,
    gw,
    gh,
    grid,
    boxes: [],
    padZones: [],
    rampZones: [],
  }
  for (const f of def.boxes) {
    const at = pointAt(t, f * total, 0)
    const hw = at.w
    for (const l of [-0.62, -0.21, 0.21, 0.62]) {
      const p = pointAt(t, f * total, l * hw)
      t.boxes.push([p.x, p.y])
    }
  }
  for (const [f, lat, l] of def.pads) {
    const hw = pointAt(t, f * total, 0).w
    t.padZones.push([f * total, f * total + l, lat * hw - 10, lat * hw + 10])
  }
  for (const f of def.ramps) t.rampZones.push([f * total, f * total + 10])
  cache[index] = t
  return t
}

/** Wraps an arc length into [0, total). */
export function wrapS(t: Track, s: number): number {
  s %= t.total
  return s < 0 ? s + t.total : s
}

/** The segment containing arc length s. */
export function segAt(t: Track, s: number): number {
  s = wrapS(t, s)
  let lo = 0
  let hi = t.n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (t.s[mid] <= s) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The point at arc length s, `lat` units to the right of the centerline, with the direction there. */
export function pointAt(t: Track, s: number, lat: number): { x: number; y: number; w: number; dx: number; dy: number; k: number } {
  s = wrapS(t, s)
  const k = segAt(t, s)
  const f = (s - t.s[k]) / t.len[k]
  const k2 = (k + 1) % t.n
  const cx = t.x[k] + (t.x[k2] - t.x[k]) * f
  const cy = t.y[k] + (t.y[k2] - t.y[k]) * f
  const dx = t.tx[k]
  const dy = t.ty[k]
  return { x: cx - dy * lat, y: cy + dx * lat, w: t.w[k] + (t.w[k2] - t.w[k]) * f, dx, dy, k }
}

/** Result of a nearest-segment query (reused objects are avoided: callers keep what they need). */
export interface Near {
  /** Segment index and position along it (0..1). */
  k: number
  f: number
  /** Excess over the half width (<= 0: on the road). */
  e: number
  /** Distance from the centerline, signed (+ = right of the direction of travel). */
  lat: number
  /** Arc length of the nearest centerline point. */
  s: number
  /** Unit vector from the centerline point toward the query point (the outward normal), or the right normal. */
  nx: number
  ny: number
}

function segQuery(t: Track, k: number, px: number, py: number, out: Near): number {
  const k2 = k + 1 === t.n ? 0 : k + 1
  const ax = t.x[k]
  const ay = t.y[k]
  const l = t.len[k]
  const ux = t.tx[k]
  const uy = t.ty[k]
  let f = ((px - ax) * ux + (py - ay) * uy) / l
  if (f < 0) f = 0
  else if (f > 1) f = 1
  const qx = ax + ux * l * f
  const qy = ay + uy * l * f
  const ddx = px - qx
  const ddy = py - qy
  const d = Math.sqrt(ddx * ddx + ddy * ddy)
  const e = d - (t.w[k] + (t.w[k2] - t.w[k]) * f)
  out.k = k
  out.f = f
  out.e = e
  out.lat = ddx * -uy + ddy * ux
  out.s = t.s[k] + l * f
  if (d > 1e-6) {
    out.nx = ddx / d
    out.ny = ddy / d
  } else {
    out.nx = -uy
    out.ny = ux
  }
  return e
}

export function newNear(): Near {
  return { k: 0, f: 0, e: 0, lat: 0, s: 0, nx: 0, ny: 1 }
}

const tmp = newNear()

function copyNear(from: Near, to: Near): void {
  to.k = from.k
  to.f = from.f
  to.e = from.e
  to.lat = from.lat
  to.s = from.s
  to.nx = from.nx
  to.ny = from.ny
}

/** Nearest track point (by excess, so the widest nearby road wins) over the whole track. */
export function nearest(t: Track, px: number, py: number, out: Near): Near {
  const cx = Math.floor((px - t.gx) / CELL)
  const cy = Math.floor((py - t.gy) / CELL)
  const list = cx >= 0 && cy >= 0 && cx < t.gw && cy < t.gh ? t.grid[cy * t.gw + cx] : null
  let best = Infinity
  if (list && list.length > 0) {
    for (const k of list) {
      const e = segQuery(t, k, px, py, tmp)
      if (e < best) {
        best = e
        copyNear(tmp, out)
      }
    }
    return out
  }
  for (let k = 0; k < t.n; k++) {
    const e = segQuery(t, k, px, py, tmp)
    if (e < best) {
      best = e
      copyNear(tmp, out)
    }
  }
  return out
}

/** Nearest track point among segments within ±win of `k0` (follows a kart along the loop). */
export function nearestLocal(t: Track, px: number, py: number, k0: number, win: number, out: Near): Near {
  let best = Infinity
  for (let d = -win; d <= win; d++) {
    let k = k0 + d
    if (k < 0) k += t.n
    else if (k >= t.n) k -= t.n
    const e = segQuery(t, k, px, py, tmp)
    if (e < best) {
      best = e
      copyNear(tmp, out)
    }
  }
  return out
}
