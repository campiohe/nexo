// Small helpers shared by the plain-HTTP routes (avatars, attachments): JSON errors, bounded body reads,
// bearer-token auth and CORS preflights. Everything else on the server goes over socket.io.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { User } from '../../shared/protocol.ts'
import type { Db } from './db.ts'

export class HttpError extends Error {
  status: number
  headers: Record<string, string>
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message)
    this.status = status
    this.headers = headers
  }
}

/** CORS headers for an API path that accepts `methods` (plus OPTIONS). */
export function corsHeaders(methods: string): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': `${methods}, OPTIONS`,
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '600',
  }
}

/** Answers a CORS preflight. */
export function preflight(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>) {
  // Chromium asks before a public/file:// page talks to a private-network server (LAN, Tailscale).
  const pna = req.headers['access-control-request-private-network'] === 'true'
  res.writeHead(204, { ...cors, ...(pna ? { 'access-control-allow-private-network': 'true' } : {}) }).end()
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(json)
}

/**
 * Discards what's left of a rejected upload, up to a bound (bytes and time). Resolves true once the request
 * body has been fully read, false if it was dropped instead (too big, too slow, or the client went away).
 */
function drain(req: IncomingMessage, maxBytes: number): Promise<boolean> {
  if (req.complete) return Promise.resolve(true)
  if (req.destroyed) return Promise.resolve(false)
  return new Promise((resolve) => {
    let size = 0
    const timer = setTimeout(() => req.destroy(), 10_000)
    timer.unref()
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) req.destroy()
    })
    req.on('end', () => {
      clearTimeout(timer)
      resolve(true)
    })
    req.on('close', () => {
      clearTimeout(timer)
      resolve(req.complete)
    })
    req.resume()
  })
}

/**
 * Reads the request body, failing with `tooLarge()` as soon as it exceeds `limit` bytes.
 * On overflow the rest of the upload is drained (bounded) so the client can read the 413 response.
 */
export function readBody(req: IncomingMessage, limit: number, tooLarge: () => HttpError): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const onData = (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        done = true
        chunks.length = 0
        reject(tooLarge())
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks, size))
    })
    req.on('error', (err) => {
      if (done) return
      done = true
      reject(err)
    })
    req.on('close', () => {
      if (done) return
      done = true
      reject(new HttpError(400, 'Upload aborted'))
    })
  })
}

/** The user behind `Authorization: Bearer <device token>`, or a 401. */
export function authenticate(req: IncomingMessage, users: Db['users'], hashToken: (token: string) => string): User {
  const header = req.headers.authorization
  const m = typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null
  if (!m) throw new HttpError(401, 'Missing device token (Authorization: Bearer <token>)', { 'www-authenticate': 'Bearer' })
  const user = users.byTokenHash(hashToken(m[1]))
  if (!user) throw new HttpError(401, 'Unknown device token', { 'www-authenticate': 'Bearer error="invalid_token"' })
  return user
}

/** The media type of the request body, lowercased and without parameters (`image/png; x=y` → `image/png`). */
export const declaredType = (req: IncomingMessage) => (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()

/** Content-Length when the client sent one, else NaN. */
export const declaredLength = (req: IncomingMessage) => Number(req.headers['content-length'])

/**
 * Settles a route's work: an HttpError becomes its JSON error, anything else a logged 500.
 * A rejected upload may still be streaming in. Its rest is drained (bounded) before the response goes out:
 * answering first and closing would make the client fail with a broken pipe instead of reading the error.
 */
export function finish(
  req: IncomingMessage,
  res: ServerResponse,
  work: Promise<void>,
  opts: { label: string; cors: Record<string, string>; drainBytes: number },
) {
  work.catch(async (err: unknown) => {
    const unread = !req.complete
    if (!(err instanceof HttpError)) console.error(`[nexo] ${opts.label} request failed:`, err)
    if (unread && !(await drain(req, opts.drainBytes))) return
    // Don't keep a connection alive after a request we gave up on.
    const extra: Record<string, string> = { ...opts.cors, ...(unread ? { connection: 'close' } : {}) }
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message }, { ...extra, ...err.headers })
    else sendJson(res, 500, { error: 'Server error, try again' }, extra)
  })
}

/** Server-generated ids (UUIDs); anything else (e.g. `..%2F`) never reaches the filesystem. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
