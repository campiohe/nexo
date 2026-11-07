// Owner: workstream D. Push-to-talk input: keeps the main-process global hook in sync with the
// preferences, listens for presses (global hook, or in-window keys/buttons as a fallback) and
// exposes the mic gate (`usePtt().open`). session.ts applies the gate to the published mic track.
//
// Initialized once at module load (session.ts imports this module), so React StrictMode double
// effects never register duplicate listeners.
import { create } from 'zustand'
import type { NexoBridge, PttBinding, PttStatus } from '../../../preload/api'
import { useInputPrefs } from './prefs'

export interface PttState {
  /** Result of the last `setBinding` while in PTT mode (null in voice-activity mode / pending). */
  status: PttStatus | null
  /** The bound key or button is physically held. */
  keyDown: boolean
  /** Mic gate: open while held and for the release delay afterwards. */
  open: boolean
  /** A keybind recording is in progress (see `captureBinding`). */
  capturing: boolean
}

export const usePtt = create<PttState>()(() => ({ status: null, keyDown: false, open: false, capturing: false }))

function bridge(): NexoBridge | undefined {
  return (window as { nexo?: NexoBridge }).nexo
}

// ---------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------

let releaseTimer: number | undefined

function closeGateNow(): void {
  window.clearTimeout(releaseTimer)
  releaseTimer = undefined
  const s = usePtt.getState()
  if (s.keyDown || s.open) usePtt.setState({ keyDown: false, open: false })
}

/** Feed a press (true) or release (false) of the PTT binding. */
export function setPttPressed(pressed: boolean): void {
  if (useInputPrefs.getState().inputMode !== 'ptt') {
    closeGateNow()
    return
  }
  const s = usePtt.getState()
  if (pressed) {
    window.clearTimeout(releaseTimer)
    releaseTimer = undefined
    if (!s.keyDown || !s.open) usePtt.setState({ keyDown: true, open: true })
    return
  }
  if (!s.keyDown) return
  const delay = useInputPrefs.getState().pttReleaseDelayMs
  window.clearTimeout(releaseTimer)
  releaseTimer = undefined
  if (delay <= 0) {
    usePtt.setState({ keyDown: false, open: false })
    return
  }
  usePtt.setState({ keyDown: false })
  releaseTimer = window.setTimeout(() => {
    releaseTimer = undefined
    if (!usePtt.getState().keyDown) usePtt.setState({ open: false })
  }, delay)
}

// ---------------------------------------------------------------------------------------------
// Global hook (main process)
// ---------------------------------------------------------------------------------------------

let syncSeq = 0

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'unknown error'
}

async function syncBinding(): Promise<void> {
  const { inputMode, pttBinding } = useInputPrefs.getState()
  const seq = ++syncSeq
  const ptt = bridge()?.ptt
  if (!ptt) {
    usePtt.setState({
      status:
        inputMode === 'ptt'
          ? { active: false, reason: 'Global push to talk needs the Nexo desktop app. It only works while this window is focused.' }
          : null,
    })
    return
  }
  try {
    const status = await ptt.setBinding(inputMode === 'ptt' ? pttBinding : null)
    if (seq !== syncSeq) return
    usePtt.setState({ status: inputMode === 'ptt' ? status : null })
  } catch (e) {
    if (seq !== syncSeq) return
    usePtt.setState({
      status: inputMode === 'ptt' ? { active: false, reason: `Global push to talk is unavailable (${errorText(e)}).` } : null,
    })
  }
}

// ---------------------------------------------------------------------------------------------
// DOM <-> uiohook codes (in-window fallback + local keybind capture)
// ---------------------------------------------------------------------------------------------

