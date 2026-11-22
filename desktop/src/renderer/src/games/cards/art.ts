// Color Rush pixel art, all drawn in code: suit icons (7×7 bitmaps), card faces and backs (cached sprites).
import { DECK_RANK, DECK_SUIT, R_BLOCK, R_FLIP, R_PLUS2, R_WILD4, WILD } from '@shared/games/cards/logic'
import { drawText } from '../retro'

export const CARD_W = 22
export const CARD_H = 30

/** Suit colors (amber star, cyan gem, pink heart, violet bolt): different hues AND lightness, plus a symbol. */
export const SUIT_COLOR = ['#ffb000', '#20c4e6', '#ff4d8d', '#9a6cff']
export const SUIT_DARK = ['#8a5400', '#0b6a80', '#93204f', '#4b2e9e']
export const INK = '#0b0a16'
export const CREAM = '#f6efdc'

// 7×7 icons, one row per entry, bit 6 = left column.
// prettier-ignore
export const ICONS = {
  star: [0x08, 0x1c, 0x7f, 0x3e, 0x1c, 0x36, 0x22],
  gem: [0x08, 0x1c, 0x3e, 0x7f, 0x3e, 0x1c, 0x08],
  heart: [0x36, 0x7f, 0x7f, 0x3e, 0x1c, 0x08, 0x00],
  bolt: [0x0c, 0x18, 0x30, 0x7f, 0x06, 0x0c, 0x18],
  block: [0x1c, 0x32, 0x51, 0x49, 0x45, 0x26, 0x1c],
  flip: [0x20, 0x7f, 0x20, 0x00, 0x02, 0x7f, 0x02],
}
export const SUIT_ICONS = [ICONS.star, ICONS.gem, ICONS.heart, ICONS.bolt]

export function drawIcon(ctx: CanvasRenderingContext2D, bits: number[], x: number, y: number, color: string, scale = 1): void {
  ctx.fillStyle = color
  for (let r = 0; r < 7; r++) {
    const row = bits[r]
    if (!row) continue
    for (let c = 0; c < 7; c++) if (row & (1 << (6 - c))) ctx.fillRect(Math.round(x) + c * scale, Math.round(y) + r * scale, scale, scale)
  }
}

/** A box with its corners cut (pixel "rounded" rectangle). */
export function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string): void {
  ctx.fillStyle = fill
  ctx.fillRect(x + 1, y, w - 2, h)
  ctx.fillRect(x, y + 1, w, h - 2)
}

const cache = new Map<string, HTMLCanvasElement>()

function sprite(key: string, w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  let c = cache.get(key)
  if (!c) {
    c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    if (ctx) paint(ctx)
    cache.set(key, c)
  }
  return c
}

function rankLabel(rank: number): string {
  return rank <= 9 ? String(rank) : rank === R_PLUS2 ? '+2' : rank === R_WILD4 ? '+4' : 'W'
}

function paintFace(ctx: CanvasRenderingContext2D, id: number): void {
  const suit = DECK_SUIT[id]
  const rank = DECK_RANK[id]
  box(ctx, 0, 0, CARD_W, CARD_H, INK)
  box(ctx, 1, 1, CARD_W - 2, CARD_H - 2, CREAM)
  if (suit === WILD) {
    ctx.fillStyle = '#1d1830'
    ctx.fillRect(2, 2, CARD_W - 4, CARD_H - 4)
    // Four suit icons in a 2×2 grid: wilds are every suit at once.
    for (let i = 0; i < 4; i++) drawIcon(ctx, SUIT_ICONS[i], 3 + (i % 2) * 9, 11 + Math.floor(i / 2) * 8, SUIT_COLOR[i])
    drawText(ctx, rankLabel(rank), 3, 3, { color: '#ffffff' })
    return
  }
  const color = SUIT_COLOR[suit]
  const dark = SUIT_DARK[suit]
  ctx.fillStyle = color
  ctx.fillRect(2, 2, CARD_W - 4, CARD_H - 4)
  // A darker band at the bottom (retro bevel).
  ctx.fillStyle = dark
  ctx.fillRect(2, CARD_H - 4, CARD_W - 4, 2)
  // Corner index: rank (top-left) and suit icon (top-right).
  if (rank === R_BLOCK) drawIcon(ctx, ICONS.block, 3, 3, '#ffffff')
  else if (rank === R_FLIP) drawIcon(ctx, ICONS.flip, 3, 3, '#ffffff')
  else drawText(ctx, rankLabel(rank), 3, 3, { color: '#ffffff', shadow: dark })
  if (rank !== R_PLUS2) drawIcon(ctx, SUIT_ICONS[suit], CARD_W - 10, 3, '#ffffff')
  // Center art.
  const cx = CARD_W / 2
  if (rank <= 9) {
    drawText(ctx, String(rank), cx - 1, 12, { align: 'center', color: '#ffffff', scale: 2, shadow: dark })
  } else if (rank === R_BLOCK || rank === R_FLIP) {
    drawIcon(ctx, rank === R_BLOCK ? ICONS.block : ICONS.flip, cx - 6, 13, dark, 2)
    drawIcon(ctx, rank === R_BLOCK ? ICONS.block : ICONS.flip, cx - 7, 12, '#ffffff', 2)
  } else {
    // +2: two little stacked cards.
    box(ctx, cx - 8, 14, 9, 11, INK)
    box(ctx, cx - 7, 15, 7, 9, '#ffffff')
    box(ctx, cx - 2, 11, 9, 11, INK)
    box(ctx, cx - 1, 12, 7, 9, '#ffffff')
    drawIcon(ctx, SUIT_ICONS[suit], cx - 1, 13, color)
  }
}

function paintBack(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  box(ctx, 0, 0, w, h, INK)
  box(ctx, 1, 1, w - 2, h - 2, '#d9d0ff')
  ctx.fillStyle = '#2a1d5c'
  ctx.fillRect(2, 2, w - 4, h - 4)
  // Diagonal checker stripes in the four suit colors.
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const d = x + y
      if (d % 4 === 0) {
        ctx.fillStyle = SUIT_DARK[Math.floor(d / 8) % 4]
        ctx.fillRect(x, y, 1, 1)
      }
    }
  }
  if (w >= 16) {
    box(ctx, w / 2 - 6, h / 2 - 6, 12, 12, INK)
    drawIcon(ctx, ICONS.bolt, w / 2 - 3.5, h / 2 - 3.5, '#ffd84a')
  }
}

export function drawFace(ctx: CanvasRenderingContext2D, id: number, x: number, y: number): void {
  ctx.drawImage(
    sprite(`f${id}`, CARD_W, CARD_H, (c) => paintFace(c, id)),
    Math.round(x),
    Math.round(y),
  )
}

export function drawBack(ctx: CanvasRenderingContext2D, x: number, y: number, mini = false): void {
  if (mini) {
    // A tiny face-down card for the fans around the table: outline, violet back, light left edge.
    const rx = Math.round(x)
    const ry = Math.round(y)
    ctx.fillStyle = INK
    ctx.fillRect(rx, ry, 6, 9)
    ctx.fillStyle = '#5a3fc8'
    ctx.fillRect(rx + 1, ry + 1, 4, 7)
    ctx.fillStyle = '#d9d0ff'
    ctx.fillRect(rx + 1, ry + 1, 1, 7)
    ctx.fillStyle = '#ffd84a'
    ctx.fillRect(rx + 3, ry + 4, 1, 1)
    return
  }
  ctx.drawImage(
    sprite('b', CARD_W, CARD_H, (c) => paintBack(c, CARD_W, CARD_H)),
    Math.round(x),
    Math.round(y),
  )
}
