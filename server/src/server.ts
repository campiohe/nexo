import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { Server, type Socket } from 'socket.io'
import { AccessToken, TrackSource } from 'livekit-server-sdk'
import type {
  AccessRequest,
  Ack,
  Activity,
  ChannelType,
  ClientToServerEvents,
  Presence,
  PresenceStatus,
  Role,
  ServerToClientEvents,
  User,
  VoiceState,
} from '../../shared/protocol.ts'
import {
  ACCESS_REQUEST_TTL_MS,
  ACTIVITY_NAME_MAX,
  DEFAULT_PRESENCE,
  EMOJI_RE,
  hasEveryoneMention,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_LENGTH,
  MAX_REACTIONS_PER_MESSAGE,
  MAX_WATCHING,
  MENTION_TOKEN_RE,
  NUDGE_COOLDOWN_MS,
  SOUND_COOLDOWN_MS,
  STATUS_TEXT_MAX,
} from '../../shared/protocol.ts'
import { MAX_PINS_PER_CHANNEL, SEARCH_QUERY_MAX } from '../../shared/protocol.ts'
import { streamIdentity } from '../../shared/stream.ts'
import { loadConfig, type Config } from './config.ts'
import { isUniqueViolation, openDb, searchWords } from './db.ts'
import { createAvatarRoutes } from './avatars.ts'
import { createAttachmentRoutes } from './attachments.ts'
import { createAccountRoutes } from './accounts.ts'
import { isTailscaleAddress, unwrapAddress } from './address.ts'
import { safeEqual } from './http.ts'
import { normalizeDisplayText, truncate } from './text.ts'
import { createEmbedRoutes } from './embeds.ts'
import { createSoundRoutes } from './sounds.ts'

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
  /** Minimum ms between two nudges from the same sender to the same target. Default: NUDGE_COOLDOWN_MS. */
  nudgeCooldownMs?: number
  /** `message:react` requests per user per window. Default: LIMITS.reactionsPerWindow / reactionWindowMs. */
  reactionLimit?: { count: number; windowMs: number }
  /** `presence:update` events per socket per window. Default: LIMITS.presenceUpdatesPerWindow / presenceWindowMs. */
  presenceLimit?: { count: number; windowMs: number }
  /** Link previews: the fetch used for oEmbed requests (tests inject a fake). Default: global fetch. */
  embedFetch?: typeof fetch
  /** Link previews: timeout of one oEmbed request. Default: LIMITS.embedTimeoutMs. */
  embedTimeoutMs?: number
  /** Link previews: oEmbed lookups per user per minute. Default: LIMITS.embedLookupsPerMinute. */
  embedLookupsPerMinute?: number
  /** Soundboard uploads per user per minute. Default: LIMITS.soundUploadsPerMinute. */
  soundUploadsPerMinute?: number
  /** Minimum ms between two `sound:play` from the same user. Default: SOUND_COOLDOWN_MS. */
  soundCooldownMs?: number
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
  /** `message:react` requests per user (all sockets) in any window of reactionWindowMs. */
  reactionsPerWindow: 10,
  reactionWindowMs: 5000,
  /** Longest emoji accepted by `message:react`, in UTF-16 units (RGI sequences are at most ~15). */
  emojiMaxLength: 32,
  /**
   * `presence:update` events per socket in any window of presenceWindowMs. Excess updates are delayed, not
   * lost: the latest values are applied (merged) as soon as the window allows.
   */
  presenceUpdatesPerWindow: 20,
  presenceWindowMs: 60_000,
  /** Oldest accepted activity start: `startedAt` is clamped to [now - this, now]. */
  activityMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /** Link previews: oEmbed lookups a user may start per minute (cache hits don't count)… */
  embedLookupsPerMinute: 30,
  /** …each given this long. */
  embedTimeoutMs: 4000,
  /** Soundboard uploads per user per minute. */
  soundUploadsPerMinute: 10,
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
  moveMembers: 'Only admins can move people',
  moveOwner: "Admins can't move the owner",
} as const

