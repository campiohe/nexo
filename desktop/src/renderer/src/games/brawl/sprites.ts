// Ring Out fighter sprites, built in code: each pose is a little skeleton (head, shoulders, hips, elbows,
// hands, knees, feet) rasterized into chunky pixels with the character's build, a per-character head drawn
// from a string grid, and an automatic dark outline. Cached per character × pose × seat color × variant.
import { ANIMS, CHARS, FL, MOVES } from '@shared/games/brawl/data'

// ---------------------------------------------------------------------------------------------
// Poses: [head, neck, hip, front elbow, front hand, back elbow, back hand, front knee, front foot, back knee,
// back foot] as x,y pairs relative to the feet, facing right, for a 22 px tall fighter.

// prettier-ignore
const POSES = {
  idle:     [1,-18, 0,-14, 0,-7,  3,-11, 5,-14,  -2,-11, 2,-13,  2,-3, 3,0,  -2,-3, -3,0],
  idle2:    [1,-17, 0,-13, 0,-7,  3,-10, 5,-13,  -2,-10, 2,-12,  2,-3, 3,0,  -2,-3, -3,0],
  run1:     [3,-17, 2,-13, 0,-7,  -1,-10, -3,-8,  4,-11, 6,-13,  4,-4, 6,-1,  -2,-3, -5,-2],
  run2:     [3,-18, 2,-14, 0,-8,  2,-11, 3,-9,  2,-11, 4,-12,  2,-4, 1,0,  0,-4, -2,-2],
  run3:     [3,-17, 2,-13, 0,-7,  4,-11, 6,-13,  -1,-10, -3,-8,  -2,-3, -5,-2,  4,-4, 6,-1],
  run4:     [3,-18, 2,-14, 0,-8,  2,-11, 4,-12,  2,-11, 3,-9,  0,-4, -1,-1,  2,-4, 2,0],
  crouch:   [2,-13, 1,-10, -1,-5,  4,-8, 6,-10,  0,-8, 3,-9,  4,-4, 4,0,  -3,-3, -4,0],
  jump:     [1,-19, 0,-15, 0,-8,  3,-18, 4,-21,  -3,-12, -5,-10,  3,-5, 2,-1,  -1,-4, -3,-2],
  fall:     [1,-18, 0,-14, 0,-7,  4,-15, 6,-17,  -4,-15, -6,-17,  2,-3, 2,1,  -2,-3, -3,1],
  tuck:     [2,-12, 0,-10, -1,-6,  3,-8, 4,-5,  1,-8, 2,-5,  3,-7, 3,-3,  0,-6, -1,-2],
  hurt:     [-3,-17, -1,-13, 0,-7,  3,-15, 5,-18,  -4,-13, -6,-15,  3,-3, 5,-1,  -2,-3, -1,0],
  hang:     [1,-15, 0,-12, 0,-6,  3,-17, 5,-20,  2,-17, 4,-20,  1,-3, 0,1,  -1,-2, -2,1],
  guard:    [1,-18, 0,-14, 0,-7,  3,-12, 5,-16,  4,-11, 4,-15,  3,-3, 4,0,  -3,-3, -4,0],
  windup:   [-1,-18, -1,-14, 0,-7,  -4,-12, -6,-14,  2,-12, 4,-14,  3,-3, 4,0,  -2,-3, -4,0],
  punch:    [2,-18, 1,-14, 0,-7,  6,-13, 10,-13,  -2,-11, 0,-12,  3,-3, 4,0,  -2,-3, -4,0],
  bigpunch: [4,-17, 3,-13, 0,-7,  8,-13, 13,-13,  -1,-11, -3,-9,  4,-4, 6,0,  -3,-3, -6,0],
  kick:     [-2,-18, -2,-14, 0,-8,  -4,-11, -6,-13,  1,-12, 3,-14,  5,-9, 11,-11,  -1,-4, -1,0],
  uppercut: [1,-18, 0,-14, 0,-7,  3,-19, 4,-25,  -2,-11, -1,-9,  2,-3, 3,0,  -2,-3, -3,0],
  lowkick:  [-1,-13, -1,-10, -1,-5,  1,-9, 3,-10,  -3,-8, -4,-6,  5,-3, 11,-1,  -3,-3, -4,0],
  spread:   [1,-18, 0,-14, 0,-8,  5,-14, 9,-14,  -5,-14, -9,-14,  4,-6, 8,-5,  -4,-6, -8,-5],
  airkick:  [0,-18, 0,-14, 0,-8,  -3,-13, -5,-11,  2,-12, 3,-10,  5,-9, 12,-11,  1,-4, -1,-2],
  backkick: [2,-18, 1,-14, 0,-8,  3,-12, 5,-10,  -1,-12, 1,-10,  -5,-9, -12,-11,  1,-4, 2,-1],
  upkick:   [-1,-17, -1,-13, 0,-7,  -4,-10, -6,-8,  2,-10, 4,-9,  3,-14, 5,-22,  -1,-3, -2,0],
  stomp:    [0,-19, 0,-15, 0,-9,  -3,-16, -4,-19,  3,-16, 4,-19,  1,-4, 1,3,  -2,-6, -3,-3],
  dash:     [5,-14, 3,-12, -2,-8,  6,-10, 9,-11,  2,-9, 5,-8,  1,-4, 2,0,  -5,-5, -8,-3],
  slam:     [1,-16, 0,-12, 0,-6,  4,-8, 6,-3,  2,-8, 4,-3,  3,-3, 5,0,  -3,-3, -5,0],
  grab:     [2,-18, 1,-14, 0,-7,  5,-12, 9,-12,  4,-11, 8,-10,  3,-3, 4,0,  -2,-3, -4,0],
} satisfies Record<string, number[]>

