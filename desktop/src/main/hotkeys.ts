// Global hotkeys: a system-wide keyboard/mouse hook (uiohook-napi) that works while games have focus.
// Push to talk (pressed/released) plus toggle mute / deafen / screen share and leave voice (fire once per
// press). One hook runs while any binding is set (or a binding is being recorded).
//
// The native module is loaded lazily, on the first setBindings()/captureBinding() that needs the hook, so a
// missing or broken prebuild can never crash startup: it only turns into HotkeyStatus { active: false, reason }.
import { app, ipcMain, systemPreferences, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { UiohookKeyboardEvent, UiohookMouseEvent } from 'uiohook-napi'
import {
  effectiveMods,
  formatKeybindLabel,
  GLOBAL_HOTKEY_ACTIONS,
  IPC,
  modifierOf,
  modsEqual,
  modsInclude,
  NO_MODS,
  type GlobalHotkeyAction,
  type HotkeyPhase,
  type HotkeyStatus,
  type Keybind,
  type KeybindCapture,
  type KeybindMods,
} from '../preload/api'
import { platform } from './platform'
import { isAppUrl } from './security'

type UiohookModule = typeof import('uiohook-napi')
type Bindings = Record<GlobalHotkeyAction, Keybind | null>

const CAPTURE_TIMEOUT_MS = 15_000
/** How long after a global toggleShare press the renderer may bring the window to the front. */
const FOCUS_GRANT_MS = 3_000
const ESCAPE = 0x0001 // UiohookKey.Escape
const BACKSPACE = 0x000e
const DELETE = 0x0e53
const MAX_KEYCODE = 0xffff
const MAX_MOUSE_BUTTON = 32
const MAX_LABEL = 64

interface Capture {
  promise: Promise<KeybindCapture>
  resolve(result: KeybindCapture): void
  timer: NodeJS.Timeout
  /** Keys pressed since the recording started and still held. */
  held: Set<number>
  /** A modifier pressed while nothing else was held: bound if it's released before any other key. */
  loneModifier: number | null
}

interface Deps {
  getWindow(): BrowserWindow | null
  /** Show (even from the tray), restore and focus the main window. */
  focusWindow(): void
}

const emptyBindings = (): Bindings => ({ ptt: null, toggleMute: null, toggleDeafen: null, toggleShare: null, leaveVoice: null })

let deps: Deps = { getWindow: () => null, focusWindow: () => {} }
let hook: UiohookModule | null = null
let loadError: string | null = null
let running = false
let bindings: Bindings = emptyBindings()
/** Actions whose combination is currently held (sent 'down', 'up' pending). */
const pressed = new Set<GlobalHotkeyAction>()
/** Keys currently held down, to tell OS auto-repeat keydowns from real presses. */
const heldKeys = new Set<number>()
let capture: Capture | null = null
let keyNames: Map<number, string> | null = null
let focusGrantUntil = 0

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const anyBinding = (): boolean => GLOBAL_HOTKEY_ACTIONS.some((a) => bindings[a] !== null)

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

function makeKeybind(kind: Keybind['kind'], code: number, mods: KeybindMods): Keybind {
  const key = kind === 'mouse' ? mouseLabel(code) : keyLabel(code)
  return { kind, code, mods, label: formatKeybindLabel(mods, key, platform) }
}

// ── Hook lifecycle ──────────────────────────────────────────────────────────────────────────────────────

function isWayland(): boolean {
  return (process.env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland' || !!process.env.WAYLAND_DISPLAY
}

/** Reasons the hook can't work on this system, checked before touching the native module. */
function platformBlocker(): string | null {
  if (platform === 'linux' && isWayland()) {
    return "Global hotkeys need an X11 session: Wayland doesn't let apps see keys pressed in other windows."
  }
  if (platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
    return 'Global hotkeys need the Accessibility permission. Allow Nexo in System Settings → Privacy & Security → Accessibility, then set a key again (restart Nexo if it still doesn’t work).'
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

function ensureRunning(): HotkeyStatus {
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
    if (!anyBinding() && !capture) stopHook()
  })
}

function currentStatus(): HotkeyStatus {
  if (running && anyBinding()) return { active: true }
  const reason = platformBlocker() ?? loadError
  return reason ? { active: false, reason } : { active: false }
}

// ── Events ──────────────────────────────────────────────────────────────────────────────────────────────

function emit(action: GlobalHotkeyAction, phase: HotkeyPhase): void {
  if (action === 'toggleShare' && phase === 'down') focusGrantUntil = Date.now() + FOCUS_GRANT_MS
  try {
    const win = deps.getWindow()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) return
    win.webContents.send(IPC.hotkeysAction, { action, phase })
  } catch (err) {
    console.warn('[nexo] could not deliver a hotkey:', err)
  }
}

/** Ends the presses in progress (bindings changed, recording started), so the renderer never stays "talking". */
function releaseAll(): void {
  for (const action of [...pressed]) {
    pressed.delete(action)
    emit(action, 'up')
  }
}

function finishCapture(result: KeybindCapture): void {
  const c = capture
  if (!c) return
  capture = null
  clearTimeout(c.timer)
  c.resolve(result)
  stopIfIdle()
}

function heldMods(e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }): KeybindMods {
  return { ctrl: !!e.ctrlKey, shift: !!e.shiftKey, alt: !!e.altKey, meta: !!e.metaKey }
}

