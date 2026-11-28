// Settings → Appearance → App icon: the variants of the Nexo icon (resources/icon.svg: a ring with a dot breaking out
// of it, on a rounded-square tile) and the PNG main applies to the window, tray and shortcuts (main/appIcon.ts).

import { msg } from '../i18n/core'

/** Labels are message keys: show them with t(label). */
export const APP_ICONS = [
  { id: 'classic', label: msg('Classic') },
  { id: 'accent', label: msg('Accent // app icon') },
  { id: 'paper', label: msg('Paper') },
  { id: 'mono', label: msg('Mono') },
] as const
export type AppIconChoice = (typeof APP_ICONS)[number]['id']

/** Variants drawn from the accent: redrawn when the accent changes. */
export const usesAccent = (choice: AppIconChoice): boolean => choice === 'accent' || choice === 'paper'

/** resources/icon.svg, in its 1024 unit box. */
export const ICON_GEOMETRY = {
  size: 1024,
  tile: { x: 72, y: 72, size: 880, radius: 196 },
  ring: { cx: 496, cy: 528, r: 226, width: 80 },
  /** The ring is cut around the dot (the mask in icon.svg). */
  cut: { cx: 655.81, cy: 368.19, r: 130 },
  dot: { cx: 655.81, cy: 368.19, r: 96 },
} as const

export interface IconColors {
  tile: string
  ring: string
  dot: string
}

/** The artwork's colors; `accent` / `ink` are the accent and the color on it (CSS values or resolved hex). */
export function iconColors(choice: AppIconChoice, accent: string, ink: string): IconColors {
  switch (choice) {
    case 'accent':
      return { tile: accent, ring: ink, dot: ink }
    case 'paper':
      return { tile: '#f4f4f2', ring: '#1a1a1a', dot: accent }
    case 'mono':
      return { tile: '#000000', ring: '#ffffff', dot: '#ffffff' }
    default:
      return { tile: '#0b0d11', ring: '#3ee6b0', dot: '#3ee6b0' }
  }
}

/** The accent preset's dark-palette shade (--accent-d / --accent-ink-d), so the icon is the same in every theme. */
function pageAccent(): { accent: string; ink: string } {
  const css = getComputedStyle(document.documentElement)
  return {
    accent: css.getPropertyValue('--accent-d').trim() || '#43d6a3',
    ink: css.getPropertyValue('--accent-ink-d').trim() || '#06261b',
  }
}

/**
 * The variant as a square PNG data URL, framed like icon.png (same margin around the tile, so it sits in the
 * taskbar at the same size). Drawn with canvas paths rather than an SVG image: synchronous, and no image loading.
 */
export function renderAppIcon(choice: AppIconChoice, px = 256): string | null {
  const { accent, ink } = pageAccent()
  const colors = iconColors(choice, accent, ink)
  const { size, tile, ring, cut, dot } = ICON_GEOMETRY

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = px
  const ctx = canvas.getContext('2d')
  // The ring goes on its own layer, so cutting the gap for the dot doesn't cut the tile under it.
  const layer = document.createElement('canvas')
  layer.width = layer.height = px
  const lctx = layer.getContext('2d')
  if (!ctx || !lctx) return null
  const scale = px / size
  ctx.scale(scale, scale)
  lctx.scale(scale, scale)

  ctx.fillStyle = colors.tile
  ctx.beginPath()
  ctx.roundRect(tile.x, tile.y, tile.size, tile.size, tile.radius)
  ctx.fill()

  lctx.strokeStyle = colors.ring
  lctx.lineWidth = ring.width
  lctx.beginPath()
  lctx.arc(ring.cx, ring.cy, ring.r, 0, Math.PI * 2)
  lctx.stroke()
  lctx.globalCompositeOperation = 'destination-out'
  lctx.beginPath()
  lctx.arc(cut.cx, cut.cy, cut.r, 0, Math.PI * 2)
  lctx.fill()

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(layer, 0, 0)
  ctx.scale(scale, scale)

  ctx.fillStyle = colors.dot
  ctx.beginPath()
  ctx.arc(dot.cx, dot.cy, dot.r, 0, Math.PI * 2)
  ctx.fill()

  return canvas.toDataURL('image/png')
}
