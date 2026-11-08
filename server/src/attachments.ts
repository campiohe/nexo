// Chat images over plain HTTP (see the ATTACHMENT_* block in shared/protocol.ts):
//   POST /api/attachments   upload (Authorization: Bearer <device token>) → pending attachment
//   GET  /attachments/:id   serve (only once a message has claimed it)
// Files live in <dataDir>/attachments/<id>; the DB row holds type, size and dimensions.
// Validation reads magic bytes and the dimensions from the image header: no decoding, no native libraries.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { open, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { AttachmentType } from '../../shared/protocol.ts'
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_DIMENSION, ATTACHMENT_TYPES } from '../../shared/protocol.ts'
import type { Db } from './db.ts'
import {
  HttpError,
  UUID_RE,
  authenticate,
  corsHeaders,
  declaredLength,
  declaredType,
  finish,
  preflight,
  readBody,
  sendJson,
} from './http.ts'

// ---------- header parsing ----------

export interface ImageInfo {
  type: AttachmentType
  width: number
  height: number
}

const startsWith = (buf: Uint8Array, bytes: number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Detects the image type from its first bytes, or null if it isn't a PNG, JPEG, WebP or GIF. */
export function sniffAttachment(buf: Uint8Array): AttachmentType | null {
  if (startsWith(buf, PNG_SIG)) return 'image/png'
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) return 'image/webp'
  if (startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'))) return 'image/gif'
  return null
}

type Size = { width: number; height: number }

/** PNG: the IHDR chunk always comes first (width and height are big-endian u32). */
function pngSize(b: Buffer): Size | null {
  if (b.length < 24 || !startsWith(b, ascii('IHDR'), 12)) return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

/** GIF: the logical screen descriptor right after the signature (little-endian u16). */
function gifSize(b: Buffer): Size | null {
  if (b.length < 10) return null
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
}

/** WebP: lossy (VP8), lossless (VP8L) or extended (VP8X, also used for animations) bitstreams. */
function webpSize(b: Buffer): Size | null {
  if (b.length < 30) return null
  const chunk = b.toString('latin1', 12, 16)
  if (chunk === 'VP8 ') {
    // 3-byte frame tag, then the key frame start code 9d 01 2a and 14-bit dimensions.
    if (!startsWith(b, [0x9d, 0x01, 0x2a], 23)) return null
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
  }
  return null
}

/** EXIF orientation (1–8) from an APP1 segment payload, or 1 when absent or unreadable. */
function exifOrientation(b: Buffer, start: number, end: number): number {
  if (end - start < 14 || b.toString('latin1', start, start + 6) !== 'Exif\0\0') return 1
  const tiff = start + 6
  const order = b.toString('latin1', tiff, tiff + 2)
  if (order !== 'II' && order !== 'MM') return 1
  const le = order === 'II'
  const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
  const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
  const ifd = tiff + u32(tiff + 4)
  if (ifd + 2 > end) return 1
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) break
    if (u16(entry) === 0x0112) {
      const v = u16(entry + 8)
      return v >= 1 && v <= 8 ? v : 1
    }
  }
  return 1
}

/**
 * JPEG: walk the marker segments up to the first SOFn frame header (height, then width, big-endian u16).
 * EXIF orientations 5–8 rotate by 90°, which Chromium applies when displaying, so those swap the sides.
 */
function jpegSize(b: Buffer): Size | null {
  let o = 2
  let orientation = 1
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null
    const marker = b[o + 1]
    if (marker === 0xff) {
      o++ // fill byte
      continue
    }
    // Markers without a length: TEM and RST0–7. SOS/EOI before a frame header means there is none.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const len = b.readUInt16BE(o + 2)
    if (len < 2 || o + 2 + len > b.length) return null
    if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(b, o + 4, o + 2 + len)
    // SOF0–SOF15, except DHT (c4), JPG (c8) and DAC (cc), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (len < 7) return null
      const height = b.readUInt16BE(o + 5)
      const width = b.readUInt16BE(o + 7)
      return orientation >= 5 ? { width: height, height: width } : { width, height }
    }
    o += 2 + len
  }
  return null
}

