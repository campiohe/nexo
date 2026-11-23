// Presence beyond online/offline (docs/SPEC.md): everyone's status (online / idle / do not disturb) and
// activity ("Playing X") from the server, plus this device's own presence inputs. Sending lives in
// lib/presenceSync.ts; net/socket.ts feeds the server events in here.
//
// Your own presence is shown from this device's state (instant, and works on servers without presence),
// everyone else's from the server (the aggregate over their devices). The server's aggregate for yourself
// lands in `byUser` too but is never shown nor adopted: a choice made here stays here (per device), and what
// others see is the combination (Do not disturb anywhere wins). Older servers send no presence at all:
// everyone is plain online then.
import { create } from 'zustand'
import type { Activity, Presence, PresenceStatus } from '@shared/protocol'
import { DEFAULT_PRESENCE } from '@shared/protocol'
import { useApp } from './app'
import { msg } from '../i18n'

const KEY_STATUS = 'nexo.presence.status'

function loadManual(): PresenceStatus {
  try {
    const v = localStorage.getItem(KEY_STATUS)
    return v === 'idle' || v === 'dnd' ? v : 'online'
  } catch {
    return 'online'
  }
}

interface PresenceState {
  /** userId -> presence from the server, for online users whose presence isn't DEFAULT_PRESENCE. */
  byUser: Record<string, Presence>
  /** The status you picked (persisted per device). */
  manual: PresenceStatus
  /** No input for 10 minutes (main process, powerMonitor). */
  systemIdle: boolean
  /** The game this device detects (only while "Share what I'm playing" is on). */
  activity: Activity | null
}

export const usePresenceStore = create<PresenceState>()(() => ({
  byUser: {},
  manual: loadManual(),
  systemIdle: false,
  activity: null,
}))

export function setManualStatus(status: PresenceStatus): void {
  usePresenceStore.setState({ manual: status })
  try {
    localStorage.setItem(KEY_STATUS, status)
  } catch {
    /* storage unavailable: keep it for this session */
  }
}

const isDefault = (p: Presence) => p.status === 'online' && !p.activity

/** Bootstrap: the server's full list (older servers omit it: nobody has a presence then). */
export function setBootstrapPresence(map: Record<string, Presence> | undefined): void {
  const byUser: Record<string, Presence> = {}
  for (const [id, p] of Object.entries(map ?? {})) if (p && !isDefault(p)) byUser[id] = p
  usePresenceStore.setState({ byUser })
}

/** `presence:changed`. */
export function applyPresenceChanged(userId: string, presence: Presence): void {
  usePresenceStore.setState((s) => {
    const { [userId]: _old, ...rest } = s.byUser
    return { byUser: isDefault(presence) ? rest : { ...rest, [userId]: presence } }
  })
}

/** `presence` (who is online): offline users have no status or activity. */
export function pruneOffline(online: readonly string[]): void {
  const ids = new Set(online)
  const { byUser } = usePresenceStore.getState()
  if (Object.keys(byUser).every((id) => ids.has(id))) return
  const next: Record<string, Presence> = {}
  for (const [id, p] of Object.entries(byUser)) if (ids.has(id)) next[id] = p
  usePresenceStore.setState({ byUser: next })
}

/** Logout / server change. */
export function resetPresence(): void {
  usePresenceStore.setState({ byUser: {} })
}

/**
 * The status this device asserts: Do Not Disturb always wins, then a manual Idle, then auto-idle (which
 * presenceSync suppresses while you talk in voice or play a detected game, see `autoIdle`).
 */
export function effectiveStatus(manual: PresenceStatus, autoIdle: boolean): PresenceStatus {
  if (manual === 'dnd') return 'dnd'
  if (manual === 'idle' || autoIdle) return 'idle'
  return 'online'
}

/** Set by lib/presenceSync.ts: system idle and not talking in voice / playing. */
export const useAutoIdle = create<{ autoIdle: boolean }>()(() => ({ autoIdle: false }))

/** Your own status as you see it. */
export function ownStatus(): PresenceStatus {
  return effectiveStatus(usePresenceStore.getState().manual, useAutoIdle.getState().autoIdle)
}

/** Do Not Disturb: no notification popups, sounds or taskbar flashes (lib/notify.ts). */
export function isDnd(): boolean {
  return usePresenceStore.getState().manual === 'dnd'
}

export function useOwnStatus(): PresenceStatus {
  const manual = usePresenceStore((s) => s.manual)
  const autoIdle = useAutoIdle((s) => s.autoIdle)
  return effectiveStatus(manual, autoIdle)
}

/**
 * A user's presence: null when offline; DEFAULT_PRESENCE when online without one. Yourself: this device's
 * status and activity.
 */
export function usePresence(userId: string | undefined | null): Presence | null {
  const meId = useApp((s) => s.me?.id)
  const online = useApp((s) => !!userId && !!s.online[userId])
  const connected = useApp((s) => s.connection === 'connected')
  const isMe = !!userId && userId === meId
  const other = usePresenceStore((s) => (userId && !isMe ? s.byUser[userId] : undefined))
  const ownActivity = usePresenceStore((s) => s.activity)
  const own = useOwnStatus()
  if (!userId) return null
  if (isMe) {
    if (!connected) return null
    // Stable object per (status, activity) so memoized children don't re-render on unrelated changes.
    return ownPresence(own, ownActivity)
  }
  if (!online) return null
  return other ?? DEFAULT_PRESENCE
}

let ownCache: Presence = DEFAULT_PRESENCE
function ownPresence(status: PresenceStatus, activity: Activity | null): Presence {
  if (ownCache.status !== status || ownCache.activity !== activity) ownCache = { status, activity }
  return ownCache
}

/** Message keys (msg): show them with t(STATUS_LABEL[status]). */
export const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: msg('Online'),
  idle: msg('Idle'),
  dnd: msg('Do not disturb'),
}
