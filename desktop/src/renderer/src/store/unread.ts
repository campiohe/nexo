// Unread text channels. The server says when someone else last wrote in each channel (bootstrap
// `lastMessageAt`, then live `message:new`); how far you have read is kept per server and identity in
// localStorage. Every timestamp is a server message `createdAt`, so the client's clock never matters.
//
// Mentions ride on the same read marks: `mentionAt` is the newest message that mentions you per channel
// (bootstrap `lastMentionAt`, then live `message:new`), unread while it's newer than the read mark.
import { create } from 'zustand'
import type { Message } from '@shared/protocol'
import { mentionsUser } from '../lib/mentions'

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
  /** channelId -> createdAt of the newest message by someone else that mentions you. */
  mentionAt: Record<string, number>
  /**
   * channelId -> unread mentions counted so far. Only channels with an unread mention have an entry.
   * `exact: false` when some of them are only known from a bootstrap (`lastMentionAt` says "at least one"),
   * so the real number may be higher than `count`.
   */
  mentionCount: Record<string, { count: number; exact: boolean }>
}

interface Persisted {
  since: number
  read: Record<string, number>
}

const KEY_PREFIX = 'nexo:read:' // + serverUrl + ':' + userId

let storageKey: string | null = null

export const useUnread = create<UnreadState>()(() => ({ latest: {}, read: {}, since: 0, mentionAt: {}, mentionCount: {} }))

const readMark = (s: Pick<UnreadState, 'read' | 'since'>, channelId: string): number => s.read[channelId] ?? s.since

export function isUnread(s: UnreadState, channelId: string): boolean {
  const latest = s.latest[channelId]
  return latest !== undefined && latest > readMark(s, channelId)
}

export function hasUnreadMention(s: UnreadState, channelId: string): boolean {
  const at = s.mentionAt[channelId]
  return at !== undefined && at > readMark(s, channelId)
}

/** Unread mentions in a channel: 0 when none, else the count (a lower bound when `exact` is false). */
export function unreadMentions(s: UnreadState, channelId: string): { count: number; exact: boolean } {
  if (!hasUnreadMention(s, channelId)) return { count: 0, exact: true }
  return s.mentionCount[channelId] ?? { count: 1, exact: false }
}

/** Badge text for a channel's unread mentions: "3", or "@" / "2+" when only a lower bound is known. */
export function mentionBadgeLabel(m: { count: number; exact: boolean }): string {
  if (m.exact) return m.count > 99 ? '99+' : String(m.count)
  return m.count <= 1 ? '@' : `${Math.min(m.count, 99)}+`
}

/** Unread mentions over every channel (a lower bound when `exact` is false). */
export function totalUnreadMentions(s: UnreadState): { count: number; exact: boolean } {
  let count = 0
  let exact = true
  for (const id of Object.keys(s.mentionAt)) {
    const m = unreadMentions(s, id)
    count += m.count
    exact &&= m.exact
  }
  return { count, exact }
}

/** Whether any channel has unread messages. */
export function anyUnread(s: UnreadState): boolean {
  return Object.keys(s.latest).some((id) => isUnread(s, id))
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
  lastMentionAt?: Record<string, number>,
): void {
  const key = KEY_PREFIX + serverUrl + ':' + userId
  const sameSession = key === storageKey
  storageKey = key
  const live = new Set(channelIds)
  const prev = useUnread.getState()
  const pick = (source: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const [id, t] of Object.entries(source)) if (live.has(id) && typeof t === 'number' && Number.isFinite(t)) out[id] = t
    return out
  }
  const latest = pick(lastMessageAt ?? (sameSession ? prev.latest : {}))
  // Mentions learned live before a reconnect stay; the bootstrap may add newer ones (missed while offline).
  const mentionAt = pick(sameSession ? prev.mentionAt : {})
  const fromServer = pick(lastMentionAt ?? {})
  const mentionCount: Record<string, { count: number; exact: boolean }> = {}
  if (sameSession) for (const [id, c] of Object.entries(prev.mentionCount)) if (live.has(id)) mentionCount[id] = c
  for (const [id, t] of Object.entries(fromServer)) {
    if (t <= (mentionAt[id] ?? 0)) continue
    // At least one mention we didn't see live.
    const known = mentionCount[id]
    mentionCount[id] = { count: (known?.count ?? 0) + 1, exact: false }
    mentionAt[id] = t
  }

  const saved = load(key)
  if (saved) {
    const read: Record<string, number> = {}
    for (const [id, t] of Object.entries(saved.read)) if (live.has(id)) read[id] = t
    useUnread.setState({ latest, read, since: saved.since, mentionAt, mentionCount })
  } else {
    useUnread.setState({ latest, read: {}, since: Math.max(0, ...Object.values(latest)), mentionAt, mentionCount })
  }
  pruneMentions()
  persist()
}

