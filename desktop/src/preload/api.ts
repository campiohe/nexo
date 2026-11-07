// Contract between the Electron main/preload side and the renderer.
// Implemented by src/preload/index.ts (exposed as `window.nexo`) and src/main/index.ts (IPC handlers).
// Types only + IPC channel names — safe to import from main, preload and renderer.

export interface CaptureSource {
  /** desktopCapturer source id, e.g. "screen:0:0" or "window:1234:0" */
  id: string
  name: string
  kind: 'screen' | 'window'
  /** PNG data URL, ~320x180 */
  thumbnail: string
  /** App icon data URL (windows only, may be null) */
  icon: string | null
}

export interface NexoBridge {
  platform: 'win32' | 'darwin' | 'linux'
  /** True when getDisplayMedia can include system audio (loopback) on this OS. */
  supportsSystemAudio: boolean
  /** True when the OS shows its own capture picker (Linux Wayland/PipeWire); listSources() then returns []. */
  usesSystemPicker: boolean

  capture: {
    listSources(): Promise<CaptureSource[]>
    /**
     * Choose what the *next* navigator.mediaDevices.getDisplayMedia() call resolves with.
     * Pass id = null when usesSystemPicker is true.
     */
    selectSource(id: string | null, withAudio: boolean): Promise<void>
  }

  /** Small encrypted key/value store (Electron safeStorage when available). Used for the device token. */
  secrets: {
    get(key: string): Promise<string | null>
    set(key: string, value: string | null): Promise<void>
  }

  /** Open an http(s) URL in the system browser. */
  openExternal(url: string): void
}

export const IPC = {
  listSources: 'nexo:capture:list-sources',
  selectSource: 'nexo:capture:select-source',
  secretGet: 'nexo:secrets:get',
  secretSet: 'nexo:secrets:set',
  openExternal: 'nexo:open-external',
} as const
