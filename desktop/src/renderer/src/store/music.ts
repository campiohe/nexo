// Music plugin sessions per voice channel (MusicState: queue, current track, timing). From bootstrap, kept
// current by `music:state` (net/socket.ts) and the acks of `music:add` / `music:control`. Playback itself is
// voice/musicPlayer.ts. Session state: reset on server change / sign out (resetMusic).
// No imports from store/app or net/socket (net/socket imports this module; see store/sounds.ts).
import { create } from 'zustand'
import type { MusicState } from '@shared/protocol'

interface MusicStore {
  /** channelId → its session. Channels without one (or whose session became empty) have no entry. */
  byChannel: Record<string, MusicState>
}

export const useMusic = create<MusicStore>()(() => ({ byChannel: {} }))

function isState(s: unknown): s is MusicState {
  if (!s || typeof s !== 'object') return false
  const m = s as Partial<MusicState>
  return typeof m.channelId === 'string' && typeof m.rev === 'number' && Array.isArray(m.queue)
}

function isEmpty(s: MusicState): boolean {
  return !s.current && s.queue.length === 0
}

export function setBootstrapMusic(list: MusicState[] | undefined): void {
  const byChannel: Record<string, MusicState> = {}
  if (Array.isArray(list)) for (const s of list) if (isState(s) && !isEmpty(s)) byChannel[s.channelId] = s
  useMusic.setState({ byChannel })
}

/**
 * A session changed. States older than (or as old as) the one we have are ignored. An empty session is
 * dropped, so a session the server later starts over (its `rev` may start over too) is accepted.
 */
export function applyMusicState(s: MusicState): void {
  if (!isState(s)) return
  useMusic.setState((st) => {
    const cur = st.byChannel[s.channelId]
    if (cur && s.rev <= cur.rev) return st
    const byChannel = { ...st.byChannel }
    if (isEmpty(s)) {
      if (!cur) return st
      delete byChannel[s.channelId]
    } else {
      byChannel[s.channelId] = s
    }
    return { byChannel }
  })
}

/** A deleted channel's session goes with it. */
export function forgetMusicChannel(channelId: string): void {
  useMusic.setState((st) => {
    if (!(channelId in st.byChannel)) return st
    const byChannel = { ...st.byChannel }
    delete byChannel[channelId]
    return { byChannel }
  })
}

/** Another server, or signed out (store/app.ts, net/socket.ts, store/signin.ts). */
export function resetMusic(): void {
  useMusic.setState({ byChannel: {} })
}
