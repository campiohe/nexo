// Owner: workstream D (generalized to all global hotkeys, SPEC §13.2). Keeps the main-process global hook
// in sync with the keybind preferences, receives presses (global hook, or in-window keys/buttons as a
// fallback when the hook can't run), records keybinds, and exposes the push-to-talk mic gate
// (`usePtt().open`). session.ts applies the gate to the published mic track; the other global actions
// (toggle mute / deafen / share, leave voice) go to the handler registered with `setHotkeyHandler`.
//
// Initialized once at module load (session.ts imports this module), so React StrictMode double
// effects never register duplicate listeners.
import { create } from 'zustand'
import {
  effectiveMods,
  modifierOf,
  modsEqual,
  NO_MODS,
  type GlobalHotkeyAction,
  type HotkeyBindings,
  type HotkeyPhase,
  type HotkeyStatus,
  type Keybind,
  type KeybindCapture,
  type NexoBridge,
  type PttStatus,
} from '../../../preload/api'
import {
  domKey,
  domMods,
  domMouseButton,
  domPressMatches,
  isTypingTarget,
  makeKeybind,
  mouseButtonLabel,
  typesText,
} from '../lib/keybinds'
import { useInputPrefs, useKeybinds, type KeybindPrefs } from './prefs'

export interface PttState {
  /** Hook status while in PTT mode (null in voice-activity mode / pending). */
  status: PttStatus | null
  /** Result of the last global `setBindings` (null: pending / no bridge and nothing bound). */
  hookStatus: HotkeyStatus | null
  /** The bound key or button is physically held. */
  keyDown: boolean
  /** Mic gate: open while held and for the release delay afterwards. */
  open: boolean
  /** A keybind recording is in progress (see `recordKeybind`). */
  capturing: boolean
}

export const usePtt = create<PttState>()(() => ({
  status: null,
  hookStatus: null,
  keyDown: false,
  open: false,
  capturing: false,
}))

export type GlobalToggleAction = Exclude<GlobalHotkeyAction, 'ptt'>

const TOGGLES: readonly GlobalToggleAction[] = ['toggleMute', 'toggleDeafen', 'toggleShare', 'leaveVoice']

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
// Actions
// ---------------------------------------------------------------------------------------------

let toggleHandler: ((action: GlobalToggleAction) => void) | null = null

/** Register who performs the toggle actions (App.tsx). Returns an unregister function. */
export function setHotkeyHandler(fn: (action: GlobalToggleAction) => void): () => void {
  toggleHandler = fn
  return () => {
    if (toggleHandler === fn) toggleHandler = null
  }
}

function onHotkey(action: GlobalHotkeyAction, phase: HotkeyPhase): void {
  if (action === 'ptt') {
    setPttPressed(phase === 'down')
    return
  }
  if (phase !== 'down') return
  try {
    toggleHandler?.(action)
  } catch (e) {
    console.warn(`[voice] hotkey ${action} failed`, e)
  }
}

// ---------------------------------------------------------------------------------------------
// Global hook (main process)
// ---------------------------------------------------------------------------------------------

let syncSeq = 0

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'unknown error'
}

/** The bindings the global hook should watch (push to talk only in PTT mode). */
function globalBindings(): HotkeyBindings {
  const { inputMode, pttBinding } = useInputPrefs.getState()
  const kb = useKeybinds.getState()
  const out: HotkeyBindings = { ptt: inputMode === 'ptt' ? pttBinding : null }
  for (const a of TOGGLES) out[a] = kb[a]
  return out
}

function setHookStatus(hookStatus: HotkeyStatus | null): void {
  const ptt = useInputPrefs.getState().inputMode === 'ptt'
  usePtt.setState({ hookStatus, status: ptt ? (hookStatus ?? { active: false }) : null })
}

async function syncBindings(): Promise<void> {
  const bindings = globalBindings()
  const anyBound = Object.values(bindings).some(Boolean)
  const seq = ++syncSeq
  const hotkeys = bridge()?.hotkeys
  if (!hotkeys) {
    setHookStatus(
      anyBound || useInputPrefs.getState().inputMode === 'ptt'
        ? { active: false, reason: 'Global hotkeys need the Nexo desktop app. They only work while this window is focused.' }
        : null,
    )
    return
  }
  try {
    const status = await hotkeys.setBindings(bindings)
    if (seq === syncSeq) setHookStatus(status)
  } catch (e) {
    if (seq === syncSeq) setHookStatus({ active: false, reason: `Global hotkeys are unavailable (${errorText(e)}).` })
  }
}

