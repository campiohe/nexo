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
 * Presence beyond online/offline (docs/SPEC.md). Ephemeral (memory only) and kept per connection: each
 * device (socket) reports only its own state with `presence:update` (DEFAULT_PRESENCE until it does), and
 * the account's presence that everyone sees is the aggregate over its connected sockets, recomputed on every
 * update and every disconnect:
 * - status: 'dnd' if any socket is dnd, else 'online' if any is online, else 'idle' (busy anywhere = busy;
 *   active anywhere = not away);
 * - activity: the one with the latest `startedAt` among the sockets that have one (null if none).
 * Clients never adopt the aggregate as their own choice: each keeps its own status (per device).
 * - 'idle': set automatically by the client after inactivity (and back to 'online' on input), or picked.
 * - 'dnd': chosen by the user; their client suppresses notification popups and sounds (wake-ups still ring).
 */
export type PresenceStatus = 'online' | 'idle' | 'dnd'

/** What someone is playing, detected by their client (opt-in). */
export interface Activity {
  /**
   * Display name, e.g. "Counter-Strike 2" (1..ACTIVITY_NAME_MAX UTF-16 units). The server normalizes it like
   * statusText (trimmed, whitespace collapsed, control characters removed) and cuts longer names to the limit.
   */
  name: string
  /** When they started (ms epoch; the server clamps it to [now - 7 days, now]). */
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
  /**
   * Pinned to its channel (`message:pin`): by whom and when. null/absent = not pinned. `by` is '' once the
   * pinner's account was removed (the pin stays).
   */
  pinned?: { by: string; at: number } | null
}

export const MAX_PINS_PER_CHANNEL = 50

/** One page of `message:search` results, newest first. */
export interface SearchResult {
  messages: Message[]
  /** Older matches exist: ask again with `before` = the last message's createdAt. */
  hasMore: boolean
}
export const SEARCH_PAGE_SIZE = 25
export const SEARCH_QUERY_MAX = 200

/**
 * A link preview (GET /api/embed). Only for allowlisted providers fetched through their oEmbed endpoints by
 * the server; the server never fetches arbitrary URLs.
 */
export interface Embed {
  /** The link as it appears in the message. */
  url: string
  /** 'YouTube', 'Spotify', 'SoundCloud', 'Vimeo' or 'Reddit' (more may come; show it as text). */
  provider: string
  kind: 'video' | 'audio' | 'post'
  title: string
  author?: string
  /** https image on the provider's CDN (loaded directly by clients). */
  thumbnail?: { url: string; width: number; height: number }
}
/** Previews shown per message (the first N distinct links that have one). */
export const MAX_EMBEDS_PER_MESSAGE = 3

/** A soundboard clip (docs/SPEC.md). Audio at GET /sounds/:id. */
export interface Sound {
  id: string
  /** 1..SOUND_NAME_MAX UTF-16 units, normalized like statusText. */
  name: string
  /** Optional single emoji (EMOJI_RE) shown on the button. */
  emoji: string | null
  uploaderId: string
  /** Measured by the server from the uploaded WAV's data chunk, 1..SOUND_MAX_MS. */
  durationMs: number
  createdAt: number
}
export const SOUND_NAME_MAX = 32
export const SOUND_MAX_MS = 5000
export const SOUND_MAX_BYTES = 512 * 1024
export const MAX_SOUNDS = 100
/** Minimum time between two `sound:play` from the same user. */
export const SOUND_COOLDOWN_MS = 2000
/**
 * Media types a stored sound may have. Older servers also accepted OGG, MP3 and WebM, so existing clips may
 * still be served with those types; uploads are limited to SOUND_TYPES.
 */