/** KeyboardEvent.code -> [uiohook keycode, label]. Matches uiohook-napi's `UiohookKey`. */
const DOM_KEYS: Record<string, [number, string]> = {
  Backspace: [0x000e, 'Backspace'],
  Tab: [0x000f, 'Tab'],
  Enter: [0x001c, 'Enter'],
  CapsLock: [0x003a, 'Caps Lock'],
  Escape: [0x0001, 'Esc'],
  Space: [0x0039, 'Space'],
  PageUp: [0x0e49, 'Page Up'],
  PageDown: [0x0e51, 'Page Down'],
  End: [0x0e4f, 'End'],
  Home: [0x0e47, 'Home'],
  ArrowLeft: [0xe04b, 'Left'],
  ArrowUp: [0xe048, 'Up'],
  ArrowRight: [0xe04d, 'Right'],
  ArrowDown: [0xe050, 'Down'],
  Insert: [0x0e52, 'Insert'],
  Delete: [0x0e53, 'Delete'],
  Numpad0: [0x0052, 'Num 0'],
  Numpad1: [0x004f, 'Num 1'],
  Numpad2: [0x0050, 'Num 2'],
  Numpad3: [0x0051, 'Num 3'],
  Numpad4: [0x004b, 'Num 4'],
  Numpad5: [0x004c, 'Num 5'],
  Numpad6: [0x004d, 'Num 6'],
  Numpad7: [0x0047, 'Num 7'],
  Numpad8: [0x0048, 'Num 8'],
  Numpad9: [0x0049, 'Num 9'],
  NumpadMultiply: [0x0037, 'Num *'],
  NumpadAdd: [0x004e, 'Num +'],
  NumpadSubtract: [0x004a, 'Num -'],
  NumpadDecimal: [0x0053, 'Num .'],
  NumpadDivide: [0x0e35, 'Num /'],
  NumpadEnter: [0x0e1c, 'Num Enter'],
  Semicolon: [0x0027, ';'],
  Equal: [0x000d, '='],
  Comma: [0x0033, ','],
  Minus: [0x000c, '-'],
  Period: [0x0034, '.'],
  Slash: [0x0035, '/'],
  Backquote: [0x0029, '`'],
  BracketLeft: [0x001a, '['],
  Backslash: [0x002b, '\\'],
  BracketRight: [0x001b, ']'],
  Quote: [0x0028, "'"],
  ControlLeft: [0x001d, 'Left Ctrl'],
  ControlRight: [0x0e1d, 'Right Ctrl'],
  AltLeft: [0x0038, 'Left Alt'],
  AltRight: [0x0e38, 'Right Alt'],
  ShiftLeft: [0x002a, 'Left Shift'],
  ShiftRight: [0x0036, 'Right Shift'],
  MetaLeft: [0x0e5b, 'Left Meta'],
  MetaRight: [0x0e5c, 'Right Meta'],
  NumLock: [0x0045, 'Num Lock'],
  ScrollLock: [0x0046, 'Scroll Lock'],
  PrintScreen: [0x0e37, 'Print Screen'],
}
const LETTERS: Record<string, number> = {
  A: 0x1e, B: 0x30, C: 0x2e, D: 0x20, E: 0x12, F: 0x21, G: 0x22, H: 0x23, I: 0x17, J: 0x24, K: 0x25, L: 0x26, M: 0x32,
  N: 0x31, O: 0x18, P: 0x19, Q: 0x10, R: 0x13, S: 0x1f, T: 0x14, U: 0x16, V: 0x2f, W: 0x11, X: 0x2d, Y: 0x15, Z: 0x2c,
}
const DIGITS = [0x0b, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a]
const FKEYS = [
  0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58, 0x5b, 0x5c, 0x5d, 0x63, 0x64, 0x65, 0x66, 0x67,
  0x68, 0x69, 0x6a, 0x6b,
]

function domKey(code: string): [number, string] | null {
  const known = DOM_KEYS[code]
  if (known) return known
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return [LETTERS[m[1]], m[1]]
  m = /^Digit([0-9])$/.exec(code)
  if (m) return [DIGITS[Number(m[1])], m[1]]
  m = /^F([0-9]{1,2})$/.exec(code)
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 24) return [FKEYS[Number(m[1]) - 1], `F${m[1]}`]
  return null
}

/** MouseEvent.button (0 left, 1 middle, 2 right, 3 back, 4 forward) -> uiohook button (1..5). */
function domMouseButton(button: number): number | null {
  if (button === 1) return 3
  if (button === 3) return 4
  if (button === 4) return 5
  return null // left/right are never PTT bindings
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true
  if (t instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file'].includes(t.type)
  }
  return false
}

/** The binding the in-window fallback should react to (only when the global hook is not active). */
function fallbackBinding(): PttBinding | null {
  const { inputMode, pttBinding } = useInputPrefs.getState()
  if (inputMode !== 'ptt' || !pttBinding) return null
  if (usePtt.getState().status?.active) return null
  return pttBinding
}

// ---------------------------------------------------------------------------------------------
// Keybind capture
// ---------------------------------------------------------------------------------------------

let captureSeq = 0
let localCapture: ((b: PttBinding | null) => void) | null = null

/**
 * Record the next key / mouse button. Uses the main-process hook when available (so e.g. side
 * mouse buttons are seen exactly as the hook reports them), else in-window events. Esc cancels
 * (resolves null). While recording, key events never reach the rest of the app (so Esc doesn't
 * also close the Settings modal).
 */
