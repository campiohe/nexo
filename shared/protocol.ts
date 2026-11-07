// Wire protocol shared by the Nexo server and desktop client (types only).

export type ChannelType = 'text' | 'voice'

export interface User {
  id: string
  name: string
  color: string
  /**
   * Profile picture version token, or null when the user has none.
   * Image URL: `${serverUrl}/avatars/${id}?v=${avatar}` (see AVATAR_* below).
   */
  avatar: string | null
}

export interface Channel {
  id: string
  name: string
  type: ChannelType
  position: number
}

export interface Message {
  id: string
  channelId: string
  userId: string
  content: string
  createdAt: number
}

/** What a user is doing in voice. `channelId: null` means not in voice. */
export interface VoiceStatePatch {
  channelId: string | null
  muted: boolean
  deafened: boolean
  camera: boolean
  streaming: boolean
}

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
}

/** Sent in the socket.io handshake `auth` field. */
export type HandshakeAuth =
  | { token: string }
  | { name: string; color: string; password?: string }

export type AckResult<T> = { ok: true; data: T } | { ok: false; error: string }
export type Ack<T> = (res: AckResult<T>) => void

export interface VoiceCredentials {
  url: string
  token: string
  room: string
}

export interface ClientToServerEvents {
  'channel:create': (p: { name: string; type: ChannelType }, ack: Ack<Channel>) => void
  'channel:rename': (p: { channelId: string; name: string }, ack: Ack<Channel>) => void
  'channel:delete': (p: { channelId: string }, ack: Ack<null>) => void
  'message:send': (p: { channelId: string; content: string }, ack: Ack<Message>) => void
  'message:delete': (p: { messageId: string }, ack: Ack<null>) => void
  'message:history': (p: { channelId: string; before?: number }, ack: Ack<Message[]>) => void
  typing: (p: { channelId: string }) => void
  'voice:token': (p: { channelId: string }, ack: Ack<VoiceCredentials>) => void
  'voice:state': (p: VoiceStatePatch) => void
  'profile:update': (p: { color: string }, ack: Ack<User>) => void
}

export interface ServerToClientEvents {
  bootstrap: (b: Bootstrap) => void
  'user:upsert': (u: User) => void
  presence: (online: string[]) => void
  'channel:upsert': (c: Channel) => void
  'channel:deleted': (p: { channelId: string }) => void
  'message:new': (m: Message) => void
  'message:deleted': (p: { messageId: string; channelId: string }) => void
  typing: (p: { channelId: string; userId: string }) => void
  'voice:states': (states: VoiceState[]) => void
}

// ---- Profile pictures (HTTP, not socket.io) ----
// PUT    /api/avatar   Authorization: Bearer <device token>, body = image bytes
//                      (Content-Type image/webp | image/png | image/jpeg, <= AVATAR_MAX_BYTES)
//                      → 200 { user: User }  (server also broadcasts `user:upsert`)
// DELETE /api/avatar   Authorization: Bearer <device token> → 200 { user: User }
// GET    /avatars/:userId?v=<avatar>  → the image (long-lived cache; the version changes on update)
// Clients crop to a square and resize to AVATAR_SIZE×AVATAR_SIZE before uploading.
export const AVATAR_MAX_BYTES = 512 * 1024
export const AVATAR_SIZE = 256

export const MESSAGE_PAGE_SIZE = 50
export const MAX_MESSAGE_LENGTH = 4000