export type SoundType = 'audio/ogg' | 'audio/mpeg' | 'audio/wav' | 'audio/webm'
/** Accepted upload types: 16-bit PCM WAV only (what the desktop client encodes), so the server can measure it. */
export const SOUND_TYPES: readonly SoundType[] = ['audio/wav']

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
   * MAX_WATCHING. The server only checks the shape (strings of at most 64 characters, not yourself, no
   * duplicates; an array longer than 64 is ignored as a whole), not whether those users are in the same
   * channel or streaming (they may announce after you, e.g. after a server restart): clients count a viewer
   * only for a streamer in the viewer's channel who is streaming. Older clients omit it (= watching nothing known).
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
  /** userId -> aggregate presence, for online users whose presence isn't DEFAULT_PRESENCE. Older servers omit it. */
  presence?: Record<string, Presence>
  /** The soundboard, oldest first. Older servers omit it. */
  sounds?: Sound[]
  /** Which built-in plugins the admins turned on. Older servers omit it (= no plugins). */
  plugins?: ServerPlugins
  /** Music sessions of voice channels that have one (MusicState.current or queue non-empty). */
  music?: MusicState[]
  /** Games plugin: the open game session of each voice channel that has one. Older servers omit it. */
  games?: GameLobby[]
  /** Emulator plugin: the running emulator session of each voice channel that has one. Older servers omit it. */
  emulator?: EmuSession[]
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
  /**
   * Pin or unpin. Anyone may pin (up to MAX_PINS_PER_CHANNEL per channel); unpinning is for whoever pinned
   * it, the message's author, or admins/owner. Idempotent. Broadcasts `message:updated` with `pinned` set.
   */
  'message:pin': (p: { messageId: string; pinned: boolean }, ack: Ack<null>) => void
  /** A text channel's pinned messages, most recently pinned first (at most MAX_PINS_PER_CHANNEL). */
  'message:pins': (p: { channelId: string }, ack: Ack<Message[]>) => void
  /**
   * Full-text search (case and accent insensitive; each word matches as a prefix, all words must match).
   * Words are runs of letters and numbers (punctuation separates them; at most the first 10 are used; `<@id>`
   * mention tokens are not searchable). Optional filters: one text channel, one author. `before` pages to
   * older results. `query` may have no words only when `authorId` is given (then: that author's messages).
   * Fails for a query over SEARCH_QUERY_MAX characters.
   */
  'message:search': (
    p: { query: string; channelId?: string; authorId?: string; before?: number },
    ack: Ack<SearchResult>,
  ) => void
  /**
   * Admins/owner: set the order of all channels of one type. `ids` must contain every channel of that type
   * exactly once. Broadcasts `channel:upsert` for each channel whose position changed.
   */
  'channel:reorder': (p: { type: ChannelType; ids: string[] }, ack: Ack<null>) => void
  /**
   * Play a soundboard clip to your voice channel. You must be in voice; at most one per SOUND_COOLDOWN_MS
   * (ack error otherwise). The server sends `sound:played` to the voice-owning socket of everyone in that
   * channel (the caller included); each client plays it locally (not through anyone's microphone), unless
   * deafened.
   */
  'sound:play': (p: { soundId: string }, ack: Ack<null>) => void
  /**
   * Admins/owner: turn a built-in plugin on or off for the whole server (persisted). Broadcasts `plugins:changed`
   * when it changed. Turning `music` off ends every music session; turning `games` or `emulator` off closes
   * every game / emulator session.
   */
  'plugins:set': (p: { plugin: PluginId; enabled: boolean }, ack: Ack<ServerPlugins>) => void
  /** The server's clock (ms epoch), for MusicState timing. Clients estimate their offset from several RTTs. */
  'time:now': (p: Record<string, never>, ack: Ack<{ now: number }>) => void
  /**
   * Add tracks to a voice channel's music queue (the `music` plugin must be on and you must be in that voice
   * channel). `next: true` inserts them right after the current track instead of at the end. Starts playing
   * when nothing was. At most MUSIC_MAX_ADD per call, MUSIC_MAX_QUEUE queued in total (the track that starts
   * playing doesn't count); one invalid track fails the whole call. Shares `music:control`'s rate limit.
   * Broadcasts `music:state`.
   */
  'music:add': (p: { channelId: string; tracks: MusicTrackInfo[]; next?: boolean }, ack: Ack<MusicState>) => void
  /**
   * Control a voice channel's music (same rules as `music:add`). `play`/`pause` resume or pause at the
   * current position; `seek` to `positionMs` (clamped to [0, durationMs - 1000]); `skip` plays the next track
   * (also when paused; stops when the queue is empty); `previous` restarts the current track and plays it (or
   * goes back to the last played one when within the first 3 s, the current one returning to the queue's front);
   * `remove` / `move` a queued entry by `queueId` (move to `toIndex` in `queue`); `clear` empties the queue
   * (keeps the current track); `stop` clears everything. Rate limited per user. Broadcasts `music:state`
   * (a no-op, e.g. `pause` while paused, only acks the state).
   */
  /**
   * Games plugin (docs/SPEC.md §5.5). Every `games:*` request needs the `games` plugin on and must come from
   * the socket that owns the caller's voice state, in that voice channel. `games:open` starts the channel's
   * session (lobby) with that game and seats the caller as host; on an existing session, the host (or an
   * admin) switches its game when no match is running. Broadcasts `games:lobby`.
   */
  'games:open': (p: { channelId: string; gameId: GameId }, ack: Ack<GameLobby>) => void
  /** Take a seat for the next match (lobby or finished; a bot gives up its seat when the table is full). */
  'games:join': (p: { channelId: string }, ack: Ack<GameLobby>) => void
  /** Give up your seat (during a match: you forfeit and watch). The host role moves on; nobody left closes. */
  'games:leave': (p: { channelId: string }, ack: Ack<GameLobby>) => void
  /** Host / admins: how many bots (computer players) fill seats in the next match (games that have bots). */
  'games:bots': (p: { channelId: string; count: number }, ack: Ack<GameLobby>) => void
  /** Host / admins: start a match (also "play again" after one finished). Needs enough players + bots. */
  'games:start': (p: { channelId: string }, ack: Ack<GameLobby>) => void
  /** Host / admins: abort the running match (back to the lobby, no result). */
  'games:stop': (p: { channelId: string }, ack: Ack<GameLobby>) => void
  /** Host / admins: close the channel's game session. */
  'games:close': (p: { channelId: string }, ack: Ack<null>) => void
  /**
   * Controller state of a `pad` game: the buttons (GAME_PAD bits) you hold now. Sent on every change; the
   * server keeps the last one per seat. No ack; ignored when you have no seat in `matchId`, rate limited.
   */
  'games:input': (p: { channelId: string; matchId: string; buttons: number }) => void
  /** One move of an `actions` game (e.g. play a card). The game validates it; its refusal is the ack error. */
  'games:action': (p: { channelId: string; matchId: string; action: unknown }, ack: Ack<null>) => void
  /**
   * Emulator plugin (docs/SPEC.md §5.6). Every `emu:*` request needs the `emulator` plugin on and must come from
   * the socket that owns the caller's voice state, in that voice channel. `emu:start`: the caller hosts a game
   * they loaded on their own device (the file never goes through the server; only `title` and `system`) and
   * takes port 1. One session per voice channel ("Someone is already hosting a game here"); the host may call it
   * again to change the title (new game loaded). Broadcasts `emu:session`.
   */
  'emu:start': (p: { channelId: string; system: EmuSystem; title: string }, ack: Ack<EmuSession>) => void
  /** Take a free controller port (0-based, < EMU_PORTS), or give yours up (`port: null`). */
  'emu:port': (p: { channelId: string; port: number | null }, ack: Ack<EmuSession>) => void
  /** Host / admins: put someone in the channel on a port (or free it: `userId: null`). Moves them off another port. */
  'emu:assign': (p: { channelId: string; port: number; userId: string | null }, ack: Ack<EmuSession>) => void
  /** Host: paused for everyone (shown to players; the host's emulator actually pauses). */
  'emu:pause': (p: { channelId: string; paused: boolean }, ack: Ack<EmuSession>) => void
  /** Host / admins: end the session. */
  'emu:stop': (p: { channelId: string }, ack: Ack<null>) => void
  /**
   * A player's held buttons (GAME_PAD bits), sent on every change. No ack; ignored unless you hold a port in
   * that channel's session; rate limited. Relayed to the host's voice socket as `emu:input`.
   */
  'emu:input': (p: { channelId: string; buttons: number }) => void
  'music:control': (
    p: {
      channelId: string
      action: 'play' | 'pause' | 'seek' | 'skip' | 'previous' | 'remove' | 'move' | 'clear' | 'stop'
      positionMs?: number
      queueId?: string
      toIndex?: number
    },
    ack: Ack<MusicState>,
  ) => void
  'message:history': (p: { channelId: string; before?: number }, ack: Ack<Message[]>) => void
  typing: (p: { channelId: string }) => void
  'voice:token': (p: { channelId: string }, ack: Ack<VoiceCredentials>) => void
  /** Only while the caller's voice state (from this socket) is in `channelId`. */
  'voice:streamToken': (p: { channelId: string }, ack: Ack<StreamCredentials>) => void
  'voice:state': (p: VoiceStatePatch) => void
  /**
   * Change any of (at least one): color, custom status text (normalized: NFC, whitespace runs collapsed to one
   * space, control characters removed, trimmed; '' or null clears; > STATUS_TEXT_MAX UTF-16 units fails).
   * Broadcasts `user:upsert`.
   */
  'profile:update': (p: { color?: string; statusText?: string | null }, ack: Ack<User>) => void
  /**
   * Set this connection's status and/or activity (omitted fields keep their value). No ack; invalid fields
   * are ignored. The account's presence is the aggregate over its sockets (see PresenceStatus); a
   * `presence:changed` is broadcast only when that aggregate changed. Rate limited per socket: excess
   * updates are delayed (merged, latest values win) until the window allows, never lost. A new connection
   * counts as DEFAULT_PRESENCE, so clients send their full presence after every (re)connect.
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
  /** A soundboard clip was added (POST /api/sounds) or changed. */
  'sound:upsert': (s: Sound) => void
  'sound:deleted': (p: { soundId: string }) => void
  /** `userId` played a clip in voice channel `channelId` (only sent to that channel's members). */
  'sound:played': (p: { soundId: string; userId: string; channelId: string }) => void
  'plugins:changed': (p: ServerPlugins) => void
  /** A voice channel's music session changed (also sent when it becomes empty: current null, queue []). */
  'music:state': (s: MusicState) => void
  /** A voice channel's game session changed (to everyone; `status: 'closed'` when it ended). Not per frame. */
  'games:lobby': (l: GameLobby) => void
  /** The running match's state as seen by you (to the voice-owning sockets in that channel, at the game's rate). */
  'games:frame': (f: GameFrame) => void
  /** A voice channel's emulator session changed (to everyone; `status: 'closed'` when it ended). */
  'emu:session': (s: EmuSession) => void
  /**
   * To the host's voice socket only: the buttons the player on `port` holds now (also `buttons: 0` when a player
   * leaves their port). The host applies it to that controller.
   */
  'emu:input': (p: { channelId: string; port: number; buttons: number }) => void
  /**
   * `userId`'s aggregate presence changed (DEFAULT_PRESENCE when they went back to plain online or went
   * offline). Also sent for yourself: it's what others see, not something to adopt as your own status.
   */
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
   * An edited, pinned or unpinned message, complete (replace the stored copy; keep its position). Loaded
   * replies whose `replyTo.id` is this message should refresh their preview content (cut to
   * REPLY_PREVIEW_LENGTH).
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

