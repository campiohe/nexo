// Account routes over plain HTTP, no auth (docs/SPEC-ACCOUNTS.md §3 and §4; ServerInfo and the sign-in
// request block in shared/protocol.ts):
//   GET    /api/info                  server id, name, password flag, accounts linked to the caller's device
//   POST   /api/access-requests       ask to sign in to an existing account → { id, secret, expiresAt }
//   GET    /api/access-requests/:id   poll (Authorization: Bearer <secret>)
//   DELETE /api/access-requests/:id   cancel
// Sign-in requests live in memory only: a restart forgets them, which just means asking again.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AccessRequest, AccessRequestStatus, ServerInfo, User } from '../../shared/protocol.ts'
import { unwrapAddress } from './address.ts'
import type { Db } from './db.ts'
import { HttpError, UUID_RE, bearer, corsHeaders, finish, preflight, readBody, safeEqual, sendJson } from './http.ts'

const INFO_CORS = corsHeaders('GET')
const REQUESTS_CORS = corsHeaders('GET, POST, DELETE')
/** `{ name, password }` is tiny; anything bigger is not a sign-in request. */
const BODY_LIMIT = 4 * 1024

export const ACCESS_REQUEST_ERRORS = {
  noAccount: 'No account with that name',
  wrongPassword: 'Wrong server password',
  tooManyFromAddress: 'Too many sign-in requests from this device. Wait for an answer or cancel one first',
  tooMany: 'Too many sign-in requests right now. Try again in a few minutes',
  notFound: 'No such sign-in request (it expired, was answered or was cancelled)',
} as const

interface Entry extends AccessRequest {
  secretHash: string
  status: 'pending' | 'approved' | 'denied'
}

export interface AccountRoutesOptions {
  serverId: string
  serverName: string
  /** Empty = no password. */
  serverPassword: string
  users: Db['users']
  devices: Db['devices']
  /** Finds an account by a user-typed name (normalized like the handshake does). */
  userByName(name: unknown): User | undefined
  /** Creates a new login for the account and returns the raw token. */
  issueToken(userId: string): string
  /** Whether a (unwrapped) remote address is a device we trust to be who it was before (Tailscale). */
  isTrustedDeviceAddress(address: string): boolean
  /** Lifetime of a sign-in request. */
  ttlMs: number
  /** How often expired requests are swept. */
  sweepIntervalMs: number
  /** Pending requests per remote address. */
  maxPerAddress: number
  /** Pending requests in total. */
  maxTotal: number
  /** A new request is waiting for an answer. */
  onRequest(r: AccessRequest): void
  /** A request was approved, denied, cancelled, replaced or expired. */
  onResolved(r: AccessRequest): void
  log(msg: string): void
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const pub = ({ id, userId, address, createdAt, expiresAt }: Entry): AccessRequest => ({ id, userId, address, createdAt, expiresAt })

export function createAccountRoutes(opts: AccountRoutesOptions) {
  const { users, devices } = opts
  /** requestId -> request */
  const requests = new Map<string, Entry>()
  const nameOf = (userId: string) => users.get(userId)?.name ?? userId

  /** Removes expired requests; pending ones are announced as resolved. */
  function sweep(now = Date.now()) {
    for (const e of requests.values()) {
      if (e.expiresAt > now) continue
      requests.delete(e.id)
      if (e.status === 'pending') {
        opts.log(`[nexo] sign-in request for "${nameOf(e.userId)}" from ${e.address} expired`)
        opts.onResolved(pub(e))
      }
    }
  }
  const sweepTimer = setInterval(() => {
    try {
      sweep()
    } catch (err) {
      console.error('[nexo] sign-in request sweep failed:', err)
    }
  }, opts.sweepIntervalMs)
  sweepTimer.unref()

  const pendingList = () => {
    sweep()
    return [...requests.values()].filter((e) => e.status === 'pending')
  }

  // ---------- HTTP ----------

  function info(req: IncomingMessage, res: ServerResponse) {
    const address = unwrapAddress(req.socket.remoteAddress)
    const body: ServerInfo = {
      serverId: opts.serverId,
      serverName: opts.serverName,
      passwordRequired: opts.serverPassword !== '',
      recognized: opts.isTrustedDeviceAddress(address) ? devices.users(address) : [],
    }
    sendJson(res, 200, body, INFO_CORS)
  }

  async function create(req: IncomingMessage, res: ServerResponse) {
    const raw = await readBody(req, BODY_LIMIT, () => new HttpError(413, 'Request too large'))
    let body: unknown
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new HttpError(400, 'Send JSON: { "name": "…", "password": "…" }')
    }
    if (!isObj(body)) throw new HttpError(400, 'Send JSON: { "name": "…", "password": "…" }')
    const address = unwrapAddress(req.socket.remoteAddress)
    if (opts.serverPassword && !(isStr(body.password) && safeEqual(body.password, opts.serverPassword))) {
      opts.log(`[nexo] sign-in request from ${address || 'unknown address'} refused: wrong server password`)
      throw new HttpError(403, ACCESS_REQUEST_ERRORS.wrongPassword)
    }
    const user = opts.userByName(body.name)
    if (!user) throw new HttpError(404, ACCESS_REQUEST_ERRORS.noAccount)

    // One pending request per account: a new one replaces the old.
    const pending = pendingList()
    const replaced = pending.find((e) => e.userId === user.id)
    const others = pending.filter((e) => e !== replaced)
    if (others.filter((e) => e.address === address).length >= opts.maxPerAddress) {
      opts.log(`[nexo] sign-in request for "${user.name}" from ${address} refused: too many from this address`)
      throw new HttpError(429, ACCESS_REQUEST_ERRORS.tooManyFromAddress)
    }
    if (others.length >= opts.maxTotal) {
      opts.log(`[nexo] sign-in request for "${user.name}" from ${address} refused: too many pending requests`)
      throw new HttpError(429, ACCESS_REQUEST_ERRORS.tooMany)
    }
    if (replaced) {
      requests.delete(replaced.id)
      opts.log(`[nexo] sign-in request for "${user.name}" from ${replaced.address} replaced by a new one`)
      opts.onResolved(pub(replaced))
    }

    const secret = randomBytes(32).toString('base64url')
    const now = Date.now()
    const entry: Entry = {
      id: randomUUID(),
      userId: user.id,
      address,
      createdAt: now,
      expiresAt: now + opts.ttlMs,
      secretHash: sha256(secret),
      status: 'pending',
    }
    requests.set(entry.id, entry)
    opts.log(`[nexo] sign-in request for "${user.name}" from ${address || 'unknown address'}`)
    opts.onRequest(pub(entry))
    sendJson(res, 201, { id: entry.id, secret, expiresAt: entry.expiresAt }, REQUESTS_CORS)
  }

