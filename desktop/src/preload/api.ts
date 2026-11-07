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

/** A global push-to-talk binding: a keyboard key (uiohook keycode) or a mouse button (3+ = middle/side buttons). */
export interface PttBinding {
  kind: 'key' | 'mouse'
  code: number
  /** Human-readable, e.g. "Mouse 4", "V", "Caps Lock". */
  label: string
}

export interface PttStatus {
  /** True when the global hook is running with this binding. */
  active: boolean
  /** Why it isn't active (e.g. Wayland, macOS Accessibility permission missing). */
  reason?: string
}

/** App-level preferences persisted by the main process. */
export interface AppPrefs {
  /** Closing the main window hides it to the system tray instead of quitting. Default true. */
  closeToTray: boolean
  /**
   * Windows: keep captured screen/window frames on the GPU (Chromium's WGC texture path) instead of
   * reading every frame back to the CPU. Roughly doubles stream fps when a game keeps the GPU busy.
   * Applied at startup, so a change needs a restart. Default true; ignored on other platforms.
   */
  fastCapture: boolean
}

export type TrayAction = 'toggle-mute' | 'toggle-deafen' | 'leave-voice'

/**
 * Auto-update lifecycle (electron-updater, GitHub releases):
 * - unsupported: dev build, or Linux without the AppImage (see `reason`)
 * - available: a newer release exists but can't be installed in place (macOS: open `downloadUrl`)
 * - downloading → ready: Windows/AppImage download in the background, then install on restart or quit
 */
export type UpdateStatus = 'unsupported' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateState {
  status: UpdateStatus
  /** Version of the running app. */
  currentVersion: string
  /** Version of the newer release (available / downloading / ready). */
  version?: string
  /** Download progress 0–100 (downloading). */
  percent?: number
  /** Short, user-readable message of the last failed check or download. */
  error?: string
  /** Why updates are unsupported on this build. */
  reason?: string
  /** Release page to download the new version manually (macOS). */
  downloadUrl?: string
  /** Release page of `version`. */
  releaseNotesUrl?: string
  /** True when the update downloads and installs in place (Windows NSIS, Linux AppImage). */
  canAutoInstall: boolean
}

export const UPDATE_STATUSES: readonly UpdateStatus[] = [
  'unsupported',
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'ready',
  'error',
]

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

  /** Global push-to-talk (works while other apps, e.g. games, have focus). */
  ptt: {
    /** Start the global hook for this binding; null stops it. */
    setBinding(binding: PttBinding | null): Promise<PttStatus>
    /**
     * Resolve with the next key or mouse button pressed anywhere (left/right click are ignored).
     * Escape cancels and resolves null. Times out after 15 s (null).
     */
    captureBinding(): Promise<PttBinding | null>
    /** Called with true when the bound key/button goes down and false when it is released. */
    onChange(cb: (pressed: boolean) => void): () => void
  }

  prefs: {
    get(): Promise<AppPrefs>
    set(patch: Partial<AppPrefs>): Promise<AppPrefs>
  }

  /** System tray integration. */
  tray: {
    /** Keep the tray menu/tooltip in sync with the voice session. */
    setVoiceState(state: { inVoice: boolean; channelName: string | null; muted: boolean; deafened: boolean }): void
    /** Tray menu actions the renderer must perform. */
    onAction(cb: (action: TrayAction) => void): () => void
  }

  /** Auto-update (main process). */
  updates: {
    getState(): Promise<UpdateState>
    /** Check now; resolves with the state after the check (an error is reported in the state, not thrown). */
    check(): Promise<UpdateState>
    /** Quit and install a downloaded update (status 'ready'); ignored otherwise. */
    install(): void
    /** Called on every state change; the returned function unsubscribes. */
    onState(cb: (state: UpdateState) => void): () => void
  }
}

export const IPC = {
  listSources: 'nexo:capture:list-sources',
  selectSource: 'nexo:capture:select-source',
  secretGet: 'nexo:secrets:get',
  secretSet: 'nexo:secrets:set',
  openExternal: 'nexo:open-external',
  pttSetBinding: 'nexo:ptt:set-binding',
  pttCapture: 'nexo:ptt:capture',
  pttChange: 'nexo:ptt:change', // main → renderer (boolean)
  prefsGet: 'nexo:prefs:get',
  prefsSet: 'nexo:prefs:set',
  trayVoiceState: 'nexo:tray:voice-state',
  trayAction: 'nexo:tray:action', // main → renderer (TrayAction)
  updatesGetState: 'nexo:updates:get-state',
  updatesCheck: 'nexo:updates:check',
  updatesInstall: 'nexo:updates:install',
  updatesState: 'nexo:updates:state', // main → renderer (UpdateState)
} as const