const hookActive = (): boolean => usePtt.getState().hookStatus?.active === true

// ---------------------------------------------------------------------------------------------
// In-window fallback (only while the global hook is not active)
// ---------------------------------------------------------------------------------------------

function fallbackPtt(): Keybind | null {
  const { inputMode, pttBinding } = useInputPrefs.getState()
  if (inputMode !== 'ptt' || !pttBinding || hookActive()) return null
  return pttBinding
}

/** Toggle actions pressed through this in-window event (exact modifiers). */
function fallbackToggles(kind: Keybind['kind'], code: number | null, e: KeyboardEvent | MouseEvent): GlobalToggleAction[] {
  if (hookActive()) return []
  const kb = useKeybinds.getState()
  const typing = e instanceof KeyboardEvent && isTypingTarget(e.target)
  return TOGGLES.filter((a) => {
    const b = kb[a]
    return !!b && domPressMatches(b, kind, code, e) && !(typing && typesText(b))
  })
}

// ---------------------------------------------------------------------------------------------
// Keybind recording
// ---------------------------------------------------------------------------------------------

let captureSeq = 0
let localCapture: ((r: KeybindCapture) => void) | null = null
/** In-window recording: keys held since it started, and a modifier pressed alone (bound on release). */
const localHeld = new Set<string>()
let localLoneModifier: string | null = null

/**
 * Record the next combination: modifiers held + a non-modifier key or mouse button 3+, or a lone
 * modifier pressed and released alone. Esc cancels (null); Backspace/Delete without modifiers resolves
 * 'clear'. Uses the main-process hook when available (so e.g. side mouse buttons are seen exactly as the
 * hook reports them), else in-window events. While recording, key events never reach the rest of the
 * app (so Esc doesn't also close the Settings modal).
 */
export async function recordKeybind(): Promise<KeybindCapture> {
  const seq = ++captureSeq
  localCapture?.(null)
  localHeld.clear()
  localLoneModifier = null
  usePtt.setState({ capturing: true })
  try {
    const hotkeys = bridge()?.hotkeys
    const st = usePtt.getState().hookStatus
    // The hook can't run at all (Wayland, missing macOS permission…): record in-window instead.
    const hookUsable = !!hotkeys && !(st && !st.active && st.reason)
    let result: KeybindCapture = null
    let viaHook = false
    if (hotkeys && hookUsable) {
      const t0 = performance.now()
      let localDone = false
      // Race with the local listener so in-window Esc cancels right away.
      const local = waitLocal(true).then((r) => {
        localDone = true
        return r
      })
      try {
        result = await Promise.race([hotkeys.captureBinding(), local])
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

/**
 * @deprecated Use recordKeybind. Kept for the push-to-talk recorder in Audio & video: resolves the
 * combination, or null on cancel and on Backspace/Delete.
 */
export async function captureBinding(): Promise<Keybind | null> {
  const r = await recordKeybind()
  return r === 'clear' ? null : r
}

/** Abort a recording in progress (resolves it with null). */
export function cancelCapture(): void {
  captureSeq++
  localCapture?.(null)
  localCapture = null
  usePtt.setState({ capturing: false })
}

/** Resolve on the next in-window combination. With `escOnly`, only Esc (cancel) resolves it. */
function waitLocal(escOnly: boolean): Promise<KeybindCapture> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => finish(null), 15_000)
    const finish = (r: KeybindCapture) => {
      window.clearTimeout(timer)
      if (localCapture === handler) localCapture = null
      resolve(r)
    }
    const handler = (r: KeybindCapture) => {
      if (escOnly && r) return
      finish(r)
    }
    localCapture = handler
  })
}

function recordKeyDown(e: KeyboardEvent): void {
  if (e.code === 'Escape') {
    localCapture?.(null)
    return
  }
  const k = domKey(e.code)
  if (!k) return
  if (modifierOf('key', k[0])) {
    localLoneModifier = localHeld.size === 0 ? e.code : null
    localHeld.add(e.code)
    return
  }
  localHeld.add(e.code)
  localLoneModifier = null
  const mods = effectiveMods(domMods(e), 'key', k[0])
  if ((e.code === 'Backspace' || e.code === 'Delete') && modsEqual(mods, NO_MODS)) {
    localCapture?.('clear')
    return
  }
  localCapture?.(makeKeybind('key', k[0], k[1], mods))
}

