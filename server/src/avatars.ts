// Profile pictures and banners over plain HTTP (see the AVATAR_* and BANNER_* blocks in shared/protocol.ts):
//   PUT    /api/avatar           upload (Authorization: Bearer <device token>)
//   DELETE /api/avatar           remove
//   GET    /avatars/:userId?v=   serve
// and the same for banners at /api/banner and /banners/:userId (createBannerRoutes).
// Images live in <dataDir>/avatars/<userId> (banners: <dataDir>/banners/<userId>). The DB stores only a short
// content hash (the version token) and whether the image is an animated GIF (users.avatar_animated /
// users.banner_animated); the served Content-Type is sniffed from the file. Validation is magic-byte based:
// no image decoding, no native libraries.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { User } from '../../shared/protocol.ts'
import {
  AVATAR_ANIMATED_MAX_BYTES,
  AVATAR_MAX_BYTES,
  BANNER_ANIMATED_MAX_BYTES,
  BANNER_MAX_BYTES,
} from '../../shared/protocol.ts'
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

export type ImageType = 'image/webp' | 'image/png' | 'image/jpeg' | 'image/gif'
const IMAGE_TYPES: readonly string[] = ['image/webp', 'image/png', 'image/jpeg', 'image/gif'] satisfies ImageType[]

