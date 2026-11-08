// Owner: workstream D. Persisted voice input preferences (voice activity vs push to talk) and the other
// keybinds (SPEC §13.2), both in renderer localStorage.
import { create } from 'zustand'
import type { Keybind } from '../../../preload/api'
import { defaultInAppBinding, parseKeybind, type HotkeyAction, type InAppAction } from '../lib/keybinds'

export type InputMode = 'voice' | 'ptt'

export interface InputPrefs {
  inputMode: InputMode
  /** Global push-to-talk combination (null = not set yet). */
  pttBinding: Keybind | null
  /** How long the mic stays open after the PTT key is released, in ms (0–1000). */
  pttReleaseDelayMs: number
}

export const PTT_RELEASE_DELAY_DEFAULT = 200
export const PTT_RELEASE_DELAY_MAX = 1000

const STORAGE_KEY = 'nexo.voiceInput'

function clampDelay(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : PTT_RELEASE_DELAY_DEFAULT
  return Math.round(Math.min(PTT_RELEASE_DELAY_MAX, Math.max(0, n)))
}

function load(): InputPrefs {
  const defaults: InputPrefs = { inputMode: 'voice', pttBinding: null, pttReleaseDelayMs: PTT_RELEASE_DELAY_DEFAULT }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<InputPrefs>
    return {
      inputMode: parsed.inputMode === 'ptt' ? 'ptt' : 'voice',
      pttBinding: parseKeybind(parsed.pttBinding),
      pttReleaseDelayMs: clampDelay(parsed.pttReleaseDelayMs),
    }
  } catch {
    return defaults
  }
}

/** Read with `useInputPrefs((s) => s.inputMode)`; change with `setInputPrefs`. */
export const useInputPrefs = create<InputPrefs>()(() => load())

export function setInputPrefs(patch: Partial<InputPrefs>): void {
  const next: Partial<InputPrefs> = { ...patch }
  if (patch.pttReleaseDelayMs !== undefined) next.pttReleaseDelayMs = clampDelay(patch.pttReleaseDelayMs)
  useInputPrefs.setState(next)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(useInputPrefs.getState()))
  } catch {
    /* storage unavailable: keep in memory only */
  }
}

// ---------------------------------------------------------------------------------------------
// Keybinds other than push to talk (which stays in InputPrefs.pttBinding)
// ---------------------------------------------------------------------------------------------

export type KeybindPrefs = Record<Exclude<HotkeyAction, 'ptt'>, Keybind | null>

const KEYBINDS_KEY = 'nexo.keybinds'

const IN_APP: readonly InAppAction[] = ['quickSwitcher', 'openSettings']

function loadKeybinds(): KeybindPrefs {
  let parsed: Partial<Record<keyof KeybindPrefs, unknown>> = {}
  try {
    const raw = localStorage.getItem(KEYBINDS_KEY)
    if (raw) {
      const v: unknown = JSON.parse(raw)
      if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as typeof parsed
    }
  } catch {
    /* corrupt or unavailable: defaults */
  }
  // In-app shortcuts: missing = default, null = cleared by the user.
  const inApp = (a: InAppAction): Keybind | null => (a in parsed ? parseKeybind(parsed[a]) : defaultInAppBinding(a))
  return {
    toggleMute: parseKeybind(parsed.toggleMute),
    toggleDeafen: parseKeybind(parsed.toggleDeafen),
    toggleShare: parseKeybind(parsed.toggleShare),
    leaveVoice: parseKeybind(parsed.leaveVoice),
    quickSwitcher: inApp('quickSwitcher'),
    openSettings: inApp('openSettings'),
  }
}

/** Read with `useKeybinds((s) => s.toggleMute)`; change with `setKeybind`. */
export const useKeybinds = create<KeybindPrefs>()(() => loadKeybinds())

/** Every action's binding (push to talk included). */
export function allKeybinds(): Record<HotkeyAction, Keybind | null> {
  return { ...useKeybinds.getState(), ptt: useInputPrefs.getState().pttBinding }
}

/** Bind (or clear, with null) an action. Conflicts are the caller's job (see findConflict). */
export function setKeybind(action: HotkeyAction, binding: Keybind | null): void {
  if (action === 'ptt') {
    setInputPrefs({ pttBinding: binding })
    return
  }
  useKeybinds.setState({ [action]: binding } as Partial<KeybindPrefs>)
  try {
    localStorage.setItem(KEYBINDS_KEY, JSON.stringify(useKeybinds.getState()))
  } catch {
    /* storage unavailable: keep in memory only */
  }
}

export function isInAppAction(action: HotkeyAction): action is InAppAction {
  return (IN_APP as readonly HotkeyAction[]).includes(action)
}