function recordKeyUp(e: KeyboardEvent): void {
  const wasHeld = localHeld.delete(e.code)
  if (wasHeld && localLoneModifier === e.code && localHeld.size === 0) {
    const k = domKey(e.code)
    if (k) localCapture?.(makeKeybind('key', k[0], k[1], { ...NO_MODS }))
  }
  if (localHeld.size === 0) localLoneModifier = null
}

// ---------------------------------------------------------------------------------------------
// Window listeners (registered at module load: before any modal, so recording can swallow keys)
// ---------------------------------------------------------------------------------------------

function onKeyDown(e: KeyboardEvent): void {
  if (usePtt.getState().capturing) {
    e.preventDefault()
    e.stopImmediatePropagation()
    if (!e.repeat) recordKeyDown(e)
    return
  }
  const code = domKey(e.code)?.[0] ?? null
  if (code === null) return
  const ptt = fallbackPtt()
  if (ptt && domPressMatches(ptt, 'key', code, e, true) && !(isTypingTarget(e.target) && typesText(ptt))) {
    if (!e.repeat) setPttPressed(true)
  }
  const toggles = fallbackToggles('key', code, e)
  if (toggles.length === 0) return
  e.preventDefault()
  if (!e.repeat) toggles.forEach((a) => onHotkey(a, 'down'))
}

function onKeyUp(e: KeyboardEvent): void {
  if (usePtt.getState().capturing) {
    e.preventDefault()
    e.stopImmediatePropagation()
    recordKeyUp(e)
    return
  }
  const b = fallbackPtt()
  if (!b || b.kind !== 'key' || !usePtt.getState().keyDown) return
  if (domKey(e.code)?.[0] === b.code) setPttPressed(false)
}

function onMouseDown(e: MouseEvent): void {
  const btn = domMouseButton(e.button)
  if (usePtt.getState().capturing) {
    if (btn === null) return
    e.preventDefault()
    localCapture?.(makeKeybind('mouse', btn, mouseButtonLabel(btn), domMods(e)))
    return
  }
  if (btn === null) return
  if (domPressMatches(fallbackPtt(), 'mouse', btn, e, true)) setPttPressed(true)
  const toggles = fallbackToggles('mouse', btn, e)
  if (toggles.length === 0) return
  e.preventDefault()
  toggles.forEach((a) => onHotkey(a, 'down'))
}

function onMouseUp(e: MouseEvent): void {
  const btn = domMouseButton(e.button)
  if (btn === null) return
  const b = usePtt.getState().capturing ? null : fallbackPtt()
  if (btn >= 4) e.preventDefault() // side buttons: no history navigation
  if (b?.kind === 'mouse' && btn === b.code && usePtt.getState().keyDown) setPttPressed(false)
}

function onBlur(): void {
  // The in-window fallback can't see the release once the window loses focus.
  if (fallbackPtt() && usePtt.getState().keyDown) setPttPressed(false)
}

function onFocus(): void {
  // The hook couldn't start (e.g. macOS permission just granted in System Settings): try again.
  const st = usePtt.getState().hookStatus
  if (st && !st.active && st.reason && Object.values(globalBindings()).some(Boolean)) void syncBindings()
}

const globalKeybindsChanged = (a: KeybindPrefs, b: KeybindPrefs): boolean => TOGGLES.some((k) => a[k] !== b[k])

function init(): () => void {
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('mousedown', onMouseDown, true)
  window.addEventListener('mouseup', onMouseUp, true)
  window.addEventListener('blur', onBlur)
  window.addEventListener('focus', onFocus)

  let offAction: (() => void) | undefined
  try {
    offAction = bridge()?.hotkeys?.onAction(onHotkey)
  } catch (e) {
    console.warn('[voice] hotkeys.onAction unavailable', e)
  }

  const offPrefs = useInputPrefs.subscribe((s, prev) => {
    if (s.inputMode !== prev.inputMode || s.pttBinding !== prev.pttBinding) {
      closeGateNow()
      void syncBindings()
    }
  })
  const offKeybinds = useKeybinds.subscribe((s, prev) => {
    if (globalKeybindsChanged(s, prev)) void syncBindings()
  })
  void syncBindings()

  return () => {
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('keyup', onKeyUp, true)
    window.removeEventListener('mousedown', onMouseDown, true)
    window.removeEventListener('mouseup', onMouseUp, true)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('focus', onFocus)
    offAction?.()
    offPrefs()
    offKeybinds()
    closeGateNow()
  }
}

const dispose = init()

if (import.meta.hot) {
  import.meta.hot.dispose(() => dispose())
}
