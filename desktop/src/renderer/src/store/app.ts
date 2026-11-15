// CONTRACT (owner: workstream C — renderer core & chat). Extended freely; the original fields/actions are kept.
import { create } from 'zustand'
import type { Channel, ChannelType, Message, Reaction, User, VoiceState } from '@shared/protocol'
import { MAX_MESSAGE_LENGTH, MAX_REACTIONS_PER_MESSAGE, MESSAGE_PAGE_SIZE } from '@shared/protocol'
import { connect, disconnect, request } from '../net/socket'
import { normalizeServerUrl } from '../lib/url'
import { settings } from './settings'
import { resetUnread } from './unread'
import { findLogin, NOTICE_UNREADABLE, resetSignIn } from './signin'
import { useCompose } from './compose'
import { chatPanelsMessageDeleted, chatPanelsMessageUpdated, chatPanelsUnpinned, resetChatPanels } from './chatPanels'
import { resetSounds } from './sounds'

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

/** Which top-level screen the app shows. `boot` = reading saved settings. */
export type AppView = 'boot' | 'onboarding' | 'main'

export interface ChannelMessages {
  items: Message[]
  loaded: boolean
  hasMore: boolean
  /** A history request (initial or older) is in flight. */
  loading: boolean
}

export interface JoinParams {
  serverUrl: string
  name: string
  color: string
  password?: string
}

export interface AppState {
  connection: ConnectionStatus
  connectionError: string | null
  serverName: string
  me: User | null
  users: Record<string, User>
  online: Record<string, true>
  channels: Channel[]
  /** Voice presence for everyone, from the server (`voice:states`). */
  voice: VoiceState[]
  messages: Record<string, ChannelMessages>
  /** channelId -> userId -> expiry timestamp (ms) */
  typing: Record<string, Record<string, number>>
  /** Channel shown in the center pane (text or voice). */
  selectedChannelId: string | null
  selectChannel(id: string | null): void

  // ---- session / shell ----
  view: AppView
  /** Server URL of the current (or last attempted) connection. */
  serverUrl: string | null
  /** Shown above the onboarding form (e.g. "this device is no longer recognized"). */
  onboardingNotice: string | null
  /**
   * Read saved settings and auto-connect when a saved login exists. Without one, asks the server's
   * /api/info (docs/SPEC-ACCOUNTS.md §1, §3) before showing onboarding.
   */
  init(): Promise<void>
  /** Onboarding: create a new identity on a server. */
  join(p: JoinParams): void
  /** Retry the saved-token connection after an error. */
  retry(): Promise<void>
  /** Leave the current connection (keeping the token) and go back to onboarding to pick another server. */
  changeServer(): void
  /** Forget this device's token for the current server, disconnect and show onboarding. */
  logout(): Promise<void>

  // ---- data actions ----
  loadHistory(channelId: string): Promise<void>
  loadOlder(channelId: string): Promise<void>
  /**
   * `attachmentIds`: uploaded images (net/attachments.ts), in display order. Text may be empty when there are some.
   * `replyToId`: the message (same channel) this one replies to.
   */
  sendMessage(channelId: string, content: string, attachmentIds?: string[], replyToId?: string): Promise<Message>
  deleteMessage(messageId: string): Promise<void>
  /** Author only. `content` is wire content (`<@id>` mentions); may be empty only when the message has images. */
  editMessage(messageId: string, content: string): Promise<Message>
  /** Add your `emoji` reaction to a message, or remove it when you already reacted with it. Optimistic. */
  toggleReaction(messageId: string, emoji: string): Promise<void>
  /** Pin or unpin a message; the `message:updated` broadcast brings the new `pinned`. */
  pinMessage(messageId: string, pinned: boolean): Promise<void>
  createChannel(name: string, type: ChannelType): Promise<Channel>
  renameChannel(channelId: string, name: string): Promise<Channel>
  deleteChannel(channelId: string): Promise<void>
  updateColor(color: string): Promise<User>
  /** Drop expired typing entries. */
  pruneTyping(): void
}