/** Type and display size from the file header, or null when the header is missing or unreadable. */
export function probeImage(buf: Buffer): ImageInfo | null {
  const type = sniffAttachment(buf)
  if (!type) return null
  let size: Size | null = null
  try {
    if (type === 'image/png') size = pngSize(buf)
    else if (type === 'image/gif') size = gifSize(buf)
    else if (type === 'image/webp') size = webpSize(buf)
    else size = jpegSize(buf)
  } catch {
    size = null // a read past the end of a truncated header
  }
  return size && { type, ...size }
}

// ---------- routes ----------

const CORS_HEADERS = corsHeaders('POST')
const MB = Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))
const tooLarge = () => new HttpError(413, `Images are limited to ${MB} MB`)
const RATE_WINDOW_MS = 60_000

export interface AttachmentRoutesOptions {
  dataDir: string
  users: Db['users']
  attachments: Db['attachments']
  hashToken(token: string): string
  /** Accepted uploads per user per minute. */
  uploadsPerMinute: number
  /** Pending (unclaimed) uploads older than this are deleted by the sweep. */
  pendingTtlMs: number
  /** How often the sweep runs (it also runs once at start). */
  sweepIntervalMs: number
  log(msg: string): void
}

export function createAttachmentRoutes(opts: AttachmentRoutesOptions) {
  const { users, attachments } = opts
  const memory = opts.dataDir === ':memory:'
  const dir = memory ? mkdtempSync(path.join(tmpdir(), 'nexo-attachments-')) : path.join(opts.dataDir, 'attachments')
  mkdirSync(dir, { recursive: true })
  const fileFor = (id: string) => path.join(dir, id)

  // Leftovers from a crash: temp files, and files whose row never got written (or was deleted before the file).
  const known = attachments.allIds()
  for (const name of readdirSync(dir)) if (!known.has(name)) rmSync(path.join(dir, name), { force: true })

  /** userId -> times of recent uploads (sliding one-minute window) */
  const recentUploads = new Map<string, number[]>()

  function rateLimit(userId: string) {
    const now = Date.now()
    const recent = (recentUploads.get(userId) ?? []).filter((t) => t > now - RATE_WINDOW_MS)
    if (recent.length >= opts.uploadsPerMinute) {
      recentUploads.set(userId, recent)
      throw new HttpError(429, 'Slow down: too many images in the last minute', {
        'retry-after': String(Math.max(1, Math.ceil((recent[0] + RATE_WINDOW_MS - now) / 1000))),
      })
    }
    recent.push(now)
    recentUploads.set(userId, recent)
  }

  /** Deletes attachment files (rows are already gone). Never throws. */
  function removeFiles(ids: string[]) {
    for (const id of ids) {
      if (!UUID_RE.test(id)) continue
      rm(fileFor(id), { force: true }).catch((err) => console.error(`[nexo] couldn't delete attachment ${id}:`, err))
    }
  }

  function sweep() {
    try {
      const expired = attachments.deletePendingBefore(Date.now() - opts.pendingTtlMs)
      if (expired.length > 0) {
        removeFiles(expired)
        opts.log(`[nexo] removed ${expired.length} unsent image upload${expired.length > 1 ? 's' : ''}`)
      }
      // Rate-limit windows of users who stopped uploading.
      const cutoff = Date.now() - RATE_WINDOW_MS
      for (const [userId, times] of recentUploads) if (!times.some((t) => t > cutoff)) recentUploads.delete(userId)
    } catch (err) {
      console.error('[nexo] attachment sweep failed:', err)
    }
  }
  sweep()
  const sweepTimer = setInterval(sweep, opts.sweepIntervalMs)
  sweepTimer.unref()

  async function upload(req: IncomingMessage, res: ServerResponse) {
    const user = authenticate(req, users, opts.hashToken)
    const declared = declaredType(req)
    if (!(ATTACHMENT_TYPES as readonly string[]).includes(declared)) {
      throw new HttpError(415, 'Images must be PNG, JPEG, WebP or GIF (Content-Type image/png, image/jpeg, image/webp or image/gif)')
    }
    if (declaredLength(req) > ATTACHMENT_MAX_BYTES) throw tooLarge()
    rateLimit(user.id)

    const body = await readBody(req, ATTACHMENT_MAX_BYTES, tooLarge)
    if (body.length === 0) throw new HttpError(400, 'The upload is empty')
    const actual = sniffAttachment(body)
    if (actual !== declared) {
      throw new HttpError(415, actual ? `The file is ${actual}, not ${declared}` : 'The file is not a PNG, JPEG, WebP or GIF image')
    }
    const info = probeImage(body)
    if (!info || info.width < 1 || info.height < 1) throw new HttpError(422, "Couldn't read the image size (is the file damaged?)")
    if (info.width > ATTACHMENT_MAX_DIMENSION || info.height > ATTACHMENT_MAX_DIMENSION) {
      throw new HttpError(422, `Images are limited to ${ATTACHMENT_MAX_DIMENSION}×${ATTACHMENT_MAX_DIMENSION} pixels`)
    }

    // Nobody learns the id before the 201, so the pending row can be written before the file is renamed into
    // place. If the rename fails, the row stays pending (never servable) and the sweep removes it.
    const tmp = path.join(dir, `.${randomBytes(8).toString('hex')}.tmp`)
    try {
      await writeFile(tmp, body)
      const attachment = attachments.create(user.id, { ...info, size: body.length })
      await rename(tmp, fileFor(attachment.id))
      opts.log(`[nexo] ${user.name} uploaded an image (${info.type}, ${info.width}×${info.height}, ${body.length} bytes)`)
      sendJson(res, 201, { attachment }, CORS_HEADERS)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  async function serve(req: IncomingMessage, res: ServerResponse, id: string) {
    const att = UUID_RE.test(id) ? attachments.servable(id) : undefined
    if (!att) throw new HttpError(404, 'No such image')
    let file: Awaited<ReturnType<typeof open>>
    try {
      file = await open(fileFor(id), 'r')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'No such image')
      throw err
    }
    try {
      const { size } = await file.stat()
      res.writeHead(200, {
        'content-type': att.type,
        'content-length': size,
        // The id names immutable content.
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'",
        'cross-origin-resource-policy': 'cross-origin',
        'access-control-allow-origin': '*',
      })
    } catch (err) {
      await file.close()
      throw err
    }
    if (req.method === 'HEAD') {
      await file.close()
      res.end()
      return
    }
    // Streamed (up to 10 MB); a client that goes away just ends the pipeline.
    await pipeline(file.createReadStream(), res).catch(() => res.destroy())
  }

  /** Handles attachment routes. Returns false when the request isn't one (the caller then answers it). */
  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://nexo.invalid')
    } catch {
      return false
    }
    const method = req.method ?? 'GET'
    let work: Promise<void>

    if (url.pathname === '/api/attachments') {
      if (method === 'OPTIONS') {
        preflight(req, res, CORS_HEADERS)
        return true
      }
      if (method === 'POST') work = upload(req, res)
      else work = Promise.reject(new HttpError(405, 'Use POST', { allow: 'POST, OPTIONS' }))
    } else if (url.pathname.startsWith('/attachments/')) {
      if (method !== 'GET' && method !== 'HEAD') work = Promise.reject(new HttpError(405, 'Use GET', { allow: 'GET, HEAD' }))
      else work = serve(req, res, url.pathname.slice('/attachments/'.length))
    } else {
      return false
    }

    finish(req, res, work, { label: 'attachment', cors: CORS_HEADERS, drainBytes: ATTACHMENT_MAX_BYTES * 2 })
    return true
  }

  return {
    handle,
    removeFiles,
    close() {
      clearInterval(sweepTimer)
      if (memory) rmSync(dir, { recursive: true, force: true })
    },
  }
}
