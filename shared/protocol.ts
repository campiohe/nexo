// Wire protocol shared by the Nexo server and desktop client (types only).

export type ChannelType = 'text' | 'voice'

/**
 * What a user may do (docs/SPEC-ACCOUNTS.md §2). owner: the host, exactly one per server; admin: manages
 * channels, deletes any message, removes members, approves sign-in requests; member: everything else.
 */
export type Role = 'owner' | 'admin' | 'member'

export interface User {
  id: string
  name: string
  color: string
  /**
   * Profile picture version token, or null when the user has none.
   * Image URL: `${serverUrl}/avatars/${id}?v=${avatar}` (see AVATAR_* below).
   */
  avatar: string | null
  /** Older servers omit it: they check no permissions, so clients treat a missing role as 'admin'. */
  role?: Role
  /** Custom status text ("brb dinner"), at most STATUS_TEXT_MAX characters; null/absent = none. */
  statusText?: string | null
  /**
   * The profile picture may be animated (GIF). Clients show its first frame and animate it only on hover or
   * while the user is speaking (saves CPU while gaming). Older servers omit it.
   */
  avatarAnimated?: boolean
}

export const STATUS_TEXT_MAX = 64

/**
 * Presence beyond online/offline (docs/SPEC.md). Ephemeral (memory only), per account: the latest
 * `presence:update` from any of the account's sockets wins; dropped when its last socket disconnects.
 * - 'idle': set automatically by the client after inactivity (and back to 'online' on input).
 * - 'dnd': chosen by the user; their client suppresses notification popups and sounds (wake-ups still ring).
 */
export type PresenceStatus = 'online' | 'idle' | 'dnd'

/** What someone is playing, detected by their client (opt-in). */
export interface Activity {
  /** Display name, e.g. "Counter-Strike 2" (1..ACTIVITY_NAME_MAX chars, trimmed by the server). */
  name: string
  /** When they started (ms epoch; the server clamps it to now). */
  startedAt: number
}
export const ACTIVITY_NAME_MAX = 64

export interface Presence {
  status: PresenceStatus
  activity: Activity | null
}
/** Presence of an online user who never sent `presence:update`. */
export const DEFAULT_PRESENCE: Presence = { status: 'online', activity: null }

/** Someone without a saved login asking to sign in to an existing account (docs/SPEC-ACCOUNTS.md §4). */
export interface AccessRequest {
  id: string
  /** The account they want to sign in to. */
  userId: string
  /** Address the request came from, as the server saw it (for the approver to judge). */
  address: string
  createdAt: number
  expiresAt: number
}

export interface Channel {
  id: string
  name: string
  type: ChannelType
  position: number
}

/** Image formats accepted as chat attachments (see the ATTACHMENT_* block below). */
export type AttachmentType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface Attachment {
  id: string
  type: AttachmentType
  /** Display size in pixels (EXIF rotation already applied for JPEG). */
  width: number
  height: number
  /** File size in bytes. */
  size: number
}

export interface Message {
  id: string
  channelId: string
  userId: string
  /** May be '' when the message has attachments. */
  content: string
  createdAt: number
  /** Always present ([] for text-only messages). Older servers omit it, so clients should still default it. */
  attachments: Attachment[]
  /** When the author last edited it (`message:edit`); null/absent = never edited. Older servers omit it. */
  editedAt?: number | null
  /**
   * The message this one replies to (same channel), as a preview. null/absent = not a reply. When the
   * original was deleted the preview stays with `deleted: true` and empty content.
   */
  replyTo?: ReplyPreview | null
  /**
   * Reactions in the order each emoji was first added (an emoji keeps its place while anyone still has it;
   * removed by everyone and added again, it goes last). Absent/[] = none. Older servers omit it.
   */
  reactions?: Reaction[]
  /**
   * userIds this message notifies, computed by the server: everyone named with a `<@userId>` token in the
   * content, plus the author of `replyTo` (a reply pings, like Discord). Never includes the author. With
   * `mentionsEveryone`, it notifies every account. Older servers omit both.
   */
  mentions?: string[]
  /** The content contains the `@everyone` token. */
  mentionsEveryone?: boolean
}

/**
 * Mentions in message content (docs/SPEC.md): `<@userId>` for a person (rendered as "@Name", so renames
 * keep working), and the literal `@everyone`. Clients insert `<@userId>` from the @ autocomplete.
 */
export const MENTION_TOKEN_RE = /<@([A-Za-z0-9_-]{1,64})>/g
export const EVERYONE_TOKEN = '@everyone'
/**
 * Where `@everyone` counts as a mention: at the start or after whitespace / an opening bracket or quote,
 * and not running on into a word, an address or a domain ("bob@everyone.org", "x.com/@everyone" and
 * "@everyones" don't ping; "@everyone." and "(@everyone)" do). Global: use with matchAll / replace, or
 * `hasEveryoneMention`.
 */
