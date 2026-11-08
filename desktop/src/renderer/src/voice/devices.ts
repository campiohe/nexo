// Owner: workstream D. Persisted media device preferences (mic / speaker / camera).
import { create } from 'zustand'

export type DeviceKind = 'audioinput' | 'audiooutput' | 'videoinput'

/**
 * SPEC §13.3 microphone noise suppression. 'off' = none, 'standard' = Chromium's built-in suppressor,
 * 'enhanced' = RNNoise in an AudioWorklet (Chromium's suppressor off). Echo cancellation and AGC stay on.
 */
export type NoiseMode = 'off' | 'standard' | 'enhanced'
export const DEFAULT_NOISE_MODE: NoiseMode = 'enhanced'

export interface DevicePrefs {
  audioinput: string | null
  audiooutput: string | null
  videoinput: string | null
  noiseMode: NoiseMode
}

function isNoiseMode(v: unknown): v is NoiseMode {
  return v === 'off' || v === 'standard' || v === 'enhanced'
}

const STORAGE_KEY = 'nexo.devices'

function load(): DevicePrefs {
  const empty: DevicePrefs = { audioinput: null, audiooutput: null, videoinput: null, noiseMode: DEFAULT_NOISE_MODE }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const parsed = JSON.parse(raw) as Partial<DevicePrefs>
    return {
      audioinput: typeof parsed.audioinput === 'string' ? parsed.audioinput : null,
      audiooutput: typeof parsed.audiooutput === 'string' ? parsed.audiooutput : null,
      videoinput: typeof parsed.videoinput === 'string' ? parsed.videoinput : null,
      noiseMode: isNoiseMode(parsed.noiseMode) ? parsed.noiseMode : DEFAULT_NOISE_MODE,
    }
  } catch {
    return empty
  }
}

/** Selected device ids (null = system default). Read with `useDevicePrefs(s => s.audioinput)`. */
export const useDevicePrefs = create<DevicePrefs>()(() => load())

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(useDevicePrefs.getState()))
  } catch {
    /* storage unavailable: keep in memory only */
  }
}

export function saveDevicePref(kind: DeviceKind, deviceId: string | null): void {
  useDevicePrefs.setState({ [kind]: deviceId || null } as Partial<DevicePrefs>)
  persist()
}

/** Persist the noise suppression mode. voice/session.ts applies it live to the call's mic. */
export function saveNoiseMode(mode: NoiseMode): void {
  if (useDevicePrefs.getState().noiseMode === mode) return
  useDevicePrefs.setState({ noiseMode: mode })
  persist()
}

/** Constraint for a preferred device that still works if the device has disappeared. */
export function idealDevice(deviceId: string | null): ConstrainDOMString | undefined {
  return deviceId && deviceId !== 'default' ? { ideal: deviceId } : undefined
}
