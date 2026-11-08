// Screen / window capture: custom picker sources + the getDisplayMedia handler (SPEC §4.2).
import { BrowserWindow, desktopCapturer, ipcMain, screen, session, type IpcMainInvokeEvent } from 'electron'
import { IPC, type CaptureSource } from '../preload/api'
import { NativeShareFailure } from './native-media/mapping'
import type { HelperAudioMode, HelperRect, HelperSource } from './native-media/protocol'
import { supportsSystemAudio, usesSystemPicker } from './platform'
import { isAppUrl } from './security'

interface PendingChoice {
  id: string | null
  withAudio: boolean
  at: number
}

/** A selection is only honoured by a getDisplayMedia call made shortly afterwards. */
const PENDING_TTL_MS = 60_000
export const SOURCE_ID_RE = /^(screen|window):[\w:.-]{1,128}$/

let pending: PendingChoice | null = null

function fromApp(event: IpcMainInvokeEvent): boolean {
  return isAppUrl(event.senderFrame?.url)
}

/** "window:<native id>:<n>" → "<native id>" */
function nativeWindowId(sourceId: string): string | null {
  const parts = sourceId.split(':')
  return parts[0] === 'window' && parts[1] ? parts[1] : null
}

async function listSources(): Promise<CaptureSource[]> {
  // On Wayland, getSources() would open the portal picker; the renderer shows a single "Share" button instead.
  if (usesSystemPicker) return []

  const own = new Set(
    BrowserWindow.getAllWindows()
      .map((w) => nativeWindowId(w.getMediaSourceId()))
      .filter((id): id is string => !!id),
  )
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  })
  return sources
    .filter((s) => {
      const nid = nativeWindowId(s.id)
      return !(nid && own.has(nid))
    })
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }))
}

async function resolveSource(choice: PendingChoice): Promise<Electron.DesktopCapturerSource | undefined> {
  const noThumb = { width: 0, height: 0 }
  if (usesSystemPicker) {
    // Wayland: this call shows the xdg-desktop-portal (PipeWire) picker; the portal lets the user pick a
    // monitor or a window and returns exactly one source. Empty when the user cancels.
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: noThumb })
    return sources[0]
  }
  if (!choice.id) return undefined
  const kind = choice.id.startsWith('screen:') ? 'screen' : 'window'
  const sources = await desktopCapturer.getSources({ types: [kind], thumbnailSize: noThumb })
  return sources.find((s) => s.id === choice.id)
}

async function handleDisplayMedia(
  request: Electron.DisplayMediaRequestHandlerHandlerRequest,
): Promise<Electron.Streams | null> {
  const choice = pending
  pending = null
  if (!request.frame || !isAppUrl(request.frame.url)) {
    console.warn('[nexo] getDisplayMedia from a foreign frame denied')
    return null
  }
  if (!choice || Date.now() - choice.at > PENDING_TTL_MS) {
    console.warn('[nexo] getDisplayMedia without a prior nexo.capture.selectSource() — denied')
    return null
  }
  const source = await resolveSource(choice)
  if (!source) {
    console.warn('[nexo] selected capture source is gone or the picker was cancelled')
    return null
  }
  const streams: Electron.Streams = { video: { id: source.id, name: source.name } }
  if (choice.withAudio && request.audioRequested && supportsSystemAudio) streams.audio = 'loopback'
  return streams
}

// ── Native share (docs/SPEC-BETA.md §5): picker id → helper source ─────────────────────────────────────

export type SourceKind = 'window' | 'screen'

export function sourceKind(sourceId: string): SourceKind {
  return sourceId.startsWith('screen:') ? 'screen' : 'window'
}

/** Physical pixels for a DIP rect. screen.dipToScreenRect is Windows-only; elsewhere (fake helper) scale it. */
function physicalRect(display: Electron.Display): HelperRect {
  const r =
    process.platform === 'win32'
      ? screen.dipToScreenRect(null, display.bounds)
      : {
          x: Math.round(display.bounds.x * display.scaleFactor),
          y: Math.round(display.bounds.y * display.scaleFactor),
          width: Math.round(display.bounds.width * display.scaleFactor),
          height: Math.round(display.bounds.height * display.scaleFactor),
        }
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

/**
 * desktopCapturer id → what the helper captures. `window:<hwnd>:<n>` → the HWND (decimal, as Chromium
 * formats it on Windows); `screen:<id>:<n>` → the matching Display's physical bounds (the helper resolves
 * them with MonitorFromRect). Throws NativeShareFailure('capture-failed') when the source is gone.
 */
export async function toHelperSource(sourceId: string): Promise<HelperSource> {
  if (!SOURCE_ID_RE.test(sourceId)) throw new NativeShareFailure('internal', 'invalid capture source id')
  const [kind, id] = sourceId.split(':')
  if (kind === 'window') {
    if (!id || !/^\d{1,20}$/.test(id)) throw new NativeShareFailure('capture-failed', 'This window cannot be captured natively')
    return { kind: 'window', hwnd: id }
  }

  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
  const source = sources.find((s) => s.id === sourceId)
  if (!source) throw new NativeShareFailure('capture-failed', 'The selected screen is no longer available')
  const displays = screen.getAllDisplays()
  const display =
    displays.find((d) => source.display_id !== '' && String(d.id) === source.display_id) ??
    // display_id can be empty when Chromium doesn't know it; only a single display is unambiguous.
    (source.display_id === '' && displays.length === 1 ? displays[0] : undefined)
  if (!display) throw new NativeShareFailure('capture-failed', 'Could not match the selected screen to a display')
  return { kind: 'monitor', rect: physicalRect(display) }
}

/** SPEC-BETA §4.7: a window streams its own app's audio, a screen everything except Nexo. */
export function helperAudioMode(kind: SourceKind, withAudio: boolean): HelperAudioMode {
  if (!withAudio) return 'off'
  return kind === 'window' ? 'app' : 'system-but-nexo'
}

export function installCapture(): void {
  ipcMain.handle(IPC.listSources, async (event) => {
    if (!fromApp(event)) throw new Error('forbidden')
    return listSources()
  })

  ipcMain.handle(IPC.selectSource, (event, id: unknown, withAudio: unknown) => {
    if (!fromApp(event)) throw new Error('forbidden')
    if (typeof withAudio !== 'boolean') throw new TypeError('withAudio must be a boolean')
    if (usesSystemPicker) {
      if (id !== null) throw new TypeError('id must be null when the system picker is used')
    } else if (typeof id !== 'string' || !SOURCE_ID_RE.test(id)) {
      throw new TypeError('invalid capture source id')
    }
    pending = { id: id as string | null, withAudio, at: Date.now() }
  })

  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      handleDisplayMedia(request).then(
        (streams) => callback(streams),
        (err: unknown) => {
          console.error('[nexo] display media handler failed:', err)
          callback(null)
        },
      )
    },
    // The macOS 15+ native picker would bypass Nexo's own picker (and the pending-choice gate).
    { useSystemPicker: false },
  )
}
