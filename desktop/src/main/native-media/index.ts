// Electron side of the native share (docs/SPEC-BETA.md §8.1): helper location, IPC handlers, source
// translation, content protection ("Hide Nexo from the stream") and app/window lifecycle.
// The process/protocol logic lives in ./supervisor.ts, which has no Electron imports.
//
// Environment (dev/debug):
//   NEXO_MEDIA_EXE=<path>        use this helper exe instead of the bundled/dev copy
//   NEXO_MEDIA_FAKE=1            use desktop/scripts/fake-nexo-media.mjs, run by the Electron binary itself
//                                (ELECTRON_RUN_AS_NODE=1), on any OS. Looked up at <app path>/scripts/ (the
//                                repo's desktop/ for `npm run dev`; scripts/win-run.sh copies it there), or
//                                NEXO_MEDIA_FAKE_SCRIPT=<path>. FAKE_NEXO_MEDIA=… picks a failure (see the script).
//   NEXO_MEDIA_DEBUG=1           print every command/event (token redacted) and the helper's debug logs
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  IPC,
  type NativeShareContentHint,
  type NativeShareEvent,
  type NativeSharePreset,
} from '../../preload/api'
import { helperAudioMode, SOURCE_ID_RE, sourceKind, toHelperSource } from '../capture'
import { platform } from '../platform'
import { isAppUrl } from '../security'
import type { NativeShareInvokeResult } from './ipc-result'
import { NativeShareFailure, toNativeShareError } from './mapping'
import { HELPER_ARGS } from './protocol'
import { NativeShareSupervisor, type LaunchResult, type UpdateRequest } from './supervisor'

const FAKE = process.env.NEXO_MEDIA_FAKE === '1'
const FAKE_SCRIPT = 'fake-nexo-media.mjs'
/** How long quitting waits for a clean stop + shutdown before killing the helper. */
const QUIT_GRACE_MS = 2_500

function resolveLaunch(): LaunchResult {
  const parentArg = `${HELPER_ARGS.parentPid}=${process.pid}`
  if (FAKE) {
    const script = [process.env.NEXO_MEDIA_FAKE_SCRIPT, join(app.getAppPath(), 'scripts', FAKE_SCRIPT)].find(
      (p): p is string => !!p && existsSync(p),
    )
    if (!script) return { ok: false, reason: `NEXO_MEDIA_FAKE=1 but ${FAKE_SCRIPT} was not found (set NEXO_MEDIA_FAKE_SCRIPT)` }
    return {
      ok: true,
      spec: {
        command: process.execPath,
        args: [script, parentArg],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        label: `fake helper ${script}`,
      },
    }
  }
  const exe =
    process.env.NEXO_MEDIA_EXE ||
    (app.isPackaged
      ? join(process.resourcesPath, 'native', 'nexo-media.exe')
      : join(app.getAppPath(), 'resources', 'native', 'nexo-media.exe'))
  if (!existsSync(exe)) {
    return {
      ok: false,
      reason: app.isPackaged
        ? 'nexo-media.exe is missing from this installation. Reinstall Nexo.'
        : `nexo-media.exe not found at ${exe} (build it with scripts/win-run.sh --native)`,
    }
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return { ok: true, spec: { command: exe, args: [parentArg], env, label: exe } }
}

// ── Content protection (SPEC-BETA §4.9) ─────────────────────────────────────────────────────────────────

let hideNexo = false

function setHideNexo(on: boolean): void {
  hideNexo = on
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setContentProtection(on)
  }
}

// ── Argument validation ─────────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function invalid(message: string): never {
  throw new NativeShareFailure('internal', message)
}

function intIn(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) invalid(`${name} must be an integer in ${min}..${max}`)
  return v
}

function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') invalid(`${name} must be a boolean`)
  return v
}

const CONTENT_HINTS: readonly NativeShareContentHint[] = ['motion', 'detail']
const PRESET_LIMITS = {
  width: [16, 7680],
  height: [16, 4320],
  fps: [1, 240],
  maxBitrate: [100_000, 200_000_000],
} as const

function presetField<K extends keyof NativeSharePreset>(key: K, v: unknown): NativeSharePreset[K] {
  if (key === 'contentHint') {
    if (!CONTENT_HINTS.includes(v as NativeShareContentHint)) invalid('preset.contentHint must be "motion" or "detail"')
    return v as NativeSharePreset[K]
  }
  const [min, max] = PRESET_LIMITS[key as keyof typeof PRESET_LIMITS]
  return intIn(v, `preset.${key}`, min, max) as NativeSharePreset[K]
}

function parsePreset(v: unknown): NativeSharePreset {
  if (!isObj(v)) invalid('preset must be an object')
  return {
    width: presetField('width', v.width),
    height: presetField('height', v.height),
    fps: presetField('fps', v.fps),
    maxBitrate: presetField('maxBitrate', v.maxBitrate),
    contentHint: presetField('contentHint', v.contentHint),
  }
}

