import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { Server, type Socket } from 'socket.io'
import { AccessToken, TrackSource } from 'livekit-server-sdk'
import type {
  AccessRequest,
  Ack,
  ChannelType,
  ClientToServerEvents,
  Role,
  ServerToClientEvents,
  User,
  VoiceState,
} from '../../shared/protocol.ts'
import { ACCESS_REQUEST_TTL_MS, MAX_ATTACHMENTS_PER_MESSAGE, MAX_MESSAGE_LENGTH } from '../../shared/protocol.ts'
import { streamIdentity } from '../../shared/stream.ts'
import { loadConfig, type Config } from './config.ts'
import { isUniqueViolation, openDb } from './db.ts'
import { createAvatarRoutes } from './avatars.ts'
import { createAttachmentRoutes } from './attachments.ts'
import { createAccountRoutes } from './accounts.ts'
import { isTailscaleAddress, unwrapAddress } from './address.ts'
import { safeEqual } from './http.ts'

interface SocketData {
  user: User
  /** Remote address (IPv4-mapped IPv6 unwrapped), from the TCP connection, never from headers. */
  address: string
  /** A login created by this handshake (new account or claim), delivered once in bootstrap. */
  newToken?: string
  /** This handshake created the account. */
  created?: boolean
}

type NexoServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>
type NexoSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>

export interface StartOptions extends Partial<Omit<Config, 'livekit'>> {
  livekit?: Partial<Config['livekit']>
  /** Logger for info lines; `false` silences them (errors are still printed). Default: console.log. */
  log?: ((msg: string) => void) | false
  /** Minimum ms between two profile picture changes by the same user. Default: LIMITS.avatarIntervalMs. */
  avatarIntervalMs?: number
  /** Image uploads per user per minute. Default: LIMITS.attachmentUploadsPerMinute. */
  attachmentUploadsPerMinute?: number
  /** Age at which unsent image uploads are deleted. Default: LIMITS.attachmentPendingTtlMs. */
  attachmentPendingTtlMs?: number
  /** How often unsent uploads are swept. Default: LIMITS.attachmentSweepIntervalMs. */
  attachmentSweepIntervalMs?: number
  /**
   * Whether a connection from this (unwrapped) remote address is a known device: links it to the account
   * and allows "welcome back" claims (docs/SPEC-ACCOUNTS.md §3). Default: isTailscaleAddress. Tests inject
   * one that trusts 127.0.0.1.
   */
  isTrustedDeviceAddress?: (address: string) => boolean
  /** Lifetime of a sign-in request. Default: ACCESS_REQUEST_TTL_MS. */
  accessRequestTtlMs?: number
  /** How often expired sign-in requests are swept. Default: LIMITS.accessRequestSweepIntervalMs. */
  accessRequestSweepIntervalMs?: number
}

export interface NexoInstance {
  /** The port actually bound (useful with `port: 0`). */
  port: number
  /** e.g. http://127.0.0.1:3001 */
  url: string
  config: Config
  io: NexoServer
  /** Disconnects all clients, stops listening and closes the database. */
  close(): Promise<void>
  /** Live counts for hosts (the server CLI's status line). Cheap: no I/O. */
  stats(): ServerStats
}

export interface ServerStats {
  /** Users with at least one connected socket. */
  online: number
  inVoice: number
  streaming: number
  /** Remote addresses of connected sockets (IPv4-mapped IPv6 unwrapped), deduplicated. */
  clientAddresses: string[]
}

// ---------- limits & validation ----------

export const LIMITS = {
  nameMin: 2,
  nameMax: 24,
  channelNameMax: 32,
  maxChannels: 200,
  payloadBytes: 64 * 1024,
  typingThrottleMs: 1000,
  tokenTtl: '12h',
  /** One profile picture change (upload or delete) per user every 3 s. */
  avatarIntervalMs: 3000,
  /** Chat image uploads per user per minute. */
  attachmentUploadsPerMinute: 20,
  /** Uploads not attached to a message within an hour are deleted… */
  attachmentPendingTtlMs: 60 * 60 * 1000,
  /** …by a sweep that runs at start and then every 10 minutes. */
  attachmentSweepIntervalMs: 10 * 60 * 1000,
  /** Pending sign-in requests per remote address… */
  accessRequestsPerAddress: 3,
  /** …and in total. */
  accessRequestsTotal: 20,
  /** Expired sign-in requests are swept (and announced as resolved) this often. */
  accessRequestSweepIntervalMs: 15 * 1000,
} as const

