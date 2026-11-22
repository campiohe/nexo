// Emulator plugin sessions per voice channel (EmuSession: host, game title, controller ports). From bootstrap,
// kept current by `emu:session` (net/socket.ts) and the acks of the `emu:*` requests. The engine itself only
// exists on the host's device (emulator/engine.ts, owned by components/emulator). Session state: reset on
// server change / sign out (resetEmulator).
// No imports from store/app or net/socket (net/socket imports this module; see store/sounds.ts).
import { create } from 'zustand'
import type { EmuAxes, EmuSession } from '@shared/protocol'

interface EmulatorStore {
  /** channelId → its running session. Closed sessions have no entry. */
  byChannel: Record<string, EmuSession>
  /** Channels whose emulator view this device hid (the stage shows people instead). */
  hidden: Record<string, true>
}

export const useEmulator = create<EmulatorStore>()(() => ({ byChannel: {}, hidden: {} }))

function isSession(s: unknown): s is EmuSession {
  if (!s || typeof s !== 'object') return false
  const e = s as Partial<EmuSession>
  return typeof e.channelId === 'string' && typeof e.rev === 'number' && typeof e.hostId === 'string' && Array.isArray(e.ports)
}

export function setBootstrapEmulator(list: EmuSession[] | undefined): void {
  const byChannel: Record<string, EmuSession> = {}
  if (Array.isArray(list)) for (const s of list) if (isSession(s) && s.status !== 'closed') byChannel[s.channelId] = s
  useEmulator.setState({ byChannel, hidden: {} })
}

/** A session changed (older revs ignored); `closed` drops it. */
export function applyEmuSession(s: EmuSession): void {
  if (!isSession(s)) return
  useEmulator.setState((st) => {
    const cur = st.byChannel[s.channelId]
    if (cur && s.rev <= cur.rev) return st
    const byChannel = { ...st.byChannel }
    let hidden = st.hidden
    if (s.status === 'closed') {
      if (!cur) return st
      delete byChannel[s.channelId]
      if (hidden[s.channelId]) {
        hidden = { ...hidden }
        delete hidden[s.channelId]
      }
    } else {
      byChannel[s.channelId] = s
    }
    return { byChannel, hidden }
  })
}

export function setEmulatorHidden(channelId: string, hide: boolean): void {
  useEmulator.setState((st) => {
    if (!!st.hidden[channelId] === hide) return st
    const hidden = { ...st.hidden }
    if (hide) hidden[channelId] = true
    else delete hidden[channelId]
    return { hidden }
  })
}

/** A deleted channel's session goes with it. */
export function forgetEmulatorChannel(channelId: string): void {
  useEmulator.setState((st) => {
    if (!(channelId in st.byChannel)) return st
    const byChannel = { ...st.byChannel }
    delete byChannel[channelId]
    return { byChannel }
  })
}

/** Another server, or signed out (store/app.ts, net/socket.ts, store/signin.ts). */
export function resetEmulator(): void {
  useEmulator.setState({ byChannel: {}, hidden: {} })
}

// ---- host side: player input relayed by the server (`emu:input`, only sent to the host) ----

/** A relayed player's controller: `axes` only while a stick is off center (already validated). */
export interface EmuRelayedInput {
  channelId: string
  port: number
  buttons: number
  axes?: EmuAxes
}
export type EmuInputListener = (p: EmuRelayedInput) => void
const inputListeners = new Set<EmuInputListener>()

/** Host: get every relayed `emu:input` (apply it with engine.setPad). Returns the unsubscribe. */
export function onEmuInput(cb: EmuInputListener): () => void {
  inputListeners.add(cb)
  return () => {
    inputListeners.delete(cb)
  }
}

/** Stick axes from the wire: 4 finite numbers clamped to -127..127, else undefined (centered). */
function axesFrom(raw: unknown): EmuAxes | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined
  if (!raw.every((v) => typeof v === 'number' && Number.isFinite(v))) return undefined
  const axes = raw.map((v: number) => Math.max(-127, Math.min(127, Math.round(v)))) as EmuAxes
  return axes.every((v) => v === 0) ? undefined : axes
}

/** `emu:input` from the server (net/socket.ts). */
export function handleEmuInput(p: { channelId: string; port: number; buttons: number; axes?: unknown }): void {
  if (!p || typeof p.port !== 'number' || typeof p.buttons !== 'number') return
  const axes = axesFrom(p.axes)
  const input: EmuRelayedInput = axes
    ? { channelId: p.channelId, port: p.port, buttons: p.buttons, axes }
    : { channelId: p.channelId, port: p.port, buttons: p.buttons }
  for (const cb of [...inputListeners]) {
    try {
      cb(input)
    } catch (err) {
      console.error('[emulator] input listener failed', err)
    }
  }
}
