// "Playing X" display helpers.
import { useEffect, useState } from 'react'
import type { Activity, Presence, User } from '@shared/protocol'
import { t as current, type Translate } from '../i18n'

/**
 * "for 5m", "for 1h 12m", "for 3d 4h"; under a minute: "just started". Components pass their useT() `t` (the
 * default translates in the current language without subscribing).
 */
export function formatElapsed(startedAt: number, now: number, t: Translate = current): string {
  const minutes = Math.floor(Math.max(0, now - startedAt) / 60_000)
  if (minutes < 1) return t('just started')
  if (minutes < 60) return t('for {minutes}m', { minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('for {hours}h {minutes}m', { hours, minutes: minutes % 60 })
  return t('for {days}d {hours}h', { days: Math.floor(hours / 24), hours: hours % 24 })
}

/** "Playing {game}". Components pass their useT() `t`. */
export const activityLabel = (a: Activity, t: Translate = current): string => t('Playing {game}', { game: a.name })

/** The one-line status under a name: what they're playing, else their custom status, else null. */
export function subtitleOf(
  user: Pick<User, 'statusText'> | undefined,
  presence: Presence | null,
  t: Translate = current,
): string | null {
  if (presence?.activity) return activityLabel(presence.activity, t)
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