/** Ack errors of `voice:move` and `voice:nudge` (besides PERMISSION_ERRORS). */
export const VOICE_ERRORS = {
  channelNotFound: 'Voice channel not found',
  notInVoice: "They're not in voice",
  nudgeSelf: "You can't nudge yourself",
  notMuted: "They're not muted",
  /** `You can nudge them again in N s` (N rounded up, at least 1). */
  nudgeCooldown: (ms: number) => `You can nudge them again in ${Math.max(1, Math.ceil(ms / 1000))} s`,
} as const

/** Ack errors of the message events (clients show them as toasts). */
export const MESSAGE_ERRORS = {
  notFound: 'Message not found',
  empty: 'Message is empty',
  tooLong: `Messages are limited to ${MAX_MESSAGE_LENGTH} characters`,
  invalidContent: 'Invalid message',
  replyNotFound: 'The message you replied to was not found',
  editOthers: 'You can only edit your own messages',
  invalidEmoji: 'Invalid emoji',
  invalidReaction: 'Invalid reaction',
  tooManyReactions: `Messages can have at most ${MAX_REACTIONS_PER_MESSAGE} different reactions`,
  slowDown: 'Slow down',
  // ---------- pins / search / reorder ----------
  invalidPin: 'Invalid pin',
  tooManyPins: `This channel has ${MAX_PINS_PER_CHANNEL} pinned messages. Unpin one first`,
  unpinOthers: 'Only the person who pinned it, its author or an admin can unpin it',
} as const

/** Ack errors of `message:search`. */
export const SEARCH_ERRORS = {
  invalid: 'Invalid search',
  tooLong: `Search is limited to ${SEARCH_QUERY_MAX} characters`,
  noWords: 'Type at least one word to search',
  channelNotFound: 'Channel not found',
} as const

/** Ack errors of `channel:reorder` (besides PERMISSION_ERRORS.manageChannels). */
export const REORDER_ERRORS = {
  invalidType: 'Invalid channel type',
  changed: 'The channel list changed, try again',
} as const

/** Ack errors of `sound:play`. */
export const SOUND_ERRORS = {
  notFound: 'Sound not found',
  notInVoice: 'Join a voice channel to play sounds',
  cooldown: 'Wait a moment before playing another sound',
} as const