/** Drops mention counts of channels whose mentions are all read. */
function pruneMentions(): void {
  const s = useUnread.getState()
  let changed = false
  const mentionCount = { ...s.mentionCount }
  for (const id of Object.keys(mentionCount)) {
    if (!hasUnreadMention(s, id)) {
      delete mentionCount[id]
      changed = true
    }
  }
  if (changed) useUnread.setState({ mentionCount })
}

/** A message arrived (`message:new`). Writing in a channel means you've read it up to there. */
export function noteMessage(m: Message, meId: string | undefined): void {
  if (m.userId === meId) {
    markRead(m.channelId, m.createdAt)
    return
  }
  const mentioned = mentionsUser(m, meId)
  useUnread.setState((s) => {
    const patch: Partial<UnreadState> = {}
    if ((s.latest[m.channelId] ?? 0) < m.createdAt) patch.latest = { ...s.latest, [m.channelId]: m.createdAt }
    if (mentioned && m.createdAt > readMark(s, m.channelId)) {
      const known = unreadMentions(s, m.channelId)
      patch.mentionCount = { ...s.mentionCount, [m.channelId]: { count: known.count + 1, exact: known.exact } }
      if ((s.mentionAt[m.channelId] ?? 0) < m.createdAt) patch.mentionAt = { ...s.mentionAt, [m.channelId]: m.createdAt }
    }
    return patch
  })
}

/**
 * A message was deleted. When it was the newest one by someone else, fall back to the newest such
 * message still loaded (`remaining`), so a quickly deleted message doesn't leave the channel unread.
 * Without loaded history there is nothing to fall back to and the mark stays.
 */
export function noteDeleted(channelId: string, deleted: Message, remaining: Message[], meId: string | undefined): void {
  if (deleted.userId === meId) return
  noteDeletedMention(channelId, deleted, remaining, meId)
  const s = useUnread.getState()
  if (s.latest[channelId] !== deleted.createdAt) return
  let newest = 0
  for (const m of remaining) if (m.userId !== meId && m.createdAt > newest) newest = m.createdAt
  const latest = { ...s.latest }
  if (newest > 0) latest[channelId] = newest
  else delete latest[channelId]
  useUnread.setState({ latest })
}

/**
 * An unread message that mentioned you was deleted: one mention less. When it was the newest mention, fall
 * back to the newest unread mention still loaded; without one (or with only a lower bound from the
 * bootstrap) the mark stays, so the badge may linger until the channel is read.
 */
function noteDeletedMention(channelId: string, deleted: Message, remaining: Message[], meId: string | undefined): void {
  const s = useUnread.getState()
  if (!mentionsUser(deleted, meId) || deleted.createdAt <= readMark(s, channelId) || !hasUnreadMention(s, channelId)) return
  const known = s.mentionCount[channelId]
  if (!known?.exact) return
  const count = known.count - 1
  const mentionCount = { ...s.mentionCount }
  const mentionAt = { ...s.mentionAt }
  if (count <= 0) {
    delete mentionCount[channelId]
    delete mentionAt[channelId]
  } else {
    mentionCount[channelId] = { count, exact: true }
    if (mentionAt[channelId] === deleted.createdAt) {
      let newest = 0
      for (const m of remaining) if (mentionsUser(m, meId) && m.createdAt > newest) newest = m.createdAt
      if (newest > readMark(s, channelId)) mentionAt[channelId] = newest
    }
  }
  useUnread.setState({ mentionCount, mentionAt })
}

/** Mark a channel read up to `upTo` (default: everything known in it). */
export function markRead(channelId: string, upTo?: number): void {
  const s = useUnread.getState()
  const current = s.read[channelId] ?? s.since
  const target = Math.max(current, upTo ?? s.latest[channelId] ?? 0)
  if (target === current && channelId in s.read) return
  const patch: Partial<UnreadState> = { read: { ...s.read, [channelId]: target } }
  if (channelId in s.mentionCount && (s.mentionAt[channelId] ?? 0) <= target) {
    const { [channelId]: _read, ...rest } = s.mentionCount
    patch.mentionCount = rest
  }
  useUnread.setState(patch)
  persist()
}

export function forgetChannel(channelId: string): void {
  useUnread.setState((s) => {
    const latest = { ...s.latest }
    const read = { ...s.read }
    const mentionAt = { ...s.mentionAt }
    const mentionCount = { ...s.mentionCount }
    delete latest[channelId]
    delete read[channelId]
    delete mentionAt[channelId]
    delete mentionCount[channelId]
    return { latest, read, mentionAt, mentionCount }
  })
  persist()
}

/** Logout / server change: drop the in-memory state (what was persisted stays for next time). */
export function resetUnread(): void {
  storageKey = null
  useUnread.setState({ latest: {}, read: {}, since: 0, mentionAt: {}, mentionCount: {} })
}
