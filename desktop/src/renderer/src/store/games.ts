// Games plugin sessions per voice channel (GameLobby: game, host, players, bots, match). From bootstrap, kept
// current by `games:lobby` (net/socket.ts) and the acks of the `games:*` requests. Frames (the match itself)
// don't go through React state: games/frames.ts. Session state: reset on server change / sign out (resetGames).
// No imports from store/app or net/socket (net/socket imports this module; see store/sounds.ts).
import { create } from 'zustand'
import type { GameLobby } from '@shared/protocol'

interface GamesStore {
  /** channelId → its open session. Closed sessions have no entry. */
  byChannel: Record<string, GameLobby>
  /** Channels whose game this device hid (the stage shows people instead); a new match shows it again. */
  hidden: Record<string, true>
}

export const useGames = create<GamesStore>()(() => ({ byChannel: {}, hidden: {} }))

function isLobby(l: unknown): l is GameLobby {
  if (!l || typeof l !== 'object') return false
  const g = l as Partial<GameLobby>
  return typeof g.channelId === 'string' && typeof g.rev === 'number' && typeof g.gameId === 'string' && Array.isArray(g.players)
}

export function setBootstrapGames(list: GameLobby[] | undefined): void {
  const byChannel: Record<string, GameLobby> = {}
  if (Array.isArray(list)) for (const l of list) if (isLobby(l) && l.status !== 'closed') byChannel[l.channelId] = l
  useGames.setState({ byChannel, hidden: {} })
}

/** A session changed (older revs ignored); `closed` drops it. A newly started match un-hides the game. */
export function applyGameLobby(l: GameLobby): void {
  if (!isLobby(l)) return
  useGames.setState((st) => {
    const cur = st.byChannel[l.channelId]
    if (cur && l.rev <= cur.rev) return st
    const byChannel = { ...st.byChannel }
    let hidden = st.hidden
    if (l.status === 'closed') {
      if (!cur) return st
      delete byChannel[l.channelId]
    } else {
      byChannel[l.channelId] = l
    }
    if ((l.status === 'closed' || (l.status === 'playing' && cur?.matchId !== l.matchId)) && hidden[l.channelId]) {
      hidden = { ...hidden }
      delete hidden[l.channelId]
    }
    return { byChannel, hidden }
  })
}

export function setGameHidden(channelId: string, hide: boolean): void {
  useGames.setState((st) => {
    if (!!st.hidden[channelId] === hide) return st
    const hidden = { ...st.hidden }
    if (hide) hidden[channelId] = true
    else delete hidden[channelId]
    return { hidden }
  })
}

/** A deleted channel's session goes with it. */
export function forgetGameChannel(channelId: string): void {
  useGames.setState((st) => {
    if (!(channelId in st.byChannel)) return st
    const byChannel = { ...st.byChannel }
    delete byChannel[channelId]
    return { byChannel }
  })
}

/** Another server, or signed out (store/app.ts, net/socket.ts, store/signin.ts). */
export function resetGames(): void {
  useGames.setState({ byChannel: {}, hidden: {} })
}