export const HANDSHAKE_ERRORS = {
  unknownToken: 'UNKNOWN_TOKEN',
  /** A "welcome back" claim from an address that isn't a device linked to that account. */
  notRecognized: 'NOT_RECOGNIZED',
  badName: `Names must be ${LIMITS.nameMin}–${LIMITS.nameMax} letters, numbers, spaces, . _ or -`,
  nameTaken: 'That name is already taken',
  wrongPassword: 'Wrong server password',
  server: 'Server error, try again',
} as const

/** Ack errors of role-checked events (docs/SPEC-ACCOUNTS.md §2). */
export const PERMISSION_ERRORS = {
  manageChannels: 'Only admins can manage channels',
  deleteOthersMessages: "Only admins can delete other people's messages",
  setRole: 'Only the owner can change roles',
  ownerRole: "The owner's role can't be changed",
  invalidRole: 'Invalid role',
  removeAccounts: 'Only admins can remove accounts',
  removeSelf: "You can't remove your own account",
  removeOwner: "The owner can't be removed",
  removeAdmin: 'Only the owner can remove admins',
  answerRequests: 'Only admins can answer sign-in requests',
  userNotFound: 'User not found',
  requestNotFound: 'This sign-in request expired or was already answered',
  invalidAnswer: 'Invalid answer',
} as const

/** admin and owner manage channels, delete any message, remove members and answer sign-in requests. */
export const isAdminRole = (role: Role | undefined): boolean => role === 'admin' || role === 'owner'

const DEFAULT_COLOR = '#3ee6b0'
const COLOR_RE = /^#[0-9a-f]{6}$/i
const NAME_RE = new RegExp(`^[\\p{L}\\p{M}\\p{N}_.\\- ]{${LIMITS.nameMin},${LIMITS.nameMax}}$`, 'u')

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Whether an already-normalized name (normalizeUserName) is allowed. Shared with the server CLI's rename-user. */
export function isValidUserName(name: string): boolean {
  return NAME_RE.test(name)
}

export function normalizeUserName(name: unknown): string {
  return isStr(name) ? name.normalize('NFC').trim().replace(/\s+/g, ' ') : ''
}

export function normalizeChannelName(name: unknown, type: ChannelType): string | null {
  if (!isStr(name)) return null
  let n = name.normalize('NFC').replace(/\p{C}/gu, '').trim()
  if (type === 'text') {
    n = n
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{M}\p{N}_-]/gu, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
  } else {
    n = n.replace(/\s+/g, ' ')
  }
  n = n.slice(0, LIMITS.channelNameMax).trim()
  if (type === 'text') n = n.replace(/-+$/, '')
  return n.length > 0 ? n : null
}

function ok<T>(ack: unknown, data: T) {
  if (typeof ack === 'function') (ack as Ack<T>)({ ok: true, data })
}
function fail(ack: unknown, error: string) {
  if (typeof ack === 'function') (ack as Ack<never>)({ ok: false, error })
}

// ---------- server ----------

