// Native chat notifications and the unread badge (taskbar overlay / dock count / tray dot).
// The renderer decides *whether* to notify (lib/notify.ts: its prefs, the channel on screen, mentions);
// main only shows what it's asked to. The renderer's web Notification permission stays denied
// (security.ts): everything goes through these IPC channels.
import { app, ipcMain, nativeImage, Notification, type BrowserWindow, type IpcMainEvent, type NativeImage } from 'electron'
import icon from '../../resources/icon.png?asset'
import { IPC, type ChatNotification, type UnreadBadge } from '../preload/api'
import { platform } from './platform'
import { isAppUrl } from './security'
import { setTrayMentions } from './tray'

interface NotificationDeps {
  getWindow(): BrowserWindow | null
  /** Show (even from the tray), restore and focus the main window. */
  showWindow(): void
}

const MAX_TITLE = 128
const MAX_BODY = 256
const MAX_ID = 128
/** Base64 of a ≤ 256 KB PNG. */
const MAX_DATA_URL = 360_000
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/

let deps: NotificationDeps | null = null
/** The notification on screen per channel. Holding the reference also keeps its click handler alive (GC). */
const shown = new Map<string, Notification>()
let appIcon: NativeImage | null = null

function clean(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function imageFromDataUrl(raw: unknown): NativeImage | null {
  if (typeof raw !== 'string' || raw.length > MAX_DATA_URL || !PNG_DATA_URL.test(raw)) return null
  const img = nativeImage.createFromDataURL(raw)
  return img.isEmpty() ? null : img
}

function parseNotification(raw: unknown): (Omit<ChatNotification, 'icon'> & { icon: NativeImage | null }) | null {
  if (typeof raw !== 'object' || raw === null) return null
  const n = raw as Record<string, unknown>
  if (typeof n.channelId !== 'string' || !n.channelId || n.channelId.length > MAX_ID) return null
  const title = clean(n.title, MAX_TITLE)
  const body = clean(n.body, MAX_BODY)
  if (!title || body === null) return null
  return { channelId: n.channelId, title, body, icon: imageFromDataUrl(n.icon) }
}

function close(channelId: string): void {
  const n = shown.get(channelId)
  if (!n) return
  shown.delete(channelId)
  n.close()
}

function show(req: NonNullable<ReturnType<typeof parseNotification>>): void {
  if (!Notification.isSupported()) return
  // One per channel: a newer message replaces the older notification (also in the Windows Action Center).
  close(req.channelId)
  appIcon ??= nativeImage.createFromPath(icon)
  const n = new Notification({
    title: req.title,
    body: req.body,
    icon: req.icon ?? appIcon,
    // The renderer plays its own sound (Settings → Notifications), so the OS one would double it.
    silent: true,
  })
  const forget = (): void => {
    if (shown.get(req.channelId) === n) shown.delete(req.channelId)
  }
  n.on('click', () => {
    forget()
    deps?.showWindow()
    const win = deps?.getWindow()
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IPC.notifyOpen, req.channelId)
  })
  // On Windows a toast that times out ('timedOut') stays in the Action Center: keep the reference so the next
  // message replaces it, reading the channel clears it, and clicking it still opens the channel.
  n.on('close', (e) => {
    if (e.reason !== 'timedOut') forget()
  })
  n.on('failed', (_e, error) => {
    forget()
    console.warn('[nexo] notification failed:', error)
  })
  shown.set(req.channelId, n)
  n.show()
}

/** The Windows overlay last asked for (data URL + description), re-applied when the window is shown again. */
let overlay: { url: string; image: NativeImage; description: string } | null = null
/** Window whose 'show' re-applies the overlay (hiding to the tray recreates the taskbar button without it). */
let hookedWindow: BrowserWindow | null = null

function applyOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.setOverlayIcon(overlay?.image ?? null, overlay?.description ?? '')
}

function setBadge(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return
  const b = raw as Partial<UnreadBadge>
  const count = typeof b.mentions === 'number' && Number.isFinite(b.mentions) ? Math.max(0, Math.floor(b.mentions)) : 0
  setTrayMentions(count)
  if (platform !== 'win32') {
    // macOS dock badge; on Linux only Unity-style launchers show it (a no-op elsewhere).
    app.setBadgeCount(count)
    return
  }
  const url = count > 0 && typeof b.overlay === 'string' ? b.overlay : null
  const description = clean(b.description, MAX_TITLE) ?? ''
  if (url !== overlay?.url || description !== overlay?.description) {
    const image = url ? imageFromDataUrl(url) : null
    overlay = url && image ? { url, image, description } : null
  }
  const win = deps?.getWindow()
  if (!win || win.isDestroyed()) return
  if (hookedWindow !== win) {
    hookedWindow = win
    win.on('show', () => applyOverlay(win))
  }
  applyOverlay(win)
}

function fromApp(event: IpcMainEvent): boolean {
  return isAppUrl(event.senderFrame?.url)
}

export function installNotifications(d: NotificationDeps): void {
  deps = d
  ipcMain.on(IPC.notifyShow, (event, raw: unknown) => {
    if (!fromApp(event)) return
    const req = parseNotification(raw)
    if (req) show(req)
  })
  ipcMain.on(IPC.notifyClear, (event, channelId: unknown) => {
    if (!fromApp(event)) return
    if (channelId === null) for (const id of [...shown.keys()]) close(id)
    else if (typeof channelId === 'string') close(channelId)
  })
  ipcMain.on(IPC.notifyBadge, (event, raw: unknown) => {
    if (fromApp(event)) setBadge(raw)
  })
}

/** On quit: remove our notifications from the Action Center / notification list. */
export function closeAllNotifications(): void {
  for (const id of [...shown.keys()]) close(id)
}