export async function captureBinding(): Promise<PttBinding | null> {
  const seq = ++captureSeq
  localCapture?.(null)
  usePtt.setState({ capturing: true })
  try {
    const ptt = bridge()?.ptt
    const st = usePtt.getState().status
    // The hook can't run at all (Wayland, missing macOS permission…): record in-window instead.
    const hookUsable = !!ptt && !(st && !st.active && st.reason)
    let result: PttBinding | null = null
    let viaHook = false
    if (ptt && hookUsable) {
      const t0 = performance.now()
      let localDone = false
      // Race with the local listener so in-window Esc cancels right away.
      const local = waitLocal(true).then((b) => {
        localDone = true
        return b
      })
      try {
        result = await Promise.race([ptt.captureBinding(), local])
        // An instant null without Esc means the hook couldn't capture: fall back to in-window.
        viaHook = !(result === null && !localDone && performance.now() - t0 < 500)
      } catch {
        viaHook = false
      }
    }
    if (!viaHook) result = await waitLocal(false)
    return seq === captureSeq ? result : null
  } finally {
    if (seq === captureSeq) {
      localCapture = null
      usePtt.setState({ capturing: false })
    }
  }
}

/** Abort a recording in progress (resolves it with null). */
export function cancelCapture(): void {
  captureSeq++
  localCapture?.(null)
  localCapture = null
  usePtt.setState({ capturing: false })
}

/** Resolve on the next in-window key / button. With `escOnly`, only Esc (cancel) resolves it. */
function waitLocal(escOnly: boolean): Promise<PttBinding | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => finish(null), 15_000)
    const finish = (b: PttBinding | null) => {
      window.clearTimeout(timer)
      if (localCapture === handler) localCapture = null
      resolve(b)
    }
    const handler = (b: PttBinding | null) => {
      if (escOnly && b) return
      finish(b)
    }
    localCapture = handler
  })
}

// ---------------------------------------------------------------------------------------------
// Window listeners (registered at module load: before any modal, so capture can swallow keys)
// ---------------------------------------------------------------------------------------------

function onKeyDown(e: KeyboardEvent): void {
  if (usePtt.getState().capturing) {
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.repeat) return
    if (e.code === 'Escape') {
      localCapture?.(null)
      return
    }
    const k = domKey(e.code)
    if (k) localCapture?.({ kind: 'key', code: k[0], label: k[1] })
    return
  }
  const b = fallbackBinding()
  if (!b || b.kind !== 'key') return
  const k = domKey(e.code)
  if (!k || k[0] !== b.code) return
  if (isTypingTarget(e.target)) return
  if (!e.repeat) setPttPressed(true)
}

function onKeyUp(e: KeyboardEvent): void {
  if (usePtt.getState().capturing) {
    e.preventDefault()
    e.stopImmediatePropagation()
    return
  }
  const b = fallbackBinding()
  if (!b || b.kind !== 'key' || !usePtt.getState().keyDown) return
  const k = domKey(e.code)
  if (k && k[0] === b.code) setPttPressed(false)
}

function onMouseDown(e: MouseEvent): void {
  const btn = domMouseButton(e.button)
  if (usePtt.getState().capturing) {
    if (btn === null) return
    e.preventDefault()
    localCapture?.({ kind: 'mouse', code: btn, label: btn === 3 ? 'Middle Mouse' : `Mouse ${btn}` })
    return
  }
  const b = fallbackBinding()
  if (b?.kind === 'mouse' && btn === b.code) setPttPressed(true)
}

function onMouseUp(e: MouseEvent): void {
  const btn = domMouseButton(e.button)
  if (btn === null) return
  const b = usePtt.getState().capturing ? null : fallbackBinding()
  if (btn >= 4) e.preventDefault() // side buttons: no history navigation
  if (b?.kind === 'mouse' && btn === b.code && usePtt.getState().keyDown) setPttPressed(false)
}

function onBlur(): void {
  // The in-window fallback can't see the release once the window loses focus.
  if (fallbackBinding() && usePtt.getState().keyDown) setPttPressed(false)
}

function init(): () => void {
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('mousedown', onMouseDown, true)
  window.addEventListener('mouseup', onMouseUp, true)
  window.addEventListener('blur', onBlur)

  let offChange: (() => void) | undefined
  try {
    offChange = bridge()?.ptt?.onChange((pressed) => setPttPressed(pressed))
  } catch (e) {
    console.warn('[voice] ptt.onChange unavailable', e)
  }

  const offPrefs = useInputPrefs.subscribe((s, prev) => {
    if (s.inputMode !== prev.inputMode || s.pttBinding !== prev.pttBinding) {
      closeGateNow()
      void syncBinding()
    }
  })
  void syncBinding()

  return () => {
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('keyup', onKeyUp, true)
    window.removeEventListener('mousedown', onMouseDown, true)
    window.removeEventListener('mouseup', onMouseUp, true)
    window.removeEventListener('blur', onBlur)
    offChange?.()
    offPrefs()
    closeGateNow()
  }
}

const dispose = init()

if (import.meta.hot) {
  import.meta.hot.dispose(() => dispose())
}
