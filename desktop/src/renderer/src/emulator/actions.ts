// Emulator plugin requests (`emu:*`) with their errors toasted, the player's input sender, and the host's
// subscription to relayed player input (`emu:input` from the server, dispatched by net/socket.ts).
import type { EmuSession, EmuSystem } from '@shared/protocol'
import { emit, request } from '../net/socket'
import { applyEmuSession } from '../store/emulator'
import { toast } from '../lib/toast'

type SessionEvent = 'emu:start' | 'emu:port' | 'emu:assign' | 'emu:pause'

async function sessionRequest(event: SessionEvent, payload: Record<string, unknown>): Promise<EmuSession | null> {
  try {
    const s = (await request(event, payload as never)) as EmuSession
    applyEmuSession(s)
    return s
  } catch (err) {
    toast(err, 'error')
    return null
  }
}

/** Host: announce the game you loaded (or a new one) in `channelId`. */
export const hostEmuGame = (channelId: string, system: EmuSystem, title: string) =>
  sessionRequest('emu:start', { channelId, system, title })
/** Take a free port, or give yours up (null). */
export const takeEmuPort = (channelId: string, port: number | null) => sessionRequest('emu:port', { channelId, port })
/** Host / admins: put someone on a port, or free it (userId null). */
export const assignEmuPort = (channelId: string, port: number, userId: string | null) =>
  sessionRequest('emu:assign', { channelId, port, userId })
export const pauseEmu = (channelId: string, paused: boolean) => sessionRequest('emu:pause', { channelId, paused })

export async function stopEmu(channelId: string): Promise<boolean> {
  try {
    await request('emu:stop', { channelId })
    return true
  } catch (err) {
    toast(err, 'error')
    return false
  }
}

/** Player: your held buttons (GAME_PAD bits), sent on every change. */
export function sendEmuInput(channelId: string, buttons: number): void {
  emit('emu:input', { channelId, buttons })
}

// Host side: relayed player input is in store/emulator.ts (onEmuInput / handleEmuInput), so net/socket.ts can
// dispatch it without importing this module (which imports net/socket).
export { onEmuInput } from '../store/emulator'
