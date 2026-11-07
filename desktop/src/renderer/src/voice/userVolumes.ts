// Owner: workstream D. Per-user voice volume + "mute for me", persisted locally (keyed by userId =
// LiveKit identity). Applied to remote microphone tracks by session.ts; stream audio is separate.
import { create } from 'zustand'

export const USER_VOLUME_MAX = 2

export interface UserVolumesState {
  /** userId -> volume 0..2 (missing = 1). */
  volumes: Record<string, number>
  /** userId -> muted locally. */
  muted: Record<string, true>
}

const STORAGE_KEY = 'nexo.userVolumes'

export function clampUserVolume(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.round(Math.min(USER_VOLUME_MAX, Math.max(0, v)) * 100) / 100
}

function load(): UserVolumesState {
  const empty: UserVolumesState = { volumes: {}, muted: {} }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const parsed = JSON.parse(raw) as Partial<UserVolumesState>
    const volumes: Record<string, number> = {}
    const muted: Record<string, true> = {}
    if (parsed.volumes && typeof parsed.volumes === 'object') {
      for (const [id, v] of Object.entries(parsed.volumes)) {
        if (typeof v === 'number' && Number.isFinite(v) && v !== 1) volumes[id] = clampUserVolume(v)
      }
    }
    if (parsed.muted && typeof parsed.muted === 'object') {
      for (const [id, m] of Object.entries(parsed.muted)) if (m === true) muted[id] = true
    }
    return { volumes, muted }
  } catch {
    return empty
  }
}

export const useUserVolumes = create<UserVolumesState>()(() => load())

export function persistUserVolumes(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(useUserVolumes.getState()))
  } catch {
    /* storage unavailable: keep in memory only */
  }
}