function parseLivekit(v: unknown): { url: string; token: string } {
  if (!isObj(v)) invalid('livekit must be an object')
  const { url, token } = v
  if (typeof url !== 'string' || url.length > 2048) invalid('livekit.url must be a URL')
  try {
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(new URL(url).protocol)) invalid('livekit.url must be ws(s) or http(s)')
  } catch (err) {
    if (err instanceof NativeShareFailure) throw err
    invalid('livekit.url must be a URL')
  }
  // Never echo the token in an error message.
  if (typeof token !== 'string' || token.length === 0 || token.length > 8192 || /[\s\u0000-\u001f]/.test(token))
    invalid('livekit.token is invalid')
  return { url, token }
}

function parseStart(v: unknown) {
  if (!isObj(v)) invalid('options must be an object')
  if (typeof v.sourceId !== 'string' || !SOURCE_ID_RE.test(v.sourceId)) invalid('invalid capture source id')
  return {
    sourceId: v.sourceId,
    preset: parsePreset(v.preset),
    cursor: bool(v.cursor, 'cursor'),
    withAudio: bool(v.withAudio, 'withAudio'),
    hideNexo: bool(v.hideNexo, 'hideNexo'),
    livekit: parseLivekit(v.livekit),
  }
}

function parseUpdate(v: unknown): UpdateRequest {
  if (!isObj(v)) invalid('patch must be an object')
  const out: UpdateRequest = {}
  if (v.preset !== undefined) {
    if (!isObj(v.preset)) invalid('preset must be an object')
    const preset: Partial<NativeSharePreset> = {}
    for (const key of ['width', 'height', 'fps', 'maxBitrate', 'contentHint'] as const) {
      if (v.preset[key] !== undefined) (preset as Record<string, unknown>)[key] = presetField(key, v.preset[key])
    }
    out.preset = preset
  }
  if (v.cursor !== undefined) out.cursor = bool(v.cursor, 'cursor')
  return out
}

// ── Install ─────────────────────────────────────────────────────────────────────────────────────────────

let supervisor: NativeShareSupervisor | null = null

async function settle(fn: () => Promise<void>): Promise<NativeShareInvokeResult> {
  try {
    await fn()
    return { ok: true }
  } catch (err) {
    const error = toNativeShareError(err)
    if (error.code === 'internal') console.warn('[nexo] native share:', error.message)
    return { ok: false, error }
  }
}

export interface NativeShareDeps {
  getWindow(): BrowserWindow | null
}

export function installNativeShare(deps: NativeShareDeps): void {
  const sup = new NativeShareSupervisor({
    resolveLaunch,
    osSupported: platform === 'win32' || FAKE,
    osReason: 'Native capture is only available on Windows',
    emit: (event: NativeShareEvent) => {
      const win = deps.getWindow()
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IPC.nativeShareEvent, event)
    },
    setHideNexo,
    debug: process.env.NEXO_MEDIA_DEBUG === '1',
  })
  supervisor = sup

  const fromApp = (event: IpcMainInvokeEvent): boolean => isAppUrl(event.senderFrame?.url)

  ipcMain.handle(IPC.nativeShareCapabilities, (event) => {
    if (!fromApp(event)) throw new Error('forbidden')
    return sup.capabilities()
  })

  ipcMain.handle(IPC.nativeShareStart, (event, opts: unknown) => {
    if (!fromApp(event)) throw new Error('forbidden')
    return settle(async () => {
      const o = parseStart(opts)
      // The renderer never sends HWNDs or PIDs (SPEC-BETA §8.1): main translates and fills them in.
      const kind = sourceKind(o.sourceId)
      const source = await toHelperSource(o.sourceId)
      await sup.start({
        source,
        preset: o.preset,
        cursor: o.cursor,
        audio: helperAudioMode(kind, o.withAudio),
        excludePid: process.pid,
        livekit: o.livekit,
        hideNexo: kind === 'screen' && o.hideNexo,
      })
    })
  })

  ipcMain.handle(IPC.nativeShareUpdate, (event, patch: unknown) => {
    if (!fromApp(event)) throw new Error('forbidden')
    return settle(() => sup.update(parseUpdate(patch)))
  })

  ipcMain.handle(IPC.nativeShareStop, (event) => {
    if (!fromApp(event)) throw new Error('forbidden')
    return settle(() => sup.stop())
  })

  ipcMain.handle(IPC.nativeShareRelease, (event) => {
    if (!fromApp(event)) throw new Error('forbidden')
    return settle(() => sup.release())
  })

  // A window created mid-share is hidden too.
  app.on('browser-window-created', (_event, win) => {
    if (hideNexo) win.setContentProtection(true)
  })

  // Quit: stop the share and shut the helper down cleanly (so the stream participant leaves at once instead
  // of timing out), bounded by QUIT_GRACE_MS. The helper's own watchdog covers a hard Electron exit.
  let quitting = false
  app.on('will-quit', (event) => {
    if (quitting || (!sup.running && !sup.sharing)) {
      sup.dispose()
      return
    }
    quitting = true
    event.preventDefault()
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, QUIT_GRACE_MS))
    void Promise.race([sup.release(), timeout]).finally(() => {
      sup.dispose()
      if (hideNexo) setHideNexo(false)
      app.quit()
    })
  })
}

/** Stop any share and shut the helper down: the main window closed, or its renderer reloaded or died. */
export function releaseNativeShare(): void {
  void supervisor?.release()
}
