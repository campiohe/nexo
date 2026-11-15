// Who is watching a stream: eye + count + up to 3 stacked mini avatars, names on hover. Data comes from the
// server's voice states (`watching`, announced by session.ts), so it covers everyone in the channel.
import { memo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { VoiceState } from '@shared/protocol'
import { useApp } from '@renderer/store/app'
import { Avatar } from '@renderer/components/Avatar'
import { EyeIcon } from './icons'

const NO_VIEWERS: string[] = []

/**
 * userIds watching `streamerId`'s stream: voice states in the streamer's channel whose `watching` lists them.
 * Use with `useShallow` (as useStreamViewers does) so the result only changes when the viewers do.
 */
export function streamViewerIds(voice: readonly VoiceState[], streamerId: string): string[] {
  const channelId = voice.find((v) => v.userId === streamerId)?.channelId
  if (!channelId) return NO_VIEWERS
  const ids = voice
    .filter((v) => v.channelId === channelId && v.userId !== streamerId && v.watching?.includes(streamerId))
    .map((v) => v.userId)
  return ids.length ? ids : NO_VIEWERS
}

export function useStreamViewers(streamerId: string): string[] {
  return useApp(useShallow((s) => streamViewerIds(s.voice, streamerId)))
}

const MAX_FACES = 3

interface Props {
  streamerId: string
  /** 'chip': compact overlay on a stream (nothing when nobody watches). 'card': the "You're live" card. */
  variant: 'chip' | 'card'
  /** Card only: say so when nobody is watching yet. */
  showEmpty?: boolean
}

export const StreamViewers = memo(function StreamViewers({ streamerId, variant, showEmpty }: Props) {
  const ids = useStreamViewers(streamerId)
  const users = useApp((s) => s.users)
  if (ids.length === 0) {
    return variant === 'card' && showEmpty ? <span className="vx-viewers is-card is-empty">No one is watching yet</span> : null
  }
  const names = ids.map((id) => users[id]?.name ?? 'Someone')
  const label = `${ids.length} watching: ${names.join(', ')}`
  const faces = ids.slice(0, MAX_FACES)
  const size = variant === 'card' ? 22 : 18
  return (
    <span className={`vx-viewers is-${variant}`} title={label} aria-label={label} role="img">
      <EyeIcon size={variant === 'card' ? 15 : 13} />
      <span className="vx-viewers-count">{ids.length}</span>
      <span className="vx-viewers-faces" aria-hidden="true">
        {faces.map((id) => (
          <Avatar key={id} user={users[id] ?? { id, name: '?', color: 'var(--bg-4)' }} size={size} />
        ))}
      </span>
      {variant === 'card' && (
        <span className="vx-viewers-names">
          {names.slice(0, 2).join(', ')}
          {names.length > 2 ? ` +${names.length - 2}` : ''}
        </span>
      )}
    </span>
  )
})
