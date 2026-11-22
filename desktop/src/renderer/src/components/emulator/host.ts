// Emulator plugin, host side (docs/SPEC.md §5.6): the one engine this device may run, kept at module level so
// it survives the stage re-rendering or the user looking at a text channel. It loads the game file the host
// picked (never uploaded anywhere), announces the session (`emu:start`), streams the engine's picture and sound
// as the host's stream (voice/session.ts) and applies the players' relayed buttons.
//
// Lifecycle: the engine is destroyed and the stream stopped when the host presses Stop, leaves (or switches)
// the voice channel, the session ends or passes to someone else remotely, the plugin is turned off, the
// account changes, or the window unloads. A published track is never left behind.
import { create } from 'zustand'
import { EMU_PORTS, EMU_TITLE_MAX, GAME_PAD_MASK, type EmuSystem } from '@shared/protocol'
import type { EmulatorEngine } from '../../emulator/types'
import { createEmulator, ROM_EXTENSIONS } from '../../emulator/engine'
import { hostEmuGame, onEmuInput, pauseEmu, stopEmu } from '../../emulator/actions'
import { useEmulator } from '../../store/emulator'
import { usePlugins } from '../../store/plugins'
import { useApp } from '../../store/app'
import { startEmulatorStream, stopEmulatorStream, useVoice } from '../../voice/session'
import { toast } from '../../lib/toast'

/** Frames per second of the stream (the SNES runs at ~60). */
export const EMU_STREAM_FPS = 60
/** Largest file accepted (SNES games are at most 6 MB; zipped ones less). */
const MAX_FILE_BYTES = 32 * 1024 * 1024
const VOLUME_KEY = 'nexo.emulator.volume'

export interface EmuHostState {
  /** Voice channel the engine runs for (null: not hosting). */
  channelId: string | null
  engine: EmulatorEngine | null
  /** Name of the file being loaded (null when not loading). */
  loading: string | null
  /** The engine is paused (mirrors engine.paused, which isn't reactive). */
  paused: boolean
  /** A quick save exists for the running game. */
  hasSave: boolean
  /** Host's own speaker volume for the game, 0..1 (persisted). Doesn't change what viewers hear. */
  volume: number
}

function loadVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY))
    return localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8
  } catch {
    return 0.8
  }
}

export const useEmuHost = create<EmuHostState>()(() => ({
  channelId: null,
  engine: null,
  loading: null,
  paused: false,
  hasSave: false,
  volume: loadVolume(),
}))

/** One quick-save slot, in memory, for the running game. */
let saveSlot: Uint8Array | null = null
/** Bumped by every load and stop, so a load that finishes late can tell it was superseded. */
let loadSeq = 0

/** File picker `accept` for a system. */
export function acceptFor(system: EmuSystem = 'snes'): string {
  return ROM_EXTENSIONS[system].join(',')
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

/** "Super_Game (USA) [!].sfc" → "Super Game (USA)". */
export function titleFromFileName(name: string): string {
  const ext = extensionOf(name)
  let t = ext ? name.slice(0, -ext.length) : name
  t = t
    .replace(/\[[^\]]*\]/g, ' ') // dump tags like [!] [h1]
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) t = 'Game'
  return t.length > EMU_TITLE_MAX ? t.slice(0, EMU_TITLE_MAX - 1).trimEnd() + '…' : t
}

function effectiveVolume(): number {
  return useVoice.getState().deafened ? 0 : useEmuHost.getState().volume
}

/**
 * Host a game file in `channelId` (your voice channel): load it, start (or update) the session, stream it.
 * Loading another file while hosting replaces the game; viewers keep watching the same stream.
 */
export async function hostGameFile(channelId: string, file: File, system: EmuSystem = 'snes'): Promise<void> {
  const exts = ROM_EXTENSIONS[system]
  if (!exts.includes(extensionOf(file.name))) {
    toast(`That isn't a game file this emulator reads (${exts.join(', ')})`, 'error')
    return
  }
  if (file.size === 0 || file.size > MAX_FILE_BYTES) {
    toast(file.size === 0 ? 'That file is empty' : 'That file is too big to be a game', 'error')
    return
  }
  if (useVoice.getState().channelId !== channelId) {
    toast('Join the voice channel to host a game', 'error')
    return
  }
  const me = useApp.getState().me?.id
  const existing = useEmulator.getState().byChannel[channelId]
  if (existing && existing.hostId !== me) {
    toast('Someone is already hosting a game here', 'error')
    return
  }

  const seq = ++loadSeq
  useEmuHost.setState({ loading: file.name })
  const stillWanted = () =>
    seq === loadSeq && useVoice.getState().channelId === channelId && usePlugins.getState().plugins.emulator

  let engine: EmulatorEngine
  try {
    const rom = new Uint8Array(await file.arrayBuffer())
    engine = await createEmulator({ system, rom, fileName: file.name })
  } catch (err) {
    if (seq === loadSeq) useEmuHost.setState({ loading: null })
    console.warn('[emulator] could not start the game', err)
    toast(err instanceof Error && err.message ? err.message : "Couldn't start that game", 'error')
    return
  }
  if (!stillWanted()) {
    engine.destroy()
    if (seq === loadSeq) useEmuHost.setState({ loading: null })
    return
  }

  const session = await hostEmuGame(channelId, system, titleFromFileName(file.name)) // errors are toasted
  if (!session || !stillWanted() || session.hostId !== useApp.getState().me?.id) {
    engine.destroy()
    if (seq === loadSeq) useEmuHost.setState({ loading: null })
    return
  }

  const prev = useEmuHost.getState().engine
  saveSlot = null
  engine.setLocalVolume(effectiveVolume())
  if (session.paused) engine.pause()
  useEmuHost.setState({ channelId, engine, loading: null, paused: engine.paused, hasSave: false })
  // A held key of the previous game doesn't carry over: the component re-applies the host's pad on change.
  try {
    // Replaces the previous game's picture in place when one was streaming.
    await startEmulatorStream(engine.mediaStream(EMU_STREAM_FPS))
  } catch (err) {
    if (useEmuHost.getState().engine === engine) toast(err, 'error')
  } finally {
    if (prev && prev !== engine) prev.destroy()
  }
}

