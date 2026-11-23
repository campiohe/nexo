// Profile picture upload/removal over HTTP (PUT/DELETE /api/avatar, see shared/protocol.ts).
// Auth is the same device token the socket handshake uses, sent as a bearer token.
import type { User } from '@shared/protocol'
import { AVATAR_ANIMATED_MAX_BYTES, AVATAR_MAX_BYTES } from '@shared/protocol'
import { useApp } from '../store/app'
import { settings } from '../store/settings'
import { msg, t } from '../i18n'

const UPLOAD_TIMEOUT_MS = 30_000

/** Apply a user returned by the server (the `user:upsert` broadcast normally arrives too; this is idempotent). */
export function applyUser(user: User) {
  useApp.setState((st) => ({ users: { ...st.users, [user.id]: user }, me: st.me?.id === user.id ? user : st.me }))
}

/**
 * PUT (upload `body`) or DELETE an image of the signed-in user at `path` (/api/avatar, /api/banner) and apply
 * the user the server returns. `unsupported` is the error shown when an older server answers 404 (a message key).
 */
export async function authedImageRequest(
  path: string,
  method: 'PUT' | 'DELETE',
  unsupported: string,
  body?: Blob,
): Promise<User> {
  const serverUrl = useApp.getState().serverUrl
  if (!serverUrl) throw new Error(t('Not connected to a server'))
  const token = await settings.getToken(serverUrl)
  if (!token) throw new Error(t("This device isn't signed in to the server"))

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (body) headers['Content-Type'] = body.type
  let res: Response
  try {
    res = await fetch(`${serverUrl}${path}`, {
      method,
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') throw new Error(t('The server took too long to respond'))
    throw new Error(t("Can't reach the server at {url}", { url: serverUrl }))
  }

  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* not JSON (e.g. an older server without avatar / banner support answers 404 with no body) */
  }
  if (!res.ok) {
    const error = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : null
    if (error) throw new Error(error)
    if (res.status === 404) throw new Error(t(unsupported))
    throw new Error(t('The server rejected the request (HTTP {status})', { status: res.status }))
  }
  const user = data && typeof data === 'object' && 'user' in data ? (data.user as User) : null
  if (!user || typeof user.id !== 'string') throw new Error(t('Invalid response from the server'))
  applyUser(user)
  return user
}

/**
 * Upload an already cropped/resized image: image/webp, image/png or image/jpeg (AVATAR_MAX_BYTES), or an
 * animated image/gif (AVATAR_ANIMATED_MAX_BYTES; the server then sets `avatarAnimated`).
 */
export function uploadAvatar(image: Blob): Promise<User> {
  if (image.type === 'image/gif') {
    if (image.size > AVATAR_ANIMATED_MAX_BYTES) {
      return Promise.reject(
        new Error(
          t('Animated profile pictures are limited to {size} MB', { size: Math.round(AVATAR_ANIMATED_MAX_BYTES / (1024 * 1024)) }),
        ),
      )
    }
  } else if (image.size > AVATAR_MAX_BYTES) {
    return Promise.reject(new Error(t('Profile pictures are limited to {size} KB', { size: Math.round(AVATAR_MAX_BYTES / 1024) })))
  }
  return authedImageRequest('/api/avatar', 'PUT', NO_AVATARS, image)
}

export function removeAvatar(): Promise<User> {
  return authedImageRequest('/api/avatar', 'DELETE', NO_AVATARS)
}

const NO_AVATARS = msg("This server doesn't support profile pictures yet (update the Nexo server)")

