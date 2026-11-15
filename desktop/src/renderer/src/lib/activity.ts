// "Playing X" display helpers.
import { useEffect, useState } from 'react'
import type { Activity, Presence, User } from '@shared/protocol'

/** "for 5m", "for 1h 12m", "for 3d 4h"; under a minute: "just started". */
export function formatElapsed(startedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - startedAt) / 60_000)
  if (minutes < 1) return 'just started'
  if (minutes < 60) return `for ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `for ${hours}h ${minutes % 60}m`
  return `for ${Math.floor(hours / 24)}d ${hours % 24}h`
}

export const activityLabel = (a: Activity): string => `Playing ${a.name}`

/** The one-line status under a name: what they're playing, else their custom status, else null. */
export function subtitleOf(user: Pick<User, 'statusText'> | undefined, presence: Presence | null): string | null {
  if (presence?.activity) return activityLabel(presence.activity)
  return user?.statusText?.trim() || null
}

/** Current time, refreshed every `everyMs` while mounted (live "for 1h 12m"). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(id)
  }, [everyMs])
  return now
}
