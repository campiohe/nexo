// Client-side profile picture / banner processing: decode a picked file, crop a square (picture) or a
// BANNER_ASPECT rectangle (banner), resize to AVATAR_SIZE / BANNER_WIDTH×BANNER_HEIGHT and encode it small
// enough for the server (AVATAR_MAX_BYTES / BANNER_MAX_BYTES). Everything happens in a canvas; nothing leaves
// the machine except the final image.
import { AVATAR_MAX_BYTES, AVATAR_SIZE, BANNER_HEIGHT, BANNER_MAX_BYTES, BANNER_WIDTH } from '@shared/protocol'
import { animatedTypeOf } from './gifAvatar'
import { t } from '../i18n'

export const AVATAR_INPUT_TYPES = ['image/png', 'image/apng', 'image/jpeg', 'image/webp', 'image/gif'] as const
/** Refuse absurdly large source files before decoding them. */
export const AVATAR_INPUT_MAX_BYTES = 25 * 1024 * 1024
const MAX_SOURCE_PIXELS = 80_000_000

export interface LoadedImage {
  img: HTMLImageElement
  width: number
  height: number
  /** blob: URL backing `img`; call release() when done. */
  url: string
  release(): void
  /** The picked file. */
  file: Blob
  /**
   * Decoder type (image/gif, image/webp, image/png) when the file is an animation this machine can decode:
   * it's uploaded as an animated GIF (lib/gifAvatar.ts). null = a still picture.
   */
  animatedType: string | null
}

/** Decode a user-picked image file (`img` animates for animations). EXIF orientation is applied by Chromium. */
export async function loadImageFile(file: File): Promise<LoadedImage> {
  if (!(AVATAR_INPUT_TYPES as readonly string[]).includes(file.type)) {
    throw new Error(t('Pick a PNG, JPEG, WebP or GIF image'))
  }
  if (file.size > AVATAR_INPUT_MAX_BYTES) throw new Error(t('That image is too large (max 25 MB)'))
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  try {
    await img.decode()
  } catch {
    URL.revokeObjectURL(url)
    throw new Error(t("Couldn't read that image"))
  }
  const width = img.naturalWidth
  const height = img.naturalHeight
  if (!width || !height || width * height > MAX_SOURCE_PIXELS) {
    URL.revokeObjectURL(url)
    throw new Error(width && height ? t('That image has too many pixels') : t("Couldn't read that image"))
  }
  const animatedType = await animatedTypeOf(file).catch(() => null)
  return { img, width, height, url, release: () => URL.revokeObjectURL(url), file, animatedType }
}

/** A region of the source image, in source pixels (square for pictures, BANNER_ASPECT for banners). */
export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

/** What an encoded picture / banner must be: output size in pixels and the server's byte limit. */
export interface EncodeTarget {
  width: number
  height: number
  maxBytes: number
}
export const AVATAR_TARGET: EncodeTarget = { width: AVATAR_SIZE, height: AVATAR_SIZE, maxBytes: AVATAR_MAX_BYTES }
export const BANNER_TARGET: EncodeTarget = { width: BANNER_WIDTH, height: BANNER_HEIGHT, maxBytes: BANNER_MAX_BYTES }

/** Draw `crop` of `img` into a canvas of `width`×`height` px (square when `height` is omitted). */
export function drawCrop(
  canvas: HTMLCanvasElement,
  img: CanvasImageSource,
  crop: CropRect,
  width: number,
  height = width,
): void {
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height)
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/**
 * Render the crop at the target's size and encode it: WebP at 0.85, then lower qualities, then JPEG,
 * until it fits the target's maxBytes. The returned blob's `type` is the Content-Type to upload with.
 */
export async function encodeStill(img: CanvasImageSource, crop: CropRect, target: EncodeTarget): Promise<Blob> {
  const canvas = document.createElement('canvas')
  drawCrop(canvas, img, crop, target.width, target.height)

  const attempts: [string, number][] = [
    ['image/webp', 0.85],
    ['image/webp', 0.7],
    ['image/webp', 0.55],
    ['image/jpeg', 0.85],
    ['image/jpeg', 0.7],
    ['image/jpeg', 0.5],
  ]
  for (const [type, quality] of attempts) {
    const blob = await toBlob(canvas, type, quality)
    // An unsupported type silently falls back to PNG; skip it and try the next format.
    if (blob && blob.type === type && blob.size > 0 && blob.size <= target.maxBytes) return blob
  }
  throw new Error(t("Couldn't make that image small enough to upload"))
}
