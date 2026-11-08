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

/** Modifiers that must be held with a keybind's main key/button. Left and right variants are equivalent. */
export interface KeybindMods {
  ctrl: boolean
  shift: boolean
  alt: boolean
  /** Cmd on macOS, Win on Windows, Super on Linux. */
  meta: boolean
}

/**
 * A key combination: modifiers + a keyboard key (uiohook keycode, i.e. a physical scancode) or a mouse
 * button (3 = middle, 4/5 = side buttons; left/right click are never bindable).
 * A lone modifier (e.g. Left Ctrl) is a `key` binding with that modifier's code and no `mods`.
 */
export interface Keybind {
  kind: 'key' | 'mouse'
  code: number
  mods: KeybindMods
  /** Human-readable, e.g. "Ctrl+Shift+M", "Mouse 4", "Alt+Mouse 5", "Caps Lock". */
  label: string
}

/** @deprecated Use Keybind. Kept for the `nexo.ptt` alias; bindings without `mods` mean no modifiers. */
export type PttBinding = Keybind

/** Actions handled by the system-wide hook (work while a game has focus). */
export type GlobalHotkeyAction = 'ptt' | 'toggleMute' | 'toggleDeafen' | 'toggleShare' | 'leaveVoice'

export const GLOBAL_HOTKEY_ACTIONS: readonly GlobalHotkeyAction[] = [
  'ptt',
  'toggleMute',
  'toggleDeafen',
  'toggleShare',
  'leaveVoice',
]

/** Global bindings; a missing or null entry is unbound. */
export type HotkeyBindings = Partial<Record<GlobalHotkeyAction, Keybind | null>>

/**
 * `down` when the combination is pressed (once per press: OS auto-repeat is ignored), `up` when its main
 * key/button is released. Push to talk uses both; toggles only act on `down`.
 */
export type HotkeyPhase = 'down' | 'up'

export interface HotkeyEvent {
  action: GlobalHotkeyAction
  phase: HotkeyPhase
}

/** Result of recording a keybind: the combination, 'clear' (Backspace/Delete), or null (Esc / timeout). */
export type KeybindCapture = Keybind | 'clear' | null

export interface HotkeyStatus {
  /** True when the global hook is running with the current bindings. */
  active: boolean
  /** Why it isn't (or can't be) active, e.g. Wayland, macOS Accessibility permission missing. */
  reason?: string
}

/** @deprecated Use HotkeyStatus. */
export type PttStatus = HotkeyStatus

// ── Keybind helpers (pure: shared by main and renderer) ─────────────────────────────────────────────────

export const NO_MODS: Readonly<KeybindMods> = Object.freeze({ ctrl: false, shift: false, alt: false, meta: false })

const MOD_KEYS: readonly (keyof KeybindMods)[] = ['ctrl', 'alt', 'shift', 'meta']

/** uiohook keycodes of the modifier keys (left and right) → the modifier they are. */
export const MODIFIER_KEYCODES: Readonly<Record<number, keyof KeybindMods>> = Object.freeze({
  0x001d: 'ctrl', // Ctrl
  0x0e1d: 'ctrl', // CtrlRight
  0x0038: 'alt', // Alt
  0x0e38: 'alt', // AltRight
  0x002a: 'shift', // Shift
  0x0036: 'shift', // ShiftRight
  0x0e5b: 'meta', // Meta
  0x0e5c: 'meta', // MetaRight
})

/** The modifier a key binding's main key is, if any. */
export function modifierOf(kind: Keybind['kind'], code: number): keyof KeybindMods | null {
  return kind === 'key' ? (MODIFIER_KEYCODES[code] ?? null) : null
}

export function modsEqual(a: KeybindMods, b: KeybindMods): boolean {
  return MOD_KEYS.every((k) => a[k] === b[k])
}

/** True when every modifier in `required` is held in `held` (extra held modifiers are allowed). */
export function modsInclude(held: KeybindMods, required: KeybindMods): boolean {
  return MOD_KEYS.every((k) => !required[k] || held[k])
}

/**
 * Modifiers that count for matching a key event: the main key's own modifier is dropped, so a lone-modifier
 * binding (e.g. Left Ctrl) matches whether or not the OS already reports Ctrl as held on its keydown.
 */
export function effectiveMods(held: KeybindMods, kind: Keybind['kind'], code: number): KeybindMods {
  const own = modifierOf(kind, code)
  return own ? { ...held, [own]: false } : held
}

/** Platform names of the modifiers, in display order. */
export function modifierNames(platform: NexoBridge['platform']): Record<keyof KeybindMods, string> {
  return {
    ctrl: 'Ctrl',
    alt: platform === 'darwin' ? 'Option' : 'Alt',
    shift: 'Shift',
    meta: platform === 'darwin' ? 'Cmd' : platform === 'win32' ? 'Win' : 'Super',
  }
}

