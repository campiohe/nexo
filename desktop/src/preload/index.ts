// Owner: workstream B. Exposes NexoBridge (see ./api.ts) as window.nexo.
// Runs sandboxed: only contextBridge / ipcRenderer are available. Platform flags come from main via
// webPreferences.additionalArguments (see src/main/platform.ts).
import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppPrefs,
  type CaptureSource,
  type GlobalHotkeyAction,
  type HotkeyBindings,
  type HotkeyEvent,
  type HotkeyStatus,
  type KeybindCapture,
  type NativeShareCapabilities,
  type NativeShareError,
  type NativeShareEvent,
  type NexoBridge,
  type PttBinding,
  type PttStatus,
  type TrayAction,
  GLOBAL_HOTKEY_ACTIONS,
  type UpdateState,
  UPDATE_STATUSES,
} from './api'
import type { NativeShareInvokeResult } from '../main/native-media/ipc-result'

function arg(name: string): string | undefined {
  const prefix = `--nexo-${name}=`
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length)
}

const platformArg = arg('platform')
const platform: NexoBridge['platform'] =
  platformArg === 'win32' || platformArg === 'darwin' || platformArg === 'linux' ? platformArg : 'linux'

const TRAY_ACTIONS: readonly TrayAction[] = ['toggle-mute', 'toggle-deafen', 'leave-voice']

