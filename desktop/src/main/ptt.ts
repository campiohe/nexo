// Global push-to-talk: a system-wide keyboard/mouse hook (uiohook-napi) that works while games have focus.
//
// The native module is loaded lazily, on the first setBinding()/captureBinding() that needs the hook, so a
// missing or broken prebuild can never crash startup: it only turns into PttStatus { active: false, reason }.
import { app, ipcMain, systemPreferences, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { UiohookKeyboardEvent, UiohookMouseEvent } from 'uiohook-napi'
import { IPC, type PttBinding, type PttStatus } from '../preload/api'
import { platform } from './platform'
import { isAppUrl } from './security'

type UiohookModule = typeof import('uiohook-napi')

const CAPTURE_TIMEOUT_MS = 15_000
const ESCAPE = 0x0001 // UiohookKey.Escape
const MAX_KEYCODE = 0xffff
const MAX_MOUSE_BUTTON = 32
const MAX_LABEL = 64

interface Capture {
  promise: Promise<PttBinding | null>
  resolve(binding: PttBinding | null): void
  timer: NodeJS.Timeout
}

let getWindow: () => BrowserWindow | null = () => null
let hook: UiohookModule | null = null
let loadError: string | null = null
let running = false
let binding: PttBinding | null = null
let pressed = false
/** Keys currently held down, to tell OS auto-repeat keydowns from real presses. */
const heldKeys = new Set<number>()
let capture: Capture | null = null
let keyNames: Map<number, string> | null = null

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ── Labels ──────────────────────────────────────────────────────────────────────────────────────────────

const META = platform === 'darwin' ? 'Cmd' : platform === 'win32' ? 'Win' : 'Super'
const ALT = platform === 'darwin' ? 'Option' : 'Alt'

/** UiohookKey names that the generic "CamelCase → Camel Case" rule doesn't render nicely. */
const LABEL_OVERRIDES: Record<string, string> = {
  ArrowLeft: 'Left Arrow',
  ArrowUp: 'Up Arrow',
  ArrowRight: 'Right Arrow',
  ArrowDown: 'Down Arrow',
  NumpadMultiply: 'Numpad *',
  NumpadAdd: 'Numpad +',
  NumpadSubtract: 'Numpad -',
  NumpadDecimal: 'Numpad .',
  NumpadDivide: 'Numpad /',
  NumpadArrowLeft: 'Numpad Left',
  NumpadArrowUp: 'Numpad Up',
  NumpadArrowRight: 'Numpad Right',
  NumpadArrowDown: 'Numpad Down',
  Semicolon: ';',
  Equal: '=',
  Comma: ',',
  Minus: '-',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  BracketLeft: '[',
  Backslash: '\\',
  BracketRight: ']',
  Quote: "'",
  Ctrl: 'Left Ctrl',
  CtrlRight: 'Right Ctrl',
  Alt: `Left ${ALT}`,
  AltRight: `Right ${ALT}`,
  Shift: 'Left Shift',
  ShiftRight: 'Right Shift',
  Meta: `Left ${META}`,
  MetaRight: `Right ${META}`,
}

function buildKeyNames(keys: Record<string, number>): Map<number, string> {
  const map = new Map<number, string>()
  for (const [name, code] of Object.entries(keys)) {
    if (map.has(code)) continue
    map.set(code, LABEL_OVERRIDES[name] ?? name.replace(/([a-z])([A-Z0-9])/g, '$1 $2'))
  }
  return map
}

function keyLabel(code: number): string {
  if (!keyNames && hook) keyNames = buildKeyNames(hook.UiohookKey)
  return keyNames?.get(code) ?? `Key ${code}`
}

function mouseLabel(button: number): string {
  return button === 3 ? 'Middle Mouse' : `Mouse ${button}`
}

// ── Hook lifecycle ──────────────────────────────────────────────────────────────────────────────────────

function isWayland(): boolean {
  return (process.env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland' || !!process.env.WAYLAND_DISPLAY
}

/** Reasons the hook can't work on this system, checked before touching the native module. */
function platformBlocker(): string | null {
  if (platform === 'linux' && isWayland()) {
    return "Global push-to-talk needs an X11 session: Wayland doesn't let apps see keys pressed in other windows."
  }
  if (platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
    return 'Global push-to-talk needs the Accessibility permission. Allow Nexo in System Settings → Privacy & Security → Accessibility, then set the key again (restart Nexo if it still doesn’t work).'
  }
  return null
}

function loadHook(): UiohookModule | null {
  if (hook || loadError) return hook
  try {
    // Plain require (kept external by electron-vite): resolved from node_modules next to the app, with the
    // .node prebuild picked by node-gyp-build from app.asar.unpacked.
    const mod = require('uiohook-napi') as UiohookModule
    mod.uIOhook.on('keydown', onKeyDown)
    mod.uIOhook.on('keyup', onKeyUp)
    mod.uIOhook.on('mousedown', onMouseDown)
    mod.uIOhook.on('mouseup', onMouseUp)
    hook = mod
  } catch (err) {
    loadError = `Couldn't load the global input hook (uiohook-napi): ${errorMessage(err)}`
    console.warn(`[nexo] ${loadError}`)
  }
  return hook
}

function ensureRunning(): PttStatus {
  if (running) return { active: true }
  const blocker = platformBlocker()
  if (blocker) return { active: false, reason: blocker }
  const mod = loadHook()
  if (!mod) return { active: false, reason: loadError ?? 'The global input hook is unavailable.' }
  try {
    heldKeys.clear()
    mod.uIOhook.start()
    running = true
    return { active: true }
  } catch (err) {
    const reason = `Couldn't start the global input hook: ${errorMessage(err)}`
    console.warn(`[nexo] ${reason}`)
    return { active: false, reason }
  }
}

function stopHook(): void {
  if (!running || !hook) return
  running = false
  heldKeys.clear()
  try {
    hook.uIOhook.stop()
  } catch (err) {
    console.warn('[nexo] could not stop the global input hook:', err)
  }
}

function stopIfIdle(): void {
  // Deferred: we may be inside a hook event callback.
  setImmediate(() => {
    if (!binding && !capture) stopHook()
  })
}

// ── Events ──────────────────────────────────────────────────────────────────────────────────────────────

function emit(down: boolean): void {
  try {
    const win = getWindow()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) return
    win.webContents.send(IPC.pttChange, down)
  } catch (err) {
    console.warn('[nexo] could not deliver push-to-talk state:', err)
  }
}

/** Ends a press in progress (binding changed, capture started), so the renderer never stays "talking". */
function release(): void {
  if (!pressed) return
  pressed = false
  emit(false)
}

function finishCapture(result: PttBinding | null): void {
  const c = capture
  if (!c) return
  capture = null
  clearTimeout(c.timer)
  c.resolve(result)
  stopIfIdle()
}

function matches(kind: PttBinding['kind'], code: number): boolean {
  return !!binding && binding.kind === kind && binding.code === code
}

// Listeners run inside a native N-API callback: an exception escaping here aborts the process, so each one
// is fully guarded.
function onKeyDown(e: UiohookKeyboardEvent): void {
  try {
    // OS auto-repeat sends keydown again while a key is held; only the first one counts.
    const repeat = heldKeys.has(e.keycode)
    heldKeys.add(e.keycode)
    if (repeat) return
    if (capture) {
      finishCapture(e.keycode === ESCAPE ? null : { kind: 'key', code: e.keycode, label: keyLabel(e.keycode) })
      return
    }
    if (!pressed && matches('key', e.keycode)) {
      pressed = true
      emit(true)
    }
  } catch (err) {
    console.warn('[nexo] push-to-talk keydown handler failed:', err)
  }
}

function onKeyUp(e: UiohookKeyboardEvent): void {
  try {
    heldKeys.delete(e.keycode)
    if (pressed && matches('key', e.keycode)) {
      pressed = false
      emit(false)
    }
  } catch (err) {
    console.warn('[nexo] push-to-talk keyup handler failed:', err)
  }
}

function onMouseDown(e: UiohookMouseEvent): void {
  try {
    const button = Number(e.button)
    if (!Number.isInteger(button) || button < 3) return // left / right click are never bindable
    if (capture) {
      finishCapture({ kind: 'mouse', code: button, label: mouseLabel(button) })
      return
    }
    if (!pressed && matches('mouse', button)) {
      pressed = true
      emit(true)
    }
  } catch (err) {
    console.warn('[nexo] push-to-talk mousedown handler failed:', err)
  }
}

function onMouseUp(e: UiohookMouseEvent): void {
  try {
    const button = Number(e.button)
    if (pressed && matches('mouse', button)) {
      pressed = false
      emit(false)
    }
  } catch (err) {
    console.warn('[nexo] push-to-talk mouseup handler failed:', err)
  }
}

// ── API ─────────────────────────────────────────────────────────────────────────────────────────────────

function parseBinding(raw: unknown): PttBinding | null {
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('binding must be an object or null')
  const b = raw as Record<string, unknown>
  const code = b.code
  if (typeof code !== 'number' || !Number.isInteger(code)) throw new TypeError('binding.code must be an integer')
  if (b.kind === 'key') {
    if (code <= 0 || code > MAX_KEYCODE) throw new TypeError('invalid key code')
  } else if (b.kind === 'mouse') {
    if (code < 3 || code > MAX_MOUSE_BUTTON) throw new TypeError('invalid mouse button (3+ only)')
  } else {
    throw new TypeError("binding.kind must be 'key' or 'mouse'")
  }
  const fallback = b.kind === 'mouse' ? mouseLabel(code) : `Key ${code}`
  const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, MAX_LABEL) : fallback
  return { kind: b.kind, code, label }
}

