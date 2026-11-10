// Unread text channels. The server says when someone else last wrote in each channel (bootstrap
// `lastMessageAt`, then live `message:new`); how far you have read is kept per server and identity in
// localStorage. Every timestamp is a server message `createdAt`, so the client's clock never matters.
import { create } from 'zustand'
import type { Message } from '@shared/protocol'

export interface UnreadState {
  /** channelId -> createdAt of the newest message written by someone else. */
  latest: Record<string, number>
  /** channelId -> createdAt up to which the channel has been read. */
  read: Record<string, number>
  /**
   * Read mark for channels missing from `read`: the newest message this device knew about when it first
   * joined the server. So nothing shows as unread on first run, but a channel created later does.
   */
  since: number
}

interface Persisted {
  since: number
  read: Record<string, number>
}

const KEY_PREFIX = 'nexo:read:' // + serverUrl + ':' + userId

let storageKey: string | null = null

export const useUnread = create<UnreadState>()(() => ({ latest: {}, read: {}, since: 0 }))

export function isUnread(s: UnreadState, channelId: string): boolean {
  const latest = s.latest[channelId]
  return latest !== undefined && latest > (s.read[channelId] ?? s.since)
}

function load(key: string): Persisted | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Persisted>
    if (typeof parsed.since !== 'number' || !Number.isFinite(parsed.since)) return null
    const read: Record<string, number> = {}
    if (parsed.read && typeof parsed.read === 'object') {
      for (const [id, t] of Object.entries(parsed.read)) if (typeof t === 'number' && Number.isFinite(t)) read[id] = t
    }
    return { since: parsed.since, read }
  } catch {
    return null
  }
}

function persist(): void {
  if (!storageKey) return
  const { since, read } = useUnread.getState()
  try {
    localStorage.setItem(storageKey, JSON.stringify({ since, read } satisfies Persisted))
  } catch {
    /* storage unavailable: keep in memory only */
  }
}

/**
 * On every bootstrap. `lastMessageAt` is undefined on older servers: then only messages that arrive
 * live can mark a channel unread (and what was learned before a reconnect is kept).
 */
export function loadReadState(
  serverUrl: string,
  userId: string,
  lastMessageAt: Record<string, number> | undefined,
  channelIds: string[],
): void {
  const key = KEY_PREFIX + serverUrl + ':' + userId
  const sameSession = key === storageKey
  storageKey = key
  const live = new Set(channelIds)
  const latest: Record<string, number> = {}
  const source = lastMessageAt ?? (sameSession ? useUnread.getState().latest : {})
  for (const [id, t] of Object.entries(source)) if (live.has(id) && typeof t === 'number') latest[id] = t

  const saved = load(key)
  if (saved) {
    const read: Record<string, number> = {}
    for (const [id, t] of Object.entries(saved.read)) if (live.has(id)) read[id] = t
    useUnread.setState({ latest, read, since: saved.since })
  } else {
    useUnread.setState({ latest, read: {}, since: Math.max(0, ...Object.values(latest)) })
  }
  persist()
}

/** A message arrived (`message:new`). Writing in a channel means you've read it up to there. */
export function noteMessage(m: Message, meId: string | undefined): void {
  if (m.userId === meId) {
    markRead(m.channelId, m.createdAt)
    return
  }
  useUnread.setState((s) => {
    if ((s.latest[m.channelId] ?? 0) >= m.createdAt) return {}
    return { latest: { ...s.latest, [m.channelId]: m.createdAt } }
  })
}

/**
 * A message was deleted. When it was the newest one by someone else, fall back to the newest such
 * message still loaded (`remaining`), so a quickly deleted message doesn't leave the channel unread.
 * Without loaded history there is nothing to fall back to and the mark stays.
 */
export function noteDeleted(channelId: string, deleted: Message, remaining: Message[], meId: string | undefined): void {
  const s = useUnread.getState()
  if (deleted.userId === meId || s.latest[channelId] !== deleted.createdAt) return
  let newest = 0
  for (const m of remaining) if (m.userId !== meId && m.createdAt > newest) newest = m.createdAt
  const latest = { ...s.latest }
  if (newest > 0) latest[channelId] = newest
  else delete latest[channelId]
  useUnread.setState({ latest })
}

/** Mark a channel read up to `upTo` (default: everything known in it). */
export function markRead(channelId: string, upTo?: number): void {
  const s = useUnread.getState()
  const current = s.read[channelId] ?? s.since
  const target = Math.max(current, upTo ?? s.latest[channelId] ?? 0)
  if (target === current && channelId in s.read) return
  useUnread.setState({ read: { ...s.read, [channelId]: target } })
  persist()
}

export function forgetChannel(channelId: string): void {
  useUnread.setState((s) => {
    const latest = { ...s.latest }
    const read = { ...s.read }
    delete latest[channelId]
    delete read[channelId]
    return { latest, read }
  })
  persist()
}

/** Logout / server change: drop the in-memory state (what was persisted stays for next time). */
export function resetUnread(): void {
  storageKey = null
  useUnread.setState({ latest: {}, read: {}, since: 0 })
}