export type PoseId = keyof typeof POSES

/** Each move: [startup pose, strike pose]. */
const MOVE_POSES: Record<string, [PoseId, PoseId]> = {
  jab: ['guard', 'punch'],
  ftilt: ['windup', 'kick'],
  utilt: ['crouch', 'uppercut'],
  dtilt: ['crouch', 'lowkick'],
  nair: ['tuck', 'spread'],
  fair: ['tuck', 'airkick'],
  bair: ['tuck', 'backkick'],
  uair: ['tuck', 'upkick'],
  dair: ['jump', 'stomp'],
  nb: ['windup', 'bigpunch'],
  sb: ['windup', 'dash'],
  ub: ['crouch', 'uppercut'],
  ctr: ['guard', 'guard'],
  ctrs: ['punch', 'bigpunch'],
  flip: ['crouch', 'upkick'],
  slam: ['jump', 'slam'],
  slama: ['jump', 'stomp'],
  grab: ['guard', 'grab'],
  thf: ['grab', 'punch'],
  thb: ['grab', 'backkick'],
  thu: ['grab', 'uppercut'],
  thd: ['grab', 'slam'],
  lga: ['crouch', 'kick'],
}

/** The pose for an animation id at tick t of it. */
export function poseFor(anim: number, t: number, flags: number, tick: number): PoseId {
  const name = ANIMS[anim] ?? 'idle'
  const m = MOVES[name]
  if (m) {
    const [pre, hit] = MOVE_POSES[name] ?? ['idle', 'punch']
    if (t < m.s) return pre
    if (t < m.s + m.a + 4) return hit
    return name === 'ub' ? 'fall' : name.startsWith('th') || ['jab', 'ftilt', 'utilt', 'dtilt', 'nb', 'grab', 'lga', 'slam', 'ctr', 'ctrs'].includes(name) ? 'idle' : 'fall'
  }
  switch (name) {
    case 'run':
      return (['run1', 'run2', 'run3', 'run4'] as const)[Math.floor(t / 5) % 4]
    case 'squat':
    case 'crouch':
    case 'land':
    case 'climb':
      return 'crouch'
    case 'air':
      return flags & FL.RISING ? (t < 12 ? 'jump' : 'idle') : 'fall'
    case 'helpless':
      return 'fall'
    case 'shield':
    case 'spot':
      return 'guard'
    case 'roll':
    case 'adodge':
      return 'tuck'
    case 'hurt':
    case 'held':
    case 'dizzy':
      return 'hurt'
    case 'ledge':
      return 'hang'
    case 'hold':
      return 'grab'
    default:
      return Math.floor(tick / 30) % 2 ? 'idle2' : 'idle'
  }
}

