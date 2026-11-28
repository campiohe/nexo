// Settings → Appearance → App icon: an alternate icon for the window / taskbar button, the macOS Dock and the tray
// while the app runs. The renderer draws the chosen variant (lib/appIcon.ts) and sends it as a PNG data URL, since
// nativeImage can't load SVG on Windows. Main validates it, applies it and keeps it in <userData>/app-icon.png, so
// the next launch starts with it. Classic (null) removes the file and puts the bundled icon back.
//
// Windows: the taskbar button doesn't show the window's icon. It shows the icon of the shortcut carrying the app's
// AppUserModelID (the installer's Start menu shortcut), and reads it once per launch. So the installed app also points
// its own shortcuts (Start menu, desktop, pinned to the taskbar) at an .ico of the chosen icon: the taskbar shows it
// from the next start. The installer recreates the shortcuts on every update, hence the check at each start.
import { app, BrowserWindow, ipcMain, nativeImage, shell, type NativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

/** Sizes in the .ico: the taskbar, Start menu and desktop pick the nearest one for the display scale. */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
const ICO_PREFIX = 'app-icon-'

/** An .ico holding PNG-compressed images (Windows Vista and later). */
function toIco(image: NativeImage): Buffer {
  const pngs = ICO_SIZES.map((size) => image.resize({ width: size, height: size, quality: 'best' }).toPNG())
  const header = Buffer.alloc(6 + 16 * pngs.length)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)
  let offset = header.length
  pngs.forEach((png, i) => {
    const entry = 6 + 16 * i
    const size = ICO_SIZES[i]!
    header[entry] = size >= 256 ? 0 : size // 0 means 256
    header[entry + 1] = size >= 256 ? 0 : size
    header.writeUInt16LE(1, entry + 4) // planes
    header.writeUInt16LE(32, entry + 6) // bits per pixel
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...pngs])
}

/**
 * The .ico for the custom icon, written once per icon. The name carries a hash of the image: Windows caches shortcut
 * icons by path, so a changed file under the same name could keep showing the old one. Older .ico files are removed.
 */
function customIco(png: Buffer, image: NativeImage): string | null {
  const dir = app.getPath('userData')
  const name = `${ICO_PREFIX}${createHash('sha256').update(png).digest('hex').slice(0, 16)}.ico`
  try {
    removeIcos(name)
    const target = join(dir, name)
    if (!existsSync(target)) {
      writeFileSync(`${target}.tmp`, toIco(image))
      renameSync(`${target}.tmp`, target)
    }
    return target
  } catch (err) {
    console.warn('[nexo] could not write the app icon .ico:', err)
    return null
  }
}

/** Deletes our .ico files except `keep`. */
function removeIcos(keep: string | null): void {
  const dir = app.getPath('userData')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name === keep || !name.startsWith(ICO_PREFIX) || !name.endsWith('.ico')) continue
    try {
      unlinkSync(join(dir, name))
    } catch {
      /* in use or gone: tried again next time */
    }
  }
}

/** Folders the installer (Start menu, desktop) and the user (taskbar pins) put shortcuts to Nexo in. */
function shortcutFolders(): string[] {
  const roaming = app.getPath('appData')
  return [
    join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    app.getPath('desktop'),
    join(roaming, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
  ]
}

/** Windows, installed app: points the shortcuts that start this executable at the current icon. */
function syncShortcuts(): void {
  if (platform !== 'win32' || !app.isPackaged) return
  const exe = resolve(process.execPath).toLowerCase()
  const icon = custom ? customIco(custom.png, custom.image) : process.execPath
  if (!icon) return
  if (!custom) removeIcos(null)
  for (const dir of shortcutFolders()) {
    let names: string[]
    try {
      names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.lnk'))
    } catch {
      continue
    }
    for (const name of names) {
      const file = join(dir, name)
      try {
        const link = shell.readShortcutLink(file)
        if (!link.target || resolve(link.target).toLowerCase() !== exe) continue
        if (link.icon && resolve(link.icon).toLowerCase() === icon.toLowerCase() && (link.iconIndex ?? 0) === 0) continue
        if (!shell.writeShortcutLink(file, 'update', { target: link.target, icon, iconIndex: 0 })) console.warn(`[nexo] could not update ${file}`)
      } catch {
        /* not a readable shortcut */
      }
    }
  }
}

/**
 * BrowserWindow `icon` option: the custom icon, else the bundled one on Linux and in development (the installed app
 * on Windows/macOS uses the exe/bundle's; a dev run would show Electron's).
 */
export function windowIconOption(): { icon?: NativeImage | string } {
  if (custom) return { icon: custom.image }
  return platform === 'linux' || !app.isPackaged ? { icon } : {}
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
  syncShortcuts()
}

/** Call before the first window and the tray are created. */
export function installAppIcon(): void {
  load()
  if (custom) {
    setTrayBaseIcon(custom.image)
    // Windows/Linux get it through windowIconOption(); the Dock icon has no constructor option.
    if (platform === 'darwin') app.dock?.setIcon(custom.image)
  }
  // Before the first window: the taskbar reads the shortcut's icon when the window appears.
  syncShortcuts()

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
