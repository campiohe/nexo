// CONTRACT (owner: workstream C — renderer core & chat). Extended freely; the original fields/actions are kept.
import { create } from 'zustand'
import type { Channel, ChannelType, Message, User, VoiceState } from '@shared/protocol'
import { MAX_MESSAGE_LENGTH, MESSAGE_PAGE_SIZE } from '@shared/protocol'
import { connect, disconnect, request } from '../net/socket'
import { normalizeServerUrl } from '../lib/url'
import { settings } from './settings'

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
  /** Read saved settings and auto-connect when a token exists. */
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
  /** `attachmentIds`: uploaded images (net/attachments.ts), in display order. Text may be empty when there are some. */
  sendMessage(channelId: string, content: string, attachmentIds?: string[]): Promise<Message>
  deleteMessage(messageId: string): Promise<void>
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
      const token = url ? await settings.getToken(url) : null
      if (url && token) {
        set({ view: 'main', serverUrl: url })
        connect(url, { token })
      } else {
        set({ view: 'onboarding', serverUrl: url })
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

    sendMessage: async (channelId, content, attachmentIds = []) => {
      const text = content.trim()
      if (!text && attachmentIds.length === 0) throw new Error('Message is empty')
      if (text.length > MAX_MESSAGE_LENGTH) throw new Error(`Messages are limited to ${MAX_MESSAGE_LENGTH} characters`)
      // attachmentIds is only sent when used, so text-only messages look exactly like before to older servers.
      const msg = await request('message:send', attachmentIds.length ? { channelId, content: text, attachmentIds } : { channelId, content: text })
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
