// A custom accent (Settings → Appearance): the six accent variables tokens.css gives each preset, derived from one
// picked #rrggbb. Pure functions, no DOM.
//
// Shades move along OKLCH lightness with the hue kept (chroma is only reduced where the color would leave sRGB), so
// they stay as vivid as the picked color. A shade that already meets the contrast target is the picked color itself.

/** The six accent variables (tokens.css, accent presets). */
export interface AccentShades {
  /** Dark / midnight palettes: the accent, its pressed / hover shade, text drawn on it. */
  accentD: string
  strongD: string
  inkD: string
  /** Light palette: deepened so it reads as text on bg-1…bg-3. */
  accentL: string
  strongL: string
  inkL: string
}

/** CSS custom property for each shade. */
export const ACCENT_VARS: Record<keyof AccentShades, string> = {
  accentD: '--accent-d',
  strongD: '--accent-strong-d',
  inkD: '--accent-ink-d',
  accentL: '--accent-l',
  strongL: '--accent-strong-l',
  inkL: '--accent-ink-l',
}

/** WCAG AA for normal text. */
const MIN_CONTRAST = 4.5
/**
 * The lightest dark-palette surface (bg-4, active / pressed); midnight is darker still. Measured against it rather
 * than bg-3 so a lightened color lands nearer the presets' brightness (5.7–8.6:1 on bg-3) instead of just passing.
 */
const DARK_SURFACE = '#303030'
/** The darkest surface of the light palette's bg-1…bg-3 (bg-3). */
const LIGHT_SURFACE = '#ececec'
/** How much darker the strong (hover / pressed) shade is, in OKLCH lightness; about what the presets use. */
const STRONG_STEP_D = 0.05
const STRONG_STEP_L = 0.06
/** The dark-palette ink: a very dark tint of the hue. */
const INK_D_LIGHTNESS = 0.25
const INK_D_MAX_CHROMA = 0.06

/** '#abc', 'abc', '#aabbcc' or 'aabbcc' (any case, surrounding spaces ok) → '#aabbcc'; anything else → null. */
export function parseHex(input: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim())
  if (!m) return null
  const h = m[1].toLowerCase()
  return '#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h)
}

type Rgb = [number, number, number] // 0…1 each

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function rgbToHex(rgb: Rgb): string {
  return '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const fromLinear = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two #rrggbb colors (1…21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

interface Oklch {
  l: number
  c: number
  /** Degrees. */
  h: number
}

function toOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex).map(toLinear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 }
}

/** Linear sRGB (may be out of 0…1) for an OKLCH color. */
function oklchToLinear({ l: L, c, h }: Oklch): Rgb {
  const A = c * Math.cos((h * Math.PI) / 180)
  const B = c * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)

/** OKLCH → #rrggbb, lowering chroma (same lightness and hue) until it fits in sRGB. */
function fromOklch(color: Oklch): string {
  const l = Math.min(1, Math.max(0, color.l))
  let rgb = oklchToLinear({ ...color, l })
  if (!inGamut(rgb)) {
    let lo = 0
    let hi = color.c
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(oklchToLinear({ l, c: mid, h: color.h }))) lo = mid
      else hi = mid
    }
    rgb = oklchToLinear({ l, c: lo, h: color.h })
  }
  return rgbToHex(rgb.map(fromLinear) as Rgb)
}

/**
 * The picked color if it already has `MIN_CONTRAST` against `surface`; otherwise the same hue moved lighter (on a
 * dark surface) or darker (on a light one) just far enough to pass.
 */
function shadeOn(hex: string, surface: string, lighter: boolean): string {
  if (contrast(hex, surface) >= MIN_CONTRAST) return hex
  const color = toOklch(hex)
  // [pass, fail] bounds on lightness: white passes on the dark surface, black on the light one.
  let pass = lighter ? 1 : 0
  let fail = color.l
  let best = fromOklch({ ...color, l: pass })
  for (let i = 0; i < 24; i++) {
    const mid = (pass + fail) / 2
    const candidate = fromOklch({ ...color, l: mid })
    if (contrast(candidate, surface) >= MIN_CONTRAST) {
      pass = mid
      best = candidate
    } else {
      fail = mid
    }
  }
  return best
}

/** `tint`, moved darker (or lighter) until it has MIN_CONTRAST on every one of `backgrounds`. */
function inkOn(tint: Oklch, backgrounds: string[], lighter: boolean): string {
  const passes = (hex: string) => backgrounds.every((bg) => contrast(hex, bg) >= MIN_CONTRAST)
  const first = fromOklch(tint)
  if (passes(first)) return first
  let pass = lighter ? 1 : 0
  let fail = tint.l
  let best = fromOklch({ ...tint, l: pass })
  for (let i = 0; i < 24; i++) {
    const mid = (pass + fail) / 2
    const candidate = fromOklch({ ...tint, l: mid })
    if (passes(candidate)) {
      pass = mid
      best = candidate
    } else {
      fail = mid
    }
  }
  return best
}

const minContrast = (fg: string, backgrounds: string[]) => Math.min(...backgrounds.map((bg) => contrast(fg, bg)))

/** The six accent variables for a picked #rrggbb (see parseHex). */
export function deriveAccent(hex: string): AccentShades {
  const picked = parseHex(hex) ?? '#43d6a3'

  // Dark palettes: light enough to read on bg-3; ink a very dark tint of the hue (white only if that reads better).
  const accentD = shadeOn(picked, DARK_SURFACE, true)
  const d = toOklch(accentD)
  const strongD = fromOklch({ ...d, l: d.l - STRONG_STEP_D })
  const darkTint = inkOn({ l: INK_D_LIGHTNESS, c: Math.min(d.c, INK_D_MAX_CHROMA), h: d.h }, [accentD, strongD], false)
  const inkD = minContrast('#ffffff', [accentD, strongD]) > minContrast(darkTint, [accentD, strongD]) ? '#ffffff' : darkTint

  // Light palette: dark enough to read on bg-3; strong darker still (lighter for a near-black pick, where darker
  // wouldn't show); white ink.
  const accentL = shadeOn(picked, LIGHT_SURFACE, false)
  const l = toOklch(accentL)
  const strongL = fromOklch({
    ...l,
    l: l.l - STRONG_STEP_L >= 0.24 ? l.l - STRONG_STEP_L : Math.max(l.l + STRONG_STEP_L, 0.3),
  })
  const inkL =
    minContrast('#ffffff', [accentL, strongL]) >= MIN_CONTRAST
      ? '#ffffff'
      : inkOn({ l: 0.2, c: Math.min(l.c, 0.04), h: l.h }, [accentL, strongL], false)

  return { accentD, strongD, inkD, accentL, strongL, inkL }
}

// ---- HSV, for the picker's saturation / value area ----

/** Hue 0…360, saturation and value 0…1. */
export interface Hsv {
  h: number
  s: number
  v: number
}

export function hexToHsv(hex: string): Hsv {
  const [r, g, b] = hexToRgb(hex)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = (h * 60 + 360) % 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return rgbToHex([f(5), f(3), f(1)])
}