/** "Ctrl+Shift+M", "Alt+Mouse 5"… `key` is the main key/button's own name. */
export function formatKeybindLabel(mods: KeybindMods, key: string, platform: NexoBridge['platform']): string {
  const names = modifierNames(platform)
  return [...MOD_KEYS.filter((k) => mods[k]).map((k) => names[k]), key].join('+')
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
  /**
   * Windows: which engine streams game/screen shares (docs/SPEC-BETA.md §8.4).
   * - native: the nexo-media helper (WGC + hardware H.264 + LiveKit C++ SDK), when available
   * - chromium: getDisplayMedia + livekit-client (the alpha path; `fastCapture` applies)
   * Default 'native'. Ignored on other platforms (always chromium).
   */
  captureEngine: CaptureEngine
}

export type CaptureEngine = 'native' | 'chromium'

// ── Native share (Windows, docs/SPEC-BETA.md) ──────────────────────────────────────────────────────────

/** `motion` (games: keep fps) or `detail` (text: keep quality, drop fps). Same values as SharePreset.contentHint. */
export type NativeShareContentHint = 'motion' | 'detail'

export interface NativeSharePreset {
  width: number
  height: number
  fps: number
  /** Bits per second. */
  maxBitrate: number
  contentHint: NativeShareContentHint
}

export interface NativeShareCapabilities {
  /** True when a native share can start (Windows, helper runs, hardware H.264 encoder found). */
  available: boolean
  /** Why not, user-readable (e.g. "No hardware H.264 encoder on this GPU"). */
  reason?: string
  version?: string
  osBuild?: number
  /** e.g. "NVIDIA GeForce RTX 4070" */
  adapter?: string
  /** e.g. "NVIDIA H.264 Encoder MFT" */
  encoder?: string
  features?: {
    borderless: boolean
    minUpdateInterval: boolean
    cursorToggle: boolean
    processLoopback: boolean
  }
}

export interface NativeShareStartOptions {
  /** desktopCapturer source id from capture.listSources() ("window:…" or "screen:…"). Main translates it. */
  sourceId: string
  preset: NativeSharePreset
  /** Capture the mouse cursor. */
  cursor: boolean
  /** Stream audio: app audio for a window, system audio without Nexo for a screen. */
  withAudio: boolean
  /** Screen sources only: exclude Nexo's windows from the capture while sharing. */
  hideNexo: boolean
  /** From the server's `voice:streamToken`. Only travels renderer → main → helper stdin. */
  livekit: { url: string; token: string }
}

export type NativeShareState = 'idle' | 'starting' | 'connecting' | 'live' | 'reconnecting' | 'stopped'

export interface NativeShareStats {
  captureFps: number
  encodeFps: number
  targetBitrate: number
  sentBitrate?: number
  keyframes: number
  droppedFrames: number
  /** No new frame for > 1 s (e.g. minimized window). */
  stalled: boolean
  encoder: string
  width: number
  height: number
}

export type NativeShareEndReason = 'source-closed' | 'stopped' | 'device-lost' | 'error' | 'crashed'

export type NativeShareErrorCode =
  /** Helper exe missing, failed to spawn, or not Windows. */
  | 'helper-unavailable'
  /** Helper exited unexpectedly (main restarts it once per SPEC-BETA §4.1). */
  | 'helper-crashed'
  /** No hardware H.264 encoder, session limit reached, or encoder creation failed. */
  | 'encoder-unavailable'
  /** Source gone / invalid, or WGC failed to start. */
  | 'capture-failed'
  | 'livekit-connect'
  /** Stream audio failed; video keeps going. */
  | 'audio-failed'
  /** A share is already running. */
  | 'busy'
  /** Malformed message or protocol version mismatch. */
  | 'protocol'
  | 'internal'

export interface NativeShareError {
  code: NativeShareErrorCode
  message: string
  /** True when the renderer should retry the share on the chromium engine. */
  fallback: boolean
}

/**
 * Every event carries the `shareId` of the share it belongs to: main numbers each start() it accepts (1, 2, …
 * for the app session) and tags all of that share's events, from `state: 'starting'` to the final
 * `state: 'idle'`. start() resolves with the same id, so the renderer can drop events of earlier shares.
 */
