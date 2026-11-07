// Remembers the main window's bounds / maximized state in <userData>/window-state.json.
import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

const filePath = (): string => join(app.getPath('userData'), 'window-state.json')
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** At least 100×50 px of the window's top area must be on some display, otherwise re-center. */
function visibleOnSomeDisplay(r: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(r.x + r.width, a.x + a.width) - Math.max(r.x, a.x)
    const h = Math.min(r.y + 50, a.y + a.height) - Math.max(r.y, a.y)
    return w >= 100 && h >= 50
  })
}

export function loadWindowState(defaults: { width: number; height: number; minWidth: number; minHeight: number }): WindowState {
  const state: WindowState = { width: defaults.width, height: defaults.height, maximized: false }
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8')) as Record<string, unknown>
    if (isNum(raw.width) && isNum(raw.height)) {
      state.width = Math.max(defaults.minWidth, Math.round(raw.width))
      state.height = Math.max(defaults.minHeight, Math.round(raw.height))
    }
    state.maximized = raw.maximized === true
    if (isNum(raw.x) && isNum(raw.y)) {
      const r = { x: Math.round(raw.x), y: Math.round(raw.y), width: state.width, height: state.height }
      if (visibleOnSomeDisplay(r)) {
        state.x = r.x
        state.y = r.y
      }
    }
  } catch {
    // first run or unreadable file → defaults
  }
  return state
}

export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined
  const save = (): void => {
    clearTimeout(timer)
    if (win.isDestroyed()) return
    const b = win.getNormalBounds()
    const state: WindowState = { ...b, maximized: win.isMaximized() }
    try {
      writeFileSync(filePath(), JSON.stringify(state))
    } catch (err) {
      console.warn('[nexo] could not save window state:', err)
    }
  }
  const later = (): void => {
    clearTimeout(timer)
    timer = setTimeout(save, 750)
  }
  win.on('resize', later)
  win.on('move', later)
  win.on('maximize', later)
  win.on('unmaximize', later)
  win.on('close', save)
}
