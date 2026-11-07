// Profile picture upload/removal over HTTP (PUT/DELETE /api/avatar, see shared/protocol.ts).
// Auth is the same device token the socket handshake uses, sent as a bearer token.
import type { User } from '@shared/protocol'
import { AVATAR_MAX_BYTES } from '@shared/protocol'
import { useApp } from '../store/app'
import { settings } from '../store/settings'

const UPLOAD_TIMEOUT_MS = 30_000

/** Apply a user returned by the server (the `user:upsert` broadcast normally arrives too; this is idempotent). */
function applyUser(user: User) {
  useApp.setState((st) => ({ users: { ...st.users, [user.id]: user }, me: st.me?.id === user.id ? user : st.me }))
}

async function authed(method: 'PUT' | 'DELETE', body?: Blob): Promise<User> {
  const serverUrl = useApp.getState().serverUrl
  if (!serverUrl) throw new Error('Not connected to a server')
  const token = await settings.getToken(serverUrl)
  if (!token) throw new Error("This device isn't signed in to the server")

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (body) headers['Content-Type'] = body.type
  let res: Response
  try {
    res = await fetch(`${serverUrl}/api/avatar`, {
      method,
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') throw new Error('The server took too long to respond')
    throw new Error(`Can't reach the server at ${serverUrl}`)
  }

  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* not JSON (e.g. an older server without avatar support answers 404 with no body) */
  }
  if (!res.ok) {
    const error = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : null
    if (error) throw new Error(error)
    if (res.status === 404) throw new Error("This server doesn't support profile pictures yet (update the Nexo server)")
    throw new Error(`The server rejected the request (HTTP ${res.status})`)
  }
  const user = data && typeof data === 'object' && 'user' in data ? (data.user as User) : null
  if (!user || typeof user.id !== 'string') throw new Error('Invalid response from the server')
  applyUser(user)
  return user
}

/** Upload an already cropped/resized image (image/webp, image/png or image/jpeg). */
export function uploadAvatar(image: Blob): Promise<User> {
  if (image.size > AVATAR_MAX_BYTES) {
    return Promise.reject(new Error(`Profile pictures are limited to ${Math.round(AVATAR_MAX_BYTES / 1024)} KB`))
  }
  return authed('PUT', image)
}

export function removeAvatar(): Promise<User> {
  return authed('DELETE')
}