export const EVERYONE_RE = /(?<=^|[\s(\[{"'«“])@everyone(?![\p{L}\p{M}\p{N}_\-@/]|\.[\p{L}\p{N}])/gu
export function hasEveryoneMention(content: string): boolean {
  return content.includes(EVERYONE_TOKEN) && content.search(EVERYONE_RE) !== -1
}

export interface ReplyPreview {
  id: string
  userId: string
  /** The original's content, cut to REPLY_PREVIEW_LENGTH characters ('' when deleted). */
  content: string
  /** The original has images (shown as "[image]" when there's no text). */
  hasAttachments: boolean
  deleted: boolean
}
export const REPLY_PREVIEW_LENGTH = 200

export interface Reaction {
  /** One emoji (a single grapheme, validated by the server with EMOJI_RE). */
  emoji: string
  /** Who reacted, in the order they did. Never empty (a reaction with no users is removed). */
  userIds: string[]
}
/** A single emoji grapheme: pictographic base, optional variation selector / skin tone / ZWJ sequence, or a flag. */
export const EMOJI_RE =
  /^(?:\p{Regional_Indicator}{2}|[\p{Extended_Pictographic}\p{Emoji_Presentation}](?:️|\p{Emoji_Modifier})?(?:‍[\p{Extended_Pictographic}\p{Emoji_Presentation}](?:️|\p{Emoji_Modifier})?)*|[0-9#*]️?⃣)$/u
export const MAX_REACTIONS_PER_MESSAGE = 20

/** What a user is doing in voice. `channelId: null` means not in voice. */
export interface VoiceStatePatch {
  channelId: string | null
  muted: boolean
  deafened: boolean
  camera: boolean
  streaming: boolean
  /**
   * userIds whose screen share this user is watching (opted in with "Watch stream"); at most
   * MAX_WATCHING, all must be in the same voice channel (the server drops others). Older clients omit it
   * (= watching nothing known).
   */
  watching?: string[]
}
export const MAX_WATCHING = 16

export interface VoiceState extends VoiceStatePatch {
  userId: string
  channelId: string
}

export interface Bootstrap {
  serverName: string
  me: User
  /** Present only when the server just created this identity; the client must store it. */
  token?: string
  users: User[]
  online: string[]
  channels: Channel[]
  voice: VoiceState[]
  /**
   * channelId -> createdAt of the newest message written by someone other than `me` (channels without
   * one are left out). Clients compare it with what they have read to show unread channels.
   * Older servers omit it.
   */
  lastMessageAt?: Record<string, number>
  /** Permanent random id of this server; clients key saved logins by it. Older servers omit it. */
  serverId?: string
  /** Pending sign-in requests this user may answer (admins/owner, or for their own account). */
  accessRequests?: AccessRequest[]
  /**
   * channelId -> createdAt of the newest message by someone else that mentions `me` (in `mentions`, or
   * `mentionsEveryone`). Like `lastMessageAt`, clients compare it with their read marks to badge channels
   * with an unread mention. Older servers omit it.
   */
  lastMentionAt?: Record<string, number>
  /** userId -> presence, for online users whose presence isn't DEFAULT_PRESENCE. Older servers omit it. */
  presence?: Record<string, Presence>
}

/** Sent in the socket.io handshake `auth` field. */
export type HandshakeAuth =
  | { token: string }
  | { name: string; color: string; password?: string }
  /**
   * "Welcome back": sign in to `claim` (a user id) without a token. Accepted only when the connection
   * comes from a Tailscale address linked to that account (GET /api/info `recognized`). Issues a new token
   * in `bootstrap.token`. Rejected with HANDSHAKE_ERRORS NOT_RECOGNIZED otherwise.
   */
  | { claim: string }

export type AckResult<T> = { ok: true; data: T } | { ok: false; error: string }
export type Ack<T> = (res: AckResult<T>) => void

export interface VoiceCredentials {
  url: string
  token: string
  room: string
}

/**
 * Credentials for the native stream participant (Windows native share, docs/SPEC-BETA.md §7).
 * `identity` is `streamIdentity(userId)` from shared/stream.ts; the token can only publish
 * screen_share / screen_share_audio and never subscribes.
 */
export interface StreamCredentials {
  url: string
  token: string
  room: string
  identity: string
}

export interface ClientToServerEvents {
  'channel:create': (p: { name: string; type: ChannelType }, ack: Ack<Channel>) => void
  'channel:rename': (p: { channelId: string; name: string }, ack: Ack<Channel>) => void
  'channel:delete': (p: { channelId: string }, ack: Ack<null>) => void
  /**
   * `attachmentIds`: pending uploads of the sender (POST /api/attachments), in display order.
   * `replyToId`: a message in the same channel (fails with an error when it doesn't exist / is elsewhere).
   */
  'message:send': (
    p: { channelId: string; content: string; attachmentIds?: string[]; replyToId?: string },
    ack: Ack<Message>,
  ) => void
  'message:delete': (p: { messageId: string }, ack: Ack<null>) => void
  /**
   * Author only. Same content rules as `message:send` (may be '' only when the message has attachments;
   * attachments and replyTo don't change). Sets `editedAt`, recomputes mentions, broadcasts `message:updated`.
   * Unchanged content is a no-op success returning the message as is.
   */
  'message:edit': (p: { messageId: string; content: string }, ack: Ack<Message>) => void
  /**
   * Add (`on: true`) or remove your reaction. Idempotent. Anyone who can see the channel may react.
   * Fails for an invalid emoji (EMOJI_RE, at most 32 UTF-16 units) or when adding a new emoji would exceed
   * MAX_REACTIONS_PER_MESSAGE. Rate limited per user (10 requests per 5 s: "Slow down").
   * Broadcasts `message:reactions` when something changed.
   */
  'message:react': (p: { messageId: string; emoji: string; on: boolean }, ack: Ack<null>) => void
  'message:history': (p: { channelId: string; before?: number }, ack: Ack<Message[]>) => void
  typing: (p: { channelId: string }) => void
  'voice:token': (p: { channelId: string }, ack: Ack<VoiceCredentials>) => void
  /** Only while the caller's voice state (from this socket) is in `channelId`. */
  'voice:streamToken': (p: { channelId: string }, ack: Ack<StreamCredentials>) => void
  'voice:state': (p: VoiceStatePatch) => void
  /**
   * Change any of: color, custom status text (trimmed; '' or null clears; > STATUS_TEXT_MAX fails).
   * Broadcasts `user:upsert`.
   */
  'profile:update': (p: { color?: string; statusText?: string | null }, ack: Ack<User>) => void
  /**
   * Set your status and/or activity (omitted fields keep their value). No ack; invalid fields are ignored.
   * Rate limited server-side (excess updates are dropped). Broadcasts `presence:changed` when it changed.
   * Clients re-send their full presence after every (re)connect.
   */
  'presence:update': (p: { status?: PresenceStatus; activity?: Activity | null }) => void
  /** Owner only. Can't change the owner's own role (ownership moves with `nexo-server owner <name>`). */
  'user:setRole': (p: { userId: string; role: 'admin' | 'member' }, ack: Ack<User>) => void
  /**
   * Admins remove members; only the owner removes admins; nobody removes the owner or themselves.
   * Deletes the account with its messages, pictures and logins, and frees the name.
   */
  'user:remove': (p: { userId: string }, ack: Ack<null>) => void
  /** Admins/owner, or the account the request is for (from another device). */
  'access:respond': (p: { requestId: string; approve: boolean }, ack: Ack<null>) => void
  /**
   * Admins/owner move someone who is in voice to another voice channel. Admins can't move the owner.
   * Moving someone to the channel they're already in is a no-op success. The server updates the target's
   * voice state at once (camera/streaming cleared, mute/deafen kept) and broadcasts `voice:states`, then
   * sends `voice:moved` to the target's voice-owning socket, which rejoins in the new channel.
   */
  'voice:move': (p: { userId: string; channelId: string }, ack: Ack<null>) => void
  /**
   * "Wake up": get the attention of someone in voice who is muted or deafened. Anyone online may nudge
   * anyone else; at most one nudge per sender → target every NUDGE_COOLDOWN_MS (ack error otherwise).
   * Delivered as `voice:nudged` to the target's voice-owning socket.
   */
  'voice:nudge': (p: { userId: string }, ack: Ack<null>) => void
}

export interface ServerToClientEvents {
  bootstrap: (b: Bootstrap) => void
  'user:upsert': (u: User) => void
  presence: (online: string[]) => void
  /** `userId`'s presence changed (DEFAULT_PRESENCE when they went back to plain online or went offline). */
  'presence:changed': (p: { userId: string; presence: Presence }) => void
  'channel:upsert': (c: Channel) => void
  'channel:deleted': (p: { channelId: string }) => void
  'message:new': (m: Message) => void
  /**
   * Also: every loaded message whose `replyTo.id` is `messageId` should show its preview as deleted (the
   * server does the same for later history loads).
   */
  'message:deleted': (p: { messageId: string; channelId: string }) => void
  /**
   * An edited message, complete (replace the stored copy; keep its position). Loaded replies whose
   * `replyTo.id` is this message should refresh their preview content (cut to REPLY_PREVIEW_LENGTH).
   */
  'message:updated': (m: Message) => void
  /** The full, new reaction list of a message. */
  'message:reactions': (p: { messageId: string; channelId: string; reactions: Reaction[] }) => void
  typing: (p: { channelId: string; userId: string }) => void
  'voice:states': (states: VoiceState[]) => void
  /**
   * The account is gone: drop the user, their messages and voice state. Its own sockets are disconnected.
   * Their reactions on other messages are removed too (each affected message gets a `message:reactions`);
   * replies to their messages show deleted previews (userId '' on later loads).
   */
  'user:removed': (p: { userId: string }) => void
  /** To admins/owner and to the target account's sockets. */
  'access:request': (r: AccessRequest) => void
  /** The request was approved, denied, cancelled or expired: dismiss it. */
  'access:resolved': (p: { requestId: string }) => void
  /** You were moved (`voice:move`) by `by` (userId) to voice channel `channelId`: join it. */
  'voice:moved': (p: { channelId: string; by: string }) => void
  /** `by` (userId) nudged you ("wake up") while you're muted or deafened in voice. */
  'voice:nudged': (p: { by: string }) => void
}

/** Minimum time between two nudges (`voice:nudge`) from the same sender to the same target. */
export const NUDGE_COOLDOWN_MS = 15_000

// ---- Server info (HTTP, no auth) ----
// GET /api/info → 200 ServerInfo. Clients call it before connecting without a saved login, to find the
// saved login by serverId and to offer "Welcome back" for `recognized` accounts.
export interface ServerInfo {
  serverId: string
  serverName: string
  /** Account creation needs the server password. */
  passwordRequired: boolean
  /**
   * Accounts linked to the caller's Tailscale device (most recently used first). Always [] for
   * connections that don't come from a Tailscale address.
   */
  recognized: User[]
}

// ---- Sign-in requests (HTTP, no auth) ----
// POST   /api/access-requests        body { name: string; password?: string }  (password = server password,
//                                    required when the server has one)
//        → 201 { id, secret, expiresAt } | 404 { error } no such account | 403 { error } wrong password
//          | 429 { error } too many requests
// GET    /api/access-requests/:id    Authorization: Bearer <secret>
//        → 200 { status: 'pending' } | { status: 'denied' } | { status: 'approved', token }
//          (the token is delivered once; afterwards and after expiry → 404)
// DELETE /api/access-requests/:id    Authorization: Bearer <secret> → 204 (cancel)
export type AccessRequestStatus =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'approved'; token: string }
export const ACCESS_REQUEST_TTL_MS = 10 * 60 * 1000
export const ACCESS_REQUEST_POLL_MS = 2000

// ---- Profile pictures (HTTP, not socket.io) ----
// PUT    /api/avatar   Authorization: Bearer <device token>, body = image bytes
//                      (Content-Type image/webp | image/png | image/jpeg, <= AVATAR_MAX_BYTES)
//                      → 200 { user: User }  (server also broadcasts `user:upsert`)
// DELETE /api/avatar   Authorization: Bearer <device token> → 200 { user: User }
// GET    /avatars/:userId?v=<avatar>  → the image (long-lived cache; the version changes on update)
// Clients crop to a square and resize to AVATAR_SIZE×AVATAR_SIZE before uploading.
export const AVATAR_MAX_BYTES = 512 * 1024
export const AVATAR_SIZE = 256
// Animated profile pictures: `Content-Type: image/gif` (GIF87a/GIF89a magic), up to AVATAR_ANIMATED_MAX_BYTES,
// served back as image/gif; the user gets `avatarAnimated: true`. Clients crop/resize every frame to
// AVATAR_ANIMATED_SIZE square and re-encode as GIF (dropping frames / lowering the frame rate to fit).
export const AVATAR_ANIMATED_MAX_BYTES = 2 * 1024 * 1024
export const AVATAR_ANIMATED_SIZE = 160

// ---- Chat image attachments (HTTP, not socket.io) ----
// POST /api/attachments   Authorization: Bearer <device token>, body = image bytes
//                         (Content-Type = one of AttachmentType, <= ATTACHMENT_MAX_BYTES,
//                         width and height <= ATTACHMENT_MAX_DIMENSION)
//                         → 201 { attachment: Attachment }. The upload is pending until a `message:send`
//                         claims it with `attachmentIds`; unclaimed uploads are deleted after an hour.
// GET  /attachments/:id   → the image (public by unguessable id, cached forever). Pending/unknown ids → 404.
// Clients re-encode still images over the size limit to WebP (longest side <= ATTACHMENT_REENCODE_MAX_SIDE).
export const ATTACHMENT_TYPES: readonly AttachmentType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
export const ATTACHMENT_MAX_DIMENSION = 16384
export const ATTACHMENT_REENCODE_MAX_SIDE = 4096
export const MAX_ATTACHMENTS_PER_MESSAGE = 4

export const MESSAGE_PAGE_SIZE = 50
export const MAX_MESSAGE_LENGTH = 4000
