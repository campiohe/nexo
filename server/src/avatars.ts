// Profile pictures over plain HTTP (see the AVATAR_* block in shared/protocol.ts):
//   PUT    /api/avatar           upload (Authorization: Bearer <device token>)
//   DELETE /api/avatar           remove
//   GET    /avatars/:userId?v=   serve
// Images live in <dataDir>/avatars/<userId>. The DB stores only a short content hash (the version token).
// Validation is magic-byte based: no image decoding, no native libraries.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { User } from '../../shared/protocol.ts'
import { AVATAR_MAX_BYTES } from '../../shared/protocol.ts'
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

export type ImageType = 'image/webp' | 'image/png' | 'image/jpeg'
const IMAGE_TYPES: readonly string[] = ['image/webp', 'image/png', 'image/jpeg'] satisfies ImageType[]

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const startsWith = (buf: Uint8Array, bytes: number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

/** Detects the image type from its first bytes, or null if it isn't a PNG, JPEG or WebP. */
export function sniffImage(buf: Uint8Array): ImageType | null {
  if (startsWith(buf, PNG_SIG)) return 'image/png'
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) return 'image/webp'
  return null
}

/** Version token: first 12 hex chars of the SHA-256 of the image bytes. */
export const avatarToken = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 12)

const CORS_HEADERS = corsHeaders('PUT, DELETE')
const tooLarge = () => new HttpError(413, `Profile pictures are limited to ${Math.round(AVATAR_MAX_BYTES / 1024)} KB`)

export interface AvatarRoutesOptions {
  dataDir: string
  users: Db['users']
  hashToken(token: string): string
  /** Called after a user's avatar changed (refresh sockets + broadcast `user:upsert`). */
  onUserUpdated(user: User): void
  /** Minimum time between two avatar changes (upload or delete) of the same user. */
  minIntervalMs: number
  log(msg: string): void
}

/** Returns an HTTP handler that answers avatar routes and returns false for anything else. */
export function createAvatarRoutes(opts: AvatarRoutesOptions) {
  const { users } = opts
  const dir =
    opts.dataDir === ':memory:' ? mkdtempSync(path.join(tmpdir(), 'nexo-avatars-')) : path.join(opts.dataDir, 'avatars')
  mkdirSync(dir, { recursive: true })
  // Leftovers from an upload interrupted by a crash.
  for (const name of readdirSync(dir)) if (name.endsWith('.tmp')) rmSync(path.join(dir, name), { force: true })
  const fileFor = (userId: string) => path.join(dir, userId)
  /** userId -> time of the last accepted avatar change */
  const lastChange = new Map<string, number>()

  function rateLimit(userId: string) {
    const now = Date.now()
    const wait = (lastChange.get(userId) ?? -Infinity) + opts.minIntervalMs - now
    if (wait > 0) {
      throw new HttpError(429, 'Slow down: you can change your picture again in a few seconds', {
        'retry-after': String(Math.ceil(wait / 1000)),
      })
    }
    lastChange.set(userId, now)
  }

  async function upload(req: IncomingMessage, res: ServerResponse) {
    const user = authenticate(req, users, opts.hashToken)
    const declared = declaredType(req)
    if (!IMAGE_TYPES.includes(declared)) {
      throw new HttpError(415, 'Profile pictures must be WebP, PNG or JPEG (Content-Type image/webp, image/png or image/jpeg)')
    }
    if (declaredLength(req) > AVATAR_MAX_BYTES) throw tooLarge()
    rateLimit(user.id)

    const body = await readBody(req, AVATAR_MAX_BYTES, tooLarge)
    if (body.length === 0) throw new HttpError(400, 'The upload is empty')
    const actual = sniffImage(body)
    if (actual !== declared) {
      throw new HttpError(415, actual ? `The file is ${actual}, not ${declared}` : 'The file is not a WebP, PNG or JPEG image')
    }

    // Atomic replace: readers see either the old picture or the new one, never a partial file.
    const tmp = path.join(dir, `.${user.id}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await writeFile(tmp, body)
      await rename(tmp, fileFor(user.id))
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
    const updated = users.setAvatar(user.id, avatarToken(body))
    if (!updated) throw new HttpError(401, 'Unknown device token')
    opts.onUserUpdated(updated)
    opts.log(`[nexo] ${updated.name} changed their profile picture (${actual}, ${body.length} bytes)`)
    sendJson(res, 200, { user: updated }, CORS_HEADERS)
  }

  async function remove(req: IncomingMessage, res: ServerResponse) {
    const user = authenticate(req, users, opts.hashToken)
    if (user.avatar === null) return sendJson(res, 200, { user }, CORS_HEADERS)
    rateLimit(user.id)
    await rm(fileFor(user.id), { force: true })
    const updated = users.setAvatar(user.id, null)
    if (!updated) throw new HttpError(401, 'Unknown device token')
    opts.onUserUpdated(updated)
    opts.log(`[nexo] ${updated.name} removed their profile picture`)
    sendJson(res, 200, { user: updated }, CORS_HEADERS)
  }

  async function serve(req: IncomingMessage, res: ServerResponse, userId: string, version: string | null) {
    const user = UUID_RE.test(userId) ? users.get(userId) : undefined
    if (!user || user.avatar === null) throw new HttpError(404, 'No profile picture')
    let bytes: Buffer
    try {
      bytes = await readFile(fileFor(user.id))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'No profile picture')
      throw err
    }
    const type = sniffImage(bytes)
    if (!type) throw new HttpError(404, 'No profile picture')
    res.writeHead(200, {
      'content-type': type,
      'content-length': bytes.length,
      // The URL carries the version, so the current version can be cached forever. Any other URL must revalidate.
      'cache-control': version === user.avatar ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag: `"${user.avatar}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'cross-origin-resource-policy': 'cross-origin',
      'access-control-allow-origin': '*',
    })
    res.end(req.method === 'HEAD' ? undefined : bytes)
  }

  /** Handles avatar routes. Returns false when the request isn't one (the caller then answers it). */
  return function handle(req: IncomingMessage, res: ServerResponse): boolean {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://nexo.invalid')
    } catch {
      return false
    }
    const method = req.method ?? 'GET'
    let work: Promise<void>

    if (url.pathname === '/api/avatar') {
      if (method === 'OPTIONS') {
        preflight(req, res, CORS_HEADERS)
        return true
      }
      if (method === 'PUT') work = upload(req, res)
      else if (method === 'DELETE') work = remove(req, res)
      else work = Promise.reject(new HttpError(405, 'Use PUT or DELETE', { allow: 'PUT, DELETE, OPTIONS' }))
    } else if (url.pathname.startsWith('/avatars/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        work = Promise.reject(new HttpError(405, 'Use GET', { allow: 'GET, HEAD' }))
      } else {
        work = serve(req, res, url.pathname.slice('/avatars/'.length), url.searchParams.get('v'))
      }
    } else {
      return false
    }

    finish(req, res, work, { label: 'avatar', cors: CORS_HEADERS, drainBytes: AVATAR_MAX_BYTES * 4 })
    return true
  }
}
