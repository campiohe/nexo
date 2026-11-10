import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Server, type Socket } from 'socket.io'
import { AccessToken, TrackSource } from 'livekit-server-sdk'
import type {
  Ack,
  ChannelType,
  ClientToServerEvents,
  ServerToClientEvents,
  User,
  VoiceState,
} from '../../shared/protocol.ts'
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_MESSAGE_LENGTH } from '../../shared/protocol.ts'
import { streamIdentity } from '../../shared/stream.ts'
import { loadConfig, type Config } from './config.ts'
import { isUniqueViolation, openDb } from './db.ts'
import { createAvatarRoutes } from './avatars.ts'
import { createAttachmentRoutes } from './attachments.ts'

interface SocketData {
  user: User
  newToken?: string
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
} as const

export const HANDSHAKE_ERRORS = {
  unknownToken: 'UNKNOWN_TOKEN',
  badName: `Names must be ${LIMITS.nameMin}–${LIMITS.nameMax} letters, numbers, spaces, . _ or -`,
  nameTaken: 'That name is already taken',
  wrongPassword: 'Wrong server password',
  server: 'Server error, try again',
} as const

const DEFAULT_COLOR = '#3ee6b0'
const COLOR_RE = /^#[0-9a-f]{6}$/i
const NAME_RE = new RegExp(`^[\\p{L}\\p{M}\\p{N}_.\\- ]{${LIMITS.nameMin},${LIMITS.nameMax}}$`, 'u')

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Constant-time string comparison (hash first so lengths don't leak). */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

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
    ...rest
  } = options
  const config: Config = { ...base, ...rest, livekit: { ...base.livekit, ...livekit } }
  const log = logOpt === false ? () => {} : (logOpt ?? ((m: string) => console.log(m)))

  const db = openDb(config.dataDir)
  const { users, channels, messages, attachments } = db

  /** Store `user` as the latest profile on all of its sockets and tell everyone. */
  function publishUser(user: User) {
    for (const s of io.of('/').sockets.values()) if (s.data.user?.id === user.id) s.data.user = user
    io.emit('user:upsert', user)
  }

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
    if (avatarRoutes(req, res)) return
    if (attachmentRoutes.handle(req, res)) return
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
    try {
      const auth: Record<string, unknown> = isObj(socket.handshake.auth) ? socket.handshake.auth : {}

      if (isStr(auth.token) && auth.token) {
        const user = users.byTokenHash(hashToken(auth.token))
        if (!user) return next(new Error(HANDSHAKE_ERRORS.unknownToken))
        socket.data.user = user
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
      log(`[nexo] new user "${name}"`)
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

    if (socket.data.newToken) socket.broadcast.emit('user:upsert', me())
    socket.emit('bootstrap', {
      serverName: config.serverName,
      me: me(),
      ...(socket.data.newToken ? { token: socket.data.newToken } : {}),
      users: users.all(),
      online: onlineIds(),
      channels: channels.all(),
      voice: voiceList(),
      lastMessageAt: messages.lastByOthers(userId),
    })
    // The token is delivered exactly once.
    delete socket.data.newToken
    if (count === 1) broadcastPresence()

    // --- channels ---

    socket.on('channel:create', guard('channel:create', (p, ack) => {
      if (!isObj(p) || (p.type !== 'text' && p.type !== 'voice')) return fail(ack, 'Invalid channel type')
      const name = normalizeChannelName(p.name, p.type)
      if (!name) return fail(ack, 'Invalid channel name')
      if (channels.count() >= LIMITS.maxChannels) return fail(ack, 'Too many channels')
      const channel = channels.create(name, p.type)
      io.emit('channel:upsert', channel)
      ok(ack, channel)
    }))

    socket.on('channel:rename', guard('channel:rename', (p, ack) => {
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
      if (msg.userId !== userId) return fail(ack, 'You can only delete your own messages')
      attachmentRoutes.removeFiles(messages.delete(msg.id))
      io.emit('message:deleted', { messageId: msg.id, channelId: msg.channelId })
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
      const a = socket.handshake.address
      if (a) addresses.add(a.startsWith('::ffff:') ? a.slice(7) : a)
    }
    let streaming = 0
    for (const v of voiceStates.values()) if (v.streaming) streaming++
    return { online: connections.size, inVoice: voiceStates.size, streaming, clientAddresses: [...addresses] }
  }

  return { port, url: `http://${displayHost}:${port}`, config, io, close, stats }
}
