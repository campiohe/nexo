// Screen / window capture: custom picker sources + the getDisplayMedia handler (SPEC §4.2).
import { BrowserWindow, desktopCapturer, ipcMain, session, type IpcMainInvokeEvent } from 'electron'
import { IPC, type CaptureSource } from '../preload/api'
import { supportsSystemAudio, usesSystemPicker } from './platform'
import { isAppUrl } from './security'

interface PendingChoice {
  id: string | null
  withAudio: boolean
  at: number
}

/** A selection is only honoured by a getDisplayMedia call made shortly afterwards. */
const PENDING_TTL_MS = 60_000
const SOURCE_ID_RE = /^(screen|window):[\w:.-]{1,128}$/

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