// ---------------------------------------------------------------------------------------------
// Characters' looks

interface Look {
  scale: number
  torso: number
  limb: number
  hand: number
  skin: string
  hair: string
  pants: string
  glove: string
  boot: string
  metal: string
  head: string[]
}

// Head grids (facing right): k outline, h hair, s skin, e eye, w eye white, b seat color, m metal, n nose/shade.
const LOOKS: Look[] = [
  {
    // Mako: headband brawler.
    scale: 1,
    torso: 5,
    limb: 2,
    hand: 3,
    skin: '#e8b48a',
    hair: '#3a2418',
    pants: '#2b3150',
    glove: '#f1e7d6',
    boot: '#3b2a22',
    metal: '#9aa4b4',
    head: ['..kkkk..', '.khhhhk.', 'khhhhhhk', 'kbbbbbbb', 'khsswesk', 'khssssnk', '.kssssk.', '..kkkk..'],
  },
  {
    // Zip: spiky-haired sprinter.
    scale: 0.86,
    torso: 4,
    limb: 2,
    hand: 2,
    skin: '#c98b5e',
    hair: '#f4f1e8',
    pants: '#24243a',
    glove: '#ff5a1f',
    boot: '#ff5a1f',
    metal: '#9aa4b4',
    head: ['h.hhh...', 'hhhhhhk.', '.hhhhhhk', 'hhhhhhhk', '.khsswek', '..kssssk', '..ksssk.', '...kkk..'],
  },
  {
    // Grum: horned-helmet heavy.
    scale: 1.14,
    torso: 7,
    limb: 3,
    hand: 4,
    skin: '#8fbf7a',
    hair: '#5b4636',
    pants: '#3c2f26',
    glove: '#6e5a48',
    boot: '#2a211b',
    metal: '#a7b0bf',
    head: ['w.......w', 'wk.kkk.kw', '.kmmmmmk.', 'kmmmbmmmk', 'kmmmmmmmk', 'kssswweek', 'ksssssssk', '.kssnnsk.', '..kkkkk..'],
  },
]

// ---------------------------------------------------------------------------------------------
// Rasterizer

const W = 48
const H = 52
/** Feet position inside the sprite canvas. */
export const ORIGIN_X = 24
export const ORIGIN_Y = 44
export const SPRITE_W = W
export const SPRITE_H = H

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)))
  const r = ch((n >> 16) & 255)
  const g = ch((n >> 8) & 255)
  const b = ch(n & 255)
  return `rgb(${r},${g},${b})`
}

export type Variant = 'normal' | 'flash' | 'dim'

const cache = new Map<string, HTMLCanvasElement>()

/** The sprite canvas (facing right; feet at ORIGIN_X, ORIGIN_Y). */
export function sprite(ch: number, pose: PoseId, color: string, variant: Variant = 'normal'): HTMLCanvasElement {
  const key = `${ch}|${pose}|${color}|${variant}`
  let c = cache.get(key)
  if (c) return c
  c = render(ch, pose, color, variant)
  cache.set(key, c)
  return c
}

