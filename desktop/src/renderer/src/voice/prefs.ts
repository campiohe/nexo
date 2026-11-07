// Owner: workstream D. Persisted voice input preferences (voice activity vs push to talk).
import { create } from 'zustand'
import type { PttBinding } from '../../../preload/api'

export type InputMode = 'voice' | 'ptt'

export interface InputPrefs {
  inputMode: InputMode
  /** Global push-to-talk key / mouse button (null = not set yet). */
  pttBinding: PttBinding | null
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

function parseBinding(v: unknown): PttBinding | null {
  if (!v || typeof v !== 'object') return null
  const b = v as Partial<PttBinding>
  if ((b.kind !== 'key' && b.kind !== 'mouse') || typeof b.code !== 'number' || !Number.isFinite(b.code)) return null
  return { kind: b.kind, code: b.code, label: typeof b.label === 'string' && b.label ? b.label : `Key ${b.code}` }
}

function load(): InputPrefs {
  const defaults: InputPrefs = { inputMode: 'voice', pttBinding: null, pttReleaseDelayMs: PTT_RELEASE_DELAY_DEFAULT }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<InputPrefs>
    return {
      inputMode: parsed.inputMode === 'ptt' ? 'ptt' : 'voice',
      pttBinding: parseBinding(parsed.pttBinding),
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