export async function start(options: StartOptions = {}): Promise<NexoInstance> {
  const base = loadConfig()
  const {
    log: logOpt,
    livekit,
    avatarIntervalMs,
    attachmentUploadsPerMinute,
    attachmentPendingTtlMs,
    attachmentSweepIntervalMs,
    isTrustedDeviceAddress = isTailscaleAddress,
    accessRequestTtlMs,
    accessRequestSweepIntervalMs,
    ...rest
  } = options
  const config: Config = { ...base, ...rest, livekit: { ...base.livekit, ...livekit } }
  const log = logOpt === false ? () => {} : (logOpt ?? ((m: string) => console.log(m)))
  const isTrusted = (address: string) => address !== '' && isTrustedDeviceAddress(address)

  const db = openDb(config.dataDir)
  const { users, devices, channels, messages, attachments } = db

  /** Store `user` as the latest profile on all of its sockets and tell everyone. */
  function publishUser(user: User) {
    for (const s of io.of('/').sockets.values()) if (s.data.user?.id === user.id) s.data.user = user
    io.emit('user:upsert', user)
  }

  /** Creates another login for an account and returns the raw token (stored only as a hash). */
  function issueToken(userId: string): string {
    const token = randomBytes(32).toString('base64url')
    users.addToken(userId, hashToken(token))
    return token
  }

  /** The account's current role, read from the DB (undefined once the account is gone). */
  const roleOf = (userId: string): Role | undefined => users.get(userId)?.role

  /**
   * Runs `fn` for every socket that may see a sign-in request for `targetUserId`: admins/owner, and the
   * target account's own sockets.
   */
  function forApprovers(targetUserId: string, fn: (s: NexoSocket) => void) {
    const roles = new Map<string, Role | undefined>()
    for (const s of io.of('/').sockets.values()) {
      const uid = s.data.user?.id
      if (!uid) continue
      if (!roles.has(uid)) roles.set(uid, roleOf(uid))
      if (uid === targetUserId || isAdminRole(roles.get(uid))) fn(s)
    }
  }

  const accountRoutes = createAccountRoutes({
    serverId: db.serverId,
    serverName: config.serverName,
    serverPassword: config.serverPassword,
    users,
    devices,
    userByName: (name) => {
      const n = normalizeUserName(name)
      return n ? users.byName(n) : undefined
    },
    issueToken,
    isTrustedDeviceAddress: isTrusted,
    ttlMs: accessRequestTtlMs ?? ACCESS_REQUEST_TTL_MS,
    sweepIntervalMs: accessRequestSweepIntervalMs ?? LIMITS.accessRequestSweepIntervalMs,
    maxPerAddress: LIMITS.accessRequestsPerAddress,
    maxTotal: LIMITS.accessRequestsTotal,
    onRequest: (r) => forApprovers(r.userId, (s) => s.emit('access:request', r)),
    onResolved: (r) => forApprovers(r.userId, (s) => s.emit('access:resolved', { requestId: r.id })),
    log,
  })

  /** Pending sign-in requests `user` may answer (all for admins/owner, else only those for their account). */
  const requestsFor = (user: User): AccessRequest[] =>
    accountRoutes.pending().filter((r) => r.userId === user.id || isAdminRole(user.role))

  const avatarRoutes = createAvatarRoutes({
    dataDir: config.dataDir,
    users,
    hashToken,
    onUserUpdated: publishUser,
    minIntervalMs: avatarIntervalMs ?? LIMITS.avatarIntervalMs,
    log,
  })

  const attachmentRoutes = createAttachmentRoutes({
    dataDir: config.dataDir,
    users,
    attachments,
    hashToken,
    uploadsPerMinute: attachmentUploadsPerMinute ?? LIMITS.attachmentUploadsPerMinute,
    pendingTtlMs: attachmentPendingTtlMs ?? LIMITS.attachmentPendingTtlMs,
    sweepIntervalMs: attachmentSweepIntervalMs ?? LIMITS.attachmentSweepIntervalMs,
    log,
  })

  const http = createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0]
    if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify({ ok: true, name: config.serverName }))
      return
    }
    if (avatarRoutes.handle(req, res)) return
    if (attachmentRoutes.handle(req, res)) return
    if (accountRoutes.handle(req, res)) return
    // socket.io handles /socket.io/* itself; everything else is 404.
    if (!pathname.startsWith('/socket.io')) res.writeHead(404).end()
  })

  const io: NexoServer = new Server(http, {
    // Auth is token-based (no cookies), so any origin, including Electron's file://, is fine.
    cors: { origin: '*' },
    maxHttpBufferSize: LIMITS.payloadBytes,
    serveClient: false,
  })

  // ---------- presence & voice (in memory) ----------

  /** userId -> number of connected sockets */
  const connections = new Map<string, number>()
  /** userId -> voice state (+ the socket that owns it) */
  const voiceStates = new Map<string, VoiceState & { socketId: string }>()

  const userRoom = (userId: string) => `user:${userId}`
  const onlineIds = () => [...connections.keys()]
  const voiceList = (): VoiceState[] => [...voiceStates.values()].map(({ socketId: _s, ...v }) => v)
  const broadcastVoice = () => io.emit('voice:states', voiceList())
  const broadcastPresence = () => io.emit('presence', onlineIds())

  /**
   * Deletes an account (docs/SPEC-ACCOUNTS.md §2): its sign-in requests, voice state, DB rows (messages,
   * uploads, logins, device links) and files, then tells everyone and disconnects its sockets.
   */
  function removeAccount(target: User, by: User) {
    accountRoutes.dropForUser(target.id)
    const removed = users.remove(target.id)
    if (!removed) return
    attachmentRoutes.removeFiles(removed.attachmentIds)
    avatarRoutes.removeFile(target.id)
    if (voiceStates.delete(target.id)) broadcastVoice()
    io.emit('user:removed', { userId: target.id })
    io.in(userRoom(target.id)).disconnectSockets(true)
    log(
      `[nexo] ${by.name} removed the account "${target.name}" (${target.role}, ${removed.messages} message${removed.messages === 1 ? '' : 's'})`,
    )
  }

  function livekitUrlFor(socket: NexoSocket): string {
    if (config.livekit.publicUrl) return config.livekit.publicUrl
    const headers = socket.handshake.headers
    const host = (isStr(headers.host) && headers.host) || 'localhost'
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
    const secure = socket.handshake.secure || headers['x-forwarded-proto'] === 'https'
    return `${secure ? 'wss' : 'ws'}://${hostname}:${config.livekit.port}`
  }

  /** Wraps an event handler so a bad payload or bug can never crash the process. */
  function guard<A extends unknown[]>(event: string, fn: (...args: A) => unknown) {
    return (...args: A) => {
      const report = (err: unknown) => {
        console.error(`[nexo] error in "${event}":`, err)
        fail(args[args.length - 1], 'Server error')
      }
      try {
        const r = fn(...args)
        if (r instanceof Promise) r.catch(report)
      } catch (err) {
        report(err)
      }
    }
  }

  // ---------- identity handshake ----------

  io.use((socket, next) => {
    // The TCP peer (socket.io takes it from the connection, not from X-Forwarded-For).
    const address = unwrapAddress(socket.handshake.address)
    socket.data.address = address
    try {
      const auth: Record<string, unknown> = isObj(socket.handshake.auth) ? socket.handshake.auth : {}

      if (isStr(auth.token) && auth.token) {
        const hash = hashToken(auth.token)
        const user = users.byTokenHash(hash)
        if (!user) {
          log(`[nexo] refused a connection from ${address || 'unknown address'}: unknown device token (UNKNOWN_TOKEN)`)
          return next(new Error(HANDSHAKE_ERRORS.unknownToken))
        }
        users.touchToken(hash)
        socket.data.user = user
        return next()
      }

      // "Welcome back" (docs/SPEC-ACCOUNTS.md §3): only from a trusted device already linked to the account.
      if ('claim' in auth) {
        const user = isStr(auth.claim) && auth.claim ? users.get(auth.claim) : undefined
        if (!user || !isTrusted(address) || !devices.isLinked(user.id, address)) {
          const who = user ? `"${user.name}"` : 'an unknown account'
          log(`[nexo] refused a "welcome back" sign-in to ${who} from ${address || 'unknown address'} (NOT_RECOGNIZED)`)
          return next(new Error(HANDSHAKE_ERRORS.notRecognized))
        }
        socket.data.user = user
        socket.data.newToken = issueToken(user.id)
        log(`[nexo] "${user.name}" signed in again from their device ${address} (welcome back): new login issued`)
        return next()
      }

      const name = normalizeUserName(auth.name)
      if (!NAME_RE.test(name)) return next(new Error(HANDSHAKE_ERRORS.badName))
      if (config.serverPassword && !(isStr(auth.password) && safeEqual(auth.password, config.serverPassword))) {
        return next(new Error(HANDSHAKE_ERRORS.wrongPassword))
      }
      if (users.byName(name)) return next(new Error(HANDSHAKE_ERRORS.nameTaken))

      const color = isStr(auth.color) && COLOR_RE.test(auth.color) ? auth.color.toLowerCase() : DEFAULT_COLOR
      const token = randomBytes(32).toString('base64url')
      try {
        socket.data.user = users.create(name, color, hashToken(token))
      } catch (err) {
        if (isUniqueViolation(err)) return next(new Error(HANDSHAKE_ERRORS.nameTaken))
        throw err
      }
      socket.data.newToken = token
      socket.data.created = true
      const role = socket.data.user.role
      log(`[nexo] new user "${name}"${role === 'owner' ? ' (owner: the first account on this server)' : ''} from ${address}`)
      next()
    } catch (err) {
      console.error('[nexo] handshake error', err)
      next(new Error(HANDSHAKE_ERRORS.server))
    }
  })

  // ---------- connection ----------

  io.on('connection', (socket: NexoSocket) => {
    const userId = socket.data.user.id
    /** Always the latest profile (profile:update refreshes socket.data.user on every socket of this user). */
    const me = () => socket.data.user
    const lastTyping = new Map<string, number>()

    void socket.join(userRoom(userId))
    const count = (connections.get(userId) ?? 0) + 1
    connections.set(userId, count)
    log(`[nexo] ${me().name} connected (${socket.id}, ${count} socket${count > 1 ? 's' : ''})`)

    // Device link for "welcome back" (Tailscale addresses only, see isTrustedDeviceAddress).
    if (isTrusted(socket.data.address)) devices.link(userId, socket.data.address)

    if (socket.data.created) socket.broadcast.emit('user:upsert', me())
    socket.emit('bootstrap', {
      serverName: config.serverName,
      serverId: db.serverId,
      me: me(),
      ...(socket.data.newToken ? { token: socket.data.newToken } : {}),
      users: users.all(),
      online: onlineIds(),
      channels: channels.all(),
      voice: voiceList(),
      lastMessageAt: messages.lastByOthers(userId),
      accessRequests: requestsFor(me()),
    })
    // The token is delivered exactly once.
    delete socket.data.newToken
    delete socket.data.created
    if (count === 1) broadcastPresence()

    /** Role checks read the DB, so a change (or removal) applies at once to every socket. */
    const isAdmin = () => isAdminRole(roleOf(userId))

    // --- channels (admins/owner) ---

    socket.on('channel:create', guard('channel:create', (p, ack) => {
      if (!isAdmin()) return fail(ack, PERMISSION_ERRORS.manageChannels)
      if (!isObj(p) || (p.type !== 'text' && p.type !== 'voice')) return fail(ack, 'Invalid channel type')
      const name = normalizeChannelName(p.name, p.type)
      if (!name) return fail(ack, 'Invalid channel name')
      if (channels.count() >= LIMITS.maxChannels) return fail(ack, 'Too many channels')
      const channel = channels.create(name, p.type)
      io.emit('channel:upsert', channel)
      ok(ack, channel)
    }))

    socket.on('channel:rename', guard('channel:rename', (p, ack) => {
      if (!isAdmin()) return fail(ack, PERMISSION_ERRORS.manageChannels)
      const existing = isObj(p) && isStr(p.channelId) ? channels.get(p.channelId) : undefined
      if (!existing) return fail(ack, 'Channel not found')
      const name = normalizeChannelName(p.name, existing.type)
      if (!name) return fail(ack, 'Invalid channel name')
      const channel = channels.rename(existing.id, name)
      if (!channel) return fail(ack, 'Channel not found')
      io.emit('channel:upsert', channel)
      ok(ack, channel)
    }))

    socket.on('channel:delete', guard('channel:delete', (p, ack) => {
      if (!isAdmin()) return fail(ack, PERMISSION_ERRORS.manageChannels)
      const existing = isObj(p) && isStr(p.channelId) ? channels.get(p.channelId) : undefined
      if (!existing) return fail(ack, 'Channel not found')
      attachmentRoutes.removeFiles(channels.delete(existing.id))
      // Everyone in a deleted voice channel is out of voice.
      let voiceChanged = false
      for (const [uid, v] of voiceStates) {
        if (v.channelId === existing.id) {
          voiceStates.delete(uid)
          voiceChanged = true
        }
      }
      io.emit('channel:deleted', { channelId: existing.id })
      if (voiceChanged) broadcastVoice()
      log(`[nexo] ${me().name} deleted ${existing.type} channel "${existing.name}"`)
      ok(ack, null)
    }))

    // --- messages ---

    socket.on('message:send', guard('message:send', (p, ack) => {
      const channel = isObj(p) && isStr(p.channelId) ? channels.get(p.channelId) : undefined
      if (!channel || channel.type !== 'text') return fail(ack, 'Channel not found')
      const content = isStr(p.content) ? p.content.trim() : ''
      let attachmentIds: string[] = []
      if (p.attachmentIds !== undefined && p.attachmentIds !== null) {
        if (!Array.isArray(p.attachmentIds) || !p.attachmentIds.every(isStr)) return fail(ack, 'Invalid attachments')
        attachmentIds = p.attachmentIds
      }
      if (!content && attachmentIds.length === 0) return fail(ack, 'Message is empty')
      if (content.length > MAX_MESSAGE_LENGTH) return fail(ack, `Messages are limited to ${MAX_MESSAGE_LENGTH} characters`)
      if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        return fail(ack, `Messages can have at most ${MAX_ATTACHMENTS_PER_MESSAGE} images`)
      }
      if (new Set(attachmentIds).size !== attachmentIds.length) return fail(ack, 'The same image is attached twice')
      // Pending uploads of this user only. (Checked and claimed synchronously, so nothing can race in between.)
      if (!attachmentIds.every((id) => attachments.pending(id, userId))) {
        return fail(ack, 'An image upload expired or was not found. Remove it and add it again')
      }
      const msg = messages.create(channel.id, userId, content, attachmentIds)
      io.emit('message:new', msg)
      ok(ack, msg)
    }))

    socket.on('message:delete', guard('message:delete', (p, ack) => {
      const msg = isObj(p) && isStr(p.messageId) ? messages.get(p.messageId) : undefined
      if (!msg) return fail(ack, 'Message not found')
      const own = msg.userId === userId
      if (!own && !isAdmin()) return fail(ack, PERMISSION_ERRORS.deleteOthersMessages)
      attachmentRoutes.removeFiles(messages.delete(msg.id))
      io.emit('message:deleted', { messageId: msg.id, channelId: msg.channelId })
      if (!own) log(`[nexo] ${me().name} deleted a message by ${users.get(msg.userId)?.name ?? msg.userId}`)
      ok(ack, null)
    }))

    socket.on('message:history', guard('message:history', (p, ack) => {
      const channel = isObj(p) && isStr(p.channelId) ? channels.get(p.channelId) : undefined
      if (!channel) return fail(ack, 'Channel not found')
      let before: number | undefined
      if (p.before !== undefined && p.before !== null) {
        if (typeof p.before !== 'number' || !Number.isFinite(p.before)) return fail(ack, 'Invalid "before" timestamp')
        before = p.before
      }
      ok(ack, messages.history(channel.id, before))
    }))

    socket.on('typing', guard('typing', (p) => {
      if (!isObj(p) || !isStr(p.channelId)) return
      const now = Date.now()
      if (now - (lastTyping.get(p.channelId) ?? 0) < LIMITS.typingThrottleMs) return
      const channel = channels.get(p.channelId)
      if (!channel || channel.type !== 'text') return
      lastTyping.set(channel.id, now)
      // Not echoed to any of the typer's own sockets.
      io.except(userRoom(userId)).emit('typing', { channelId: channel.id, userId })
    }))

    // --- voice ---

    socket.on('voice:token', guard('voice:token', async (p, ack) => {
      const channel = isObj(p) && isStr(p.channelId) ? channels.get(p.channelId) : undefined
      if (!channel || channel.type !== 'voice') return fail(ack, 'Voice channel not found')
      const user = me()
      const room = `voice-${channel.id}`
      const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
        identity: user.id,
        name: user.name,
        metadata: JSON.stringify({ color: user.color }),
        ttl: LIMITS.tokenTtl,
      })
      at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true })
      ok(ack, { url: livekitUrlFor(socket), token: await at.toJwt(), room })
    }))

    // The native share helper (Windows) joins as a second, publish-only participant `<userId>#stream`
    // (docs/SPEC-BETA.md §7). Only for the voice channel this socket is currently in, so a stream can't
    // appear in a room its owner isn't in.
    socket.on('voice:streamToken', guard('voice:streamToken', async (p, ack) => {
      const channel = isObj(p) && isStr(p.channelId) ? channels.get(p.channelId) : undefined
      if (!channel || channel.type !== 'voice') return fail(ack, 'Voice channel not found')
      const current = voiceStates.get(userId)
      if (current?.channelId !== channel.id || current.socketId !== socket.id) {
        return fail(ack, 'Join the voice channel before streaming')
      }
      const user = me()
      const room = `voice-${channel.id}`
      const identity = streamIdentity(user.id)
      const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
        identity,
        name: user.name,
        metadata: JSON.stringify({ color: user.color }),
        ttl: LIMITS.tokenTtl,
      })
      at.addGrant({
        room,
        roomJoin: true,
        canPublish: true,
        canSubscribe: false,
        canPublishData: false,
        canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
      })
      ok(ack, { url: livekitUrlFor(socket), token: await at.toJwt(), room, identity })
    }))

    socket.on('voice:state', guard('voice:state', (p) => {
      if (!isObj(p)) return
      const current = voiceStates.get(userId)
      if (p.channelId === null || p.channelId === undefined) {
        // Only the socket that owns the voice session can end it.
        if (current?.socketId === socket.id) {
          voiceStates.delete(userId)
          broadcastVoice()
        }
        return
      }
      const channel = isStr(p.channelId) ? channels.get(p.channelId) : undefined
      if (!channel || channel.type !== 'voice') return
      const next = {
        userId,
        channelId: channel.id,
        muted: p.muted === true,
        deafened: p.deafened === true,
        camera: p.camera === true,
        streaming: p.streaming === true,
        socketId: socket.id,
      }
      const unchanged =
        current &&
        current.socketId === next.socketId &&
        current.channelId === next.channelId &&
        current.muted === next.muted &&
        current.deafened === next.deafened &&
        current.camera === next.camera &&
        current.streaming === next.streaming
      // The latest socket to announce a voice state owns it (e.g. joining from a second device).
      voiceStates.set(userId, next)
      if (!unchanged) broadcastVoice()
    }))

    // --- profile ---

    socket.on('profile:update', guard('profile:update', (p, ack) => {
      if (!isObj(p) || !isStr(p.color) || !COLOR_RE.test(p.color)) return fail(ack, 'Invalid color')
      const updated = users.setColor(userId, p.color.toLowerCase())
      if (!updated) return fail(ack, 'User not found')
      publishUser(updated)
      ok(ack, updated)
    }))

    // --- accounts (docs/SPEC-ACCOUNTS.md §2) ---

    socket.on('user:setRole', guard('user:setRole', (p, ack) => {
      if (roleOf(userId) !== 'owner') return fail(ack, PERMISSION_ERRORS.setRole)
      const target = isObj(p) && isStr(p.userId) ? users.get(p.userId) : undefined
      if (!target) return fail(ack, PERMISSION_ERRORS.userNotFound)
      const role = p.role
      if (role !== 'admin' && role !== 'member') return fail(ack, PERMISSION_ERRORS.invalidRole)
      if (target.role === 'owner') return fail(ack, PERMISSION_ERRORS.ownerRole)
      if (target.role === role) return ok(ack, target)
      const updated = users.setRole(target.id, role)
      if (!updated) return fail(ack, PERMISSION_ERRORS.userNotFound)
      publishUser(updated)
      // Other accounts' pending sign-in requests appear for a new admin and go away for a former one.
      for (const r of accountRoutes.pending()) {
        if (r.userId === updated.id) continue
        if (role === 'admin') io.to(userRoom(updated.id)).emit('access:request', r)
        else io.to(userRoom(updated.id)).emit('access:resolved', { requestId: r.id })
      }
      log(`[nexo] ${me().name} made "${updated.name}" ${role === 'admin' ? 'an admin' : 'a member'} (was ${target.role})`)
      ok(ack, updated)
    }))

    socket.on('user:remove', guard('user:remove', (p, ack) => {
      const role = roleOf(userId)
      if (!isAdminRole(role)) return fail(ack, PERMISSION_ERRORS.removeAccounts)
      const target = isObj(p) && isStr(p.userId) ? users.get(p.userId) : undefined
      if (!target) return fail(ack, PERMISSION_ERRORS.userNotFound)
      if (target.id === userId) return fail(ack, PERMISSION_ERRORS.removeSelf)
      if (target.role === 'owner') return fail(ack, PERMISSION_ERRORS.removeOwner)
      if (target.role === 'admin' && role !== 'owner') return fail(ack, PERMISSION_ERRORS.removeAdmin)
      removeAccount(target, me())
      ok(ack, null)
    }))

    socket.on('access:respond', guard('access:respond', (p, ack) => {
      if (!isObj(p) || !isStr(p.requestId) || typeof p.approve !== 'boolean') return fail(ack, PERMISSION_ERRORS.invalidAnswer)
      const request = accountRoutes.get(p.requestId)
      if (!request) return fail(ack, PERMISSION_ERRORS.requestNotFound)
      if (request.userId !== userId && !isAdmin()) return fail(ack, PERMISSION_ERRORS.answerRequests)
      if (!accountRoutes.answer(request.id, p.approve, me())) return fail(ack, PERMISSION_ERRORS.requestNotFound)
      ok(ack, null)
    }))

    // --- disconnect ---

    socket.on('disconnect', (reason) => {
      const n = (connections.get(userId) ?? 1) - 1
      if (n <= 0) connections.delete(userId)
      else connections.set(userId, n)
      if (voiceStates.get(userId)?.socketId === socket.id) {
        voiceStates.delete(userId)
        broadcastVoice()
      }
      if (n <= 0) broadcastPresence()
      log(`[nexo] ${me().name} disconnected (${reason})`)
    })
  })

  // ---------- listen ----------

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      attachmentRoutes.close()
      accountRoutes.close()
      db.close()
      reject(err)
    }
    http.once('error', onError)
    http.listen(config.port, config.host, () => {
      http.off('error', onError)
      resolve()
    })
  })
  const port = (http.address() as AddressInfo).port
  const displayHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host

  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      attachmentRoutes.close()
      accountRoutes.close()
      io.disconnectSockets(true)
      await io.close() // also closes the http server
      http.closeAllConnections()
      db.close()
    })())

  log(`[nexo] "${config.serverName}" listening on http://${config.host}:${port}`)
  log(`[nexo] LiveKit URL for clients: ${config.livekit.publicUrl || `ws://<host clients use>:${config.livekit.port}`}`)
  if (config.serverPassword) log('[nexo] Server password is enabled for new users')

  const stats = (): ServerStats => {
    const addresses = new Set<string>()
    for (const socket of io.sockets.sockets.values()) {
      const a = unwrapAddress(socket.handshake.address)
      if (a) addresses.add(a)
    }
    let streaming = 0
    for (const v of voiceStates.values()) if (v.streaming) streaming++
    return { online: connections.size, inVoice: voiceStates.size, streaming, clientAddresses: [...addresses] }
  }

  return { port, url: `http://${displayHost}:${port}`, config, io, close, stats }
}
