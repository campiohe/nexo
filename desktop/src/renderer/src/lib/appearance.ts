// Theme, message density and UI zoom (Settings → Appearance).
// Imported first by main.tsx: the module body sets <html data-theme / data-density> synchronously, before React or
// any stylesheet module runs, so the first paint already uses the saved theme (tokens.css paints no page background
// until data-theme is set; until then the window's background, set by main from the same choice, shows).
import { create } from 'zustand'
import { THEME_CHOICES, ZOOM_STEPS, type ThemeChoice, type ZoomEvent } from '../../../preload/api'
import { toast, useToasts } from './toast'

export type { ThemeChoice }
export type ResolvedTheme = 'dark' | 'light'
export type Density = 'cozy' | 'compact'

const KEY_THEME = 'nexo:theme'
const KEY_DENSITY = 'nexo:density'

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

function readDensity(): Density {
  return lsGet(KEY_DENSITY) === 'compact' ? 'compact' : 'cozy'
}

/** 'system' → what the OS uses (main mirrors the choice into nativeTheme.themeSource, which drives this query). */
export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice !== 'system') return choice
  return darkQuery && !darkQuery.matches ? 'light' : 'dark'
}

const bridge = () => (typeof window !== 'undefined' ? window.nexo?.appearance : undefined)

/** The page's --bg-0 as #rrggbb (for the window background), or null if it isn't a plain hex color. */
function pageBackground(): string | null {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim()
  return /^#[0-9a-f]{6}$/i.test(v) ? v : null
}

function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice)
  document.documentElement.dataset.theme = resolved
  return resolved
}

/** Tell main (themeSource + window background). Needs the stylesheets, so not at the very first apply. */
function syncMain(choice: ThemeChoice): void {
  const bg = pageBackground()
  if (bg) bridge()?.setTheme(choice, bg)
}

function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density
}

interface AppearanceStore {
  theme: ThemeChoice
  /** The palette in use (follows the OS while theme is 'system'). */
  resolved: ResolvedTheme
  density: Density
  /** Current zoom factor; null until main answered (or without the Electron bridge). */
  zoom: number | null
  setTheme(theme: ThemeChoice): void
  setDensity(density: Density): void
  setZoom(factor: number): Promise<void>
}

// ---- before the first paint ----
const initialTheme = readTheme()
const initialDensity = readDensity()
const initialResolved = applyTheme(initialTheme)
applyDensity(initialDensity)

export const useAppearance = create<AppearanceStore>()((set, get) => ({
  theme: initialTheme,
  resolved: initialResolved,
  density: initialDensity,
  zoom: null,
  setTheme: (theme) => {
    lsSet(KEY_THEME, theme)
    set({ theme, resolved: applyTheme(theme) })
    syncMain(theme)
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