/** A main key/button went down (not an auto-repeat): start every action whose combination matches. */
function press(kind: Keybind['kind'], code: number, held: KeybindMods): void {
  const mods = effectiveMods(held, kind, code)
  for (const action of GLOBAL_HOTKEY_ACTIONS) {
    const b = bindings[action]
    if (!b || b.kind !== kind || b.code !== code || pressed.has(action)) continue
    // Push to talk keeps talking with extra modifiers (PTT + Shift); toggles need exactly theirs.
    const hit = action === 'ptt' ? modsInclude(mods, b.mods) : modsEqual(mods, b.mods)
    if (!hit) continue
    pressed.add(action)
    emit(action, 'down')
  }
}

/** A main key/button was released: end every action pressed through it. */
function unpress(kind: Keybind['kind'], code: number): void {
  for (const action of [...pressed]) {
    const b = bindings[action]
    if (b && (b.kind !== kind || b.code !== code)) continue
    pressed.delete(action)
    emit(action, 'up')
  }
}

function captureKeyDown(c: Capture, code: number, held: KeybindMods): void {
  if (code === ESCAPE) return finishCapture(null)
  const own = modifierOf('key', code)
  if (own) {
    c.loneModifier = c.held.size === 0 ? code : null
    c.held.add(code)
    return
  }
  c.held.add(code)
  c.loneModifier = null
  const mods = effectiveMods(held, 'key', code)
  if ((code === BACKSPACE || code === DELETE) && modsEqual(mods, NO_MODS)) return finishCapture('clear')
  finishCapture(makeKeybind('key', code, mods))
}

function captureKeyUp(c: Capture, code: number): void {
  const wasHeld = c.held.delete(code)
  if (wasHeld && c.loneModifier === code && c.held.size === 0) {
    finishCapture(makeKeybind('key', code, { ...NO_MODS }))
    return
  }
  if (c.held.size === 0) c.loneModifier = null
}

// Listeners run inside a native N-API callback: an exception escaping here aborts the process, so each one
// is fully guarded.
function onKeyDown(e: UiohookKeyboardEvent): void {
  try {
    // OS auto-repeat sends keydown again while a key is held; only the first one counts.
    const repeat = heldKeys.has(e.keycode)
    heldKeys.add(e.keycode)
    if (repeat) return
    if (capture) return captureKeyDown(capture, e.keycode, heldMods(e))
    press('key', e.keycode, heldMods(e))
  } catch (err) {
    console.warn('[nexo] hotkey keydown handler failed:', err)
  }
}

function onKeyUp(e: UiohookKeyboardEvent): void {
  try {
    heldKeys.delete(e.keycode)
    if (capture) return captureKeyUp(capture, e.keycode)
    unpress('key', e.keycode)
  } catch (err) {
    console.warn('[nexo] hotkey keyup handler failed:', err)
  }
}

function onMouseDown(e: UiohookMouseEvent): void {
  try {
    const button = Number(e.button)
    if (!Number.isInteger(button) || button < 3) return // left / right click are never bindable
    if (capture) return finishCapture(makeKeybind('mouse', button, heldMods(e)))
    press('mouse', button, heldMods(e))
  } catch (err) {
    console.warn('[nexo] hotkey mousedown handler failed:', err)
  }
}

