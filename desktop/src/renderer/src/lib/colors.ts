// Profile color palette + helpers.

export const SWATCHES = [
  '#3ee6b0', // mint
  '#4cc9f0', // sky
  '#7c8cff', // periwinkle
  '#b980ff', // violet
  '#ff6fb5', // pink
  '#ff7a59', // coral
  '#ffc145', // amber
  '#9be564', // lime
] as const

export function randomSwatch(): string {
  return SWATCHES[Math.floor(Math.random() * SWATCHES.length)]
}

/** First letter (or two) for an avatar. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return [...parts[0]][0]!.toUpperCase()
  return ([...parts[0]][0]! + [...parts[1]][0]!).toUpperCase()
}

/** Readable text color (dark or light) on top of a #rrggbb background. */
export function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return '#0b0d11'
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.55 ? '#0b0d11' : '#ffffff'
}