  /** The request `id` if the caller holds its secret (and it hasn't expired), else a 401/404. */
  function own(req: IncomingMessage, id: string): Entry {
    const secret = bearer(req)
    if (!secret) {
      throw new HttpError(401, 'Missing request secret (Authorization: Bearer <secret>)', { 'www-authenticate': 'Bearer' })
    }
    sweep()
    const entry = UUID_RE.test(id) ? requests.get(id) : undefined
    if (!entry || !safeEqual(sha256(secret), entry.secretHash)) throw new HttpError(404, ACCESS_REQUEST_ERRORS.notFound)
    return entry
  }

  async function poll(req: IncomingMessage, res: ServerResponse, id: string) {
    const entry = own(req, id)
    let body: AccessRequestStatus
    if (entry.status === 'approved') {
      // The new login is created now and delivered once.
      requests.delete(entry.id)
      if (!users.get(entry.userId)) throw new HttpError(404, ACCESS_REQUEST_ERRORS.notFound)
      body = { status: 'approved', token: opts.issueToken(entry.userId) }
      opts.log(`[nexo] "${nameOf(entry.userId)}" signed in on a new device (${entry.address}) after approval`)
    } else {
      body = { status: entry.status }
    }
    sendJson(res, 200, body, REQUESTS_CORS)
  }

  async function cancel(req: IncomingMessage, res: ServerResponse, id: string) {
    const entry = own(req, id)
    requests.delete(entry.id)
    if (entry.status === 'pending') {
      opts.log(`[nexo] sign-in request for "${nameOf(entry.userId)}" from ${entry.address} cancelled`)
      opts.onResolved(pub(entry))
    }
    res.writeHead(204, REQUESTS_CORS).end()
  }

  /** Handles account routes. Returns false when the request isn't one (the caller then answers it). */
  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://nexo.invalid')
    } catch {
      return false
    }
    const method = req.method ?? 'GET'
    let work: Promise<void>
    let cors = REQUESTS_CORS

    if (url.pathname === '/api/info') {
      cors = INFO_CORS
      if (method === 'OPTIONS') {
        preflight(req, res, cors)
        return true
      }
      if (method === 'GET') work = Promise.resolve().then(() => info(req, res))
      else work = Promise.reject(new HttpError(405, 'Use GET', { allow: 'GET, OPTIONS' }))
    } else if (url.pathname === '/api/access-requests') {
      if (method === 'OPTIONS') {
        preflight(req, res, cors)
        return true
      }
      if (method === 'POST') work = create(req, res)
      else work = Promise.reject(new HttpError(405, 'Use POST', { allow: 'POST, OPTIONS' }))
    } else if (url.pathname.startsWith('/api/access-requests/')) {
      const id = url.pathname.slice('/api/access-requests/'.length)
      if (method === 'OPTIONS') {
        preflight(req, res, cors)
        return true
      }
      if (method === 'GET') work = poll(req, res, id)
      else if (method === 'DELETE') work = cancel(req, res, id)
      else work = Promise.reject(new HttpError(405, 'Use GET or DELETE', { allow: 'GET, DELETE, OPTIONS' }))
    } else {
      return false
    }

    finish(req, res, work, { label: 'account', cors, drainBytes: BODY_LIMIT * 4 })
    return true
  }

  // ---------- for the socket side ----------

  return {
    handle,
    /** Pending requests, oldest first. */
    pending: (): AccessRequest[] => pendingList().map(pub),
    /** A pending request, or undefined (unknown, answered or expired). */
    get(id: string): AccessRequest | undefined {
      const e = isStr(id) ? requests.get(id) : undefined
      return e && e.status === 'pending' && e.expiresAt > Date.now() ? pub(e) : undefined
    },
    /** Approves or denies a pending request (the caller checked who may). Returns false if it isn't pending. */
    answer(id: string, approve: boolean, by: User): boolean {
      const e = requests.get(id)
      if (!e || e.status !== 'pending' || e.expiresAt <= Date.now()) return false
      e.status = approve ? 'approved' : 'denied'
      opts.log(
        `[nexo] ${by.name} ${approve ? 'approved' : 'denied'} the sign-in request for "${nameOf(e.userId)}" from ${e.address}`,
      )
      opts.onResolved(pub(e))
      return true
    },
    /** Drops every request for an account that is being removed. Call before the account row is deleted. */
    dropForUser(userId: string) {
      for (const e of [...requests.values()]) {
        if (e.userId !== userId) continue
        requests.delete(e.id)
        if (e.status === 'pending') opts.onResolved(pub(e))
      }
    },
    sweep,
    close() {
      clearInterval(sweepTimer)
    },
  }
}