function setBinding(next: PttBinding | null): PttStatus {
  release()
  binding = next
  if (!next) {
    stopIfIdle()
    return { active: false }
  }
  const status = ensureRunning()
  if (!status.active) binding = null
  return status
}

function captureBinding(): Promise<PttBinding | null> {
  // One capture at a time: a second request while one is pending shares its result.
  if (capture) return capture.promise
  const status = ensureRunning()
  if (!status.active) return Promise.reject(new Error(status.reason ?? 'The global input hook is unavailable.'))
  release()
  let resolve!: (b: PttBinding | null) => void
  const promise = new Promise<PttBinding | null>((r) => (resolve = r))
  capture = { promise, resolve, timer: setTimeout(() => finishCapture(null), CAPTURE_TIMEOUT_MS) }
  return promise
}

function fromApp(event: IpcMainInvokeEvent): boolean {
  return isAppUrl(event.senderFrame?.url)
}

export function installPtt(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  ipcMain.handle(IPC.pttSetBinding, (event, raw: unknown) => {
    if (!fromApp(event)) throw new Error('forbidden')
    return setBinding(parseBinding(raw))
  })
  ipcMain.handle(IPC.pttCapture, (event) => {
    if (!fromApp(event)) throw new Error('forbidden')
    return captureBinding()
  })
  app.on('will-quit', () => {
    finishCapture(null)
    binding = null
    stopHook()
  })
}
