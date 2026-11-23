// Theme + UI zoom + window chrome on the main side, persisted in <userData>/appearance.json.
// - Theme: the renderer applies it (localStorage, before its first paint); main mirrors the choice so the window's
//   background color and nativeTheme.themeSource (OS-drawn scrollbars, menus) match from startup.
// - Title bar: on Windows the window has no native title bar (titleBarStyle 'hidden'); the page draws its own and
//   Windows draws only the caption buttons (titleBarOverlay), in the colors the renderer last sent (WindowChrome).
//   The overlay's height is in DIPs, so it follows the zoom to stay as tall as the page's bar.
// - Zoom: Ctrl+= / Ctrl+- / Ctrl+0 (Cmd on macOS) and Ctrl+mouse wheel step through ZOOM_STEPS. The app has no
//   application menu on Windows/Linux (and none with zoom roles on macOS outside dev), so nothing else handles them;
//   before-input-event's preventDefault also stops the dev View menu's own zoom accelerators.
import { app, BrowserWindow, ipcMain, nativeTheme, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, THEME_CHOICES, ZOOM_STEPS, type AppearanceState, type ThemeChoice, type WindowChrome, type ZoomSource } from '../preload/api'
import { platform } from './platform'
import { isAppUrl } from './security'

/** --bg-0 / --text-1 of the dark and light palettes (styles/tokens.css): the chrome before the renderer sends its own. */
const DEFAULT_CHROME: Record<Scheme, WindowChrome> = {
  dark: { background: '#121212', symbols: '#c2c2c2' },
  light: { background: '#e9e9e9', symbols: '#3e3e3e' },
}

/** The page's title bar height in CSS px (--titlebar-h in tokens.css). */
const TITLEBAR_HEIGHT = 36

type Scheme = 'dark' | 'light'

interface Stored extends AppearanceState {
  /** Last chrome the renderer sent, and the OS scheme it was for (a 'system' theme may have flipped since). */
  chrome?: WindowChrome & { scheme: Scheme }
}

const isTheme = (v: unknown): v is ThemeChoice => THEME_CHOICES.includes(v as ThemeChoice)
const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
const isChrome = (v: unknown): v is WindowChrome =>
  typeof v === 'object' && v !== null && isHexColor((v as WindowChrome).background) && isHexColor((v as WindowChrome).symbols)

/** nativeTheme only knows system / dark / light: Midnight is a dark palette. */
const themeSource = (theme: ThemeChoice): 'system' | 'dark' | 'light' => (theme === 'midnight' ? 'dark' : theme)

const currentScheme = (): Scheme => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')

/** Windows only: the page draws the title bar, Windows the caption buttons over it. */
export const customTitleBar = platform === 'win32'

let cache: Stored | null = null

const filePath = (): string => join(app.getPath('userData'), 'appearance.json')

/** Nearest step, so a hand-edited file or a stray IPC value can't zoom to something unusable. */
function snapZoom(factor: number): number {
  let best = 1
  for (const step of ZOOM_STEPS) if (Math.abs(step - factor) < Math.abs(best - factor)) best = step
  return best
}

function load(): Stored {
  if (cache) return cache
  const data: Stored = { theme: 'system', zoom: 1 }
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8')) as Record<string, unknown>
    if (isTheme(raw.theme)) data.theme = raw.theme
    if (typeof raw.zoom === 'number' && Number.isFinite(raw.zoom)) data.zoom = snapZoom(raw.zoom)
    const chrome = raw.chrome as Stored['chrome'] | undefined
    if (isChrome(chrome) && (chrome.scheme === 'dark' || chrome.scheme === 'light')) {
      data.chrome = { background: chrome.background, symbols: chrome.symbols, scheme: chrome.scheme }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[nexo] could not read appearance, using defaults:', err)
  }
  cache = data
  return data
}

function save(data: Stored): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const target = filePath()
    writeFileSync(`${target}.tmp`, JSON.stringify(data, null, 2), 'utf8')
    renameSync(`${target}.tmp`, target)
  } catch (err) {
    console.warn('[nexo] could not save appearance:', err)
  }
}

/** The chrome to start with: the last one the renderer sent, unless the OS scheme changed since. */
function startupChrome(): WindowChrome {
  const scheme = currentScheme()
  const saved = load().chrome
  return saved && saved.scheme === scheme ? saved : DEFAULT_CHROME[scheme]
}

/** Window background for the saved theme (call after installAppearance, which sets themeSource). */
export function windowBackground(): string {
  return startupChrome().background
}