/** Session-scoped fields reset on logout / server change. */
export const emptySession = () => ({
  connection: 'idle' as ConnectionStatus,
  connectionError: null,
  serverName: 'Nexo',
  me: null,
  users: {},
  online: {},
  channels: [],
  voice: [],
  messages: {},
  typing: {},
  selectedChannelId: null,
})

export const sortChannels = (list: Channel[]) =>
  [...list].sort((a, b) => (a.type === b.type ? a.position - b.position : a.type === 'text' ? -1 : 1))

/** Merge two oldest-first message lists, dedupe by id. */
export function mergeMessages(a: Message[], b: Message[]): Message[] {
  const byId = new Map<string, Message>()
  for (const m of a) byId.set(m.id, m)
  for (const m of b) byId.set(m.id, m)
  return [...byId.values()].sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1))
}

const inflightHistory = new Map<string, Promise<void>>()

/** Older servers send messages without reactions. */
export const NO_REACTIONS: Reaction[] = []

/** The loaded message `messageId` and its channel, or null. */
export function findMessage(messages: Record<string, ChannelMessages>, messageId: string): { channelId: string; msg: Message } | null {
  for (const [channelId, cm] of Object.entries(messages)) {
    const msg = cm.items.find((m) => m.id === messageId)
    if (msg) return { channelId, msg }
  }
  return null
}

/** `messages` with message `messageId` of `channelId` replaced by `fn(msg)` (same object when it isn't loaded). */
export function mapMessage(
  messages: Record<string, ChannelMessages>,
  channelId: string,
  messageId: string,
  fn: (m: Message) => Message,
): Record<string, ChannelMessages> {
  const cm = messages[channelId]
  const i = cm ? cm.items.findIndex((m) => m.id === messageId) : -1
  if (!cm || i < 0) return messages
  const items = cm.items.slice()
  items[i] = fn(items[i])
  return { ...messages, [channelId]: { ...cm, items } }
}

/** `reactions` with `userId` added to (`on`) or removed from `emoji`; empty reactions are dropped. */
export function applyReaction(reactions: Reaction[], emoji: string, userId: string, on: boolean): Reaction[] {
  const i = reactions.findIndex((r) => r.emoji === emoji)
  if (on) {
    if (i < 0) return [...reactions, { emoji, userIds: [userId] }]
    if (reactions[i].userIds.includes(userId)) return reactions
    return reactions.map((r, j) => (j === i ? { ...r, userIds: [...r.userIds, userId] } : r))
  }
  if (i < 0 || !reactions[i].userIds.includes(userId)) return reactions
  return reactions
    .map((r, j) => (j === i ? { ...r, userIds: r.userIds.filter((u) => u !== userId) } : r))
    .filter((r) => r.userIds.length > 0)
}

/** A message was deleted: close its inline editor (the composer handles its own reply bar). */
export function forgetDeletedMessage(messageId: string): void {
  if (useCompose.getState().editingId === messageId) useCompose.getState().setEditing(null)
}

