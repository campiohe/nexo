// Chat image uploads over HTTP (POST /api/attachments, see shared/protocol.ts) and the composer's pending
// images. Uploads start as soon as an image is added; `message:send` then claims them by id.
// Auth is the same device token the socket handshake uses, sent as a bearer token.
import { create } from 'zustand'
import type { Attachment } from '@shared/protocol'
import { MAX_ATTACHMENTS_PER_MESSAGE } from '@shared/protocol'
import { useApp } from '../store/app'
import { settings } from '../store/settings'
import { prepareImage } from '../lib/imageEncode'
import { errorMessage, toast } from '../lib/toast'

const UPLOAD_TIMEOUT_MS = 5 * 60_000
const PROBE_TIMEOUT_MS = 5000
export const UNSUPPORTED_SERVER = "This server doesn't support images yet. Ask the host to update."

/** `${serverUrl}/attachments/<id>`: public, cached forever (the id names immutable content). */
export function attachmentUrl(serverUrl: string | null | undefined, id: string): string | null {
  if (!serverUrl) return null
  return `${serverUrl.replace(/\/+$/, '')}/attachments/${encodeURIComponent(id)}`
}

/**
 * After an upload failed at the network level: is the server up but too old for images?
 * A server without image support answers unknown paths with a bare 404 that has no CORS header, so its
 * preflight fails (status 0) instead of a readable 404. A current server's 404s are readable cross-origin.
 */
