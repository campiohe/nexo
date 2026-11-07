// System tray: icon, tooltip and context menu mirroring the voice session, and the close-to-tray hint.
import { app, ipcMain, Menu, nativeImage, Notification, Tray, type BrowserWindow, type NativeImage } from 'electron'
import icon from '../../resources/icon.png?asset'
import { IPC, type TrayAction } from '../preload/api'
import { platform } from './platform'
import { takeTrayHint } from './prefs'
import { isAppUrl } from './security'

interface VoiceState {
  inVoice: boolean
  channelName: string | null
  muted: boolean
  deafened: boolean
}

interface TrayDeps {
  getWindow(): BrowserWindow | null
  showWindow(): void
}

const MAX_CHANNEL_NAME = 64

let tray: Tray | null = null
let deps: TrayDeps | null = null
let voice: VoiceState = { inVoice: false, channelName: null, muted: false, deafened: false }

/** icon.png (1024 px) scaled down; @1x/@1.5x/@2x representations so the OS picks a crisp one for its DPI. */
function trayImage(): NativeImage {
  const src = nativeImage.createFromPath(icon)
  if (src.isEmpty()) return src
  const scaled = (px: number): NativeImage => src.resize({ width: px, height: px, quality: 'best' })
  // Linux status-notifier hosts scale the image to their panel size themselves (usually 22–24 px).
  if (platform === 'linux') return scaled(32)
  // Windows: 16 px at 100 % DPI; macOS: a 16 pt full-colour icon (the logo is a coloured tile, so it isn't
  // turned into a template image — that would render as a solid square).
  const img = nativeImage.createEmpty()
  const scales = platform === 'win32' ? [1, 1.5, 2] : [1, 2]
  for (const scaleFactor of scales) img.addRepresentation({ scaleFactor, buffer: scaled(16 * scaleFactor).toPNG() })
  return img
}

function tooltip(): string {
  if (!voice.inVoice) return 'Nexo'
  const where = voice.channelName ? `in ${voice.channelName}` : 'in voice'
  const flag = voice.deafened ? ' (deafened)' : voice.muted ? ' (muted)' : ''
  return `Nexo — ${where}${flag}`
}

function sendAction(action: TrayAction): void {
  const win = deps?.getWindow()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(IPC.trayAction, action)
}

function rebuild(): void {
  if (!tray || tray.isDestroyed()) return
  const act = (action: TrayAction) => (): void => {
    sendAction(action)
    // Electron already flipped the checkbox; redraw from the last confirmed state until the renderer
    // reports the new one through tray.setVoiceState().
    rebuild()
  }
  tray.setToolTip(tooltip())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Nexo', click: () => deps?.showWindow() },
      { type: 'separator' },
      { label: 'Mute', type: 'checkbox', checked: voice.muted, enabled: voice.inVoice, click: act('toggle-mute') },
      { label: 'Deafen', type: 'checkbox', checked: voice.deafened, enabled: voice.inVoice, click: act('toggle-deafen') },
      { label: 'Leave voice', enabled: voice.inVoice, click: act('leave-voice') },
      { type: 'separator' },
      // app.quit() emits before-quit, which sets the isQuitting flag in index.ts.
      { label: 'Quit Nexo', click: () => app.quit() },
    ]),
  )
}

function parseVoiceState(raw: unknown): VoiceState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const s = raw as Record<string, unknown>
  if (typeof s.inVoice !== 'boolean' || typeof s.muted !== 'boolean' || typeof s.deafened !== 'boolean') return null
  if (s.channelName !== null && typeof s.channelName !== 'string') return null
  let channelName = typeof s.channelName === 'string' ? s.channelName.replace(/[\r\n\t]+/g, ' ').trim() : null
  if (channelName && channelName.length > MAX_CHANNEL_NAME) channelName = `${channelName.slice(0, MAX_CHANNEL_NAME - 1)}…`
  return { inVoice: s.inVoice, channelName: channelName || null, muted: s.muted, deafened: s.deafened }
}

/** Creates the tray icon. Returns false if the platform refused (the window then closes normally). */
export function installTray(d: TrayDeps): boolean {
  deps = d
  ipcMain.on(IPC.trayVoiceState, (event, raw: unknown) => {
    if (!isAppUrl(event.senderFrame?.url)) return
    const next = parseVoiceState(raw)
    if (!next) return
    voice = next
    rebuild()
  })
  try {
    tray = new Tray(trayImage())
  } catch (err) {
    console.warn('[nexo] could not create the tray icon:', err)
    tray = null
    return false
  }
  // macOS opens the context menu on click; Windows/Linux: a (left) click brings the window back.
  if (platform !== 'darwin') tray.on('click', () => deps?.showWindow())
  rebuild()
  return true
}

export function hasTray(): boolean {
  return !!tray && !tray.isDestroyed()
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}

/** One-time "still running" hint after the window is first hidden to the tray (Windows/Linux). */
export function maybeShowTrayHint(): void {
  if (!tray || tray.isDestroyed() || platform === 'darwin') return
  const title = 'Nexo is still running in the tray'
  const content = 'Click the tray icon to open Nexo again. To exit, right-click it and choose Quit Nexo.'
  if (platform === 'win32') {
    if (!takeTrayHint()) return
    // Shell balloon (Action Center toast on Windows 10/11); not subject to the web Notification permission.
    tray.displayBalloon({ title, content, iconType: 'info', noSound: true })
    return
  }
  if (!Notification.isSupported() || !takeTrayHint()) return
  try {
    new Notification({ title, body: content, icon, silent: true }).show()
  } catch (err) {
    console.warn('[nexo] could not show the tray hint:', err)
  }
}
