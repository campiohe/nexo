// Sends this device's presence (`presence:update`) and keeps its inputs up to date: the status you picked,
// auto-idle and the detected game from the main process (window.nexo.presence), and voice state.
// Imported once for its side effects by App.tsx (after voice/session exists, which this module needs).
//
// - The server keeps presence per connection and shows others the aggregate over your devices (dnd > online
//   > idle; the most recently started activity), so this device only ever reports its OWN state: the
//   status picked here (persisted per device), auto-idle, and the game detected here. It never adopts the
//   aggregate (`presence:changed` / bootstrap for yourself) as its own choice.
// - Only changes are sent (the server rate-limits per socket and applies excess updates late, never drops
//   them); after every (re)connect the full state is sent again (a new connection starts as plain online).
// - Auto-idle: system idle for 10 minutes, unless you're talking in voice (unmuted) or a detected game is
//   running (controller input doesn't count as input for the OS). Never overrides Do Not Disturb.
// - Older servers ignore `presence:update` (and send no presence): everything just stays local.
import type { Activity, PresenceStatus, User } from '@shared/protocol'
import { emit, isConnected, onConnected, request } from '../net/socket'
import { useApp } from '../store/app'
import { ownStatus, resetPresence, useAutoIdle, usePresenceStore } from '../store/presence'
import { t } from '../i18n'
import { useVoice } from '../voice/session'

/** What the server last got from this device (null = nothing yet). */
let sentStatus: PresenceStatus | null = null
let sentActivity: Activity | null = null

const sameActivity = (a: Activity | null, b: Activity | null) =>
  a === b || (!!a && !!b && a.name === b.name && a.startedAt === b.startedAt)

function talking(): boolean {
  const v = useVoice.getState()
  return !!v.channelId && (v.status === 'connected' || v.status === 'reconnecting') && !v.muted && !v.deafened
}

function refreshAutoIdle(): void {
  const s = usePresenceStore.getState()
  const autoIdle = s.systemIdle && !talking() && !s.activity
  if (useAutoIdle.getState().autoIdle !== autoIdle) useAutoIdle.setState({ autoIdle })
}

function send(full: boolean): void {
  if (!isConnected()) return
  const status = ownStatus()
  const activity = usePresenceStore.getState().activity
  const patch: { status?: PresenceStatus; activity?: Activity | null } = {}
  if (full || status !== sentStatus) patch.status = status
  if (full || !sameActivity(activity, sentActivity)) patch.activity = activity
  if (patch.status === undefined && patch.activity === undefined) return
  emit('presence:update', patch)
  sentStatus = status
  sentActivity = activity
}

/** Set (or with '' / null clear) your custom status text. Rejects with the server's error. */
export async function updateStatusText(text: string | null): Promise<User> {
  const value = text?.trim() ? text.trim() : null
  const user = await request('profile:update', { statusText: value })
  if (user.statusText === undefined) throw new Error(t("This server doesn't support custom status yet"))
  useApp.setState((s) => ({ me: s.me?.id === user.id ? user : s.me, users: { ...s.users, [user.id]: user } }))
  return user
}

/** The server keeps custom status text (it sends `statusText` on every user, null when none). */
export const supportsStatusText = (me: User | null | undefined): boolean => !!me && me.statusText !== undefined

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────────────────

const offs: (() => void)[] = []

const bridge = window.nexo?.presence
if (bridge && typeof bridge.getState === 'function') {
  bridge
    .getState()
    .then((s) => {
      usePresenceStore.setState({ systemIdle: s.idle, activity: s.activity ? { ...s.activity } : null })
    })
    .catch((err) => console.warn('[nexo] presence state unavailable', err))
  offs.push(bridge.onIdle((idle) => usePresenceStore.setState({ systemIdle: idle })))
  offs.push(bridge.onActivity((a) => usePresenceStore.setState({ activity: a ? { name: a.name, startedAt: a.startedAt } : null })))
}

offs.push(
  usePresenceStore.subscribe((s, prev) => {
    if (s.systemIdle !== prev.systemIdle || s.activity !== prev.activity) refreshAutoIdle()
    if (s.manual !== prev.manual || s.activity !== prev.activity) send(false)
  }),
)
offs.push(useAutoIdle.subscribe(() => send(false)))
offs.push(
  useVoice.subscribe((s, prev) => {
    if (s.channelId !== prev.channelId || s.status !== prev.status || s.muted !== prev.muted || s.deafened !== prev.deafened)
      refreshAutoIdle()
  }),
)
offs.push(onConnected(() => send(true)))
offs.push(
  useApp.subscribe((s, prev) => {
    // Logout / server change: forget everyone's presence and what the old server was told.
    if ((!s.me && prev.me) || s.serverUrl !== prev.serverUrl) {
      resetPresence()
      sentStatus = null
      sentActivity = null
    }
  }),
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const off of offs) off()
  })
}
