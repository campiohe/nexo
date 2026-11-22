// Blast Arena pixel art: string sprites (one char per pixel, '.' transparent) rendered once into small canvases
// per palette, and the color helpers the view uses. Original designs: round "blast bots" with an antenna light
// (tinted with the seat color), charge-core bombs, wooden crates, riveted steel pillars, hazard blocks.

export type Palette = Record<string, string>

const cache = new Map<string, HTMLCanvasElement>()

/** A sprite drawn into a canvas (cached by `key`). `flip` mirrors it horizontally. */
export function sprite(key: string, rows: readonly string[], pal: Palette, flip = false): HTMLCanvasElement {
  const k = `${key}|${flip ? 1 : 0}`
  const hit = cache.get(k)
  if (hit) return hit
  const w = rows[0].length
  const h = rows.length
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][flip ? w - 1 - x : x]
      const color = pal[ch]
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(x, y, 1, 1)
    }
  }
  if (cache.size > 400) cache.clear()
  cache.set(k, c)
  return c
}

function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const n = m ? parseInt(m[1], 16) : 0xffffff
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** a + (b - a) * t in RGB, as #rrggbb. */
export function mix(a: string, b: string, t: number): string {
  const x = hexRgb(a)
  const y = hexRgb(b)
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t))
  return `#${((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1)}`
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexRgb(hex)
  return `rgba(${r},${g},${b},${alpha})`
}

// ---------------------------------------------------------------------------------------------
// Blast bots (12×16): body (14 rows) + feet (2 rows). Facing: 0 up, 1 down, 2 left, 3 right (= left mirrored).

const HEAD = ['.....oo.....', '....oyyo....', '.....oo.....', '...oooooo...']

const BODY_DOWN = [
  ...HEAD,
  '..ollcccco..',
  '.olccccccco.',
  '.ovvvvvvvvo.',
  '.ovwvvvvwvo.',
  '.ovvvvvvvvo.',
  '.occcccccco.',
  '..oddddddo..',
  '.ohowwwwoho.',
  '.oo.oddo.oo.',
  '...oddddo...',
]

const BODY_UP = [
  ...HEAD,
  '..occccllo..',
  '.occcccccco.',
  '.occcccccco.',
  '.oddddddddo.',
  '.occcccccco.',
  '.occcccccco.',
  '..oddddddo..',
  '.ohoggggoho.',
  '.oo.oggo.oo.',
  '...oddddo...',
]

const BODY_LEFT = [
  '......oo....',
  '.....oyyo...',
  '......oo....',
  '...oooooo...',
  '..ollcccco..',
  '.olccccccco.',
  '.ovvvvvccco.',
  '.owvvvvccco.',
  '.ovvvvvccco.',
  '.occcccccco.',
  '..oddddddo..',
  '..owwdddho..',
  '..owwddoo...',
  '...oddddo...',
]

const FEET = [
  ['..oko..oko..', '..ooo..ooo..'],
  ['..oko..oko..', '..ooo.......'],
  ['..oko..oko..', '.......ooo..'],
]

/** Walk cycle: feet frame and body bob per step. */
export const WALK = [0, 1, 0, 2]

export function botSprite(dir: number, step: number, pal: Palette, palKey: string): HTMLCanvasElement {
  const body = dir === 0 ? BODY_UP : dir === 1 ? BODY_DOWN : BODY_LEFT
  const feet = FEET[step] ?? FEET[0]
  return sprite(`bot${dir === 3 ? 2 : dir}:${step}:${palKey}`, [...body, ...feet], pal, dir === 3)
}

export function botPalette(color: string, light = '#fff27a'): Palette {
  return {
    o: '#0b0d14',
    c: color,
    l: mix(color, '#ffffff', 0.45),
    d: mix(color, '#000000', 0.38),
    v: '#162232',
    w: '#eef3ff',
    y: light,
    h: '#d6dbe6',
    k: '#2b3040',
    g: '#7d879b',
  }
}

/** All-white silhouette (hit flash). */
export const FLASH_PALETTE: Palette = { o: '#ffffff', c: '#ffffff', l: '#ffffff', d: '#ffffff', v: '#ffffff', w: '#ffffff', y: '#ffffff', h: '#ffffff', k: '#ffffff', g: '#ffffff' }

// ---------------------------------------------------------------------------------------------
// Bombs (12×12): a charge core with a band in the owner's color.

export const BOMB = [
  '......f.....',
  '.....ooo....',
  '...oooooo...',
  '..obbbbbbo..',
  '.obwwbbbbbo.',
  '.obwbbbbbbo.',
  '.obbbbbbbbo.',
  '.occcccccco.',
  '.obbbbbbbbo.',
  '.obbbbbbbbo.',
  '..obbbbbbo..',
  '...oooooo...',
]

/** The pulse frame: the core swells by a pixel. */
export const BOMB_BIG = [
  '......f.....',
  '.....ooo....',
  '...oooooo...',
  '.oobbbbbboo.',
  'obwwbbbbbbbo',
  'obwbbbbbbbbo',
  'obbbbbbbbbbo',
  'occcccccccco',
  'obbbbbbbbbbo',
  'obbbbbbbbbbo',
  '.oobbbbbboo.',
  '...oooooo...',
]

export function bombPalette(color: string, hot: boolean): Palette {
  return {
    o: '#07080d',
    b: hot ? '#b3263c' : '#2a2f45',
    w: hot ? '#ff8a8a' : '#8b93b8',
    c: color,
    f: '#c9a26b',
  }
}

// ---------------------------------------------------------------------------------------------
// Power-up icons (8×8, 'x' light, 'k' dark).

export const ICONS: Record<number, readonly string[]> = {
  1: ['.....x..', '....x...', '..xxxx..', '.xxxxxx.', '.xkxxxx.', '.xxxxxx.', '.xxxxxx.', '..xxxx..'],
  2: ['...x....', '...xx...', '..xxx.x.', '..xxxxx.', '.xxkxxx.', '.xkkkxx.', '.xxkkxx.', '..xxxx..'],
  3: ['x...x...', 'xx..xx..', '.xx..xx.', '..xx..xx', '..xx..xx', '.xx..xx.', 'xx..xx..', 'x...x...'],
  4: ['..xxx...', '..xxx...', '..xxx...', '..xxx...', '..xxxx..', '..xxxxxx', '.xxxxxxx', '.xxxxxxx'],
  5: ['.xxxxxx.', 'xxxxxxxx', 'xxxkkxxx', 'xxxkkxxx', 'xxkkkkxx', '.xxkkxx.', '..xxxx..', '...xx...'],
  6: ['.xxxxxx.', '...xx...', '...xx...', '.xxxxxx.', 'xkkkkkkx', 'xkxxxxkx', 'xkkkkkkx', 'xxxxxxxx'],
}

/** Item tile colors by item (1 bomb, 2 range, 3 speed, 4 kick, 5 shield, 6 trigger). */
export const ITEM_COLORS: Record<number, string> = {
  1: '#3d6bff',
  2: '#ff7a1a',
  3: '#22c36e',
  4: '#a35cff',
  5: '#1fb8d8',
  6: '#ff3d6b',
}

export function iconSprite(item: number, light = '#ffffff', dark = '#141824'): HTMLCanvasElement {
  return sprite(`icon${item}:${light}:${dark}`, ICONS[item] ?? ICONS[1], { x: light, k: dark })
}