const overlayHeight = (zoom: number): number => Math.round(TITLEBAR_HEIGHT * zoom)

/** titleBarOverlay for a new window (Windows), matching the saved theme and zoom. */
export function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  const { background, symbols } = startupChrome()
  return { color: background, symbolColor: symbols, height: overlayHeight(load().zoom) }
}

function updateOverlay(win: BrowserWindow, options: Electron.TitleBarOverlayOptions): void {
  if (!customTitleBar || win.isDestroyed()) return
  try {
    win.setTitleBarOverlay(options)
  } catch (err) {
    console.warn('[nexo] could not update the title bar overlay:', err)
  }
}

/** Saved zoom factor, for webPreferences.zoomFactor (the first paint is already at the right size). */
export function savedZoom(): number {
  return load().zoom
}

function setZoom(win: BrowserWindow, factor: number, source: ZoomSource): number {
  const zoom = snapZoom(factor)
  const data = load()
  if (data.zoom !== zoom) {
    data.zoom = zoom
    save(data)
  }
  if (!win.isDestroyed()) {
    updateOverlay(win, { height: overlayHeight(zoom) })
    win.webContents.setZoomFactor(zoom)
    win.webContents.send(IPC.appearanceZoom, { factor: zoom, source })
  }
  return zoom
}

function stepZoom(win: BrowserWindow, dir: 1 | -1, source: ZoomSource): void {
  const current = load().zoom
  const i = ZOOM_STEPS.indexOf(current)
  const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i < 0 ? ZOOM_STEPS.indexOf(1) : i) + dir))]!
  // At the end of the range: still tell the renderer, so the indicator shows why nothing happened.
  setZoom(win, next, source)
}

/** Zoom shortcuts, the Ctrl+wheel and keeping the saved zoom across reloads, for the main window. */
export function attachAppearance(win: BrowserWindow): void {
  const contents = win.webContents
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const mod = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
    if (!mod || input.alt) return
    const { key, code } = input
    if (key === '=' || key === '+' || code === 'NumpadAdd') stepZoom(win, 1, 'keyboard')
    else if (key === '-' || key === '_' || code === 'NumpadSubtract') stepZoom(win, -1, 'keyboard')
    else if ((key === '0' && !input.shift) || code === 'Numpad0') setZoom(win, 1, 'keyboard')
    else return
    event.preventDefault()
  })

  // Electron doesn't zoom on Ctrl+wheel by itself; it only reports the request. A touchpad sends a burst of these
  // per gesture: one step per 100 ms keeps it controllable.
  let lastWheel = 0
  contents.on('zoom-changed', (_event, direction) => {
    const now = Date.now()
    if (now - lastWheel < 100) return
    lastWheel = now
    stepZoom(win, direction === 'in' ? 1 : -1, 'wheel')
  })

  // A reload / renderer crash recovery: keep the saved zoom.
  contents.on('did-finish-load', () => {
    const zoom = load().zoom
    if (Math.abs(contents.getZoomFactor() - zoom) > 0.001) contents.setZoomFactor(zoom)
  })
}

export function installAppearance(): void {
  nativeTheme.themeSource = themeSource(load().theme)

  const fromApp = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => isAppUrl(event.senderFrame?.url)

  ipcMain.handle(IPC.appearanceGet, (event): AppearanceState => {
    if (!fromApp(event)) throw new Error('forbidden')
    const { theme, zoom } = load()
    return { theme, zoom }
  })

  ipcMain.on(IPC.appearanceSetTheme, (event, theme: unknown, chrome: unknown) => {
    if (!fromApp(event) || !isTheme(theme)) return
    const source = themeSource(theme)
    if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source
    const data = load()
    let changed = data.theme !== theme
    data.theme = theme
    if (isChrome(chrome)) {
      const saved = data.chrome
      const scheme = currentScheme()
      if (!saved || saved.background !== chrome.background || saved.symbols !== chrome.symbols || saved.scheme !== scheme) {
        data.chrome = { background: chrome.background, symbols: chrome.symbols, scheme }
        changed = true
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && !win.isDestroyed()) {
        win.setBackgroundColor(chrome.background)
        updateOverlay(win, { color: chrome.background, symbolColor: chrome.symbols })
      }
    }
    if (changed) save(data)
  })

  ipcMain.handle(IPC.appearanceSetZoom, (event, factor: unknown): number => {
    if (!fromApp(event)) throw new Error('forbidden')
    if (typeof factor !== 'number' || !Number.isFinite(factor)) throw new TypeError('zoom must be a number')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('no window')
    return setZoom(win, factor, 'settings')
  })
}
