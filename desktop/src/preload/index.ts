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
  type NexoBridge,
  type PttBinding,
  type PttStatus,
  type TrayAction,
  GLOBAL_HOTKEY_ACTIONS,
  type UpdateState,
  UPDATE_STATUSES,
} from './api'

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

const bridge: NexoBridge = {
  platform,
  supportsSystemAudio: arg('system-audio') === '1',
  usesSystemPicker: arg('system-picker') === '1',

  capture: {
    listSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke(IPC.listSources),
    selectSource: (id: string | null, withAudio: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.selectSource, id, withAudio),
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
