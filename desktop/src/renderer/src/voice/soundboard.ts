// Soundboard (docs/SPEC.md): playing clips to your voice channel (`sound:play`, with its cooldown), hearing
// the ones played there (`sound:played`), previews only you hear, and the popover / dialog UI state.
//
// Clips are fetched from GET /sounds/:id and decoded with Web Audio (the renderer CSP's media-src doesn't
// allow server URLs, so no <audio src>), cached as AudioBuffers in a small LRU (bounded by entries and by
// decoded bytes), and played through one
// lazily created AudioContext on the selected speaker, suspended again when idle (like voice/sounds.ts).
// The context only feeds its own destination, never the mic / WebRTC graph: nobody hears them through you.
import { create } from 'zustand'
import type { Sound } from '@shared/protocol'
import { SOUND_COOLDOWN_MS, SOUND_MAX_BYTES, SOUND_MAX_MS } from '@shared/protocol'
import { useApp } from '../store/app'
import { findSound } from '../store/sounds'
import type { AnchorRect } from '../store/ui'
import { soundUrl } from '../net/sounds'
import { request } from '../net/socket'
import { toast } from '../lib/toast'
import { useDevicePrefs } from './devices'
import { useUserVolumes } from './userVolumes'
import { useVoice } from './session'

// ---------------------------------------------------------------------------------------------
// UI state

export interface SoundFeedItem {
  key: number
  userId: string
  soundId: string
}

interface SoundboardUi {
  /** The open popover, anchored to the button that opened it. */
  popover: { anchor: AnchorRect; from: 'panel' | 'stage' } | null
  /** `sound:play` sent, ack pending. */
  pending: string | null
  /** Local cooldown after a successful play (mirrors the server's SOUND_COOLDOWN_MS). */
  cooldownStart: number
  cooldownUntil: number
  /** Sound id previewed (only for you) right now. */
  previewing: string | null
  /** "Name played sound" lines shown above the stage's soundboard button. */
  feed: SoundFeedItem[]
  uploadOpen: boolean
  confirmDelete: Sound | null
}

export const useSoundboardUi = create<SoundboardUi>()(() => ({
  popover: null,
  pending: null,
  cooldownStart: 0,
  cooldownUntil: 0,
  previewing: null,
  feed: [],
  uploadOpen: false,
  confirmDelete: null,
}))

/** A click on the button that just closed the popover (pointerdown outside) must not reopen it. */
let popoverClosed = { at: 0, from: '' }

export function closeSoundboard(): void {
  const cur = useSoundboardUi.getState().popover
  if (!cur) return
  popoverClosed = { at: Date.now(), from: cur.from }
  useSoundboardUi.setState({ popover: null })
}

export function toggleSoundboard(anchor: AnchorRect, from: 'panel' | 'stage'): void {
  const cur = useSoundboardUi.getState().popover
  if (cur?.from === from) return closeSoundboard()
  if (!cur && popoverClosed.from === from && Date.now() - popoverClosed.at < 250) return
  useSoundboardUi.setState({ popover: { anchor, from } })
}

let feedKey = 0
const FEED_MS = 3500
const FEED_MAX = 3

function pushFeed(userId: string, soundId: string): void {
  const key = ++feedKey
  useSoundboardUi.setState((s) => ({ feed: [...s.feed, { key, userId, soundId }].slice(-FEED_MAX) }))
  window.setTimeout(() => useSoundboardUi.setState((s) => ({ feed: s.feed.filter((f) => f.key !== key) })), FEED_MS)
}

// ---------------------------------------------------------------------------------------------
// Playing to the channel

/** Play a clip to everyone in your voice channel (you hear it when the server echoes `sound:played`). */
export async function playSound(soundId: string): Promise<void> {
  const ui = useSoundboardUi.getState()
  if (ui.pending || Date.now() < ui.cooldownUntil) return
  useSoundboardUi.setState({ pending: soundId })
  try {
    await request('sound:play', { soundId })
    const now = Date.now()
    useSoundboardUi.setState({ cooldownStart: now, cooldownUntil: now + SOUND_COOLDOWN_MS })
  } catch (err) {
    toast(err, 'error')
  } finally {
    useSoundboardUi.setState({ pending: null })
  }
}