function onMouseUp(e: UiohookMouseEvent): void {
  try {
    const button = Number(e.button)
    if (!Number.isInteger(button) || button < 3) return
    unpress('mouse', button)
  } catch (err) {
    console.warn('[nexo] hotkey mouseup handler failed:', err)
  }
}

// ── API ─────────────────────────────────────────────────────────────────────────────────────────────────

function parseMods(raw: unknown): KeybindMods {
  if (raw === undefined || raw === null) return { ...NO_MODS } // bindings stored before modifiers existed
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('binding.mods must be an object')
  const m = raw as Record<string, unknown>
  const flag = (k: keyof KeybindMods): boolean => {
    const v = m[k]
    if (v === undefined) return false
    if (typeof v !== 'boolean') throw new TypeError(`binding.mods.${k} must be a boolean`)
    return v
  }
  return { ctrl: flag('ctrl'), shift: flag('shift'), alt: flag('alt'), meta: flag('meta') }
}

function parseBinding(raw: unknown): Keybind | null {
  if (raw === null || raw === undefined) return null
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
  // A lone modifier is bound alone: its own modifier flag is meaningless.
  const mods = effectiveMods(parseMods(b.mods), b.kind, code)
  const fallback = b.kind === 'mouse' ? mouseLabel(code) : `Key ${code}`
  const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, MAX_LABEL) : fallback
  return { kind: b.kind, code, mods, label }
}

function parseBindings(raw: unknown): Bindings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('bindings must be an object')
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!GLOBAL_HOTKEY_ACTIONS.includes(key as GlobalHotkeyAction)) throw new TypeError(`unknown hotkey action: ${key}`)
  }
  const next = emptyBindings()
  for (const action of GLOBAL_HOTKEY_ACTIONS) next[action] = parseBinding(input[action])
  return next
}

function setBindings(next: Bindings): HotkeyStatus {
  releaseAll()
  bindings = next
  if (!anyBinding()) {
    stopIfIdle()
    return { active: false }
  }
  const status = ensureRunning()
  // Without the hook nothing can fire; the renderer falls back to in-window handling.
  if (!status.active) bindings = emptyBindings()
  return status
}

function captureBinding(): Promise<KeybindCapture> {
  // One capture at a time: a second request while one is pending shares its result.
  if (capture) return capture.promise
  const status = ensureRunning()
  if (!status.active) return Promise.reject(new Error(status.reason ?? 'The global input hook is unavailable.'))
  releaseAll()
  let resolve!: (r: KeybindCapture) => void
  const promise = new Promise<KeybindCapture>((r) => (resolve = r))
  capture = {
    promise,
    resolve,
    timer: setTimeout(() => finishCapture(null), CAPTURE_TIMEOUT_MS),
    held: new Set(),
    loneModifier: null,
  }
  return promise
}

function fromApp(event: { senderFrame?: { url?: string } | null }): boolean {
  return isAppUrl(event.senderFrame?.url)
}

function guarded<A extends unknown[], R>(fn: (...args: A) => R) {
  return (event: IpcMainInvokeEvent, ...args: A): R => {
    if (!fromApp(event)) throw new Error('forbidden')
    return fn(...args)
  }
}

export function installHotkeys(dependencies: Deps): void {
  deps = dependencies
  ipcMain.handle(
    IPC.hotkeysSetBindings,
    guarded((raw: unknown) => setBindings(parseBindings(raw))),
  )
  // Legacy nexo.ptt.setBinding: replaces the push-to-talk slot only.
  ipcMain.handle(
    IPC.pttSetBinding,
    guarded((raw: unknown) => setBindings({ ...bindings, ptt: parseBinding(raw) })),
  )
  ipcMain.handle(
    IPC.hotkeysCapture,
    guarded(() => captureBinding()),
  )
  ipcMain.handle(
    IPC.hotkeysStatus,
    guarded(() => currentStatus()),
  )
  ipcMain.on(IPC.hotkeysFocus, (event) => {
    if (!fromApp(event) || Date.now() > focusGrantUntil) return
    focusGrantUntil = 0
    deps.focusWindow()
  })
  app.on('will-quit', () => {
    finishCapture(null)
    bindings = emptyBindings()
    pressed.clear()
    stopHook()
  })
}
