// Music plugin preferences of this device (renderer localStorage, like voice/devices.ts): whether this device
// plays the channel's music at all, its volume, and ducking while people talk. Applied live by voice/musicPlayer.ts.
import { create } from 'zustand'

export interface MusicPrefs {
  /** Play the voice channel's music on this device ("Don't play music on this device" when false). */
  musicEnabled: boolean
  /** 0..1 slider position (the gain applied is its square, like the soundboard). */
  musicVolume: number
  /** Lower the music while anyone in the channel is speaking. */
  musicDuck: boolean
}

export const DEFAULT_MUSIC_VOLUME = 0.5
const STORAGE_KEY = 'nexo.music'

function clampUnit(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback
}

function load(): MusicPrefs {
  const defaults: MusicPrefs = { musicEnabled: true, musicVolume: DEFAULT_MUSIC_VOLUME, musicDuck: true }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<MusicPrefs> | null
    if (!parsed || typeof parsed !== 'object') return defaults
    return {
      musicEnabled: parsed.musicEnabled !== false,
      musicVolume: clampUnit(parsed.musicVolume, DEFAULT_MUSIC_VOLUME),
      musicDuck: parsed.musicDuck !== false,
    }
  } catch {
    return defaults
  }
}

/** Read with `useMusicPrefs((s) => s.musicVolume)`; change with `saveMusicPrefs`. */
export const useMusicPrefs = create<MusicPrefs>()(() => load())

export function saveMusicPrefs(patch: Partial<MusicPrefs>): void {
  const cur = useMusicPrefs.getState()
  const next: MusicPrefs = {
    musicEnabled: patch.musicEnabled ?? cur.musicEnabled,
    musicVolume: patch.musicVolume === undefined ? cur.musicVolume : clampUnit(patch.musicVolume, cur.musicVolume),
    musicDuck: patch.musicDuck ?? cur.musicDuck,
  }
  if (next.musicEnabled === cur.musicEnabled && next.musicVolume === cur.musicVolume && next.musicDuck === cur.musicDuck) return
  useMusicPrefs.setState(next)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable: keep in memory only */
  }
}