function render(ch: number, pose: PoseId, color: string, variant: Variant): HTMLCanvasElement {
  const look = LOOKS[ch] ?? LOOKS[0]
  const p = POSES[pose]
  const px: (string | null)[] = new Array(W * H).fill(null)
  const set = (x: number, y: number, col: string) => {
    const ix = Math.round(x)
    const iy = Math.round(y)
    if (ix >= 0 && iy >= 0 && ix < W && iy < H) px[iy * W + ix] = col
  }
  const pt = (i: number): [number, number] => [ORIGIN_X + p[i * 2] * look.scale, ORIGIN_Y + p[i * 2 + 1] * look.scale]
  const square = (x: number, y: number, size: number, col: string) => {
    const o = (size - 1) / 2
    for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) set(x - o + dx, y - o + dy, col)
  }
  const line = (a: [number, number], b: [number, number], size: number, col: string) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2))
    for (let i = 0; i <= n; i++) square(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, size, col)
  }
  const body = color
  const bodyDark = shade(color, -0.35)
  const pantsDark = shade(look.pants, -0.3)
  const [head, neck, hip, fe, fh, be, bh, fk, ff, bk, bf] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(pt)
  // Back limbs, torso, front limbs, head.
  line(be, bh, look.limb, bodyDark)
  line(neck, be, look.limb, bodyDark)
  square(bh[0], bh[1], look.hand, shade(look.glove, -0.25))
  line(hip, bk, look.limb + 1, pantsDark)
  line(bk, bf, look.limb, pantsDark)
  square(bf[0] + 1, bf[1] - 1, look.limb + 1, shade(look.boot, -0.2))
  line(neck, hip, look.torso, body)
  // A belt line in the character's pants color.
  square(hip[0], hip[1], look.torso - 1, look.pants)
  line(hip, fk, look.limb + 1, look.pants)
  line(fk, ff, look.limb, look.pants)
  square(ff[0] + 1, ff[1] - 1, look.limb + 1, look.boot)
  line(neck, fe, look.limb, body)
  line(fe, fh, look.limb, body)
  square(fh[0], fh[1], look.hand, look.glove)
  // Head grid centered on the head joint.
  const g = look.head
  const gx = Math.round(head[0] - g[0].length / 2)
  const gy = Math.round(head[1] - g.length / 2)
  const pal: Record<string, string> = {
    k: '#1b1522',
    h: look.hair,
    s: look.skin,
    n: shade(look.skin, -0.2),
    e: '#15121c',
    w: '#ffffff',
    b: color,
    m: look.metal,
  }
  for (let y = 0; y < g.length; y++) {
    for (let x = 0; x < g[y].length; x++) {
      const k = g[y][x]
      if (k !== '.' && pal[k]) set(gx + x, gy + y, pal[k])
    }
  }
  // Outline: empty pixels touching the figure.
  const outline = '#140f1a'
  const filled = px.map((v) => v !== null)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (filled[y * W + x]) continue
      if ((x > 0 && filled[y * W + x - 1]) || (x < W - 1 && filled[y * W + x + 1]) || (y > 0 && filled[(y - 1) * W + x]) || (y < H - 1 && filled[(y + 1) * W + x])) {
        px[y * W + x] = outline
      }
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = px[y * W + x]
      if (!v) continue
      ctx.fillStyle = variant === 'flash' ? '#ffffff' : v
      ctx.fillRect(x, y, 1, 1)
    }
  }
  if (variant === 'dim') {
    ctx.globalCompositeOperation = 'source-atop'
    ctx.fillStyle = 'rgba(20, 16, 40, 0.45)'
    ctx.fillRect(0, 0, W, H)
  }
  return canvas
}

/** Character display name (HUD). */
export const charName = (ch: number) => CHARS[ch]?.name ?? '?'

const iconCache = new Map<string, HTMLCanvasElement>()

/** A small head portrait (stock icons, off-screen bubbles): the head grid with an outline, 1 px per cell. */
export function headIcon(ch: number, color: string): HTMLCanvasElement {
  const key = `${ch}|${color}`
  let c = iconCache.get(key)
  if (c) return c
  const look = LOOKS[ch] ?? LOOKS[0]
  const g = look.head
  const pal: Record<string, string> = { k: '#1b1522', h: look.hair, s: look.skin, n: shade(look.skin, -0.2), e: '#15121c', w: '#ffffff', b: color, m: look.metal }
  c = document.createElement('canvas')
  c.width = g[0].length + 2
  c.height = g.length + 2
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#140f1a'
  for (let y = 0; y < g.length; y++) for (let x = 0; x < g[y].length; x++) if (g[y][x] !== '.') ctx.fillRect(x, y, 3, 3)
  for (let y = 0; y < g.length; y++) {
    for (let x = 0; x < g[y].length; x++) {
      const k = g[y][x]
      if (k === '.' || !pal[k]) continue
      ctx.fillStyle = pal[k]
      ctx.fillRect(x + 1, y + 1, 1, 1)
    }
  }
  iconCache.set(key, c)
  return c
}
