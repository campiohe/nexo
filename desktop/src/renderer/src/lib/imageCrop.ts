// Client-side profile picture processing: decode a picked file, crop a square, resize to AVATAR_SIZE and
// encode it small enough for the server (AVATAR_MAX_BYTES). Everything happens in a canvas; nothing leaves
// the machine except the final image.
import { AVATAR_MAX_BYTES, AVATAR_SIZE } from '@shared/protocol'

export const AVATAR_INPUT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
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
}

/** Decode a user-picked image file (first frame for GIFs). EXIF orientation is applied by Chromium. */
export async function loadImageFile(file: File): Promise<LoadedImage> {
  if (!(AVATAR_INPUT_TYPES as readonly string[]).includes(file.type)) {
    throw new Error('Pick a PNG, JPEG, WebP or GIF image')
  }
  if (file.size > AVATAR_INPUT_MAX_BYTES) throw new Error('That image is too large (max 25 MB)')
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  try {
    await img.decode()
  } catch {
    URL.revokeObjectURL(url)
    throw new Error("Couldn't read that image")
  }
  const width = img.naturalWidth
  const height = img.naturalHeight
  if (!width || !height || width * height > MAX_SOURCE_PIXELS) {
    URL.revokeObjectURL(url)
    throw new Error(width && height ? 'That image has too many pixels' : "Couldn't read that image")
  }
  return { img, width, height, url, release: () => URL.revokeObjectURL(url) }
}

/** A square region of the source image, in source pixels. */
export interface CropRect {
  x: number
  y: number
  size: number
}

/** Draw `crop` of `img` into a square canvas of `size` px. */
export function drawCrop(canvas: HTMLCanvasElement, img: CanvasImageSource, crop: CropRect, size: number): void {
  if (canvas.width !== size) canvas.width = size
  if (canvas.height !== size) canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, size, size)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size)
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/**
 * Render the crop at AVATAR_SIZE and encode it: WebP at 0.85, then lower qualities, then JPEG,
 * until it fits AVATAR_MAX_BYTES. The returned blob's `type` is the Content-Type to upload with.
 */
export async function encodeAvatar(img: CanvasImageSource, crop: CropRect): Promise<Blob> {
  const canvas = document.createElement('canvas')
  drawCrop(canvas, img, crop, AVATAR_SIZE)

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
    if (blob && blob.type === type && blob.size > 0 && blob.size <= AVATAR_MAX_BYTES) return blob
  }
  throw new Error("Couldn't make that picture small enough to upload")
}