async function lacksImageSupport(serverUrl: string): Promise<boolean> {
  const get = (p: string) => fetch(`${serverUrl}${p}`, { cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  try {
    if (!(await get('/health')).ok) return false
  } catch {
    return false // unreachable: a plain network problem
  }
  try {
    await get('/attachments/00000000-0000-4000-8000-000000000000')
    return false
  } catch {
    return true
  }
}

/** POST the image with upload progress (fetch can't report it, so this uses XHR). */
async function upload(blob: Blob, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<Attachment> {
  const serverUrl = useApp.getState().serverUrl
  if (!serverUrl) throw new Error('Not connected to a server')
  const token = await settings.getToken(serverUrl)
  if (!token) throw new Error("This device isn't signed in to the server")

  const xhr = new XMLHttpRequest()
  const done = new Promise<void>((resolve, reject) => {
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => resolve()
    xhr.onerror = () => reject(new Error('network'))
    xhr.ontimeout = () => reject(new Error('The upload took too long'))
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'))
  })
  signal.addEventListener('abort', () => xhr.abort(), { once: true })
  xhr.open('POST', `${serverUrl}/api/attachments`)
  xhr.timeout = UPLOAD_TIMEOUT_MS
  xhr.responseType = 'text'
  xhr.setRequestHeader('Authorization', `Bearer ${token}`)
  xhr.setRequestHeader('Content-Type', blob.type)
  xhr.send(blob)

  try {
    await done
  } catch (err) {
    if (err instanceof Error && err.message === 'network') {
      throw new Error((await lacksImageSupport(serverUrl)) ? UNSUPPORTED_SERVER : `Can't reach the server at ${serverUrl}`)
    }
    throw err
  }

  let data: unknown = null
  try {
    data = JSON.parse(xhr.responseText)
  } catch {
    /* not JSON */
  }
  if (xhr.status < 200 || xhr.status >= 300) {
    const error = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : null
    if (error) throw new Error(error)
    if (xhr.status === 404) throw new Error(UNSUPPORTED_SERVER)
    throw new Error(`The server rejected the image (HTTP ${xhr.status})`)
  }
  const attachment = data && typeof data === 'object' && 'attachment' in data ? (data.attachment as Attachment) : null
  if (!attachment || typeof attachment.id !== 'string') throw new Error('Invalid response from the server')
  return attachment
}

// ---------- pending images (per channel, survive switching channels) ----------

export type PendingStatus = 'uploading' | 'done' | 'error'

export interface PendingImage {
  key: string
  name: string
  /** blob: URL of the picked file, for the thumbnail. */
  previewUrl: string
  status: PendingStatus
  /** Upload progress 0..1 (while uploading). */
  progress: number
  error: string | null
  attachment: Attachment | null
}

interface PendingState {
  byChannel: Record<string, PendingImage[]>
}

export const usePendingImages = create<PendingState>()(() => ({ byChannel: {} }))

interface Job {
  file: File
  abort: AbortController
  /** Settles (never rejects) when the current attempt finishes. */
  promise: Promise<void>
}
const jobs = new Map<string, Job>()
let nextKey = 1

const listFor = (channelId: string) => usePendingImages.getState().byChannel[channelId] ?? []

function patch(channelId: string, key: string, p: Partial<PendingImage>) {
  usePendingImages.setState((s) => {
    const list = s.byChannel[channelId]
    if (!list?.some((i) => i.key === key)) return {}
    return { byChannel: { ...s.byChannel, [channelId]: list.map((i) => (i.key === key ? { ...i, ...p } : i)) } }
  })
}

function setList(channelId: string, list: PendingImage[]) {
  usePendingImages.setState((s) => {
    const byChannel = { ...s.byChannel }
    if (list.length) byChannel[channelId] = list
    else delete byChannel[channelId]
    return { byChannel }
  })
}

function start(channelId: string, key: string) {
  const job = jobs.get(key)
  if (!job) return
  const abort = new AbortController()
  job.abort = abort
  patch(channelId, key, { status: 'uploading', progress: 0, error: null })
  let shown = 0
  job.promise = (async () => {
    try {
      const blob = await prepareImage(job.file)
      if (abort.signal.aborted) return
      const attachment = await upload(
        blob,
        (f) => {
          // Coarse steps: enough for a progress ring without a re-render per network chunk.
          if (f - shown >= 0.02 || f === 1) patch(channelId, key, { progress: (shown = f) })
        },
        abort.signal,
      )
      patch(channelId, key, { status: 'done', progress: 1, attachment })
    } catch (err) {
      if (abort.signal.aborted) return
      const message = errorMessage(err)
      patch(channelId, key, { status: 'error', error: message })
      toast(message === UNSUPPORTED_SERVER ? message : `Couldn't upload ${job.file.name || 'the image'}: ${message}`, 'error')
    }
  })()
}

/** Add images to a channel's composer (extra files beyond the per-message limit are refused with a toast). */
export function addImages(channelId: string, files: File[]) {
  if (files.length === 0) return
  const current = listFor(channelId)
  const room = MAX_ATTACHMENTS_PER_MESSAGE - current.length
  if (room <= 0 || files.length > room) toast(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} images per message`, 'error')
  const accepted = files.slice(0, Math.max(0, room))
  if (accepted.length === 0) return
  const added: PendingImage[] = accepted.map((file) => {
    const key = `img-${nextKey++}`
    jobs.set(key, { file, abort: new AbortController(), promise: Promise.resolve() })
    return {
      key,
      name: file.name || 'image',
      previewUrl: URL.createObjectURL(file),
      status: 'uploading',
      progress: 0,
      error: null,
      attachment: null,
    }
  })
  setList(channelId, [...current, ...added])
  for (const item of added) start(channelId, item.key)
}

export function retryImage(channelId: string, key: string) {
  if (listFor(channelId).find((i) => i.key === key)?.status === 'error') start(channelId, key)
}

function release(key: string, previewUrl: string) {
  jobs.get(key)?.abort.abort()
  jobs.delete(key)
  URL.revokeObjectURL(previewUrl)
}

/** Remove one image (cancels its upload; an already uploaded file expires on the server). */
export function removeImage(channelId: string, key: string) {
  const list = listFor(channelId)
  const item = list.find((i) => i.key === key)
  if (!item) return
  release(key, item.previewUrl)
  setList(channelId, list.filter((i) => i.key !== key))
}

/** Forget the given images (after they were sent). */
export function clearImages(channelId: string, keys: string[]) {
  const list = listFor(channelId)
  for (const item of list) if (keys.includes(item.key)) release(item.key, item.previewUrl)
  setList(channelId, list.filter((i) => !keys.includes(i.key)))
}

/** Resolves once no image of the channel is still uploading, with the channel's list at that point. */
export async function settledImages(channelId: string): Promise<PendingImage[]> {
  for (;;) {
    const busy = listFor(channelId).filter((i) => i.status === 'uploading')
    if (busy.length === 0) return listFor(channelId)
    await Promise.all(busy.map((i) => jobs.get(i.key)?.promise))
  }
}

// Pending uploads belong to one server: drop them all when switching servers or signing out.
useApp.subscribe((s, prev) => {
  if (s.serverUrl === prev.serverUrl && !(s.view === 'onboarding' && prev.view !== 'onboarding')) return
  const all = usePendingImages.getState().byChannel
  for (const list of Object.values(all)) for (const item of list) release(item.key, item.previewUrl)
  usePendingImages.setState({ byChannel: {} })
})
