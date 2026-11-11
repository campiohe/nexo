// HTTP side of accounts (docs/SPEC-ACCOUNTS.md §1, §3, §4; contract in shared/protocol.ts):
// GET /api/info, and the sign-in request endpoints under /api/access-requests. No auth except the
// request's own secret.
import type { AccessRequestStatus, ServerInfo, User } from '@shared/protocol'

/** /api/info is asked before connecting, so it must not hold up the app for long. */
export const INFO_TIMEOUT_MS = 3000
const REQUEST_TIMEOUT_MS = 10_000

/** Server ids become part of a secrets key (`token:id:<serverId>`): only accept safe characters. */
const SERVER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function isValidServerId(id: unknown): id is string {
  return typeof id === 'string' && SERVER_ID_RE.test(id)
}

function isUser(u: unknown): u is User {
  if (!u || typeof u !== 'object') return false
  const x = u as Record<string, unknown>
  return typeof x.id === 'string' && typeof x.name === 'string' && typeof x.color === 'string'
}

/**
 * GET /api/info. Null when the server can't be reached, is too slow, or is an older server without the
 * endpoint (404, often without CORS headers, so it surfaces as a network error): callers then fall back to
 * the URL-keyed behavior.
 */
export async function fetchServerInfo(serverUrl: string, timeoutMs = INFO_TIMEOUT_MS): Promise<ServerInfo | null> {
  try {
    const res = await fetch(`${serverUrl}/api/info`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const data = (await res.json()) as Partial<ServerInfo> | null
    if (!data || !isValidServerId(data.serverId)) {
      console.warn('[nexo] /api/info returned no usable serverId', data?.serverId)
      return null
    }
    return {
      serverId: data.serverId,
      serverName: typeof data.serverName === 'string' ? data.serverName : 'Nexo',
      passwordRequired: data.passwordRequired === true,
      recognized: Array.isArray(data.recognized) ? data.recognized.filter(isUser) : [],
    }
  } catch {
    return null
  }
}

export interface CreatedAccessRequest {
  id: string
  secret: string
  expiresAt: number
}

/** Error from the access-request endpoints; `status` is the HTTP status (0 = network/timeout). */
export class AccessRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function errorFrom(res: Response, fallback: string): Promise<AccessRequestError> {
  let error: string | null = null
  try {
    const data = (await res.json()) as unknown
    if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') error = data.error
  } catch {
    /* no JSON body */
  }
  return new AccessRequestError(error ?? fallback, res.status)
}

async function send(url: string, init: RequestInit, networkError?: string): Promise<Response> {
  try {
    return await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError')
      throw new AccessRequestError('The server took too long to respond', 0)
    throw new AccessRequestError(networkError ?? `Can't reach the server at ${url.replace(/\/api\/.*$/, '')}`, 0)
  }
}

/** POST /api/access-requests. Throws AccessRequestError with the server's message (404 / 403 / 429). */
export async function createAccessRequest(
  serverUrl: string,
  name: string,
  password?: string,
): Promise<CreatedAccessRequest> {
  // Older servers answer 404 without CORS headers, which fetch reports as a network error.
  const networkError =
    `Couldn't send the sign-in request. The server at ${serverUrl} may be offline, or too old for ` +
    'sign-in requests (update the Nexo server).'
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(password ? { name, password } : { name }),
  }
  const res = await send(`${serverUrl}/api/access-requests`, init, networkError)
  if (!res.ok) {
    throw await errorFrom(
      res,
      res.status === 404
        ? "This server doesn't support sign-in requests yet (update the Nexo server)"
        : `The server rejected the request (HTTP ${res.status})`,
    )
  }
  const data = (await res.json().catch(() => null)) as Partial<CreatedAccessRequest> | null
  if (!data || typeof data.id !== 'string' || typeof data.secret !== 'string') {
    throw new AccessRequestError('Invalid response from the server', res.status)
  }
  return {
    id: data.id,
    secret: data.secret,
    expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : Date.now() + 10 * 60_000,
  }
}

/** GET /api/access-requests/:id. `gone` = 404: expired, cancelled, or the token was already delivered. */
export async function pollAccessRequest(
  serverUrl: string,
  req: Pick<CreatedAccessRequest, 'id' | 'secret'>,
): Promise<AccessRequestStatus | { status: 'gone' }> {
  const res = await send(`${serverUrl}/api/access-requests/${encodeURIComponent(req.id)}`, {
    headers: { Authorization: `Bearer ${req.secret}` },
  })
  if (res.status === 404) return { status: 'gone' }
  if (!res.ok) throw await errorFrom(res, `The server rejected the request (HTTP ${res.status})`)
  const data = (await res.json().catch(() => null)) as Partial<{ status: string; token: string }> | null
  if (data?.status === 'pending' || data?.status === 'denied') return { status: data.status }
  if (data?.status === 'approved' && typeof data.token === 'string' && data.token) {
    return { status: 'approved', token: data.token }
  }
  throw new AccessRequestError('Invalid response from the server', res.status)
}

/** DELETE /api/access-requests/:id (best effort). */
export async function cancelAccessRequest(serverUrl: string, req: Pick<CreatedAccessRequest, 'id' | 'secret'>) {
  try {
    await send(`${serverUrl}/api/access-requests/${encodeURIComponent(req.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${req.secret}` },
    })
  } catch (err) {
    console.warn('[nexo] cancelling the sign-in request failed', err)
  }
}
