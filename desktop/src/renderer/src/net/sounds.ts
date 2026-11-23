// Soundboard over HTTP (POST/DELETE /api/sounds, GET /sounds/:id; see shared/protocol.ts). Auth is the same
// device token the socket handshake uses, sent as a bearer token.
import type { Sound } from '@shared/protocol'
import { SOUND_MAX_BYTES } from '@shared/protocol'
import { useApp } from '../store/app'
import { t } from '../i18n'
import { settings } from '../store/settings'
import { removeSound, upsertSound } from '../store/sounds'

const TIMEOUT_MS = 30_000

/** A DELETE of a sound the server no longer has: deleteSound() treats it as done. */
class SoundGoneError extends Error {}

/** `${serverUrl}/sounds/<id>`: public, cached forever. */
export function soundUrl(serverUrl: string, id: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/sounds/${encodeURIComponent(id)}`
}

async function authed(method: 'POST' | 'DELETE', path: string, body?: Blob): Promise<unknown> {
  const serverUrl = useApp.getState().serverUrl
  if (!serverUrl) throw new Error(t('Not connected to a server'))
  const token = await settings.getToken(serverUrl)
  if (!token) throw new Error(t("This device isn't signed in to the server"))

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (body) headers['Content-Type'] = body.type
  let res: Response
  try {
    res = await fetch(`${serverUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') throw new Error(t('The server took too long to respond'))
    throw new Error(t("Can't reach the server at {url}", { url: serverUrl }))
  }
  let data: unknown = null
  if (res.status !== 204) {
    try {
      data = await res.json()
    } catch {
      /* no JSON body */
    }
  }
  if (!res.ok) {
    const error = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : null
    if (error) throw new Error(error)
    if (res.status === 404) {
      if (method === 'DELETE') throw new SoundGoneError(t('That sound is already gone'))
      throw new Error(t("This server doesn't have a soundboard yet (update the Nexo server)"))
    }
    if (res.status === 409) throw new Error(t('The soundboard is full'))
    if (res.status === 413) throw new Error(t('That clip is too large'))
    if (res.status === 429) throw new Error(t('Too many uploads, try again in a moment'))
    // status as a string: an HTTP code, not a formatted number.
    throw new Error(t('The server rejected the request (HTTP {status})', { status: String(res.status) }))
  }
  return data
}

export async function uploadSound(
  audio: Blob,
  meta: { name: string; emoji: string | null; durationMs: number },
): Promise<Sound> {
  if (audio.size > SOUND_MAX_BYTES) throw new Error(t('Sounds are limited to {size} KB', { size: Math.round(SOUND_MAX_BYTES / 1024) }))
  const q = new URLSearchParams({ name: meta.name, durationMs: String(Math.round(meta.durationMs)) })
  if (meta.emoji) q.set('emoji', meta.emoji)
  const data = await authed('POST', `/api/sounds?${q}`, audio)
  const sound = data && typeof data === 'object' && 'sound' in data ? (data.sound as Sound) : null
  if (!sound || typeof sound.id !== 'string') throw new Error(t('Invalid response from the server'))
  upsertSound(sound) // the `sound:upsert` broadcast arrives too; idempotent
  return sound
}

export async function deleteSound(id: string): Promise<void> {
  try {
    await authed('DELETE', `/api/sounds/${encodeURIComponent(id)}`)
  } catch (err) {
    if (err instanceof SoundGoneError) {
      removeSound(id)
      return
    }
    throw err
  }
  removeSound(id)
}