export const useApp = create<AppState>()((set, get) => {
  const patchChannel = (channelId: string, patch: Partial<ChannelMessages>) =>
    set((s) => {
      const cur = s.messages[channelId] ?? { items: [], loaded: false, hasMore: true, loading: false }
      return { messages: { ...s.messages, [channelId]: { ...cur, ...patch } } }
    })

  async function leaveVoiceQuietly() {
    try {
      // Dynamic import: avoids a static store <-> voice import cycle at module-evaluation time.
      const { useVoice } = await import('../voice/session')
      if (useVoice.getState().channelId) await useVoice.getState().leave()
    } catch (err) {
      console.warn('[nexo] voice leave failed', err)
    }
  }

  return {
    ...emptySession(),
    view: 'boot',
    serverUrl: null,
    onboardingNotice: null,

    selectChannel: (id) => {
      set({ selectedChannelId: id })
      const url = get().serverUrl
      if (url && id) settings.setLastChannel(url, id)
    },

    // ---------- session ----------

    init: async () => {
      const saved = settings.getServerUrl()
      const url = saved ? normalizeServerUrl(saved) : null
      const found = url ? await findLogin(url) : null
      if (url && found?.token) {
        set({ view: 'main', serverUrl: url })
        connect(url, { token: found.token })
      } else {
        set({ view: 'onboarding', serverUrl: url, onboardingNotice: found?.unreadable ? NOTICE_UNREADABLE : null })
      }
    },

    join: ({ serverUrl, name, color, password }) => {
      const url = normalizeServerUrl(serverUrl)
      set({ onboardingNotice: null })
      connect(url, password ? { name, color, password } : { name, color })
    },

    retry: async () => {
      const url = get().serverUrl
      const token = url ? await settings.getToken(url) : null
      if (!url || !token) {
        set({ ...emptySession(), view: 'onboarding' })
        return
      }
      connect(url, { token })
    },

    changeServer: () => {
      void leaveVoiceQuietly()
      disconnect()
      resetUnread()
      resetSignIn()
      resetChatPanels()
      resetSounds()
      set({ ...emptySession(), view: 'onboarding', onboardingNotice: null })
    },

    logout: async () => {
      const url = get().serverUrl
      await leaveVoiceQuietly()
      disconnect()
      if (url) {
        await settings.setToken(url, null)
        settings.setLastChannel(url, null)
      }
      resetUnread()
      resetSignIn()
      resetChatPanels()
      resetSounds()
      set({ ...emptySession(), view: 'onboarding', onboardingNotice: null })
    },

    // ---------- messages ----------

    loadHistory: (channelId) => {
      const cur = get().messages[channelId]
      if (cur?.loaded) return Promise.resolve()
      const existing = inflightHistory.get(channelId)
      if (existing) return existing
      patchChannel(channelId, { loading: true })
      const p = request('message:history', { channelId })
        .then((page) => {
          const prev = get().messages[channelId]
          patchChannel(channelId, {
            // Messages may have arrived via `message:new` while loading — merge.
            items: mergeMessages(page, prev?.items ?? []),
            loaded: true,
            hasMore: page.length >= MESSAGE_PAGE_SIZE,
            loading: false,
          })
        })
        .catch((err) => {
          patchChannel(channelId, { loading: false })
          throw err
        })
        .finally(() => inflightHistory.delete(channelId))
      inflightHistory.set(channelId, p)
      return p
    },

    loadOlder: async (channelId) => {
      const cur = get().messages[channelId]
      if (!cur?.loaded || !cur.hasMore || cur.loading) return
      const oldest = cur.items[0]
      if (!oldest) {
        patchChannel(channelId, { hasMore: false })
        return
      }
      patchChannel(channelId, { loading: true })
      try {
        const page = await request('message:history', { channelId, before: oldest.createdAt })
        const now = get().messages[channelId]
        patchChannel(channelId, {
          items: mergeMessages(page, now?.items ?? []),
          hasMore: page.length >= MESSAGE_PAGE_SIZE,
          loading: false,
        })
      } catch (err) {
        patchChannel(channelId, { loading: false })
        throw err
      }
    },

    sendMessage: async (channelId, content, attachmentIds = [], replyToId) => {
      const text = content.trim()
      if (!text && attachmentIds.length === 0) throw new Error('Message is empty')
      if (text.length > MAX_MESSAGE_LENGTH) throw new Error(`Messages are limited to ${MAX_MESSAGE_LENGTH} characters`)
      // Optional fields are only sent when used, so plain messages look exactly like before to older servers.
      const msg = await request('message:send', {
        channelId,
        content: text,
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(replyToId ? { replyToId } : {}),
      })
      // The broadcast `message:new` normally lands first; insert anyway (deduped) in case it didn't.
      const cur = get().messages[channelId]
      if (cur?.loaded) patchChannel(channelId, { items: mergeMessages(cur.items, [msg]) })
      return msg
    },

    deleteMessage: async (messageId) => {
      await request('message:delete', { messageId })
      set((s) => {
        const messages = { ...s.messages }
        for (const [cid, cm] of Object.entries(messages)) {
          if (cm.items.some((m) => m.id === messageId))
            messages[cid] = { ...cm, items: cm.items.filter((m) => m.id !== messageId) }
        }
        return { messages }
      })
      forgetDeletedMessage(messageId)
      chatPanelsMessageDeleted(messageId)
    },

    editMessage: async (messageId, content) => {
      const text = content.trim()
      const found = findMessage(get().messages, messageId)
      if (!text && found && !found.msg.attachments?.length) throw new Error('Message is empty')
      if (text.length > MAX_MESSAGE_LENGTH) throw new Error(`Messages are limited to ${MAX_MESSAGE_LENGTH} characters`)
      const msg = await request('message:edit', { messageId, content: text })
      // Same as the `message:updated` broadcast (which may have landed first): replace in place.
      set((s) => ({ messages: mapMessage(s.messages, msg.channelId, msg.id, () => msg) }))
      return msg
    },

    toggleReaction: async (messageId, emoji) => {
      const meId = get().me?.id
      const found = findMessage(get().messages, messageId)
      if (!meId || !found) return
      const reactions = found.msg.reactions ?? NO_REACTIONS
      const existing = reactions.find((r) => r.emoji === emoji)
      const on = !existing?.userIds.includes(meId)
      if (on && !existing && reactions.length >= MAX_REACTIONS_PER_MESSAGE)
        throw new Error(`Messages can have at most ${MAX_REACTIONS_PER_MESSAGE} different reactions`)
      // Optimistic; the `message:reactions` broadcast replaces the list with the server's.
      const apply = (value: boolean) =>
        set((s) => ({
          messages: mapMessage(s.messages, found.channelId, messageId, (m) => ({
            ...m,
            reactions: applyReaction(m.reactions ?? NO_REACTIONS, emoji, meId, value),
          })),
        }))
      apply(on)
      try {
        await request('message:react', { messageId, emoji, on })
      } catch (err) {
        apply(!on)
        throw err
      }
    },

    pinMessage: async (messageId, pinned) => {
      await request('message:pin', { messageId, pinned })
      // The `message:updated` broadcast normally lands first; apply anyway (it carries the server's values).
      const meId = get().me?.id
      const found = findMessage(get().messages, messageId)
      if (found && meId && !!found.msg.pinned !== pinned) {
        const msg: Message = { ...found.msg, pinned: pinned ? { by: meId, at: Date.now() } : null }
        set((s) => ({ messages: mapMessage(s.messages, found.channelId, messageId, () => msg) }))
        chatPanelsMessageUpdated(msg)
      } else if (!pinned) {
        chatPanelsUnpinned(messageId)
      }
    },

    // ---------- channels ----------

    createChannel: async (name, type) => {
      const channel = await request('channel:create', { name, type })
      set((s) => ({ channels: sortChannels([...s.channels.filter((c) => c.id !== channel.id), channel]) }))
      return channel
    },

    renameChannel: async (channelId, name) => {
      const channel = await request('channel:rename', { channelId, name })
      set((s) => ({ channels: sortChannels(s.channels.map((c) => (c.id === channel.id ? channel : c))) }))
      return channel
    },

    deleteChannel: async (channelId) => {
      await request('channel:delete', { channelId })
      // The `channel:deleted` broadcast does the cleanup (and re-selection).
    },

    // ---------- profile ----------

    updateColor: async (color) => {
      const user = await request('profile:update', { color })
      set((s) => ({ me: s.me?.id === user.id ? user : s.me, users: { ...s.users, [user.id]: user } }))
      return user
    },

    pruneTyping: () => {
      const now = Date.now()
      const typing = get().typing
      let changed = false
      const next: AppState['typing'] = {}
      for (const [cid, users] of Object.entries(typing)) {
        const keep: Record<string, number> = {}
        for (const [uid, exp] of Object.entries(users)) {
          if (exp > now) keep[uid] = exp
          else changed = true
        }
        if (Object.keys(keep).length) next[cid] = keep
        else if (Object.keys(users).length) changed = true
      }
      if (changed) set({ typing: next })
    },
  }
})

/** Pick a sensible channel to show: saved last channel, else first text channel. */
export function defaultChannelId(channels: Channel[], preferred: string | null): string | null {
  if (preferred && channels.some((c) => c.id === preferred)) return preferred
  return channels.find((c) => c.type === 'text')?.id ?? channels[0]?.id ?? null
}