// ---- Link previews (HTTP, not socket.io) ----
// GET /api/embed?url=<encoded url>   Authorization: Bearer <device token>
//     → 200 { embed: Embed } | 204 (no preview for this link) | 400 bad url | 401 | 429 too many requests
// Only allowlisted providers (YouTube, Spotify, SoundCloud, Vimeo, Reddit; not Twitch or X, which have no
// usable keyless oEmbed) via their oEmbed endpoints; results are cached by the server. Clients cache too
// and show at most MAX_EMBEDS_PER_MESSAGE per message. Thumbnails are https URLs on the provider's image CDN
// (*.ytimg.com, *.scdn.co, *.spotifycdn.com, *.sndcdn.com, *.vimeocdn.com, *.redditmedia.com, *.redd.it).

// ---- Soundboard (HTTP, not socket.io) ----
// POST   /api/sounds?name=<name>&emoji=<emoji>   Authorization: Bearer <device token>
//        body = 16-bit PCM WAV (Content-Type audio/wav, <= SOUND_MAX_BYTES; 1-2 channels, 8-96 kHz). The server
//        parses the header and measures the duration from the data chunk (a `durationMs` query parameter, sent
//        by older clients, is ignored).
//        → 201 { sound: Sound } (+ `sound:upsert` broadcast) | 400 (bad name/emoji, longer than SOUND_MAX_MS,
//          no audio) | 401 | 409 board full (MAX_SOUNDS) | 413 | 415 (not audio/wav, or not a valid PCM WAV)
//          | 429
// DELETE /api/sounds/:id   uploader or admins/owner → 204 (+ `sound:deleted`)
// GET    /sounds/:id       → the audio (no auth; unguessable id; cached forever)
// Clients trim/convert clips to <= SOUND_MAX_MS WAV before uploading and play them with Web Audio
// (fetch + decodeAudioData), since the renderer CSP's media-src doesn't allow server URLs.

