import { useState } from 'react'
import type { User } from '@shared/protocol'
import { initials, inkOn } from '../lib/colors'
import { avatarUrl } from '../lib/avatar'
import { useApp } from '../store/app'

interface AvatarProps {
  /** Pass the full User when available so the profile picture can be shown. */
  user: (Pick<User, 'name' | 'color'> & Partial<Pick<User, 'id' | 'avatar'>>) | null | undefined
  size?: number
  /** Show a presence dot: true = online, false = offline, undefined = no dot. */
  online?: boolean
  className?: string
  /** Show this image instead of the user's picture (e.g. a local preview). */
  src?: string | null
}

export function Avatar({ user, size = 32, online, className, src }: AvatarProps) {
  const serverUrl = useApp((s) => s.serverUrl)
  const url = src ?? avatarUrl(serverUrl, user)
  // Remember which URL failed so a new version (or a fixed server) is tried again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showImage = !!url && url !== failedUrl
  const color = user?.color ?? 'var(--bg-4)'
  const name = user?.name ?? '?'
  return (
    <span
      className={`avatar ${showImage ? 'has-image' : ''} ${className ?? ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: color, color: inkOn(color) }}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          className="avatar-img"
          src={url}
          alt=""
          draggable={false}
          decoding="async"
          loading="lazy"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        initials(name)
      )}
      {online !== undefined && <span className={`avatar-presence ${online ? 'is-online' : 'is-offline'}`} />}
    </span>
  )
}
