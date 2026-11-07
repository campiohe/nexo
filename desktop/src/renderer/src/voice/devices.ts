// Owner: workstream D. Persisted media device preferences (mic / speaker / camera).
import { create } from 'zustand'

export type DeviceKind = 'audioinput' | 'audiooutput' | 'videoinput'

export interface DevicePrefs {
  audioinput: string | null
  audiooutput: string | null
  videoinput: string | null
}

const STORAGE_KEY = 'nexo.devices'

function load(): DevicePrefs {
  const empty: DevicePrefs = { audioinput: null, audiooutput: null, videoinput: null }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const parsed = JSON.parse(raw) as Partial<DevicePrefs>
    return {
      audioinput: typeof parsed.audioinput === 'string' ? parsed.audioinput : null,
      audiooutput: typeof parsed.audiooutput === 'string' ? parsed.audiooutput : null,
      videoinput: typeof parsed.videoinput === 'string' ? parsed.videoinput : null,
    }
  } catch {
    return empty
  }
}

/** Selected device ids (null = system default). Read with `useDevicePrefs(s => s.audioinput)`. */
export const useDevicePrefs = create<DevicePrefs>()(() => load())

export function saveDevicePref(kind: DeviceKind, deviceId: string | null): void {
  useDevicePrefs.setState({ [kind]: deviceId || null } as Partial<DevicePrefs>)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(useDevicePrefs.getState()))
  } catch {
    /* storage unavailable: keep in memory only */
  }
}

/** Constraint for a preferred device that still works if the device has disappeared. */
export function idealDevice(deviceId: string | null): ConstrainDOMString | undefined {
  return deviceId && deviceId !== 'default' ? { ideal: deviceId } : undefined
}