/** "512 KB", "2 MB" */
const formatBytes = (n: number) => (n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${Math.round(n / 1024)} KB`)

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const startsWith = (buf: Uint8Array, bytes: number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

/** Detects the image type from its first bytes, or null if it isn't a PNG, JPEG, WebP or GIF. */
export function sniffImage(buf: Uint8Array): ImageType | null {
  if (startsWith(buf, PNG_SIG)) return 'image/png'
  if (startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) return 'image/webp'
  return null
}

/** Version token: first 12 hex chars of the SHA-256 of the image bytes. */
export const avatarToken = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 12)

const CORS_HEADERS = corsHeaders('PUT, DELETE')

export interface AvatarRoutesOptions {
  dataDir: string
  users: Db['users']
  hashToken(token: string): string
  /** Called after a user's picture / banner changed (refresh sockets + broadcast `user:upsert`). */
  onUserUpdated(user: User): void
  /** Minimum time between two changes (upload or delete) of the same user's picture (or banner). */
  minIntervalMs: number
  log(msg: string): void
}

/** What differs between profile pictures and banners. */
interface ImageKind {
  /** Upload/remove path, e.g. /api/avatar. */
  apiPath: string
  /** Directory under dataDir, also the serving prefix (/<dir>/:userId). */
  dir: string
  maxBytes: number
  animatedMaxBytes: number
  /** "Profile pictures", for size and type errors. */
  plural: string
  /** "Animated profile pictures" */
  animatedPlural: string
  /** "picture", for the rate limit error. */
  noun: string
  /** "No profile picture" (404). */
  missing: string
  /** Log lines: "changed their profile picture", "removed their profile picture". */
  logName: string
  /** Request label for unexpected errors. */
  label: string
  current(user: User): string | null | undefined
  set(users: Db['users'], id: string, token: string | null, animated: boolean): User | undefined
}

const AVATAR_KIND: ImageKind = {
  apiPath: '/api/avatar',
  dir: 'avatars',
  maxBytes: AVATAR_MAX_BYTES,
  animatedMaxBytes: AVATAR_ANIMATED_MAX_BYTES,
  plural: 'Profile pictures',
  animatedPlural: 'Animated profile pictures',
  noun: 'picture',
  missing: 'No profile picture',
  logName: 'profile picture',
  label: 'avatar',
  current: (u) => u.avatar,
  set: (users, id, token, animated) => users.setAvatar(id, token, animated),
}

const BANNER_KIND: ImageKind = {
  apiPath: '/api/banner',
  dir: 'banners',
  maxBytes: BANNER_MAX_BYTES,
  animatedMaxBytes: BANNER_ANIMATED_MAX_BYTES,
  plural: 'Banners',
  animatedPlural: 'Animated banners',
  noun: 'banner',
  missing: 'No banner',
  logName: 'banner',
  label: 'banner',
  current: (u) => u.banner,
  set: (users, id, token, animated) => users.setBanner(id, token, animated),
}

/** Returns an HTTP handler that answers avatar routes (false for anything else) and a file remover. */
export function createAvatarRoutes(opts: AvatarRoutesOptions) {
  return createImageRoutes(AVATAR_KIND, opts)
}

/** The same for profile banners: /api/banner, /banners/:userId?v=, files in <dataDir>/banners. */
export function createBannerRoutes(opts: AvatarRoutesOptions) {
  return createImageRoutes(BANNER_KIND, opts)
}

function createImageRoutes(kind: ImageKind, opts: AvatarRoutesOptions) {
  const { users } = opts
  /** Size limit of an image of the given (declared) type: GIFs may be animated, so they get more room. */
  const maxBytesFor = (type: string) => (type === 'image/gif' ? kind.animatedMaxBytes : kind.maxBytes)
  const tooLargeFor = (type: string) => () =>
    type === 'image/gif'
      ? new HttpError(413, `${kind.animatedPlural} are limited to ${formatBytes(kind.animatedMaxBytes)}`)
      : new HttpError(413, `${kind.plural} are limited to ${formatBytes(kind.maxBytes)}`)
  const servePrefix = `/${kind.dir}/`
  const dir =
    opts.dataDir === ':memory:'
      ? mkdtempSync(path.join(tmpdir(), `nexo-${kind.dir}-`))
      : path.join(opts.dataDir, kind.dir)
  mkdirSync(dir, { recursive: true })
  // Leftovers from an upload interrupted by a crash.
  for (const name of readdirSync(dir)) if (name.endsWith('.tmp')) rmSync(path.join(dir, name), { force: true })
  const fileFor = (userId: string) => path.join(dir, userId)
  /** userId -> time of the last accepted change */
  const lastChange = new Map<string, number>()

  function rateLimit(userId: string) {
    const now = Date.now()
    const wait = (lastChange.get(userId) ?? -Infinity) + opts.minIntervalMs - now
    if (wait > 0) {
      throw new HttpError(429, `Slow down: you can change your ${kind.noun} again in a few seconds`, {
        'retry-after': String(Math.ceil(wait / 1000)),
      })
    }
    lastChange.set(userId, now)
  }

  async function upload(req: IncomingMessage, res: ServerResponse) {
    const user = authenticate(req, users, opts.hashToken)
    const declared = declaredType(req)
    if (!IMAGE_TYPES.includes(declared)) {
      throw new HttpError(
        415,
        `${kind.plural} must be WebP, PNG, JPEG or GIF (Content-Type image/webp, image/png, image/jpeg or image/gif)`,
      )
    }
    const maxBytes = maxBytesFor(declared)
    const tooLarge = tooLargeFor(declared)
    if (declaredLength(req) > maxBytes) throw tooLarge()
    rateLimit(user.id)

    const body = await readBody(req, maxBytes, tooLarge)
    if (body.length === 0) throw new HttpError(400, 'The upload is empty')
    const actual = sniffImage(body)
    if (actual !== declared) {
      throw new HttpError(415, actual ? `The file is ${actual}, not ${declared}` : 'The file is not a WebP, PNG, JPEG or GIF image')
    }

    // Atomic replace: readers see either the old image or the new one, never a partial file.
    const tmp = path.join(dir, `.${user.id}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await writeFile(tmp, body)
      await rename(tmp, fileFor(user.id))
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
    // A GIF may have a single frame; clients still treat it as animated (it only costs a hover/speaking check).
    const updated = kind.set(users, user.id, avatarToken(body), actual === 'image/gif')
    if (!updated) {
      // The account was removed during the upload.
      await rm(fileFor(user.id), { force: true })
      throw new HttpError(401, 'Unknown device token')
    }
    opts.onUserUpdated(updated)
    opts.log(`[nexo] ${updated.name} changed their ${kind.logName} (${actual}, ${body.length} bytes)`)
    sendJson(res, 200, { user: updated }, CORS_HEADERS)
  }

  async function remove(req: IncomingMessage, res: ServerResponse) {
    const user = authenticate(req, users, opts.hashToken)
    if (kind.current(user) == null) return sendJson(res, 200, { user }, CORS_HEADERS)
    rateLimit(user.id)
    await rm(fileFor(user.id), { force: true })
    const updated = kind.set(users, user.id, null, false)
    if (!updated) throw new HttpError(401, 'Unknown device token')
    opts.onUserUpdated(updated)
    opts.log(`[nexo] ${updated.name} removed their ${kind.logName}`)
    sendJson(res, 200, { user: updated }, CORS_HEADERS)
  }

  async function serve(req: IncomingMessage, res: ServerResponse, userId: string, version: string | null) {
    const user = UUID_RE.test(userId) ? users.get(userId) : undefined
    const current = user ? kind.current(user) : null
    if (!user || current == null) throw new HttpError(404, kind.missing)
    let bytes: Buffer
    try {
      bytes = await readFile(fileFor(user.id))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, kind.missing)
      throw err
    }
    const type = sniffImage(bytes)
    if (!type) throw new HttpError(404, kind.missing)
    res.writeHead(200, {
      'content-type': type,
      'content-length': bytes.length,
      // The URL carries the version, so the current version can be cached forever. Any other URL must revalidate.
      'cache-control': version === current ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag: `"${current}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'cross-origin-resource-policy': 'cross-origin',
      'access-control-allow-origin': '*',
    })
    res.end(req.method === 'HEAD' ? undefined : bytes)
  }

  /** Deletes a user's image file (the DB row is the caller's). Never throws. */
  function removeFile(userId: string) {
    if (!UUID_RE.test(userId)) return
    rm(fileFor(userId), { force: true }).catch((err) =>
      console.error(`[nexo] couldn't delete ${kind.label} of ${userId}:`, err),
    )
  }

  /** Handles this kind's routes. Returns false when the request isn't one (the caller then answers it). */
  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://nexo.invalid')
    } catch {
      return false
    }
    const method = req.method ?? 'GET'
    let work: Promise<void>

    if (url.pathname === kind.apiPath) {
      if (method === 'OPTIONS') {
        preflight(req, res, CORS_HEADERS)
        return true
      }
      if (method === 'PUT') work = upload(req, res)
      else if (method === 'DELETE') work = remove(req, res)
      else work = Promise.reject(new HttpError(405, 'Use PUT or DELETE', { allow: 'PUT, DELETE, OPTIONS' }))
    } else if (url.pathname.startsWith(servePrefix)) {
      if (method !== 'GET' && method !== 'HEAD') {
        work = Promise.reject(new HttpError(405, 'Use GET', { allow: 'GET, HEAD' }))
      } else {
        work = serve(req, res, url.pathname.slice(servePrefix.length), url.searchParams.get('v'))
      }
    } else {
      return false
    }

    finish(req, res, work, { label: kind.label, cors: CORS_HEADERS, drainBytes: kind.animatedMaxBytes * 2 })
    return true
  }

  return { handle, removeFile }
}
