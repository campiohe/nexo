// Navigation / window.open / permission lockdown for every webContents.
import { app, session, shell, type WebContents } from 'electron'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const devUrl = process.env.ELECTRON_RENDERER_URL && !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : null
const devOrigin = devUrl ? new URL(devUrl).origin : null
const rendererDir = join(__dirname, '../renderer')

/** The page that renderer code is served from (dev server URL or the bundled index.html). */
export const rendererEntry = devUrl ?? join(__dirname, '../renderer/index.html')

/** True if `url` belongs to Nexo's own renderer (dev server origin, or a file inside out/renderer). */
export function isAppUrl(url: string | undefined | null): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    if (devOrigin) return u.origin === devOrigin
    if (u.protocol !== 'file:') return false
    // Path-based (not string-prefix) check: handles drive-letter case, UNC paths and percent-encoding on Windows.
    const rel = relative(rendererDir, fileURLToPath(u))
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}

export function isHttpUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 4096) return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function openExternalSafe(url: unknown): void {
  if (!isHttpUrl(url)) return
  shell.openExternal(url).catch((err: unknown) => console.warn('[nexo] openExternal failed:', err))
}

function hardenWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openExternalSafe(url)
  })
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

type Permission = Parameters<Parameters<Electron.Session['setPermissionRequestHandler']>[0] & object>[1]

/**
 * Allowed for Nexo's own frames only:
 * - media: microphone / camera (and device-label checks for enumerateDevices)
 * - display-capture: getDisplayMedia (the actual source is chosen by setDisplayMediaRequestHandler)
 * - fullscreen: double-click a stream tile
 * - speaker-selection: HTMLMediaElement.setSinkId / output device choice
 * - clipboard-sanitized-write: navigator.clipboard.writeText (copy message / link)
 * - local-network*: connecting to a self-hosted server on the LAN / localhost (Chromium Local Network Access)
 */
const ALLOWED = new Set<Permission>([
  'media',
  'display-capture',
  'fullscreen',
  'speaker-selection',
  'clipboard-sanitized-write',
  'local-network-access',
  'local-network',
  'loopback-network',
])

export function installSecurity(): void {
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents))

  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const ok = ALLOWED.has(permission) && isAppUrl(details.requestingUrl)
    if (!ok) console.warn(`[nexo] denied permission request: ${permission} from ${details.requestingUrl}`)
    callback(ok)
  })
  ses.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => {
    if (!ALLOWED.has(permission)) return false
    return isAppUrl(details.requestingUrl ?? webContents?.getURL())
  })
}
