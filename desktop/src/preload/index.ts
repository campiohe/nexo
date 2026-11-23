// Owner: workstream B. Exposes NexoBridge (see ./api.ts) as window.nexo.
// Runs sandboxed: only contextBridge / ipcRenderer are available. Platform flags come from main via
// webPreferences.additionalArguments (see src/main/platform.ts).
import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppPrefs,
  type ActivitySettings,
  type AppearanceState,
  type ThemeChoice,
  type WindowChrome,
  type ZoomEvent,
  type CaptureSource,
  type ChatNotification,
  type DetectedActivity,
  type GlobalHotkeyAction,
  type HotkeyBindings,
  type Language,
  LANGUAGES,
  type SystemLocale,
  type HotkeyEvent,
  type HotkeyStatus,
  type KeybindCapture,
  type MusicCollectionTracks,
  type MusicEngineError,
  type MusicSearchResults,
  type NativeShareCapabilities,
  type NativeShareError,
  type NativeShareEvent,
  type NexoBridge,
  type PttBinding,
  type PresenceBridgeState,
  type PttStatus,
  type SecretRead,
  type TrayAction,
  type UnreadBadge,
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

/** A BCP 47 tag like "pt-BR" or "zh-Hant-TW" (main already normalized it); anything else is dropped. */
const LOCALE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,4}$/

function systemLocale(): SystemLocale {
  const languages = (arg('languages') ?? '')
    .split(',')
    .filter((l) => LOCALE_TAG.test(l))
    .slice(0, 16)
  const region = arg('region') ?? ''
  return { languages, region: LOCALE_TAG.test(region) ? region : null }
}

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

const isChannelId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128

