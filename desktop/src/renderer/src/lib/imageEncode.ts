// Client-side preparation of chat images before upload (see the ATTACHMENT_* block in shared/protocol.ts).
// The type comes from the file's bytes (names and clipboard types can lie). Still images over the size limit
// are re-encoded to WebP in an OffscreenCanvas; animations can't be, so an oversized GIF is refused.
import type { AttachmentType } from '@shared/protocol'
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_REENCODE_MAX_SIDE } from '@shared/protocol'

const MB = Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))
/** Refuse absurdly large source files before decoding them. */
const INPUT_MAX_BYTES = 100 * 1024 * 1024
const WEBP_QUALITIES = [0.9, 0.8, 0.7]

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))

/** The attachment type from the first bytes, plus whether a WebP is animated (VP8X animation flag). */
async function sniff(blob: Blob): Promise<{ type: AttachmentType; animated: boolean } | null> {
  const b = new Uint8Array(await blob.slice(0, 32).arrayBuffer())
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return { type: 'image/png', animated: false }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', animated: false }
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return { type: 'image/gif', animated: true }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') {
    return { type: 'image/webp', animated: ascii(b, 12, 16) === 'VP8X' && (b[20] & 0x02) !== 0 }
  }
  return null
}

/** Decode, scale the longest side down to ATTACHMENT_REENCODE_MAX_SIDE and encode as WebP within the limit. */
async function reencode(blob: Blob): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    // EXIF orientation is applied here, so the result is upright without it.
    bitmap = await createImageBitmap(blob)
  } catch {
    throw new Error("Couldn't read that image")
  }
  try {
    const scale = Math.min(1, ATTACHMENT_REENCODE_MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error("Couldn't process that image")
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, width, height)
    for (const quality of WEBP_QUALITIES) {
      const out = await canvas.convertToBlob({ type: 'image/webp', quality })
      if (out.type === 'image/webp' && out.size > 0 && out.size <= ATTACHMENT_MAX_BYTES) return out
    }
    throw new Error(`Couldn't make that image smaller than ${MB} MB`)
  } finally {
    bitmap.close()
  }
}

/**
 * Returns the blob to upload, typed with its real Content-Type. Throws an Error with a user-facing message
 * for files that can't be sent.
 */
export async function prepareImage(file: Blob): Promise<Blob> {
  if (file.size === 0) throw new Error('That file is empty')
  if (file.size > INPUT_MAX_BYTES) throw new Error('That image is too large')
  const kind = await sniff(file)
  if (!kind) throw new Error('Only PNG, JPEG, WebP and GIF images can be sent')
  if (file.size <= ATTACHMENT_MAX_BYTES) return file.type === kind.type ? file : new Blob([file], { type: kind.type })
  if (kind.animated) {
    throw new Error(`${kind.type === 'image/gif' ? 'GIFs' : 'Animated images'} are limited to ${MB} MB`)
  }
  return reencode(file)
}