function hears(channelId: string, userId: string): boolean {
  const v = useVoice.getState()
  if (v.channelId !== channelId || v.deafened) return false
  if (v.status !== 'connected' && v.status !== 'reconnecting') return false
  if (!useDevicePrefs.getState().soundboard) return false
  return !useUserVolumes.getState().muted[userId]
}

/** `sound:played` from the server (net/socket.ts). */
export function handleSoundPlayed(p: { soundId: string; userId: string; channelId: string }): void {
  if (!p || typeof p.soundId !== 'string' || !hears(p.channelId, p.userId)) return
  pushFeed(p.userId, p.soundId)
  void start(p.soundId, { userId: p.userId, channelId: p.channelId }).catch((err) =>
    console.warn('[soundboard] playback failed', err),
  )
}

/** Play (or stop, when it's already playing) a clip only for yourself. */
export function previewSound(soundId: string): void {
  if (useSoundboardUi.getState().previewing === soundId) {
    useSoundboardUi.setState({ previewing: null })
    stopWhere((p) => p.preview)
    return
  }
  stopWhere((p) => p.preview)
  useSoundboardUi.setState({ previewing: soundId })
  start(soundId, null).catch((err) => {
    if (useSoundboardUi.getState().previewing === soundId) useSoundboardUi.setState({ previewing: null })
    toast(err, 'error')
  })
}

// ---------------------------------------------------------------------------------------------
// Audio engine

type SinkAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

interface Playing {
  /** null for previews (and the upload dialog). */
  userId: string | null
  channelId: string | null
  preview: boolean
  soundId: string | null
  onEnded?: () => void
}

const IDLE_SUSPEND_MS = 3000
const MAX_CONCURRENT = 4
/**
 * Longest clip played, seconds. Servers measure uploads and refuse longer ones, but an older server (or a
 * hand-crafted upload to one) may hold anything: longer clips are refused, and playback is cut here anyway.
 */
export const MAX_CLIP_SECONDS = SOUND_MAX_MS / 1000 + 0.25
/** Decoded clips kept: at most this many… */
const CACHE_MAX = 20
/** …and at most this many bytes of decoded audio (a 5 s stereo clip at 48 kHz is ≈ 1.9 MB). */
const CACHE_MAX_BYTES = 16 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

let ctx: SinkAudioContext | null = null
let out: GainNode | null = null
let appliedSink: string | null = null
let sinkReady: Promise<void> = Promise.resolve()
let idleTimer: number | undefined
const playing = new Map<AudioBufferSourceNode, Playing>()
const cache = new Map<string, AudioBuffer>()
let cacheBytes = 0
const inflight = new Map<string, Promise<AudioBuffer>>()

/** Slider position (0..1) → gain: squared, so the slider feels even and the default (60%) is ≈ -9 dB. */
function volumeGain(v: number): number {
  return Math.min(1, Math.max(0, v)) ** 2
}

function wantedSink(): string {
  const id = useDevicePrefs.getState().audiooutput
  return id && id !== 'default' ? id : ''
}

function applySink(): void {
  const c = ctx
  if (!c?.setSinkId) return
  const id = wantedSink()
  if (id === appliedSink) return
  appliedSink = id
  sinkReady = c.setSinkId(id).catch((e: unknown) => console.warn('[soundboard] setSinkId failed', e))
}

function getContext(): SinkAudioContext | null {
  if (ctx && ctx.state !== 'closed') return ctx
  try {
    ctx = new AudioContext({ latencyHint: 'interactive' })
  } catch {
    ctx = null
    return null
  }
  out = ctx.createGain()
  out.gain.value = volumeGain(useDevicePrefs.getState().soundboardVolume)
  out.connect(ctx.destination)
  appliedSink = null
  sinkReady = Promise.resolve()
  applySink()
  return ctx
}