// ---- Plugins (built-in, toggled by admins) ----
export type PluginId = 'music' | 'games' | 'emulator'
export interface ServerPlugins {
  /** "YouTube Music": listen together in voice channels. */
  music: boolean
  /** "Retro games": play together in voice channels (docs/SPEC.md §5.5). */
  games: boolean
  /** "Emulator": the host plays a console game file they load; friends play along over the stream (§5.6). */
  emulator: boolean
}
export const DEFAULT_PLUGINS: ServerPlugins = { music: false, games: false, emulator: false }

// ---- Music plugin: listen together (docs/SPEC.md) ----
// Every client in the voice channel fetches and plays the same track itself (YouTube Music via InnerTube in
// the desktop main process) at the position derived from MusicState; the server only keeps the shared
// state and advances the queue on a timer (durationMs). Nothing is re-broadcast through voice.

/** A track as found by a client's search (YouTube video id + metadata). Validated by the server. */
export interface MusicTrackInfo {
  /** YouTube video id: /^[A-Za-z0-9_-]{11}$/. */
  videoId: string
  /** 1..200 characters (UTF-16 units, after the server normalizes it like other display text). */
  title: string
  /** Artist(s) as one string, 0..200 characters. */
  artist: string
  /** 0..200 characters, or null ('' becomes null). */
  album: string | null
  /** 1 s .. MUSIC_MAX_TRACK_MS. */
  durationMs: number
  /** https artwork on ytimg.com, *.ytimg.com or *.googleusercontent.com, no credentials/port (else dropped), or null. */
  artwork: string | null
}

