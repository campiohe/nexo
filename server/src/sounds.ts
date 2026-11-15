// Soundboard clips over plain HTTP (see the soundboard block in shared/protocol.ts):
//   POST   /api/sounds?name=&emoji=&durationMs=   upload (Authorization: Bearer <device token>)
//   DELETE /api/sounds/:id                         uploader or admins/owner
//   GET    /sounds/:id                             serve (no auth; the id is a random UUID)
// Files live in <dataDir>/sounds/<id>; the DB row holds name, emoji, uploader, duration and media type.
// Validation reads magic bytes only (no decoding): the duration is the uploader's client's measurement.
// Playing a clip (`sound:play`) is a socket event, handled in server.ts.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Sound, SoundType } from '../../shared/protocol.ts'
import { EMOJI_RE, MAX_SOUNDS, SOUND_MAX_BYTES, SOUND_MAX_MS, SOUND_NAME_MAX, SOUND_TYPES } from '../../shared/protocol.ts'
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
import { normalizeDisplayText } from './text.ts'

/** Error messages of the soundboard routes (JSON `{error}`). */
export const SOUND_HTTP_ERRORS = {
  badType: 'Sounds must be OGG, MP3, WAV or WebM audio (Content-Type audio/ogg, audio/mpeg, audio/wav or audio/webm)',
  notAudio: 'The file is not an OGG, MP3, WAV or WebM audio file',
  /** The sniffed type differs from the declared one. */
  mismatch: (actual: string, declared: string) => `The file is ${actual}, not ${declared}`,
  tooLarge: `Sounds are limited to ${Math.round(SOUND_MAX_BYTES / 1024)} KB`,
  empty: 'The upload is empty',
  noName: 'Give the sound a name',
  nameTooLong: `Sound names are limited to ${SOUND_NAME_MAX} characters`,
  invalidEmoji: 'Invalid emoji',
  invalidDuration: 'Invalid sound duration',
  tooLong: `Sounds are limited to ${SOUND_MAX_MS / 1000} seconds`,
  boardFull: `The soundboard is full (${MAX_SOUNDS} sounds). Delete one first`,
  slowDown: 'Slow down: too many sounds in the last minute',
  notFound: 'No such sound',
  forbidden: 'Only the uploader or admins can delete this sound',
} as const

/** Longest accepted emoji, in UTF-16 units (as for reactions). */
const EMOJI_MAX_LENGTH = 32
const RATE_WINDOW_MS = 60_000

const startsWith = (buf: Uint8Array, bytes: number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

/** Detects the audio container from its first bytes, or null if it isn't Ogg, MP3, WAV or WebM. */
export function sniffAudio(buf: Uint8Array): SoundType | null {
  if (startsWith(buf, ascii('OggS'))) return 'audio/ogg'
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WAVE'), 8)) return 'audio/wav'
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return 'audio/webm'
  if (startsWith(buf, ascii('ID3'))) return 'audio/mpeg'
  // A bare MPEG audio frame: 11-bit frame sync (0xFFE), a valid version and a layer other than the reserved
  // 00 (which is AAC's ADTS header, not MP3).
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && ((buf[1] >> 3) & 3) !== 1 && ((buf[1] >> 1) & 3) !== 0) {
    return 'audio/mpeg'
  }
  return null
}

/** A sound name from the query string, normalized, or an error message. */
export function parseSoundName(raw: string | null): { name: string } | { error: string } {
  const name = normalizeDisplayText(raw ?? '')
  if (!name) return { error: SOUND_HTTP_ERRORS.noName }
  if (name.length > SOUND_NAME_MAX) return { error: SOUND_HTTP_ERRORS.nameTooLong }
  return { name }
}

const CORS_HEADERS = corsHeaders('POST, DELETE')

export interface SoundRoutesOptions {
  dataDir: string
  users: Db['users']
  sounds: Db['sounds']
  hashToken(token: string): string
  /** Accepted uploads per user per minute. */
  uploadsPerMinute: number
  /** A sound was added: broadcast `sound:upsert`. */
  onSound(sound: Sound): void
  /** A sound was deleted: broadcast `sound:deleted`. */
  onSoundDeleted(soundId: string): void
  log(msg: string): void
}