function scheduleIdle(): void {
  window.clearTimeout(idleTimer)
  idleTimer = window.setTimeout(() => {
    idleTimer = undefined
    if (ctx && playing.size === 0 && ctx.state === 'running') void ctx.suspend().catch(() => {})
  }, IDLE_SUSPEND_MS)
}

const decodedBytes = (b: AudioBuffer) => b.length * b.numberOfChannels * 4

function cachePut(url: string, buffer: AudioBuffer): void {
  const old = cache.get(url)
  if (old) cacheBytes -= decodedBytes(old)
  cache.delete(url)
  cache.set(url, buffer)
  cacheBytes += decodedBytes(buffer)
  // Evict the least recently used (never the one just added).
  while (cache.size > 1 && (cache.size > CACHE_MAX || cacheBytes > CACHE_MAX_BYTES)) {
    const [oldUrl, oldBuf] = cache.entries().next().value as [string, AudioBuffer]
    cache.delete(oldUrl)
    cacheBytes -= decodedBytes(oldBuf)
  }
}

function cacheClear(): void {
  cache.clear()
  cacheBytes = 0
}

/** 'RIFF….WAVE': every clip the desktop client uploads is a 16-bit PCM WAV (voice/wav.ts). */
function isWav(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 12) return false
  const b = new Uint8Array(bytes, 0, 12)
  const tag = (at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
  return tag(0) === 'RIFF' && tag(8) === 'WAVE'
}

async function load(url: string, c: AudioContext): Promise<AudioBuffer> {
  const hit = cache.get(url)
  if (hit) {
    cache.delete(url)
    cache.set(url, hit)
    return hit
  }
  let p = inflight.get(url)
  if (!p) {
    p = (async () => {
      let res: Response
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      } catch {
        throw new Error("Couldn't load that sound")
      }
      if (!res.ok) throw new Error(res.status === 404 ? 'That sound was deleted' : "Couldn't load that sound")
      const bytes = await res.arrayBuffer()
      // Bounded input: ≤ 512 KB of 16-bit PCM decodes to a few MB at most. Compressed formats (only ever on
      // older servers, from uploads this client didn't make) could decode a tiny file into minutes of audio,
      // so they aren't decoded at all.
      if (bytes.byteLength > SOUND_MAX_BYTES || !isWav(bytes)) throw new Error("Couldn't play that sound (unsupported audio)")
      const buffer = await c.decodeAudioData(bytes).catch(() => {
        throw new Error("Couldn't play that sound (unsupported audio)")
      })
      if (buffer.duration > MAX_CLIP_SECONDS) throw new Error("Couldn't play that sound (longer than 5 seconds)")
      cachePut(url, buffer)
      return buffer
    })().finally(() => inflight.delete(url))
    inflight.set(url, p)
  }
  return p
}

function stopSource(src: AudioBufferSourceNode): void {
  try {
    src.stop()
  } catch {
    /* not started / already stopped */
  }
}

function stopWhere(pred: (p: Playing) => boolean): void {
  for (const [src, p] of playing) if (pred(p)) stopSource(src)
}

/** Start `buffer` (from `offset` for `duration` s, never more than MAX_CLIP_SECONDS) on the soundboard output. */
async function playBuffer(buffer: AudioBuffer, meta: Playing, offset = 0, duration?: number): Promise<AudioBufferSourceNode | null> {
  const c = getContext()
  if (!c || !out) return null
  window.clearTimeout(idleTimer)
  idleTimer = undefined
  if (c.state !== 'running') await c.resume()
  await sinkReady
  if (ctx !== c || !out) return null
  const src = c.createBufferSource()
  src.buffer = buffer
  src.connect(out)
  playing.set(src, meta)
  src.onended = () => {
    playing.delete(src)
    src.disconnect()
    meta.onEnded?.()
    if (playing.size === 0) scheduleIdle()
  }
  // Too many at once (spam from several people): cut the oldest.
  if (playing.size > MAX_CONCURRENT) stopSource(playing.keys().next().value as AudioBufferSourceNode)
  src.start(0, offset, Math.min(duration ?? MAX_CLIP_SECONDS, MAX_CLIP_SECONDS))
  return src
}

