// Chat notifications: native notifications (shown by the main process, see main/notifications.ts), their
// sounds, flashing the taskbar on a mention, and the unread-mention badge on the taskbar / dock / tray.
//
// Preferences live in renderer localStorage (`nexo.notifications`), like the other per-device choices
// (sound effects, keybinds): every decision is made here, per message, from renderer state (which channel
// is on screen, whether the message mentions you), so main never needs them.
//
// Only live `message:new` events notify: a (re)connect's bootstrap and history refresh never do, so
// coming back online can't produce a burst (missed mentions still show as badges, from `lastMentionAt`).
import { create } from 'zustand'
import type { Message, User } from '@shared/protocol'
import { useApp } from '../store/app'
import { useUi } from '../store/ui'
import { isUnread, totalUnreadMentions, useUnread } from '../store/unread'
import { isDnd } from '../store/presence'
import { playVoiceSound } from '../voice/sounds'
import { avatarUrl } from './avatar'
import { initials, inkOn } from './colors'
import { contentToPlain, mentionsUser } from './mentions'
import { t } from '../i18n'

// ── Preferences ───────────────────────────────────────────────────────────────────────────────────────

export type NotifyLevel = 'all' | 'mentions' | 'off'

export interface NotifyPrefs {
  /** Which messages show a desktop notification (and play its sound). Default: only mentions. */
  desktop: NotifyLevel
  /** Play a sound with each notification. Default on (also needs Sound effects, Audio & video). */
  sound: boolean
  /** Flash the taskbar button when someone mentions you while Nexo isn't focused. Default on. */
  flash: boolean
}

const KEY = 'nexo.notifications'
const DEFAULTS: NotifyPrefs = { desktop: 'mentions', sound: true, flash: true }