export function createSoundRoutes(opts: SoundRoutesOptions) {
  const { users, sounds } = opts
  const memory = opts.dataDir === ':memory:'
  const dir = memory ? mkdtempSync(path.join(tmpdir(), 'nexo-sounds-')) : path.join(opts.dataDir, 'sounds')
  mkdirSync(dir, { recursive: true })
  const fileFor = (id: string) => path.join(dir, id)

  // Leftovers from a crash: temp files, and files whose row is gone (or never got written).
  const known = sounds.allIds()
  for (const name of readdirSync(dir)) if (!known.has(name)) rmSync(path.join(dir, name), { force: true })

  /** userId -> times of recent uploads (sliding one-minute window) */
  const recentUploads = new Map<string, number[]>()

  function rateLimit(userId: string) {
    const now = Date.now()
    // Also forgets the windows of users who stopped uploading, so the map stays small.
    for (const [uid, times] of recentUploads) if (!times.some((t) => t > now - RATE_WINDOW_MS)) recentUploads.delete(uid)
    const recent = (recentUploads.get(userId) ?? []).filter((t) => t > now - RATE_WINDOW_MS)
    if (recent.length >= opts.uploadsPerMinute) {
      recentUploads.set(userId, recent)
      throw new HttpError(429, SOUND_HTTP_ERRORS.slowDown, {
        'retry-after': String(Math.max(1, Math.ceil((recent[0] + RATE_WINDOW_MS - now) / 1000))),
      })
    }
    recent.push(now)
    recentUploads.set(userId, recent)
  }

  /** Deletes sound files (rows are already gone). Never throws. */
  function removeFiles(ids: string[]) {
    for (const id of ids) {
      if (!UUID_RE.test(id)) continue
      rm(fileFor(id), { force: true }).catch((err) => console.error(`[nexo] couldn't delete sound ${id}:`, err))
    }
  }

  async function upload(req: IncomingMessage, res: ServerResponse, url: URL) {
    const user = authenticate(req, users, opts.hashToken)
    const declared = declaredType(req)
    if (!(SOUND_TYPES as readonly string[]).includes(declared)) throw new HttpError(415, SOUND_HTTP_ERRORS.badType)
    const tooLarge = () => new HttpError(413, SOUND_HTTP_ERRORS.tooLarge)
    if (declaredLength(req) > SOUND_MAX_BYTES) throw tooLarge()

    const parsedName = parseSoundName(url.searchParams.get('name'))
    if ('error' in parsedName) throw new HttpError(400, parsedName.error)
    const rawEmoji = url.searchParams.get('emoji') ?? ''
    if (rawEmoji && (rawEmoji.length > EMOJI_MAX_LENGTH || !EMOJI_RE.test(rawEmoji))) {
      throw new HttpError(400, SOUND_HTTP_ERRORS.invalidEmoji)
    }
    const rawDuration = url.searchParams.get('durationMs') ?? ''
    if (!/^\d{1,9}$/.test(rawDuration) || Number(rawDuration) < 1) throw new HttpError(400, SOUND_HTTP_ERRORS.invalidDuration)
    const durationMs = Number(rawDuration)
    if (durationMs > SOUND_MAX_MS) throw new HttpError(400, SOUND_HTTP_ERRORS.tooLong)
    if (sounds.count() >= MAX_SOUNDS) throw new HttpError(409, SOUND_HTTP_ERRORS.boardFull)
    rateLimit(user.id)

    const body = await readBody(req, SOUND_MAX_BYTES, tooLarge)
    if (body.length === 0) throw new HttpError(400, SOUND_HTTP_ERRORS.empty)
    const actual = sniffAudio(body)
    if (actual !== declared) {
      throw new HttpError(415, actual ? SOUND_HTTP_ERRORS.mismatch(actual, declared) : SOUND_HTTP_ERRORS.notAudio)
    }

    // Nobody learns the id before the 201, so the file can go into place before the row is written; if the
    // row can't be written the file is removed (or swept at the next start).
    const id = randomUUID()
    const tmp = path.join(dir, `.${randomBytes(8).toString('hex')}.tmp`)
    let sound: Sound | undefined
    try {
      await writeFile(tmp, body)
      await rename(tmp, fileFor(id))
      // The board may have filled up, or the account been removed, while the body was uploading.
      if (!users.get(user.id)) throw new HttpError(401, 'Unknown device token')
      sound = sounds.create(
        { id, name: parsedName.name, emoji: rawEmoji || null, uploaderId: user.id, durationMs, type: actual, size: body.length },
        MAX_SOUNDS,
      )
      if (!sound) throw new HttpError(409, SOUND_HTTP_ERRORS.boardFull)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      await rm(fileFor(id), { force: true }).catch(() => {})
      throw err
    }
    opts.onSound(sound)
    opts.log(`[nexo] ${user.name} added the sound "${sound.name}" (${actual}, ${body.length} bytes, ${durationMs} ms)`)
    sendJson(res, 201, { sound }, CORS_HEADERS)
  }

  async function remove(req: IncomingMessage, res: ServerResponse, id: string) {
    const user = authenticate(req, users, opts.hashToken)
    const sound = UUID_RE.test(id) ? sounds.get(id) : undefined
    if (!sound) throw new HttpError(404, SOUND_HTTP_ERRORS.notFound)
    // `authenticate` reads the account from the DB, so the role is current.
    if (sound.uploaderId !== user.id && user.role !== 'admin' && user.role !== 'owner') {
      throw new HttpError(403, SOUND_HTTP_ERRORS.forbidden)
    }
    if (sounds.delete(sound.id)) {
      removeFiles([sound.id])
      opts.onSoundDeleted(sound.id)
      opts.log(`[nexo] ${user.name} deleted the sound "${sound.name}"`)
    }
    res.writeHead(204, { ...CORS_HEADERS, 'cache-control': 'no-store' }).end()
  }

  async function serve(req: IncomingMessage, res: ServerResponse, id: string) {
    const sound = UUID_RE.test(id) ? sounds.get(id) : undefined
    if (!sound) throw new HttpError(404, SOUND_HTTP_ERRORS.notFound)
    let bytes: Buffer
    try {
      bytes = await readFile(fileFor(sound.id))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, SOUND_HTTP_ERRORS.notFound)
      throw err
    }
    res.writeHead(200, {
      'content-type': sound.type,
      'content-length': bytes.length,
      // The id names immutable content.
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'cross-origin-resource-policy': 'cross-origin',
      'access-control-allow-origin': '*',
    })
    res.end(req.method === 'HEAD' ? undefined : bytes)
  }

  /** Handles soundboard routes. Returns false when the request isn't one (the caller then answers it). */
  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://nexo.invalid')
    } catch {
      return false
    }
    const method = req.method ?? 'GET'
    let work: Promise<void>

    if (url.pathname === '/api/sounds' || url.pathname.startsWith('/api/sounds/')) {
      if (method === 'OPTIONS') {
        preflight(req, res, CORS_HEADERS)
        return true
      }
      const id = url.pathname.slice('/api/sounds/'.length)
      if (url.pathname === '/api/sounds') {
        if (method === 'POST') work = upload(req, res, url)
        else work = Promise.reject(new HttpError(405, 'Use POST', { allow: 'POST, OPTIONS' }))
      } else if (method === 'DELETE') {
        work = remove(req, res, id)
      } else {
        work = Promise.reject(new HttpError(405, 'Use DELETE', { allow: 'DELETE, OPTIONS' }))
      }
    } else if (url.pathname.startsWith('/sounds/')) {
      if (method !== 'GET' && method !== 'HEAD') work = Promise.reject(new HttpError(405, 'Use GET', { allow: 'GET, HEAD' }))
      else work = serve(req, res, url.pathname.slice('/sounds/'.length))
    } else {
      return false
    }

    finish(req, res, work, { label: 'sound', cors: CORS_HEADERS, drainBytes: SOUND_MAX_BYTES * 2 })
    return true
  }

  return {
    handle,
    removeFiles,
    close() {
      recentUploads.clear()
      if (memory) rmSync(dir, { recursive: true, force: true })
    },
  }
}
