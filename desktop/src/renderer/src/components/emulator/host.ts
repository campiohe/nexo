// Emulator plugin, host side (docs/SPEC.md §5.5): the one engine this device may run, kept at module level so
// it survives the stage re-rendering or the user looking at a text channel. It tells which console the picked
// files are for (emulator/engine.ts detectSystem, asking the host when it can't tell), reads them (with progress
// for big discs; cancellable), starts the engine, announces the session (`emu:start`), streams the engine's
// picture and sound as the host's stream (voice/session.ts) and applies the players' relayed buttons and sticks.
// The files never leave this device.
//
// Lifecycle: the engine is destroyed and the stream stopped when the host presses Stop, leaves (or switches)
// the voice channel, the session ends or passes to someone else remotely, the plugin is turned off, the
// account changes, or the window unloads. A published track is never left behind.
import { create } from 'zustand'
import { EMU_PORTS, EMU_TITLE_MAX, GAME_PAD_MASK, type EmuSystem } from '@shared/protocol'
import type { EmulatorEngine } from '../../emulator/types'
import { ALL_ROM_EXTENSIONS, createEmulator, detectSystem, extensionOf } from '../../emulator/engine'
import { hostEmuGame, onEmuInput, pauseEmu, stopEmu } from '../../emulator/actions'
import { useEmulator } from '../../store/emulator'
import { usePlugins } from '../../store/plugins'
import { useApp } from '../../store/app'
import { startEmulatorStream, stopEmulatorStream, useVoice } from '../../voice/session'
import { toast } from '../../lib/toast'
import { t } from '../../i18n'

/** Frames per second of the stream (every console runs at ~60 in NTSC; PAL games at 50 just repeat frames). */
export const EMU_STREAM_FPS = 60
const VOLUME_KEY = 'nexo.emulator.volume'
/** Files at least this big are read in chunks with progress (smaller ones in one go). */
const CHUNKED_READ_BYTES = 32 * 1024 * 1024

export interface EmuLoading {
  /** The game's file name. */
  name: string
  /** `reading` the files from disk, then `starting` the engine. */
  step: 'reading' | 'starting'
  /** 0..1, or null when unknown (small files, an engine that doesn't report). */
  progress: number | null
}

/** The picked files could be a game of several consoles: the host says which (null = cancel). */
export interface EmuAsk {
  channelId: string
  systems: EmuSystem[]
  main: File
  extras: File[]
}

export interface EmuHostState {
  /** Voice channel the engine runs for (null: not hosting). */
  channelId: string | null
  engine: EmulatorEngine | null
  /** The game being loaded (null when not loading). */
  loading: EmuLoading | null
  /** Waiting for the host to say which console the picked game is for. */
  ask: EmuAsk | null
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
  ask: null,
  paused: false,
  hasSave: false,
  volume: loadVolume(),
}))

/** One quick-save slot, in memory, for the running game. */
let saveSlot: Uint8Array | null = null
/** Bumped by every load and stop, so a load that finishes late can tell it was superseded. */
let loadSeq = 0
/** Aborts reading the files of the load in progress. */
let loadAbort: AbortController | null = null