export interface MusicTrack extends MusicTrackInfo {
  /** Unique per queue entry (the same song can be queued twice). */
  queueId: string
  /** userId who added it. */
  addedBy: string
}

export interface MusicState {
  channelId: string
  current: MusicTrack | null
  /** Upcoming tracks, in order. */
  queue: MusicTrack[]
  /**
   * While playing: the server time (ms epoch) at which `current` was at position 0 (position now =
   * serverNow - startedAt). null while paused or stopped.
   */
  startedAt: number | null
  /** While paused: the position (ms) to resume from. null while playing or stopped. */
  pausedAt: number | null
  /**
   * Bumped on every change; clients ignore a state older than the one they have. One server-wide counter that
   * never goes back (not when a channel's session ends and starts again, nor across server restarts).
   */
  rev: number
}

export const MUSIC_MAX_QUEUE = 200
export const MUSIC_MAX_ADD = 100
export const MUSIC_MAX_TRACK_MS = 3 * 60 * 60 * 1000
/** A voice channel's session is cleared after its voice channel has been empty this long (paused meanwhile). */
export const MUSIC_IDLE_CLEAR_MS = 30 * 60 * 1000

// ---- Games plugin: play together in a voice channel (docs/SPEC.md §5.5) ----
// The server runs the match (shared/games/<id>: pure, deterministic game logic) and sends each player the state
// they may see, at the game's rate; clients only draw it and send their controller state or moves.

export type GameId = 'bomber' | 'kart' | 'brawl' | 'fighter' | 'cards'
export const GAME_IDS: readonly GameId[] = ['bomber', 'kart', 'brawl', 'fighter', 'cards']

