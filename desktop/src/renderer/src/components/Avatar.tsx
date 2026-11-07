import type { User } from '@shared/protocol'
import { initials, inkOn } from '../lib/colors'

interface AvatarProps {
  user: Pick<User, 'name' | 'color'> | null | undefined
  size?: number
  /** Show a presence dot: true = online, false = offline, undefined = no dot. */
  online?: boolean
  className?: string
}

export function Avatar({ user, size = 32, online, className }: AvatarProps) {
  const color = user?.color ?? 'var(--bg-4)'
  const name = user?.name ?? '?'
  return (
    <span
      className={`avatar ${className ?? ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: color, color: inkOn(color) }}
      aria-hidden="true"
    >
      {initials(name)}
      {online !== undefined && <span className={`avatar-presence ${online ? 'is-online' : 'is-offline'}`} />}
    </span>
  )
}
