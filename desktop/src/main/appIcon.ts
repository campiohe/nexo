// Settings → Appearance → App icon: an alternate icon for the window / taskbar button, the macOS Dock and the tray
// while the app runs. The renderer draws the chosen variant (lib/appIcon.ts) and sends it as a PNG data URL, since
// nativeImage can't load SVG on Windows. Main validates it, applies it and keeps it in <userData>/app-icon.png, so
// the next launch starts with it. Classic (null) removes the file and puts the bundled icon back.
// Pinned shortcuts, the Start menu and the installer keep the executable's icon: only the running app changes.
import { app, BrowserWindow, ipcMain, nativeImage, type NativeImage } from 'electron'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import icon from '../../resources/icon.png?asset'
import { IPC } from '../preload/api'
import { platform } from './platform'
import { isAppUrl } from './security'
import { setTrayBaseIcon } from './tray'

const DATA_URL_PREFIX = 'data:image/png;base64,'
/** A 256 px icon is a few KB; anything near this is not one of ours. */
const MAX_DATA_URL_LENGTH = 1_500_000
const MIN_SIZE = 16
const MAX_SIZE = 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The custom icon (re-encoded PNG bytes + image), or null for the bundled one. */
let custom: { png: Buffer; image: NativeImage } | null = null

const filePath = (): string => join(app.getPath('userData'), 'app-icon.png')

/** A square PNG within the size limits, or null. Returns the image re-encoded by nativeImage (never the raw bytes). */
function decode(bytes: Buffer): { png: Buffer; image: NativeImage } | null {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  if (width !== height || width < MIN_SIZE || width > MAX_SIZE) return null
  return { png: image.toPNG(), image }
}

function parseDataUrl(raw: unknown): { png: Buffer; image: NativeImage } | null {
  if (typeof raw !== 'string' || raw.length > MAX_DATA_URL_LENGTH || !raw.startsWith(DATA_URL_PREFIX)) return null
  const b64 = raw.slice(DATA_URL_PREFIX.length)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null
  return decode(Buffer.from(b64, 'base64'))
}

function load(): void {
  try {
    custom = decode(readFileSync(filePath()))
    if (!custom) console.warn('[nexo] ignoring an invalid app-icon.png')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[nexo] could not read the app icon:', err)
  }
}

function save(png: Buffer | null): void {
  const target = filePath()
  try {
    if (!png) {
      unlinkSync(target)
      return
    }
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(`${target}.tmp`, png)
    renameSync(`${target}.tmp`, target)
  } catch (err) {
    if (!png && (err as NodeJS.ErrnoException).code === 'ENOENT') return
    console.warn('[nexo] could not save the app icon:', err)
  }
}

/** BrowserWindow `icon` option: the custom icon, else the bundled one on Linux (Windows/macOS use the exe/bundle's). */
export function windowIconOption(): { icon?: NativeImage | string } {
  if (custom) return { icon: custom.image }
  return platform === 'linux' ? { icon } : {}
}

/** Puts the current icon on every window, the Dock and the tray. */
function apply(): void {
  const image = custom?.image ?? nativeImage.createFromPath(icon)
  if (image.isEmpty()) return
  if (platform === 'darwin') {
    app.dock?.setIcon(image)
  } else {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.setIcon(image)
  }
  setTrayBaseIcon(custom?.image ?? null)
}

/** Call before the first window and the tray are created. */
export function installAppIcon(): void {
  load()
  if (custom) {
    setTrayBaseIcon(custom.image)
    // Windows/Linux get it through windowIconOption(); the Dock icon has no constructor option.
    if (platform === 'darwin') app.dock?.setIcon(custom.image)
  }

  ipcMain.handle(IPC.appearanceSetAppIcon, (event, raw: unknown): void => {
    if (!isAppUrl(event.senderFrame?.url)) throw new Error('forbidden')
    let next: { png: Buffer; image: NativeImage } | null = null
    if (raw !== null) {
      next = parseDataUrl(raw)
      if (!next) throw new TypeError('app icon must be a square PNG data URL')
    }
    // The renderer re-sends its choice on every start and theme change: nothing to do when it's the same icon.
    // (Back to Classic from a custom icon sets the bundled one explicitly: a window icon can't be unset.)
    if (next ? custom?.png.equals(next.png) : !custom) return
    custom = next
    save(next?.png ?? null)
    apply()
  })
}