/** Subscribes to a main → renderer channel; the returned function unsubscribes. */
function subscribe<T>(channel: string, accept: (v: unknown) => v is T, cb: (v: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
    if (accept(value)) cb(value)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const isTrayAction = (v: unknown): v is TrayAction => TRAY_ACTIONS.includes(v as TrayAction)

function isHotkeyEvent(v: unknown): v is HotkeyEvent {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return GLOBAL_HOTKEY_ACTIONS.includes(e.action as GlobalHotkeyAction) && (e.phase === 'down' || e.phase === 'up')
}

const OPTIONAL_STRINGS = ['version', 'error', 'reason', 'downloadUrl', 'releaseNotesUrl'] as const

function isUpdateState(v: unknown): v is UpdateState {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  if (!UPDATE_STATUSES.includes(s.status as UpdateState['status'])) return false
  if (typeof s.currentVersion !== 'string' || typeof s.canAutoInstall !== 'boolean') return false
  if (s.percent !== undefined && (typeof s.percent !== 'number' || !Number.isFinite(s.percent))) return false
  return OPTIONAL_STRINGS.every((k) => s[k] === undefined || typeof s[k] === 'string')
}

async function invokeUpdateState(channel: string): Promise<UpdateState> {
  const state: unknown = await ipcRenderer.invoke(channel)
  if (!isUpdateState(state)) throw new Error('invalid update state')
  return state
}

// ── Native share ────────────────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const NATIVE_SHARE_STATES = ['idle', 'starting', 'connecting', 'live', 'reconnecting', 'stopped']
const NATIVE_SHARE_END_REASONS = ['source-closed', 'stopped', 'device-lost', 'error', 'crashed']

function isShareId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
}

function isNativeShareError(v: unknown): v is NativeShareError {
  return isObj(v) && typeof v.code === 'string' && typeof v.message === 'string' && typeof v.fallback === 'boolean'
}

function isNativeShareEvent(v: unknown): v is NativeShareEvent {
  if (!isObj(v) || !isShareId(v.shareId)) return false
  switch (v.type) {
    case 'state':
      return NATIVE_SHARE_STATES.includes(v.state as string)
    case 'stats':
      return isObj(v.stats) && typeof v.stats.captureFps === 'number' && typeof v.stats.stalled === 'boolean'
    case 'ended':
      return NATIVE_SHARE_END_REASONS.includes(v.reason as string)
    case 'error':
      return isNativeShareError(v.error)
    default:
      return false
  }
}

/**
 * The rejection value of nativeShare calls: a plain object, not an Error. contextBridge copies only an Error's
 * message into the page (custom properties are dropped), while a plain object keeps `code` and `fallback`.
 */
function nativeShareRejection(error: NativeShareError): NativeShareError & { name: 'NativeShareError' } {
  return { name: 'NativeShareError', code: error.code, message: error.message, fallback: error.fallback }
}

/** Main answers start/update/stop/release with a NativeShareInvokeResult; failures become rejections here. */
async function invokeNativeShare(channel: string, ...args: unknown[]): Promise<NativeShareInvokeResult & { ok: true }> {
  let result: NativeShareInvokeResult | undefined
  try {
    result = await ipcRenderer.invoke(channel, ...args)
  } catch (err) {
    throw nativeShareRejection({ code: 'internal', message: err instanceof Error ? err.message : String(err), fallback: false })
  }
  if (isObj(result) && result.ok === true) return result
  if (isObj(result) && result.ok === false && isNativeShareError(result.error)) throw nativeShareRejection(result.error)
  throw nativeShareRejection({ code: 'internal', message: 'invalid reply from main', fallback: false })
}

async function startNativeShare(opts: unknown): Promise<{ shareId: number }> {
  const result = await invokeNativeShare(IPC.nativeShareStart, opts)
  if (!isShareId(result.shareId)) {
    throw nativeShareRejection({ code: 'internal', message: 'invalid reply from main (no share id)', fallback: false })
  }
  return { shareId: result.shareId }
}

const bridge: NexoBridge = {
  platform,
  supportsSystemAudio: arg('system-audio') === '1',
  usesSystemPicker: arg('system-picker') === '1',

  capture: {
    listSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke(IPC.listSources),
    selectSource: (id: string | null, withAudio: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.selectSource, id, withAudio),
  },

  nativeShare: {
    capabilities: (): Promise<NativeShareCapabilities> => ipcRenderer.invoke(IPC.nativeShareCapabilities),
    start: (opts) => startNativeShare(opts),
    update: async (patch) => void (await invokeNativeShare(IPC.nativeShareUpdate, patch)),
    stop: async () => void (await invokeNativeShare(IPC.nativeShareStop)),
    release: async () => void (await invokeNativeShare(IPC.nativeShareRelease)),
    onEvent: (cb: (event: NativeShareEvent) => void): (() => void) =>
      subscribe(IPC.nativeShareEvent, isNativeShareEvent, cb),
  },

  secrets: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke(IPC.secretGet, key),
    set: (key: string, value: string | null): Promise<void> => ipcRenderer.invoke(IPC.secretSet, key, value),
  },

  openExternal: (url: string): void => ipcRenderer.send(IPC.openExternal, url),

  hotkeys: {
    setBindings: (bindings: HotkeyBindings): Promise<HotkeyStatus> =>
      ipcRenderer.invoke(IPC.hotkeysSetBindings, bindings),
    captureBinding: (): Promise<KeybindCapture> => ipcRenderer.invoke(IPC.hotkeysCapture),
    onAction: (cb): (() => void) => subscribe(IPC.hotkeysAction, isHotkeyEvent, (e) => cb(e.action, e.phase)),
    status: (): Promise<HotkeyStatus> => ipcRenderer.invoke(IPC.hotkeysStatus),
    focusWindow: (): void => ipcRenderer.send(IPC.hotkeysFocus),
  },

  ptt: {
    setBinding: (binding: PttBinding | null): Promise<PttStatus> => ipcRenderer.invoke(IPC.pttSetBinding, binding),
    captureBinding: async (): Promise<PttBinding | null> => {
      const result: KeybindCapture = await ipcRenderer.invoke(IPC.hotkeysCapture)
      return result === 'clear' ? null : result
    },
    onChange: (cb: (pressed: boolean) => void): (() => void) =>
      subscribe(IPC.hotkeysAction, isHotkeyEvent, (e) => {
        if (e.action === 'ptt') cb(e.phase === 'down')
      }),
  },

  prefs: {
    get: (): Promise<AppPrefs> => ipcRenderer.invoke(IPC.prefsGet),
    set: (patch: Partial<AppPrefs>): Promise<AppPrefs> => ipcRenderer.invoke(IPC.prefsSet, patch),
  },

  tray: {
    setVoiceState: (state): void => ipcRenderer.send(IPC.trayVoiceState, state),
    onAction: (cb: (action: TrayAction) => void): (() => void) => subscribe(IPC.trayAction, isTrayAction, cb),
  },

  updates: {
    getState: (): Promise<UpdateState> => invokeUpdateState(IPC.updatesGetState),
    check: (): Promise<UpdateState> => invokeUpdateState(IPC.updatesCheck),
    install: (): void => ipcRenderer.send(IPC.updatesInstall),
    onState: (cb: (state: UpdateState) => void): (() => void) => subscribe(IPC.updatesState, isUpdateState, cb),
  },
}

contextBridge.exposeInMainWorld('nexo', bridge)