/** File picker `accept`: every console's game files (use with `multiple`: a .cue with its .bin files, a BIOS). */
export const GAME_FILE_ACCEPT = ALL_ROM_EXTENSIONS.join(',')

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
 * Host the picked / dropped files in `channelId` (your voice channel): find out which console they are for (asking
 * when it can't tell), then load and stream the game (hostGame).
 */
export async function hostGameFiles(channelId: string, files: File[]): Promise<void> {
  if (files.length === 0 || !canHost(channelId)) return
  if (useEmuHost.getState().loading) {
    toast(t('A game is already loading'), 'error')
    return
  }
  const found = await detectSystem(files)
  if (found.kind === 'error') {
    toast(found.message, 'error')
    return
  }
  if (found.kind === 'ask') {
    useEmuHost.setState({ ask: { channelId, systems: found.systems, main: found.main, extras: found.extras } })
    return
  }
  await hostGame(channelId, found.system, found.main, found.extras)
}

/** The host answered "which console is this?" (null: cancelled). */
export function answerAsk(system: EmuSystem | null): void {
  const ask = useEmuHost.getState().ask
  useEmuHost.setState({ ask: null })
  if (ask && system && ask.systems.includes(system)) void hostGame(ask.channelId, system, ask.main, ask.extras)
}

function canHost(channelId: string): boolean {
  if (useVoice.getState().channelId !== channelId) {
    toast(t('Join the voice channel to host a game'), 'error')
    return false
  }
  const me = useApp.getState().me?.id
  const existing = useEmulator.getState().byChannel[channelId]
  if (existing && existing.hostId !== me) {
    toast(t('Someone is already hosting a game here'), 'error')
    return false
  }
  return true
}

/** Cancels the load in progress (reading the files stops; an engine that still starts is thrown away). */
export function cancelLoading(): void {
  if (!useEmuHost.getState().loading) return
  loadSeq++
  loadAbort?.abort()
  loadAbort = null
  useEmuHost.setState({ loading: null })
}

class LoadCancelled extends Error {}

/** A file's bytes, read in chunks for big files (progress in bytes; stops when `signal` aborts). */
async function readFile(file: File, signal: AbortSignal, onBytes: (n: number) => void): Promise<Uint8Array> {
  if (file.size < CHUNKED_READ_BYTES) {
    const data = new Uint8Array(await file.arrayBuffer())
    if (signal.aborted) throw new LoadCancelled()
    onBytes(data.length)
    return data
  }
  const out = new Uint8Array(file.size)
  const reader = file.stream().getReader()
  let filled = 0
  try {
    for (;;) {
      if (signal.aborted) throw new LoadCancelled()
      const { done, value } = await reader.read()
      if (done) break
      if (filled + value.length > out.length) throw new Error(t('The file changed while it was being read'))
      out.set(value, filled)
      filled += value.length
      onBytes(value.length)
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  if (filled !== out.length) throw new Error(t('The file changed while it was being read'))
  return out
}

/**
 * Host a game of `system` in `channelId`: read the files (the game + its extras), start the engine, start (or
 * update) the session, stream it. Loading another game while hosting replaces it; viewers keep watching the same
 * stream.
 */
export async function hostGame(channelId: string, system: EmuSystem, main: File, extras: File[] = []): Promise<void> {
  if (!canHost(channelId)) return
  const seq = ++loadSeq
  loadAbort?.abort()
  const abort = new AbortController()
  loadAbort = abort
  const loading: EmuLoading = { name: main.name, step: 'reading', progress: null }
  useEmuHost.setState({ loading })
  const stillWanted = () =>
    seq === loadSeq && useVoice.getState().channelId === channelId && usePlugins.getState().plugins.emulator
  const setLoading = (patch: Partial<EmuLoading>) => {
    if (seq !== loadSeq) return
    const cur = useEmuHost.getState().loading
    if (!cur) return
    const next = { ...cur, ...patch }
    // Progress in whole percents: no re-render per chunk.
    if (next.step === cur.step && next.progress !== null && cur.progress !== null && Math.floor(next.progress * 100) === Math.floor(cur.progress * 100)) return
    useEmuHost.setState({ loading: next })
  }
  const done = () => {
    if (seq !== loadSeq) return
    if (loadAbort === abort) loadAbort = null
    useEmuHost.setState({ loading: null })
  }

  let engine: EmulatorEngine
  try {
    const total = [main, ...extras].reduce((n, f) => n + f.size, 0)
    const chunked = total >= CHUNKED_READ_BYTES
    let read = 0
    const onBytes = (n: number) => {
      read += n
      if (chunked) setLoading({ progress: Math.min(1, read / total) })
    }
    if (chunked) setLoading({ progress: 0 })
    const rom = await readFile(main, abort.signal, onBytes)
    const extraFiles: { name: string; data: Uint8Array }[] = []
    for (const f of extras) extraFiles.push({ name: f.name, data: await readFile(f, abort.signal, onBytes) })
    if (!stillWanted()) throw new LoadCancelled()
    setLoading({ step: 'starting', progress: null })
    engine = await createEmulator({
      system,
      rom,
      fileName: main.name,
      extraFiles: extraFiles.length ? extraFiles : undefined,
      onProgress: (f) => {
        if (Number.isFinite(f)) setLoading({ step: 'starting', progress: Math.min(1, Math.max(0, f)) })
      },
    })
  } catch (err) {
    done()
    if (err instanceof LoadCancelled || seq !== loadSeq) return
    console.warn('[emulator] could not start the game', err)
    toast(err instanceof Error && err.message ? err.message : t("Couldn't start that game"), 'error')
    return
  }
  if (!stillWanted()) {
    engine.destroy()
    done()
    return
  }

  const session = await hostEmuGame(channelId, system, titleFromFileName(main.name)) // errors are toasted
  if (!session || !stillWanted() || session.hostId !== useApp.getState().me?.id) {
    engine.destroy()
    done()
    return
  }
  if (loadAbort === abort) loadAbort = null

  const prev = useEmuHost.getState().engine
  saveSlot = null
  engine.setLocalVolume(effectiveVolume())
  if (session.paused) engine.pause()
  useEmuHost.setState({ channelId, engine, loading: null, paused: engine.paused, hasSave: false })
  engine.onCrash = () => {
    if (useEmuHost.getState().engine !== engine) return
    useEmuHost.setState({ paused: true })
    toast(t('The game crashed and stopped. Load it again to keep playing.'), 'error')
  }
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
  loadAbort?.abort()
  loadAbort = null
  const { engine, channelId, loading, ask } = useEmuHost.getState()
  if (!engine && !channelId && !loading && !ask) return
  saveSlot = null
  useEmuHost.setState({ channelId: null, engine: null, loading: null, ask: null, paused: false, hasSave: false })
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
    toast(t('Saved // emulator quick save'), 'success', 1500)
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

// Players' buttons and sticks relayed by the server (only to the host).
const offInput = onEmuInput(({ channelId, port, buttons, axes }) => {
  const { engine, channelId: hosting } = useEmuHost.getState()
  if (!engine || hosting !== channelId || !Number.isInteger(port) || port < 0 || port >= EMU_PORTS) return
  engine.setPad(port, buttons & GAME_PAD_MASK, axes)
})

// The session ended or isn't ours any more (stopped by an admin, server restart, …): stop the engine.
// The host's pause state follows the session's (it is what everyone sees).
const offSessions = useEmulator.subscribe((s, prev) => {
  const { engine, channelId } = useEmuHost.getState()
  if (!engine || !channelId) return
  const session = s.byChannel[channelId]
  if (!session || session.hostId !== useApp.getState().me?.id) {
    stopHosting(false)
    toast(t('The game was stopped'), 'info')
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
  const { channelId, engine, loading, ask } = useEmuHost.getState()
  if (channelId !== null && v.channelId !== channelId) stopHosting(false)
  else if (v.channelId !== prev.channelId && (loading || ask)) stopHosting(false) // don't keep reading a disc for nothing
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
