// Theme, accent, title bar, app icon, message density and UI zoom (Settings → Appearance).
// Imported first by main.tsx: the module body sets <html data-theme / data-accent / data-density> synchronously, before React or
// any stylesheet module runs, so the first paint already uses the saved theme (tokens.css paints no page background
// until data-theme is set; until then the window's background, set by main from the same choice, shows).
import { create } from 'zustand'
import { THEME_CHOICES, ZOOM_STEPS, type ThemeChoice, type WindowChrome, type ZoomEvent } from '../../../preload/api'
import { APP_ICONS, renderAppIcon, usesAccent, type AppIconChoice } from './appIcon'
import { toast, useToasts } from './toast'

export type { AppIconChoice, ThemeChoice }
export { APP_ICONS }
/** The palette in use: <html data-theme>. */
export type ResolvedTheme = 'dark' | 'midnight' | 'light'
export type Density = 'cozy' | 'compact'

/** Accent presets (tokens.css, <html data-accent>). */
export const ACCENTS = [
  { id: 'mint', label: 'Mint' },
  { id: 'blue', label: 'Blue' },
  { id: 'violet', label: 'Violet' },
  { id: 'coral', label: 'Coral' },
  { id: 'amber', label: 'Amber' },
  { id: 'rose', label: 'Rose' },
] as const
export type AccentChoice = (typeof ACCENTS)[number]['id']

/** What the title bar shows besides the server name: the jump-to-channel box, or nothing. */
export type TitleBarStyle = 'search' | 'minimal'

const KEY_THEME = 'nexo:theme'
const KEY_ACCENT = 'nexo:accent'
const KEY_TITLEBAR = 'nexo:titlebar'
const KEY_DENSITY = 'nexo:density'
const KEY_APP_ICON = 'nexo:app-icon'

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
}

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null

function readTheme(): ThemeChoice {
  const v = lsGet(KEY_THEME)
  return THEME_CHOICES.includes(v as ThemeChoice) ? (v as ThemeChoice) : 'system'
}

function readAccent(): AccentChoice {
  const v = lsGet(KEY_ACCENT)
  return ACCENTS.some((a) => a.id === v) ? (v as AccentChoice) : 'mint'
}

function readTitleBar(): TitleBarStyle {
  return lsGet(KEY_TITLEBAR) === 'minimal' ? 'minimal' : 'search'
}

function readAppIcon(): AppIconChoice {
  const v = lsGet(KEY_APP_ICON)
  return APP_ICONS.some((i) => i.id === v) ? (v as AppIconChoice) : 'classic'
}

function readDensity(): Density {
  return lsGet(KEY_DENSITY) === 'compact' ? 'compact' : 'cozy'
}

/** 'system' → what the OS uses (main mirrors the choice into nativeTheme.themeSource, which drives this query). */
export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'midnight') return 'midnight'
  if (choice !== 'system') return choice
  return darkQuery && !darkQuery.matches ? 'light' : 'dark'
}

const bridge = () => (typeof window !== 'undefined' ? window.nexo?.appearance : undefined)

/** The page's --bg-0 (window background, title bar) and --text-1 (caption button glyphs), or null if not #rrggbb. */
function pageChrome(): WindowChrome | null {
  const css = getComputedStyle(document.documentElement)
  const hex = (name: string) => {
    const v = css.getPropertyValue(name).trim()
    return /^#[0-9a-f]{6}$/i.test(v) ? v : null
  }
  const background = hex('--bg-0')
  const symbols = hex('--text-1')
  return background && symbols ? { background, symbols } : null
}

function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice)
  document.documentElement.dataset.theme = resolved
  return resolved
}

/** Tell main (themeSource + window chrome). Needs the stylesheets, so not at the very first apply. */
function syncMain(choice: ThemeChoice): void {
  const chrome = pageChrome()
  if (chrome) bridge()?.setTheme(choice, chrome)
}

/** Main can take an alternate app icon (missing on older preloads: Settings then hides the option). */
export const hasAppIconBridge = (): boolean => typeof bridge()?.setAppIcon === 'function'

/** Last icon sent to main ('' = nothing yet, null = the bundled one). */
let sentAppIcon: string | null | '' = ''

/**
 * Draw the chosen app icon with the page's current accent and hand it to main (window, taskbar, tray; kept for the
 * next launch). Needs the stylesheets. Skips an icon identical to the last one sent.
 */
function syncAppIcon(choice: AppIconChoice): void {
  const b = bridge()
  if (!b || typeof b.setAppIcon !== 'function') return
  const png = choice === 'classic' ? null : renderAppIcon(choice)
  if (png === sentAppIcon || (choice !== 'classic' && !png)) return
  sentAppIcon = png
  b.setAppIcon(png).catch((err: unknown) => {
    sentAppIcon = ''
    console.warn('[nexo] could not set the app icon:', err)
  })
}