/** Fetch (cached) and play a board clip. `from` = who played it where; null = a preview for you. */
async function start(soundId: string, from: { userId: string; channelId: string } | null): Promise<void> {
  const serverUrl = useApp.getState().serverUrl
  const c = getContext()
  if (!serverUrl || !c) return
  window.clearTimeout(idleTimer)
  let buffer: AudioBuffer
  try {
    buffer = await load(soundUrl(serverUrl, soundId), c)
  } catch (err) {
    if (playing.size === 0) scheduleIdle()
    throw err
  }
  // Things may have changed while it downloaded.
  if (from ? !hears(from.channelId, from.userId) : useSoundboardUi.getState().previewing !== soundId) {
    if (playing.size === 0) scheduleIdle()
    return
  }
  const meta: Playing = {
    userId: from?.userId ?? null,
    channelId: from?.channelId ?? null,
    preview: !from,
    soundId,
    onEnded: from
      ? undefined
      : () => {
          if (useSoundboardUi.getState().previewing === soundId && ![...playing.values()].some((p) => p.preview))
            useSoundboardUi.setState({ previewing: null })
        },
  }
  const src = await playBuffer(buffer, meta)
  if (!src && !from) useSoundboardUi.setState({ previewing: null })
}

/**
 * Upload dialog: play part of a decoded file on the soundboard output (same speaker and volume as the
 * board). Returns a stop function and the AudioContext time it started at (for a playhead), or null.
 */
export async function previewBuffer(
  buffer: AudioBuffer,
  offset: number,
  duration: number,
  onEnded: () => void,
): Promise<{ stop(): void; startedAt: number; context: AudioContext } | null> {
  stopWhere((p) => p.preview)
  const src = await playBuffer(buffer, { userId: null, channelId: null, preview: true, soundId: null, onEnded }, offset, duration)
  if (!src || !ctx) return null
  return { stop: () => stopSource(src), startedAt: ctx.currentTime, context: ctx }
}

export function stopPreviews(): void {
  stopWhere((p) => p.preview)
}

function closeContext(): void {
  window.clearTimeout(idleTimer)
  idleTimer = undefined
  for (const src of playing.keys()) stopSource(src)
  playing.clear()
  if (ctx) void ctx.close().catch(() => {})
  ctx = null
  out = null
  appliedSink = null
}

// Deafened, left / switched channel: stop what the channel played (previews keep going).
const offVoice = useVoice.subscribe((s, prev) => {
  if ((s.deafened && !prev.deafened) || s.channelId !== prev.channelId) stopWhere((p) => !p.preview)
  if (s.channelId !== prev.channelId) {
    useSoundboardUi.setState({ feed: [] })
    if (!s.channelId) closeSoundboard()
  }
})

const offPrefs = useDevicePrefs.subscribe((s, prev) => {
  if (!s.soundboard && prev.soundboard) stopWhere((p) => !p.preview)
  if (s.soundboardVolume !== prev.soundboardVolume && out && ctx)
    out.gain.setTargetAtTime(volumeGain(s.soundboardVolume), ctx.currentTime, 0.02)
  if (s.audiooutput !== prev.audiooutput) applySink()
})

// "Mute for me": cut their clip right away too.
const offMuted = useUserVolumes.subscribe((s, prev) => {
  if (s.muted === prev.muted) return
  stopWhere((p) => !!p.userId && !!s.muted[p.userId])
})

// Clips belong to a server: drop the cache when switching servers or signing out.
const offApp = useApp.subscribe((s, prev) => {
  if (s.serverUrl === prev.serverUrl && !(s.view === 'onboarding' && prev.view !== 'onboarding')) return
  cacheClear()
  closeContext()
  useSoundboardUi.setState({ popover: null, feed: [], uploadOpen: false, confirmDelete: null, previewing: null })
})

/** A board clip by id, for labels (undefined once deleted). */
export function soundLabel(soundId: string): string {
  const s = findSound(soundId)
  return s ? `${s.emoji ? `${s.emoji} ` : ''}${s.name}` : 'a sound'
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offVoice()
    offPrefs()
    offMuted()
    offApp()
    closeContext()
  })
}