export type NativeShareEvent =
  | { type: 'state'; shareId: number; state: NativeShareState }
  | { type: 'stats'; shareId: number; stats: NativeShareStats }
  | { type: 'ended'; shareId: number; reason: NativeShareEndReason }
  | { type: 'error'; shareId: number; error: NativeShareError }

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
  /** Running a test build (version X.Y.Z-test.N): it only updates to newer test builds. */
  testBuild?: boolean
  /** leaveTestBuilds() was called: the updater now follows regular releases, older versions included. */
  leavingTestBuilds?: boolean
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

  /**
   * Native game/screen share through the nexo-media helper (Windows; docs/SPEC-BETA.md §8). On other
   * platforms capabilities() resolves `{ available: false }` and the other calls reject.
   */
  nativeShare: {
    /**
     * Starts the helper if needed and returns its capabilities (cached for the app session). Never rejects:
     * resolves `{ available: false, reason }` when native sharing can't be used.
     */
    capabilities(): Promise<NativeShareCapabilities>
    /**
     * Resolves once the helper accepted the share (state then goes connecting → live), with the `shareId`
     * its events carry. Rejects with a plain object `{ name: 'NativeShareError', code, message, fallback }`
     * (Electron drops custom Error properties across IPC); a rejected start emits only `state: 'starting'` and
     * `state: 'idle'` (with an id start() never returned), never `ended`. update/stop/release reject the same
     * way.
     */
    start(opts: NativeShareStartOptions): Promise<{ shareId: number }>
    /** Live changes: bitrate/fps/contentHint, cursor. A size change needs stop + start. */
    update(patch: { preset?: Partial<NativeSharePreset>; cursor?: boolean }): Promise<void>
    /** Stop the active share (no-op when none). */
    stop(): Promise<void>
    /** Stop any share and shut the helper down (leaving voice). */
    release(): Promise<void>
    /** Every state/stats/ended/error event; the returned function unsubscribes. */
    onEvent(cb: (event: NativeShareEvent) => void): () => void
  }

  /** Small encrypted key/value store (Electron safeStorage when available). Used for the device token. */
  secrets: {
    get(key: string): Promise<string | null>
    set(key: string, value: string | null): Promise<void>
  }

  /** Open an http(s) URL in the system browser. */
  openExternal(url: string): void

  /**
   * Global hotkeys (work while other apps, e.g. games, have focus). One system-wide hook runs while any
   * binding is set.
   */
  hotkeys: {
    /** Replace all global bindings (missing = unbound). Starts the hook if any is set, else stops it. */
    setBindings(bindings: HotkeyBindings): Promise<HotkeyStatus>
    /**
     * Record the next combination pressed anywhere: modifiers held + a non-modifier key or mouse button
     * 3+, or a lone modifier pressed and released alone. Esc cancels (null), Backspace/Delete without
     * modifiers resolves 'clear'. Times out after 15 s (null). Rejects when the hook can't run.
     */
    captureBinding(): Promise<KeybindCapture>
    /** A bound combination was pressed or released. */
    onAction(cb: (action: GlobalHotkeyAction, phase: HotkeyPhase) => void): () => void
    /** Current hook status (does not start the hook); `reason` explains why it can't run. */
    status(): Promise<HotkeyStatus>
    /**
     * Show and focus the main window (even when hidden in the tray). Only honoured right after a global
     * `toggleShare` press, so the share picker can open in front of a game.
     */
    focusWindow(): void
  }

  /** @deprecated Thin alias over `hotkeys` for the push-to-talk slot. */
  ptt: {
    /** Set only the push-to-talk binding (other hotkeys are kept); null unbinds it. */
    setBinding(binding: PttBinding | null): Promise<PttStatus>
    /** Like hotkeys.captureBinding, but 'clear' resolves null. */
    captureBinding(): Promise<PttBinding | null>
    /** Called with true when the push-to-talk combination goes down and false when it is released. */
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
    /** Test build only: switch to regular releases and download the newest one (resolves after the check). */
    leaveTestBuilds(): Promise<UpdateState>
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
  pttSetBinding: 'nexo:ptt:set-binding', // legacy: sets the 'ptt' slot only
  hotkeysSetBindings: 'nexo:hotkeys:set-bindings',
  hotkeysCapture: 'nexo:hotkeys:capture',
  hotkeysStatus: 'nexo:hotkeys:status',
  hotkeysFocus: 'nexo:hotkeys:focus-window',
  hotkeysAction: 'nexo:hotkeys:action', // main → renderer (HotkeyEvent)
  prefsGet: 'nexo:prefs:get',
  prefsSet: 'nexo:prefs:set',
  trayVoiceState: 'nexo:tray:voice-state',
  trayAction: 'nexo:tray:action', // main → renderer (TrayAction)
  updatesGetState: 'nexo:updates:get-state',
  updatesCheck: 'nexo:updates:check',
  updatesInstall: 'nexo:updates:install',
  updatesLeaveTest: 'nexo:updates:leave-test',
  updatesState: 'nexo:updates:state', // main → renderer (UpdateState)
  nativeShareCapabilities: 'nexo:native-share:capabilities',
  nativeShareStart: 'nexo:native-share:start',
  nativeShareUpdate: 'nexo:native-share:update',
  nativeShareStop: 'nexo:native-share:stop',
  nativeShareRelease: 'nexo:native-share:release',
  nativeShareEvent: 'nexo:native-share:event', // main → renderer (NativeShareEvent)
} as const
