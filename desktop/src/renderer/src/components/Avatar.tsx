import { useState } from 'react'
import type { PresenceStatus, User } from '@shared/protocol'
import { initials, inkOn } from '../lib/colors'
import { avatarUrl } from '../lib/avatar'
import { usePrefersReducedMotion, useStillFrame } from '../lib/avatarStill'
import { useApp } from '../store/app'
import './avatarMedia.css'

interface AvatarProps {
  /** Pass the full User when available so the profile picture can be shown. */
  user: (Pick<User, 'name' | 'color'> & Partial<Pick<User, 'id' | 'avatar' | 'avatarAnimated'>>) | null | undefined
  size?: number
  /** Show a presence dot: true = online, false = offline, undefined = no dot. */
  online?: boolean
  /** With `online`: idle (yellow) / do not disturb (red) instead of the plain online dot. */
  status?: PresenceStatus
  className?: string
  /** Show this image instead of the user's picture (e.g. a local preview). */
  src?: string | null
  /**
   * Animated pictures (`user.avatarAnimated`) show their first frame and play only while the avatar itself
   * is hovered, or while this is true: the parent's row is hovered, the user is speaking, a profile card /
   * settings preview. Never with the OS "reduce motion" setting.
   */
  animate?: boolean
}

export function Avatar({ user, size = 32, online, status, className, src, animate }: AvatarProps) {
  const serverUrl = useApp((s) => s.serverUrl)
  const url = src ?? avatarUrl(serverUrl, user)
  // Remember which URL failed so a new version (or a fixed server) is tried again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showImage = !!url && url !== failedUrl
  const animated = showImage && !src && !!user?.avatarAnimated
  const still = useStillFrame(animated ? url : null)
  const reducedMotion = usePrefersReducedMotion()
  const [hovered, setHovered] = useState(false)
  // Without a still frame (couldn't fetch / decode it) the picture itself is the only thing to show.
  const play = animated && ((!reducedMotion && (animate || hovered)) || still.failed)
  const color = user?.color ?? 'var(--bg-4)'
  const name = user?.name ?? '?'

  const img = (imgSrc: string, onError?: () => void) => (
    <img className="avatar-img" src={imgSrc} alt="" draggable={false} decoding="async" loading="lazy" onError={onError} />
  )

  return (
    <span
      className={`avatar ${showImage ? 'has-image' : ''} ${className ?? ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: color, color: inkOn(color) }}
      aria-hidden="true"
      onPointerEnter={animated ? () => setHovered(true) : undefined}
      onPointerLeave={animated ? () => setHovered(false) : undefined}
    >
      {!showImage
        ? initials(name)
        : !animated
          ? img(url, () => setFailedUrl(url))
          : (
              <>
                {still.url && img(still.url)}
                {/* Mounted only while playing (on top of the still frame), so idle avatars cost nothing. */}
                {play && img(url, () => setFailedUrl(url))}
              </>
            )}
      {online !== undefined && (
        <span
          className={`avatar-presence ${online ? `is-online${status && status !== 'online' ? ` is-${status}` : ''}` : 'is-offline'}`}
        />
      )}
    </span>
  )
}