function load(): NotifyPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const p = JSON.parse(raw) as Partial<NotifyPrefs>
    return {
      desktop: p.desktop === 'all' || p.desktop === 'off' ? p.desktop : 'mentions',
      sound: p.sound !== false,
      flash: p.flash !== false,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export const useNotifyPrefs = create<NotifyPrefs>()(() => load())

export function setNotifyPrefs(patch: Partial<NotifyPrefs>): void {
  useNotifyPrefs.setState(patch)
  try {
    localStorage.setItem(KEY, JSON.stringify(useNotifyPrefs.getState()))
  } catch {
    /* storage unavailable: keep in memory only */
  }
}

/** Native notifications need the Electron bridge (absent in a plain browser or an older preload). */
export const hasNativeNotifications = (): boolean => typeof window.nexo?.notifications?.show === 'function'

// ── Notifications ─────────────────────────────────────────────────────────────────────────────────────

/** A channel's notification is updated at most this often; messages in between are folded into it. */
const UPDATE_GAP_MS = 1500
/** The same sound isn't repeated within this window (a burst of messages plays once). */
const SOUND_GAP_MS: Record<'message' | 'mention', number> = { message: 2500, mention: 1000 }
const BODY_MAX = 120

interface Pending {
  /** Messages notified since the channel was last read... */
  count: number
  /** ...and how many of them mention you. */
  mentions: number
  latest: Message
  /** When this channel's notification was last shown (0 = not yet). */
  shownAt: number
  timer: number | undefined
}

/** Channels with a notification on screen (or about to be), until they're read. */
const pending = new Map<string, Pending>()
const lastSound: Record<'message' | 'mention', number> = { message: -Infinity, mention: -Infinity }

/** You're looking at Nexo: the window is focused and visible. */
const windowActive = (): boolean => document.visibilityState === 'visible' && document.hasFocus()

function playOnce(sound: 'message' | 'mention'): void {
  const now = performance.now()
  if (now - lastSound[sound] < SOUND_GAP_MS[sound]) return
  lastSound[sound] = now
  playVoiceSound(sound)
}

/** A live `message:new` (net/socket.ts). Decides on a notification, its sound and the taskbar flash. */
export function notifyMessage(m: Message): void {
  const st = useApp.getState()
  const me = st.me
  if (!me || m.userId === me.id || st.view !== 'main') return
  const channel = st.channels.find((c) => c.id === m.channelId)
  if (!channel) return
  // The channel on screen with the window focused: you're reading it, nothing to tell.
  if (st.selectedChannelId === m.channelId && windowActive()) return

  // Do Not Disturb: no popup, sound or taskbar flash (unread and mention badges still update elsewhere).
  // Wake-ups (voice/voiceActions.ts) don't come through here and still ring.
  if (isDnd()) return

  const mentioned = mentionsUser(m, me.id)
  const prefs = useNotifyPrefs.getState()
  if (mentioned && prefs.flash && !document.hasFocus()) window.nexo?.requestAttention?.()
  if (prefs.desktop === 'off' || (prefs.desktop === 'mentions' && !mentioned)) return

  if (prefs.sound) playOnce(mentioned ? 'mention' : 'message')
  if (!hasNativeNotifications()) return

  const p = pending.get(m.channelId) ?? { count: 0, mentions: 0, latest: m, shownAt: 0, timer: undefined }
  p.count++
  if (mentioned) p.mentions++
  p.latest = m
  pending.set(m.channelId, p)
  const wait = p.shownAt + UPDATE_GAP_MS - Date.now()
  if (wait <= 0) void showNow(m.channelId)
  else p.timer ??= window.setTimeout(() => void showNow(m.channelId), wait)
}

function messageText(m: Message, users: Record<string, User>): string {
  const text = contentToPlain(m.content, users).replace(/\s+/g, ' ').trim()
  const images = m.attachments?.length ?? 0
  const imageTag = images === 0 ? '' : t('{count, plural, one {[image]} other {[# images]}}', { count: images })
  const full = [text, imageTag].filter(Boolean).join(' ')
  return full.length > BODY_MAX ? `${full.slice(0, BODY_MAX - 1).trimEnd()}…` : full
}

async function showNow(channelId: string): Promise<void> {
  const p = pending.get(channelId)
  if (!p) return
  window.clearTimeout(p.timer)
  p.timer = undefined
  p.shownAt = Date.now()
  const { users, channels } = useApp.getState()
  const channel = channels.find((c) => c.id === channelId)
  if (!channel) return
  const author = users[p.latest.userId]
  const name = author?.name ?? t('Someone')
  const text = messageText(p.latest, users)
  const { count, mentions } = p
  const icon = author ? await avatarIcon(author) : null
  // Read (or replaced by a newer show) while the icon was being drawn.
  if (pending.get(channelId) !== p || p.count !== count) return
  window.nexo.notifications.show({
    channelId,
    title:
      count === 1
        ? t('{name} in {channel}', { name, channel: `#${channel.name}` })
        : mentions === count
          ? t('{count, plural, one {# mention in {channel}} other {# mentions in {channel}}}', { count, channel: `#${channel.name}` })
          : t('{count, plural, one {# new message in {channel}} other {# new messages in {channel}}}', {
              count,
              channel: `#${channel.name}`,
            }),
    body: count === 1 ? text : `${name}: ${text}`,
    icon,
  })
}

/** Drop the notification of channels that are read now. */
function clearRead(): void {
  const s = useUnread.getState()
  for (const [id, p] of pending) {
    if (isUnread(s, id)) continue
    window.clearTimeout(p.timer)
    pending.delete(id)
    window.nexo?.notifications?.clear(id)
  }
}

// ── Avatar icons ──────────────────────────────────────────────────────────────────────────────────────

const ICON_PX = 96
const icons = new Map<string, Promise<string | null>>()

/** The author's picture (or their initials on their colour) as a round PNG data URL, cached per version. */
function avatarIcon(user: User): Promise<string | null> {
  const url = avatarUrl(useApp.getState().serverUrl, user)
  const key = `${user.id}|${url ?? ''}|${user.color}|${user.name}`
  let icon = icons.get(key)
  if (!icon) {
    icon = drawAvatar(user, url).catch(() => null)
    icons.set(key, icon)
    if (icons.size > 64) icons.delete(icons.keys().next().value!)
  }
  return icon
}

async function drawAvatar(user: User, url: string | null): Promise<string | null> {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = ICON_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.beginPath()
  ctx.arc(ICON_PX / 2, ICON_PX / 2, ICON_PX / 2, 0, Math.PI * 2)
  ctx.clip()
  let bitmap: ImageBitmap | null = null
  if (url) {
    try {
      // The server sends `access-control-allow-origin: *` for pictures, so the canvas isn't tainted.
      const res = await fetch(url)
      if (res.ok) bitmap = await createImageBitmap(await res.blob())
    } catch {
      bitmap = null
    }
  }
  if (bitmap) {
    const scale = Math.max(ICON_PX / bitmap.width, ICON_PX / bitmap.height)
    const w = bitmap.width * scale
    const h = bitmap.height * scale
    ctx.drawImage(bitmap, (ICON_PX - w) / 2, (ICON_PX - h) / 2, w, h)
    bitmap.close()
  } else {
    ctx.fillStyle = user.color
    ctx.fillRect(0, 0, ICON_PX, ICON_PX)
    ctx.fillStyle = inkOn(user.color)
    ctx.font = `700 ${Math.round(ICON_PX * 0.42)}px Inter, "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(initials(user.name), ICON_PX / 2, ICON_PX / 2 + 2)
  }
  return canvas.toDataURL('image/png')
}

// ── Taskbar / dock / tray badge ───────────────────────────────────────────────────────────────────────

let lastBadge = ''

/** The red count bubble for the Windows taskbar overlay (drawn at 32 px; Windows shows it at 16–32). */
function drawOverlay(label: string): string | null {
  const px = 32
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = px
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#f23f43'
  ctx.beginPath()
  ctx.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = `800 ${label.length > 1 ? 17 : 22}px Inter, "Segoe UI", system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, px / 2, px / 2 + 1)
  return canvas.toDataURL('image/png')
}

function syncBadge(): void {
  const bridge = window.nexo?.notifications
  if (typeof bridge?.setBadge !== 'function') return
  const { count, exact } = totalUnreadMentions(useUnread.getState())
  // From a bootstrap only "at least one" is known per channel: "@" then, like the channel badge.
  const label = count === 0 ? '' : !exact && count === 1 ? '@' : count > 9 ? '9+' : String(count)
  const key = `${count}|${label}|${t.language}`
  if (key === lastBadge) return
  lastBadge = key
  const description =
    count === 0
      ? ''
      : exact
        ? t('{count, plural, one {# unread mention} other {# unread mentions}}', { count })
        : t('{count, plural, one {At least # unread mention} other {At least # unread mentions}}', { count })
  bridge.setBadge({ mentions: count, overlay: count > 0 ? drawOverlay(label) : null, description })
}

// ── Wiring (module side effects; imported by net/socket.ts) ──────────────────────────────────────────

// Debounced: a mention in the channel on screen is marked read right after it arrives, so syncing at once
// would flash the tray dot and taskbar overlay on and off.
const BADGE_DEBOUNCE_MS = 250
let badgeTimer: number | undefined
const offUnread = useUnread.subscribe((s, prev) => {
  if (s.read !== prev.read || s.latest !== prev.latest || s.since !== prev.since) clearRead()
  window.clearTimeout(badgeTimer)
  badgeTimer = window.setTimeout(syncBadge, BADGE_DEBOUNCE_MS)
})

/** Clicking a notification: main focused the window; open the channel (above any open dialog). */
const offOpen = window.nexo?.notifications?.onOpen?.((channelId) => {
  const st = useApp.getState()
  if (!st.channels.some((c) => c.id === channelId && c.type === 'text')) return
  useUi.getState().openSettings(false)
  useUi.getState().openSwitcher(false)
  st.selectChannel(channelId)
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offUnread()
    window.clearTimeout(badgeTimer)
    offOpen?.()
    for (const p of pending.values()) window.clearTimeout(p.timer)
  })
}
