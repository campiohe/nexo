// Profile picture URLs (see the AVATAR_* block in shared/protocol.ts).
import type { User } from '@shared/protocol'

/**
 * `${serverUrl}/avatars/<id>?v=<version>`, or null when there is no picture to show.
 * The version token changes on every upload, so the URL can be cached forever.
 */
export function avatarUrl(
  serverUrl: string | null | undefined,
  user: Partial<Pick<User, 'id' | 'avatar'>> | null | undefined,
): string | null {
  if (!serverUrl || !user?.id || !user.avatar) return null
  return `${serverUrl.replace(/\/+$/, '')}/avatars/${encodeURIComponent(user.id)}?v=${encodeURIComponent(user.avatar)}`
}