/** The game isn't being streamed any more (a screen share replaced it, or publishing failed): try again. */
export async function restreamGame(): Promise<void> {
  const { engine } = useEmuHost.getState()
  if (!engine) return
  try {
    await startEmulatorStream(engine.mediaStream(EMU_STREAM_FPS))
  } catch (err) {
    toast(err, 'error')
  }
}

/**
 * Stop hosting: stop the stream, destroy the engine, and (`tellServer`) end the session for everyone.
 * Safe to call when not hosting (it then only cancels a load in progress).
 */
export function stopHosting(tellServer: boolean): void {
  loadSeq++
  const { engine, channelId, loading } = useEmuHost.getState()
  if (!engine && !channelId && !loading) return
  saveSlot = null
  useEmuHost.setState({ channelId: null, engine: null, loading: null, paused: false, hasSave: false })
  // Stream first (it reads clones of the engine's tracks), then the engine.
  void stopEmulatorStream()
  try {
    engine?.destroy()
  } catch (err) {
    console.warn('[emulator] destroy failed', err)
  }
  if (tellServer && channelId && useEmulator.getState().byChannel[channelId]) void stopEmu(channelId)
}

export function togglePause(): void {
  const { engine, channelId } = useEmuHost.getState()
  if (!engine || !channelId) return
  const next = !engine.paused
  if (next) engine.pause()
  else engine.resume()
  useEmuHost.setState({ paused: next })
  void pauseEmu(channelId, next).then((s) => {
    // Refused: back to what the session says.
    const cur = useEmuHost.getState()
    if (s || cur.engine !== engine) return
    const want = !!useEmulator.getState().byChannel[channelId]?.paused
    if (want) engine.pause()
    else engine.resume()
    useEmuHost.setState({ paused: want })
  })
}

export function resetGame(): void {
  useEmuHost.getState().engine?.reset()
}

export function setGameVolume(volume: number): void {
  const v = Math.min(1, Math.max(0, volume))
  useEmuHost.setState({ volume: v })
  try {
    localStorage.setItem(VOLUME_KEY, String(v))
  } catch {
    /* private mode */
  }
  useEmuHost.getState().engine?.setLocalVolume(effectiveVolume())
}

export async function quickSave(): Promise<void> {
  const { engine } = useEmuHost.getState()
  if (!engine?.saveState) return
  try {
    const state = await engine.saveState()
    if (useEmuHost.getState().engine !== engine) return
    saveSlot = state
    useEmuHost.setState({ hasSave: true })
    toast('Saved', 'success', 1500)
  } catch (err) {
    toast(err, 'error')
  }
}

export async function quickLoad(): Promise<void> {
  const { engine } = useEmuHost.getState()
  if (!engine?.loadState || !saveSlot) return
  try {
    await engine.loadState(saveSlot)
  } catch (err) {
    toast(err, 'error')
  }
}

// ---------------------------------------------------------------------------------------------
// Wiring (module level, once)

// Players' buttons relayed by the server (only to the host).
const offInput = onEmuInput(({ channelId, port, buttons }) => {
  const { engine, channelId: hosting } = useEmuHost.getState()
  if (!engine || hosting !== channelId || !Number.isInteger(port) || port < 0 || port >= EMU_PORTS) return
  engine.setPad(port, buttons & GAME_PAD_MASK)
})

// The session ended or isn't ours any more (stopped by an admin, server restart, …): stop the engine.
// The host's pause state follows the session's (it is what everyone sees).
const offSessions = useEmulator.subscribe((s, prev) => {
  const { engine, channelId } = useEmuHost.getState()
  if (!engine || !channelId) return
  const session = s.byChannel[channelId]
  if (!session || session.hostId !== useApp.getState().me?.id) {
    stopHosting(false)
    toast('The game was stopped', 'info')
    return
  }
  const before = prev.byChannel[channelId]
  if (before && before.paused !== session.paused && engine.paused !== session.paused) {
    if (session.paused) engine.pause()
    else engine.resume()
    useEmuHost.setState({ paused: session.paused })
  }
})

// Left or switched the voice channel: the server closes the session itself.
// (A load in progress checks the voice channel itself when it finishes.)
const offVoice = useVoice.subscribe((v, prev) => {
  const { channelId, engine } = useEmuHost.getState()
  if (channelId !== null && v.channelId !== channelId) stopHosting(false)
  else if (v.deafened !== prev.deafened) engine?.setLocalVolume(effectiveVolume())
})

const offPlugins = usePlugins.subscribe((p) => {
  if (!p.plugins.emulator) stopHosting(false)
})

const offApp = useApp.subscribe((s, prev) => {
  if (s.me?.id !== prev.me?.id) stopHosting(false)
})

const onUnload = () => stopHosting(false)
window.addEventListener('beforeunload', onUnload)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offInput()
    offSessions()
    offVoice()
    offPlugins()
    offApp()
    window.removeEventListener('beforeunload', onUnload)
    stopHosting(false)
  })
}