function isZoomEvent(v: unknown): v is ZoomEvent {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return typeof e.factor === 'number' && Number.isFinite(e.factor) && (e.source === 'keyboard' || e.source === 'wheel' || e.source === 'settings')
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
  if (s.testBuild !== undefined && typeof s.testBuild !== 'boolean') return false
  if (s.leavingTestBuilds !== undefined && typeof s.leavingTestBuilds !== 'boolean') return false
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

// ── Music ───────────────────────────────────────────────────────────────────────────────────────────────

const MUSIC_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const MUSIC_ERROR_CODES: readonly MusicEngineError['code'][] = ['bot-check', 'unavailable', 'network', 'engine']

/** Rejections are plain objects (contextBridge drops custom Error properties), like nativeShare's. */
function musicError(code: MusicEngineError['code'], message: string): MusicEngineError {
  return { name: 'MusicEngineError', code, message }
}

/** Main answers music calls with { ok: true, data } or { ok: false, error: MusicEngineError }. */
async function invokeMusic<T>(channel: string, arg: unknown): Promise<T> {
  let result: unknown
  try {
    result = await ipcRenderer.invoke(channel, arg)
  } catch (err) {
    throw musicError('engine', err instanceof Error ? err.message : String(err))
  }
  if (isObj(result) && result.ok === true) return result.data as T
  if (isObj(result) && result.ok === false && isObj(result.error)) {
    const e = result.error
    const code = MUSIC_ERROR_CODES.includes(e.code as MusicEngineError['code']) ? (e.code as MusicEngineError['code']) : 'engine'
    throw musicError(code, typeof e.message === 'string' ? e.message : 'music engine error')
  }
  throw musicError('engine', 'invalid reply from main')
}

// ── Presence (idle, game detection) ─────────────────────────────────────────────────────────────────────

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

function isDetectedActivity(v: unknown): v is DetectedActivity | null {
  if (v === null) return true
  return isObj(v) && typeof v.name === 'string' && v.name.length > 0 && typeof v.startedAt === 'number' && Number.isFinite(v.startedAt)
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
    read: (key: string): Promise<SecretRead> => ipcRenderer.invoke(IPC.secretRead, key),
    set: (key: string, value: string | null): Promise<void> => ipcRenderer.invoke(IPC.secretSet, key, value),
  },

  openExternal: (url: string): void => ipcRenderer.send(IPC.openExternal, url),

  music: {
    search: (query: string): Promise<MusicSearchResults> => invokeMusic(IPC.musicSearch, query),
    resolve: (input: string): Promise<MusicCollectionTracks | null> => invokeMusic(IPC.musicResolve, input),
    streamUrl: (videoId: string): string => {
      if (typeof videoId !== 'string' || !MUSIC_VIDEO_ID.test(videoId)) throw new Error('invalid video id')
      return `nexo-music://track/${videoId}`
    },
    prefetch: async (videoId: string): Promise<void> => {
      if (typeof videoId !== 'string' || !MUSIC_VIDEO_ID.test(videoId)) return
      await ipcRenderer.invoke(IPC.musicPrefetch, videoId).catch(() => {})
    },
    lastError: async (videoId: string): Promise<MusicEngineError | null> => {
      if (typeof videoId !== 'string' || !MUSIC_VIDEO_ID.test(videoId)) return null
      return ((await ipcRenderer.invoke(IPC.musicLastError, videoId).catch(() => null)) as MusicEngineError | null) ?? null
    },
  },

  requestAttention: (): void => ipcRenderer.send(IPC.requestAttention),

  notifications: {
    show: (n: ChatNotification): void => ipcRenderer.send(IPC.notifyShow, n),
    clear: (channelId: string | null): void => ipcRenderer.send(IPC.notifyClear, channelId),
    setBadge: (badge: UnreadBadge): void => ipcRenderer.send(IPC.notifyBadge, badge),
    onOpen: (cb: (channelId: string) => void): (() => void) => subscribe(IPC.notifyOpen, isChannelId, cb),
  },

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

  presence: {
    getState: (): Promise<PresenceBridgeState> => ipcRenderer.invoke(IPC.presenceGetState),
    setSettings: (patch: Partial<ActivitySettings>): Promise<ActivitySettings> =>
      ipcRenderer.invoke(IPC.presenceSetSettings, patch),
    listProcesses: (): Promise<string[]> => ipcRenderer.invoke(IPC.presenceListProcesses),
    onIdle: (cb: (idle: boolean) => void): (() => void) => subscribe(IPC.presenceIdle, isBool, cb),
    onActivity: (cb: (activity: DetectedActivity | null) => void): (() => void) =>
      subscribe(IPC.presenceActivity, isDetectedActivity, cb),
  },

  appearance: {
    getState: (): Promise<AppearanceState> => ipcRenderer.invoke(IPC.appearanceGet),
    setTheme: (theme: ThemeChoice, chrome: WindowChrome): void => ipcRenderer.send(IPC.appearanceSetTheme, theme, chrome),
    setZoom: (factor: number): Promise<number> => ipcRenderer.invoke(IPC.appearanceSetZoom, factor),
    onZoom: (cb: (e: ZoomEvent) => void): (() => void) => subscribe(IPC.appearanceZoom, isZoomEvent, cb),
    setAppIcon: (png: string | null): Promise<void> => ipcRenderer.invoke(IPC.appearanceSetAppIcon, png),
  },

  locale: {
    system: systemLocale(),
    setLanguage: (language: Language): void => {
      if (LANGUAGES.includes(language)) ipcRenderer.send(IPC.localeSetLanguage, language)
    },
  },

  updates: {
    getState: (): Promise<UpdateState> => invokeUpdateState(IPC.updatesGetState),
    check: (): Promise<UpdateState> => invokeUpdateState(IPC.updatesCheck),
    install: (): void => ipcRenderer.send(IPC.updatesInstall),
    leaveTestBuilds: (): Promise<UpdateState> => invokeUpdateState(IPC.updatesLeaveTest),
    onState: (cb: (state: UpdateState) => void): (() => void) => subscribe(IPC.updatesState, isUpdateState, cb),
  },
}

contextBridge.exposeInMainWorld('nexo', bridge)
