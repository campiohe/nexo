// Games plugin requests (`games:*`) with their errors toasted, and the controller input sender.
import type { GameId, GameLobby } from '@shared/protocol'
import { emit, request } from '../net/socket'
import { applyGameLobby } from '../store/games'
import { toast } from '../lib/toast'

type LobbyEvent = 'games:open' | 'games:join' | 'games:leave' | 'games:bots' | 'games:start' | 'games:stop'

async function lobbyRequest(event: LobbyEvent, payload: Record<string, unknown>): Promise<GameLobby | null> {
  try {
    const l = (await request(event, payload as never)) as GameLobby
    applyGameLobby(l)
    return l
  } catch (err) {
    toast(err, 'error')
    return null
  }
}

export const openGame = (channelId: string, gameId: GameId) => lobbyRequest('games:open', { channelId, gameId })
export const joinGame = (channelId: string) => lobbyRequest('games:join', { channelId })
export const leaveGame = (channelId: string) => lobbyRequest('games:leave', { channelId })
export const setBots = (channelId: string, count: number) => lobbyRequest('games:bots', { channelId, count })
export const startGame = (channelId: string) => lobbyRequest('games:start', { channelId })
export const stopGame = (channelId: string) => lobbyRequest('games:stop', { channelId })

export async function closeGame(channelId: string): Promise<boolean> {
  try {
    await request('games:close', { channelId })
    return true
  } catch (err) {
    toast(err, 'error')
    return false
  }
}

/** One move of an `actions` game. Resolves with the refusal text (not toasted: the view shows it) or null. */
export async function sendGameAction(channelId: string, matchId: string, action: unknown): Promise<string | null> {
  try {
    await request('games:action', { channelId, matchId, action })
    return null
  } catch (err) {
    return err instanceof Error ? err.message : 'Move refused'
  }
}

/** The held buttons of a `pad` game (sent on every change). */
export function sendPadInput(channelId: string, matchId: string, buttons: number): void {
  emit('games:input', { channelId, matchId, buttons })
}