/**
 * Controller buttons (bit flags) of `pad` games and the emulator. Keyboard: arrows / WASD, A = Space / J / Z,
 * B = K / X, X = L / C, Y = I / V, L = Q, R = E, Start = Enter, Select = Backspace / right Shift. Gamepads: the
 * standard mapping. Positions follow the standard gamepad: A bottom, B right, X left, Y top.
 */
export const GAME_PAD = {
  UP: 1,
  DOWN: 2,
  LEFT: 4,
  RIGHT: 8,
  A: 16,
  B: 32,
  X: 64,
  Y: 128,
  L: 256,
  R: 512,
  START: 1024,
  SELECT: 2048,
} as const
export const GAME_PAD_MASK = 4095

/** A seat of a match: a person (userId) or a bot (userId null). */
export interface GameSeat {
  /** 0-based, also the index in the game's state. */
  seat: number
  userId: string | null
  /** The person's name when the match started, or "CPU 1"… */
  name: string
  /** GAME_SEAT_COLORS[seat]. */
  color: string
}

/** One color per seat, in seat order (distinct, readable on dark and light backgrounds). */
export const GAME_SEAT_COLORS: readonly string[] = [
  '#ff5a5f',
  '#3d9cff',
  '#ffd23f',
  '#3ee6b0',
  '#c06bff',
  '#ff9f43',
  '#ff6bcb',
  '#b8c4d6',
]

export type GameStatus = 'lobby' | 'playing' | 'finished' | 'closed'

export interface GameResult {
  /** Winning seats (empty: nobody won, e.g. a draw or the match was cut). */
  winners: GameSeat[]
  /** One line, e.g. "Ana wins 3–1". */
  summary: string
}

export interface GameLobby {
  channelId: string
  gameId: GameId
  /**
   * `lobby`: picking players; `playing`: a match runs (frames flow); `finished`: the last match's `result` shows
   * (play again or change game); `closed`: the session ended (clients drop it).
   */
  status: GameStatus
  /** Starts matches, adds bots, changes the game. Always someone in the voice channel. */
  hostId: string
  /** People seated for the next match, in the order they joined (= seat order). */
  players: string[]
  /** Bots that fill seats after the players (0 for games without bots). */
  bots: number
  /** The running (or last finished) match: its id and seats. null before the first start. */
  matchId: string | null
  seats: GameSeat[]
  /** Server time (ms epoch) the match started. */
  startedAt: number | null
  /** While `finished`. */
  result: GameResult | null
  /** Bumped on every change; one server-wide counter that never goes back (like MusicState.rev). */
  rev: number
}

export interface GameFrame {
  channelId: string
  matchId: string
  /** Simulation tick of this state (0 at the start, +1 per 1 / tickHz s). */
  tick: number
  /** The game's view of the match for this recipient (shape defined by the game). */
  view: unknown
}

/** Longest a match may run; then it ends without a winner. */
export const GAME_MAX_MATCH_MS = 30 * 60 * 1000

// ---- Emulator plugin: the host plays a console game, friends play along (docs/SPEC.md §5.6) ----
// The host's Nexo runs the emulator on a game file loaded from their own disk (never uploaded or downloaded by
// Nexo) and streams its picture and sound to the voice channel as their stream (LiveKit). Players send their
// controller state through the server, which relays it to the host; the host's emulator applies it.

export type EmuSystem = 'snes'
export const EMU_SYSTEMS: readonly EmuSystem[] = ['snes']
/** Controller ports per session (the SNES multitap has 4 usable here; port 0 is player 1). */
export const EMU_PORTS = 4
/** `title`: 1..EMU_TITLE_MAX characters after normalizing like other display text. */
export const EMU_TITLE_MAX = 80

export interface EmuSession {
  channelId: string
  /** Runs the emulator and streams it. Always in the voice channel (the session closes when they leave it). */
  hostId: string
  system: EmuSystem
  /** The game's display name, from the host's file name. */
  title: string
  /** userId on each controller port (index = port, EMU_PORTS long); null = free. */
  ports: (string | null)[]
  paused: boolean
  /** `closed`: the session ended (clients drop it). */
  status: 'running' | 'closed'
  /** Bumped on every change; one server-wide counter that never goes back (like MusicState.rev). */
  rev: number
}