/** The accent changed: redraw an icon drawn from it (always its dark-palette shade, so themes don't matter). */
function accentChanged(): void {
  const { appIcon } = useAppearance.getState()
  if (usesAccent(appIcon)) syncAppIcon(appIcon)
}

function applyAccent(accent: AccentChoice): void {
  document.documentElement.dataset.accent = accent
}

function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density
}

interface AppearanceStore {
  theme: ThemeChoice
  /** The palette in use (follows the OS while theme is 'system'). */
  resolved: ResolvedTheme
  accent: AccentChoice
  titleBar: TitleBarStyle
  /** Window / taskbar / tray icon variant. */
  appIcon: AppIconChoice
  density: Density
  /** Current zoom factor; null until main answered (or without the Electron bridge). */
  zoom: number | null
  setTheme(theme: ThemeChoice): void
  setAccent(accent: AccentChoice): void
  setTitleBar(style: TitleBarStyle): void
  setAppIcon(choice: AppIconChoice): void
  setDensity(density: Density): void
  setZoom(factor: number): Promise<void>
}

// ---- before the first paint ----
const initialTheme = readTheme()
const initialAccent = readAccent()
const initialDensity = readDensity()
const initialResolved = applyTheme(initialTheme)
applyAccent(initialAccent)
applyDensity(initialDensity)

export const useAppearance = create<AppearanceStore>()((set, get) => ({
  theme: initialTheme,
  resolved: initialResolved,
  accent: initialAccent,
  titleBar: readTitleBar(),
  appIcon: readAppIcon(),
  density: initialDensity,
  zoom: null,
  setTheme: (theme) => {
    lsSet(KEY_THEME, theme)
    set({ theme, resolved: applyTheme(theme) })
    syncMain(theme)
  },
  setAccent: (accent) => {
    lsSet(KEY_ACCENT, accent)
    applyAccent(accent)
    set({ accent })
    accentChanged()
  },
  setTitleBar: (titleBar) => {
    lsSet(KEY_TITLEBAR, titleBar)
    set({ titleBar })
  },
  setAppIcon: (appIcon) => {
    lsSet(KEY_APP_ICON, appIcon)
    set({ appIcon })
    syncAppIcon(appIcon)
  },
  setDensity: (density) => {
    lsSet(KEY_DENSITY, density)
    applyDensity(density)
    set({ density })
  },
  setZoom: async (factor) => {
    const b = bridge()
    if (!b) return
    const zoom = await b.setZoom(factor)
    if (get().zoom !== zoom) set({ zoom })
  },
}))

/** Zoom steps the settings slider and shortcuts move through. */
export { ZOOM_STEPS }

export const zoomPercent = (factor: number): string => `${Math.round(factor * 100)}%`

let zoomToastId: number | null = null

function showZoomToast(factor: number): void {
  // One indicator, replaced on every step (not a stack of toasts).
  if (zoomToastId !== null) useToasts.getState().dismiss(zoomToastId)
  const edge = factor === ZOOM_STEPS[0] ? ' (minimum)' : factor === ZOOM_STEPS[ZOOM_STEPS.length - 1] ? ' (maximum)' : ''
  zoomToastId = toast(`Zoom ${zoomPercent(factor)}${edge}`, 'info', 1500)
}

let installed = false

/** Live OS theme changes, main's zoom state and the zoom indicator. Call once at startup (main.tsx). */
export function installAppearance(): void {
  if (installed) return
  installed = true

  // Following the OS: re-resolve on change. Also fires when main changes nativeTheme.themeSource.
  darkQuery?.addEventListener('change', () => {
    const { theme, resolved } = useAppearance.getState()
    const next = applyTheme(theme)
    if (next !== resolved) {
      useAppearance.setState({ resolved: next })
      syncMain(theme)
    }
  })

  // Stylesheets are in by now (main.tsx imports them before calling this): the window background can follow.
  syncMain(initialTheme)
  // Main starts with the icon it saved; re-sending keeps both sides in step (an identical icon is a no-op there).
  syncAppIcon(useAppearance.getState().appIcon)

  const b = bridge()
  if (!b) return
  void b
    .getState()
    .then((s) => useAppearance.setState({ zoom: s.zoom }))
    .catch((err: unknown) => console.warn('[nexo] could not read appearance state:', err))
  b.onZoom((e: ZoomEvent) => {
    useAppearance.setState({ zoom: e.factor })
    if (e.source !== 'settings') showZoomToast(e.factor)
  })
}