/** Ack errors of `profile:update`. */
export const PROFILE_ERRORS = {
  nothingToUpdate: 'Nothing to update',
  invalidColor: 'Invalid color',
  invalidStatusText: 'Invalid status',
  statusTextTooLong: `Status is limited to ${STATUS_TEXT_MAX} characters`,
  userNotFound: 'User not found',
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

// normalizeDisplayText and truncate live in text.ts (shared with the HTTP routes).
export { normalizeDisplayText } from './text.ts'

const PRESENCE_STATUSES: readonly string[] = ['online', 'idle', 'dnd'] satisfies PresenceStatus[]

/**
 * A valid activity from an untrusted payload, or undefined: the name normalized (normalizeDisplayText),
 * non-empty and cut to ACTIVITY_NAME_MAX; `startedAt` a finite number, clamped to [now - maxAgeMs, now].
 */
export function parseActivity(raw: unknown, now: number, maxAgeMs: number = LIMITS.activityMaxAgeMs): Activity | undefined {
  if (!isObj(raw) || !isStr(raw.name) || typeof raw.startedAt !== 'number' || !Number.isFinite(raw.startedAt)) return undefined
  const name = truncate(normalizeDisplayText(raw.name), ACTIVITY_NAME_MAX)
  if (!name) return undefined
  return { name, startedAt: Math.min(now, Math.max(now - maxAgeMs, Math.round(raw.startedAt))) }
}

const samePresence = (a: Presence, b: Presence) =>
  a.status === b.status &&
  (a.activity === b.activity ||
    (a.activity !== null && b.activity !== null && a.activity.name === b.activity.name && a.activity.startedAt === b.activity.startedAt))

const STATUS_RANK: Record<PresenceStatus, number> = { idle: 0, online: 1, dnd: 2 }

/**
 * An account's presence from those of its connected sockets (docs/SPEC.md §5.1): the status is the
 * "strongest" one (dnd > online > idle: busy anywhere means busy; active anywhere means not away), the
 * activity is the most recently started one among the sockets that have one. No sockets → DEFAULT_PRESENCE.
 */
export function aggregatePresence(perSocket: Iterable<Presence>): Presence {
  let status: PresenceStatus | null = null
  let activity: Activity | null = null
  for (const p of perSocket) {
    if (status === null || STATUS_RANK[p.status] > STATUS_RANK[status]) status = p.status
    if (p.activity && (!activity || p.activity.startedAt > activity.startedAt)) activity = p.activity
  }
  return status === null ? DEFAULT_PRESENCE : { status, activity }
}

/** Longest `watching` array the server looks at (anything longer is ignored as a whole). */
const MAX_WATCHING_PAYLOAD = 64

/** The valid fields of a `presence:update`. */
type PresencePatch = { status?: PresenceStatus; activity?: Activity | null }

/** Sliding-window rate limiter: `allow(key, now)` records an event and says whether it is within `count` per `windowMs`. */
function rateLimiter(limit: { count: number; windowMs: number }) {
  const times = new Map<string, number[]>()
  return {
    allow(key: string, now: number): boolean {
      const recent = (times.get(key) ?? []).filter((t) => now - t < limit.windowMs)
      const allowed = recent.length < limit.count
      if (allowed) recent.push(now)
      times.set(key, recent)
      return allowed
    },
    /** When `allow(key, t)` would next succeed (`now` if it would now). */
    nextAllowedAt(key: string, now: number): number {
      const recent = (times.get(key) ?? []).filter((t) => now - t < limit.windowMs)
      return recent.length < limit.count ? now : recent[recent.length - limit.count] + limit.windowMs
    },
    forget: (key: string) => times.delete(key),
  }
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
    nudgeCooldownMs = NUDGE_COOLDOWN_MS,
    reactionLimit = { count: LIMITS.reactionsPerWindow, windowMs: LIMITS.reactionWindowMs },
    presenceLimit = { count: LIMITS.presenceUpdatesPerWindow, windowMs: LIMITS.presenceWindowMs },
    embedFetch = fetch,
    embedTimeoutMs = LIMITS.embedTimeoutMs,
    embedLookupsPerMinute = LIMITS.embedLookupsPerMinute,
    soundUploadsPerMinute = LIMITS.soundUploadsPerMinute,
    soundCooldownMs = SOUND_COOLDOWN_MS,
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

  const embedRoutes = createEmbedRoutes({
    users,
    hashToken,
    fetch: embedFetch,
    timeoutMs: embedTimeoutMs,
    lookupsPerMinute: embedLookupsPerMinute,
    log,
  })

  const soundRoutes = createSoundRoutes({
    dataDir: config.dataDir,
    users,
    sounds: db.sounds,
    hashToken,
    uploadsPerMinute: soundUploadsPerMinute,
    onSound: (sound) => io.emit('sound:upsert', sound),
    onSoundDeleted: (soundId) => io.emit('sound:deleted', { soundId }),
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
    if (embedRoutes.handle(req, res)) return
    if (soundRoutes.handle(req, res)) return
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

  /** `${senderId}>${targetId}` -> time of the last `voice:nudge` (server-wide: shared by all of a sender's sockets). */
  const lastNudges = new Map<string, number>()
  const nudgeKey = (from: string, to: string) => `${from}>${to}`
  /** Drops cooldowns that have run out (and, with `userId`, all of that user's), so the map stays small. */
  function pruneNudges(now: number, userId?: string) {
    for (const [key, at] of lastNudges) {
      if (now - at >= nudgeCooldownMs || (userId && key.split('>').includes(userId))) lastNudges.delete(key)
    }
  }

  /** userId -> time of their last accepted `sound:play` (all sockets). Expired entries are pruned on each play. */
  const lastSoundPlays = new Map<string, number>()

  /** `message:react` requests per user (server-wide: shared by all of a user's sockets). */
  const reactionRate = rateLimiter(reactionLimit)
  /** `presence:update` events per socket (each device reports only its own state). */
  const presenceRate = rateLimiter(presenceLimit)

  /**
   * Presence is kept per socket (docs/SPEC.md §5.1): userId -> socketId -> what that connection reported
   * (DEFAULT_PRESENCE until it sends `presence:update`). The account's presence is the aggregate over its
   * connected sockets (see aggregatePresence). Entries go with their socket.
   */
  const socketPresences = new Map<string, Map<string, Presence>>()
  /** userId -> the aggregate everyone was last told, only for online users whose aggregate isn't DEFAULT_PRESENCE. */
  const presences = new Map<string, Presence>()

  /** Recomputes `userId`'s aggregate and broadcasts `presence:changed` if it differs from what others know. */
  function refreshPresence(userId: string) {
    const next = aggregatePresence(socketPresences.get(userId)?.values() ?? [])
    if (samePresence(presences.get(userId) ?? DEFAULT_PRESENCE, next)) return
    if (samePresence(next, DEFAULT_PRESENCE)) presences.delete(userId)
    else presences.set(userId, next)
    io.emit('presence:changed', { userId, presence: next })
  }

  /**
   * The `watching` list of a voice state from an untrusted payload: strings of at most 64 characters, not
   * `userId` itself, without duplicates, at most MAX_WATCHING. Not an array, or longer than
   * MAX_WATCHING_PAYLOAD → []. Whether those users are in the same channel and streaming is left to clients
   * (they may announce before the streamer does, e.g. right after a server restart).
   */
  function sanitizeWatching(raw: unknown, userId: string): string[] {
    if (!Array.isArray(raw) || raw.length > MAX_WATCHING_PAYLOAD) return []
    const out: string[] = []
    for (const id of raw) {
      if (out.length >= MAX_WATCHING) break
      if (!isStr(id) || !id || id.length > 64 || id === userId || out.includes(id)) continue
      out.push(id)
    }
    return out
  }
  const sameList = (a: readonly string[] | undefined, b: readonly string[]) =>
    !!a && a.length === b.length && a.every((v, i) => v === b[i])

  /**
   * Who a message notifies (docs/SPEC.md "Mentions"): the existing accounts named by `<@userId>` tokens,
   * plus the author of the replied message, never the author, without duplicates, in order of appearance.
   * Anyone may use @everyone.
   */
  function mentionsIn(content: string, authorId: string, replyAuthorId?: string): { mentions: string[]; mentionsEveryone: boolean } {
    const ids = new Set<string>()
    for (const match of content.matchAll(MENTION_TOKEN_RE)) ids.add(match[1])
    if (replyAuthorId) ids.add(replyAuthorId)
    ids.delete(authorId)
    return { mentions: [...ids].filter((id) => users.get(id)), mentionsEveryone: hasEveryoneMention(content) }
  }

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
    // Their soundboard clips go with them.
    soundRoutes.removeFiles(removed.soundIds)
    for (const soundId of removed.soundIds) io.emit('sound:deleted', { soundId })
    lastSoundPlays.delete(target.id)
    embedRoutes.forgetUser(target.id)
    if (voiceStates.delete(target.id)) broadcastVoice()
    pruneNudges(Date.now(), target.id)
    reactionRate.forget(target.id)
    // No presence:changed: user:removed drops everything clients know about the account (and its sockets'
    // disconnects below then find nothing left to recompute).
    socketPresences.delete(target.id)
    presences.delete(target.id)
    io.emit('user:removed', { userId: target.id })
    // Their reactions on other people's messages are gone too.
    for (const update of removed.reactions) io.emit('message:reactions', update)
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
    // This connection counts as plain online until it reports its own presence (right after connecting).
    const ownPresences = socketPresences.get(userId) ?? new Map<string, Presence>()
    ownPresences.set(socket.id, DEFAULT_PRESENCE)
    socketPresences.set(userId, ownPresences)
    log(`[nexo] ${me().name} connected (${socket.id}, ${count} socket${count > 1 ? 's' : ''})`)

    // Device link for "welcome back" (Tailscale addresses only, see isTrustedDeviceAddress).
    if (isTrusted(socket.data.address)) devices.link(userId, socket.data.address)

    if (socket.data.created) socket.broadcast.emit('user:upsert', me())
    // Your other devices were all idle: this new one counts as online (until it reports otherwise). Before
    // bootstrap, so its `presence` already has the new aggregate.
    if (count > 1) refreshPresence(userId)
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
      lastMentionAt: messages.lastMentionAt(userId),
      accessRequests: requestsFor(me()),
      presence: Object.fromEntries([...presences].filter(([id]) => connections.has(id))),
      sounds: db.sounds.all(),
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
      if (!content && attachmentIds.length === 0) return fail(ack, MESSAGE_ERRORS.empty)
      if (content.length > MAX_MESSAGE_LENGTH) return fail(ack, MESSAGE_ERRORS.tooLong)
      let replyTo: { id: string; userId: string } | undefined
      if (p.replyToId !== undefined && p.replyToId !== null) {
        const original = isStr(p.replyToId) ? messages.get(p.replyToId) : undefined
        if (!original || original.channelId !== channel.id) return fail(ack, MESSAGE_ERRORS.replyNotFound)
        replyTo = { id: original.id, userId: original.userId }
      }
      if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        return fail(ack, `Messages can have at most ${MAX_ATTACHMENTS_PER_MESSAGE} images`)
      }
      if (new Set(attachmentIds).size !== attachmentIds.length) return fail(ack, 'The same image is attached twice')
      // Pending uploads of this user only. (Checked and claimed synchronously, so nothing can race in between.)
      if (!attachmentIds.every((id) => attachments.pending(id, userId))) {
        return fail(ack, 'An image upload expired or was not found. Remove it and add it again')
      }
      const msg = messages.create(channel.id, userId, content, attachmentIds, {
        replyTo,
        ...mentionsIn(content, userId, replyTo?.userId),
      })
      io.emit('message:new', msg)
      ok(ack, msg)
    }))

    socket.on('message:edit', guard('message:edit', (p, ack) => {
      const msg = isObj(p) && isStr(p.messageId) ? messages.get(p.messageId) : undefined
      if (!msg) return fail(ack, MESSAGE_ERRORS.notFound)
      if (msg.userId !== userId) return fail(ack, MESSAGE_ERRORS.editOthers)
      if (!isStr(p.content)) return fail(ack, MESSAGE_ERRORS.invalidContent)
      const content = p.content.trim()
      if (!content && msg.attachments.length === 0) return fail(ack, MESSAGE_ERRORS.empty)
      if (content.length > MAX_MESSAGE_LENGTH) return fail(ack, MESSAGE_ERRORS.tooLong)
      if (content === msg.content) return ok(ack, msg)
      const { mentions, mentionsEveryone } = mentionsIn(content, userId, msg.replyTo?.userId)
      const updated = messages.edit(msg.id, content, mentions, mentionsEveryone)
      if (!updated) return fail(ack, MESSAGE_ERRORS.notFound)
      io.emit('message:updated', updated)
      ok(ack, updated)
    }))

    socket.on('message:react', guard('message:react', (p, ack) => {
      const msg = isObj(p) && isStr(p.messageId) ? messages.get(p.messageId) : undefined
      if (!msg) return fail(ack, MESSAGE_ERRORS.notFound)
      if (typeof p.on !== 'boolean') return fail(ack, MESSAGE_ERRORS.invalidReaction)
      if (!isStr(p.emoji) || p.emoji.length > LIMITS.emojiMaxLength || !EMOJI_RE.test(p.emoji)) {
        return fail(ack, MESSAGE_ERRORS.invalidEmoji)
      }
      if (!reactionRate.allow(userId, Date.now())) return fail(ack, MESSAGE_ERRORS.slowDown)
      const result = messages.react(msg.id, userId, p.emoji, p.on)
      if (result === 'tooMany') return fail(ack, MESSAGE_ERRORS.tooManyReactions)
      if (result.changed) io.emit('message:reactions', { messageId: msg.id, channelId: msg.channelId, reactions: result.reactions })
      ok(ack, null)
    }))

    socket.on('message:delete', guard('message:delete', (p, ack) => {
      const msg = isObj(p) && isStr(p.messageId) ? messages.get(p.messageId) : undefined
      if (!msg) return fail(ack, MESSAGE_ERRORS.notFound)
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

    // ---------- pins / search / reorder ----------

    // Anyone may pin; unpinning is for whoever pinned it, the author, or admins/owner. Idempotent.
    socket.on('message:pin', guard('message:pin', (p, ack) => {
      const msg = isObj(p) && isStr(p.messageId) ? messages.get(p.messageId) : undefined
      if (!msg) return fail(ack, MESSAGE_ERRORS.notFound)
      if (typeof p.pinned !== 'boolean') return fail(ack, MESSAGE_ERRORS.invalidPin)
      if (!p.pinned && msg.pinned && msg.pinned.by !== userId && msg.userId !== userId && !isAdmin()) {
        return fail(ack, MESSAGE_ERRORS.unpinOthers)
      }
      const result = messages.pin(msg.id, userId, p.pinned)
      if (!result) return fail(ack, MESSAGE_ERRORS.notFound)
      if (result === 'tooMany') return fail(ack, MESSAGE_ERRORS.tooManyPins)
      if (result.changed) io.emit('message:updated', result.message)
      ok(ack, null)
    }))

    socket.on('message:pins', guard('message:pins', (p, ack) => {
      const channel = isObj(p) && isStr(p.channelId) ? channels.get(p.channelId) : undefined
      if (!channel || channel.type !== 'text') return fail(ack, 'Channel not found')
      ok(ack, messages.pins(channel.id))
    }))

    socket.on('message:search', guard('message:search', (p, ack) => {
      if (!isObj(p) || !isStr(p.query)) return fail(ack, SEARCH_ERRORS.invalid)
      if (p.query.length > SEARCH_QUERY_MAX) return fail(ack, SEARCH_ERRORS.tooLong)
      const filter: { channelId?: string; authorId?: string; before?: number } = {}
      if (p.channelId !== undefined && p.channelId !== null) {
        const channel = isStr(p.channelId) ? channels.get(p.channelId) : undefined
        if (!channel || channel.type !== 'text') return fail(ack, SEARCH_ERRORS.channelNotFound)
        filter.channelId = channel.id
      }
      if (p.authorId !== undefined && p.authorId !== null) {
        if (!isStr(p.authorId) || !p.authorId) return fail(ack, SEARCH_ERRORS.invalid)
        filter.authorId = p.authorId
      }
      if (p.before !== undefined && p.before !== null) {
        if (typeof p.before !== 'number' || !Number.isFinite(p.before)) return fail(ack, 'Invalid "before" timestamp')
        filter.before = p.before
      }
      const words = searchWords(p.query)
      // No words (empty, or only punctuation): only "everything by this author".
      if (words.length === 0 && !filter.authorId) return fail(ack, SEARCH_ERRORS.noWords)
      ok(ack, messages.search(words, filter))
    }))

    socket.on('channel:reorder', guard('channel:reorder', (p, ack) => {
      if (!isAdmin()) return fail(ack, PERMISSION_ERRORS.manageChannels)
      if (!isObj(p) || (p.type !== 'text' && p.type !== 'voice')) return fail(ack, REORDER_ERRORS.invalidType)
      if (!Array.isArray(p.ids) || !p.ids.every(isStr)) return fail(ack, REORDER_ERRORS.changed)
      const changed = channels.reorder(p.type, p.ids)
      if (!changed) return fail(ack, REORDER_ERRORS.changed)
      for (const channel of changed) io.emit('channel:upsert', channel)
      ok(ack, null)
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
        watching: sanitizeWatching(p.watching, userId),
        socketId: socket.id,
      }
      const unchanged =
        current &&
        current.socketId === next.socketId &&
        current.channelId === next.channelId &&
        current.muted === next.muted &&
        current.deafened === next.deafened &&
        current.camera === next.camera &&
        current.streaming === next.streaming &&
        sameList(current.watching, next.watching)
      // The latest socket to announce a voice state owns it (e.g. joining from a second device).
      voiceStates.set(userId, next)
      if (!unchanged) broadcastVoice()
    }))

    // Admins/owner move someone in voice to another voice channel. The stored state moves at once; the
    // target's voice-owning socket gets `voice:moved`, leaves the old LiveKit room, joins the new one and
    // re-announces `voice:state` (same socket, so it keeps ownership). Until then it is still connected to
    // the old room: accepted.
    socket.on('voice:move', guard('voice:move', (p, ack) => {
      const role = roleOf(userId)
      if (!isAdminRole(role)) return fail(ack, PERMISSION_ERRORS.moveMembers)
      const target = isObj(p) && isStr(p.userId) ? users.get(p.userId) : undefined
      if (!target) return fail(ack, PERMISSION_ERRORS.userNotFound)
      const current = voiceStates.get(target.id)
      if (!current) return fail(ack, VOICE_ERRORS.notInVoice)
      if (target.role === 'owner' && role !== 'owner') return fail(ack, PERMISSION_ERRORS.moveOwner)
      const channel = isStr(p.channelId) ? channels.get(p.channelId) : undefined
      if (!channel || channel.type !== 'voice') return fail(ack, VOICE_ERRORS.channelNotFound)
      if (current.channelId === channel.id) return ok(ack, null)
      const from = channels.get(current.channelId ?? '')?.name ?? current.channelId
      // In place: mute/deafen and the owning socket are kept; camera, stream and watched streams end with the
      // old room.
      voiceStates.set(target.id, { ...current, channelId: channel.id, camera: false, streaming: false, watching: [] })
      broadcastVoice()
      io.of('/').sockets.get(current.socketId)?.emit('voice:moved', { channelId: channel.id, by: userId })
      log(`[nexo] ${me().name} moved "${target.name}" from "${from}" to "${channel.name}"`)
      ok(ack, null)
    }))

    // "Wake up" someone in voice who is muted or deafened. Anyone may nudge anyone else, once per cooldown.
    socket.on('voice:nudge', guard('voice:nudge', (p, ack) => {
      const targetId = isObj(p) && isStr(p.userId) ? p.userId : undefined
      if (targetId === userId) return fail(ack, VOICE_ERRORS.nudgeSelf)
      const target = targetId ? users.get(targetId) : undefined
      if (!target) return fail(ack, PERMISSION_ERRORS.userNotFound)
      const state = voiceStates.get(target.id)
      if (!state) return fail(ack, VOICE_ERRORS.notInVoice)
      if (!state.muted && !state.deafened) return fail(ack, VOICE_ERRORS.notMuted)
      const now = Date.now()
      pruneNudges(now)
      const key = nudgeKey(userId, target.id)
      const last = lastNudges.get(key)
      if (last !== undefined) return fail(ack, VOICE_ERRORS.nudgeCooldown(last + nudgeCooldownMs - now))
      lastNudges.set(key, now)
      io.of('/').sockets.get(state.socketId)?.emit('voice:nudged', { by: userId })
      log(`[nexo] ${me().name} nudged "${target.name}"`)
      ok(ack, null)
    }))

    // Soundboard: played locally by each client in the caller's voice channel (not through a microphone).
    socket.on('sound:play', guard('sound:play', (p, ack) => {
      const sound = isObj(p) && isStr(p.soundId) ? db.sounds.get(p.soundId) : undefined
      if (!sound) return fail(ack, SOUND_ERRORS.notFound)
      const state = voiceStates.get(userId)
      if (!state) return fail(ack, SOUND_ERRORS.notInVoice)
      const now = Date.now()
      for (const [uid, at] of lastSoundPlays) if (now - at >= soundCooldownMs) lastSoundPlays.delete(uid)
      if (lastSoundPlays.has(userId)) return fail(ack, SOUND_ERRORS.cooldown)
      lastSoundPlays.set(userId, now)
      const played = { soundId: sound.id, userId, channelId: state.channelId }
      // Only the sockets that own a voice state in that channel (not the members' other devices).
      for (const v of voiceStates.values()) {
        if (v.channelId === state.channelId) io.of('/').sockets.get(v.socketId)?.emit('sound:played', played)
      }
      ok(ack, null)
    }))

    // --- profile ---

    socket.on('profile:update', guard('profile:update', (p, ack) => {
      if (!isObj(p) || (p.color === undefined && p.statusText === undefined)) return fail(ack, PROFILE_ERRORS.nothingToUpdate)
      const patch: { color?: string; statusText?: string | null } = {}
      if (p.color !== undefined) {
        if (!isStr(p.color) || !COLOR_RE.test(p.color)) return fail(ack, PROFILE_ERRORS.invalidColor)
        patch.color = p.color.toLowerCase()
      }
      if (p.statusText !== undefined) {
        if (p.statusText !== null && !isStr(p.statusText)) return fail(ack, PROFILE_ERRORS.invalidStatusText)
        const text = p.statusText === null ? '' : normalizeDisplayText(p.statusText)
        if (text.length > STATUS_TEXT_MAX) return fail(ack, PROFILE_ERRORS.statusTextTooLong)
        patch.statusText = text || null
      }
      const updated = users.updateProfile(userId, patch)
      if (!updated) return fail(ack, PROFILE_ERRORS.userNotFound)
      publishUser(updated)
      ok(ack, updated)
    }))

    // --- presence (status, activity) ---

    /** Valid fields of rate-limited updates, applied (merged) once this socket's window allows it again. */
    let pendingPresence: PresencePatch | null = null
    let pendingPresenceTimer: ReturnType<typeof setTimeout> | null = null

    /** Applies a validated patch to this socket's presence and recomputes the account's. */
    function applyPresence(patch: PresencePatch) {
      const own = socketPresences.get(userId)
      const current = own?.get(socket.id)
      if (!own || !current) return // disconnected (or account removed) meanwhile
      own.set(socket.id, {
        status: patch.status ?? current.status,
        activity: patch.activity !== undefined ? patch.activity : current.activity,
      })
      refreshPresence(userId)
    }

    function flushPendingPresence() {
      pendingPresenceTimer = null
      if (!pendingPresence) return
      const now = Date.now()
      if (presenceRate.allow(socket.id, now)) {
        const patch = pendingPresence
        pendingPresence = null
        applyPresence(patch)
        return
      }
      pendingPresenceTimer = setTimeout(flushPendingPresence, Math.max(10, presenceRate.nextAllowedAt(socket.id, now) - now))
      pendingPresenceTimer.unref?.()
    }

    socket.on('presence:update', guard('presence:update', (p) => {
      if (!isObj(p)) return
      const now = Date.now()
      const patch: PresencePatch = {}
      if (isStr(p.status) && PRESENCE_STATUSES.includes(p.status)) patch.status = p.status as PresenceStatus
      if (p.activity === null) patch.activity = null
      else if (p.activity !== undefined) {
        const activity = parseActivity(p.activity, now)
        if (activity) patch.activity = activity
      }
      if (patch.status === undefined && patch.activity === undefined) return
      if (pendingPresence || !presenceRate.allow(socket.id, now)) {
        // Over the limit: not lost, only delayed. The latest values are applied when the window allows,
        // so a burst can't leave this device's presence (and the account's) stale.
        pendingPresence = { ...pendingPresence, ...patch }
        if (!pendingPresenceTimer) flushPendingPresence()
        return
      }
      applyPresence(patch)
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
      if (pendingPresenceTimer) clearTimeout(pendingPresenceTimer)
      pendingPresence = null
      presenceRate.forget(socket.id)
      const own = socketPresences.get(userId)
      own?.delete(socket.id)
      if (own && own.size === 0) socketPresences.delete(userId)
      // The account's presence without this device (DEFAULT_PRESENCE when it was the last one: clients
      // clear what they showed for someone who went offline).
      refreshPresence(userId)
      if (n <= 0) broadcastPresence()
      log(`[nexo] ${me().name} disconnected (${reason})`)
    })
  })

  // ---------- listen ----------

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      embedRoutes.close()
      soundRoutes.close()
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
      embedRoutes.close()
      soundRoutes.close()
      lastSoundPlays.clear()
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
