// Native game/screen share (docs/SPEC-BETA.md §8.3): Windows, or any OS with the fake helper. The nexo-media
// helper captures, encodes and publishes the stream to LiveKit itself, as a second participant
// `<userId>#stream`; this module drives it through `window.nexo.nativeShare` and mirrors its state into
// `useVoice` (sharing, shareStats, …), so the rest of the UI doesn't care which engine is streaming.
//
// session.ts owns the store and the Chromium engine. It hands them over with `bindNativeShare()` instead of
// this module importing them, which keeps the two modules free of a runtime import cycle.
import { create } from 'zustand'
import type { Room } from 'livekit-client'
import { request } from '@renderer/net/socket'
import { toast } from '@renderer/lib/toast'
import type {
  CaptureEngine,
  NativeShareCapabilities,
  NativeShareEndReason,
  NativeShareError,
  NativeShareErrorCode,
  NativeShareEvent,
  NativeShareState,
  NativeShareStats,
  NexoBridge,
} from '../../../preload/api'
import type { SharePreset, ShareStats, StartShareOptions, useVoice } from './session'
import { createCaptureLowDetector, type CaptureLowDetector } from './shareHealth'

export interface NativeShareHost {
  voice: typeof useVoice
  room(): Room | null
  /** Sends our voice state (`streaming` follows `useVoice().sharing`). */
  announce(): void
  /** Remembers the share for the "toggle screen share" hotkey. */
  rememberShare(opts: StartShareOptions): void
  /** The Chromium engine (getDisplayMedia + livekit-client). Called with `shareStarting` already set. */
  startChromium(r: Room, opts: StartShareOptions, preset: SharePreset): Promise<void>
}

/** What the share picker and Settings need to know about the native engine. */
interface NativeShareUi {
  /** Helper capabilities for the current voice session (null until known, or not on Windows). */
  capabilities: NativeShareCapabilities | null
  /** Settings → App → Capture engine, as last read. */
  engine: CaptureEngine | null
  /** Helper state of the active native share ('idle' when none). */
  state: NativeShareState
  /** The active native share lost its stream audio (`audio-failed`); the video keeps going. */
  audioFailed: boolean
}

export const useNativeShare = create<NativeShareUi>()(() => ({
  capabilities: null,
  engine: null,
  state: 'idle',
  audioFailed: false,
}))

/** A helper that hangs on `hello` must not keep "Go Live" spinning: Chromium is used for that share. */
const CAPABILITIES_TIMEOUT_MS = 5000
/** start() resolved but the stream never went live (and the helper never said why). */
const LIVE_TIMEOUT_MS = 20_000
/** Helper stats arrive at 1 Hz. */
const STATS_INTERVAL_MS = 1000
/**
 * Monitor shares: WGC only delivers a frame when something on screen changes, so an idle desktop captures
 * 0–1 fps. Below this the share reads "idle" instead of a frame rate that looks broken.
 */
const IDLE_CAPTURE_FPS = 2
/**
 * AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK works from Windows 10 2004 (build 19041), as OBS's application
 * audio capture relies on; the helper reports `features.processLoopback` with the same threshold.
 */
const PROCESS_LOOPBACK_MIN_BUILD = 19041

function bridge(): NexoBridge | undefined {
  return (window as { nexo?: NexoBridge }).nexo
}

/**
 * The bridge when the native engine can be asked at all: it needs sources from our own picker. Whether it
 * actually works here is up to main: capabilities() says unavailable off Windows unless NEXO_MEDIA_FAKE=1.
 */
function nativeBridge(): NexoBridge | null {
  const b = bridge()
  return b && !b.usesSystemPicker && b.nativeShare ? b : null
}

let host: NativeShareHost | null = null
let offEvents: (() => void) | undefined

/** Called once by session.ts at load. */
export function bindNativeShare(h: NativeShareHost): void {
  host = h
  if (offEvents) return
  const b = nativeBridge()
  if (!b) return
  try {
    offEvents = b.nativeShare.onEvent(onEvent)
  } catch (e) {
    console.warn('[native-share] onEvent unavailable', e)
  }
}

// ---------------------------------------------------------------------------------------------
// Engine choice (capabilities are fetched once per voice session, off the picker's critical path)
// ---------------------------------------------------------------------------------------------

let capsPromise: Promise<NativeShareCapabilities> | null = null

function readEngine(b: NexoBridge): Promise<CaptureEngine> {
  return b.prefs
    .get()
    .then((p) => (p.captureEngine === 'chromium' ? 'chromium' : 'native')) // default native (api.ts)
    .catch(() => 'native' as const)
    .then((engine) => {
      useNativeShare.setState({ engine })
      return engine
    })
}

function invalidateCapabilities(): void {
  capsPromise = null
  const b = nativeBridge()
  if (b && host?.room()) void loadCapabilities(b)
}

function loadCapabilities(b: NexoBridge): Promise<NativeShareCapabilities> {
  if (capsPromise) return capsPromise
  const p: Promise<NativeShareCapabilities> = b.nativeShare.capabilities().then(
    (caps) => caps,
    (e: unknown) => {
      console.warn('[native-share] capabilities failed', e)
      return { available: false, reason: e instanceof Error && e.message ? e.message : 'The capture helper did not start' }
    },
  )
  capsPromise = p
  void p.then((caps) => {
    if (capsPromise === p) useNativeShare.setState({ capabilities: caps })
  })
  return p
}

/**
 * Joined voice: read the engine setting and, when it's native, start the helper and fetch its
 * capabilities in the background so the first "Go Live" doesn't wait for them.
 */
export function primeNativeShare(): void {
  const b = nativeBridge()
  if (!b) return
  void readEngine(b).then((engine) => {
    // Still in voice: a helper started after leaving would have nobody to release it.
    if (engine === 'native' && host?.room()) void loadCapabilities(b)
  })
}

/** The picker re-reads the setting when it opens (it applies to the next share, no restart). */
export function refreshNativeEngine(): void {
  primeNativeShare()
}

/** Shown once per app session: a share with audio went to Chromium because the helper can't capture it. */
let audioFallbackToasted = false

/** Why a native share can't stream audio here, or null when it can. */
export function nativeAudioUnsupportedReason(caps: NativeShareCapabilities | null): string | null {
  if (!caps?.available || caps.features?.processLoopback === true) return null
  if (caps.osBuild !== undefined && caps.osBuild < PROCESS_LOOPBACK_MIN_BUILD) return 'Stream audio needs Windows 10 version 2004 or newer'
  return "This capture helper can't stream audio"
}

/**
 * Capabilities when this share should use the native engine, else null (Chromium). Native needs a source
 * from our own picker, the setting on Native and a helper that main reports available (Windows with a
 * hardware encoder, or the fake helper). A share with audio also needs process loopback: without it,
 * Chromium streams it, since it can capture the audio.
 */
export async function nativeCapabilitiesFor(opts: StartShareOptions): Promise<NativeShareCapabilities | null> {
  const b = nativeBridge()
  if (!b || !opts.sourceId) return null
  if ((await readEngine(b)) !== 'native') return null
  let timer: number | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => resolve(null), CAPABILITIES_TIMEOUT_MS)
  })
  const caps = await Promise.race([loadCapabilities(b), timeout])
  window.clearTimeout(timer)
  if (!caps?.available) return null
  const noAudio = opts.withAudio ? nativeAudioUnsupportedReason(caps) : null
  if (noAudio) {
    console.info(`[native-share] ${noAudio}: using the Chromium engine for this share`)
    if (!audioFallbackToasted) {
      audioFallbackToasted = true
      toast(`${noAudio} with native capture — using Chromium capture for streams with audio`, 'info')
    }
    return null
  }
  return caps
}

/** True when a share started now would use the native engine (as far as is known yet). For the picker. */
export function useNativeEngineLikely(): boolean {
  const engine = useNativeShare((s) => s.engine)
  const available = useNativeShare((s) => !!s.capabilities?.available)
  return !!nativeBridge() && engine === 'native' && available
}

/** Why the native engine can't stream audio here (a share with audio then uses Chromium), or null. */
export function useNativeAudioUnsupportedReason(): string | null {
  return useNativeShare((s) => nativeAudioUnsupportedReason(s.capabilities))
}

// ---------------------------------------------------------------------------------------------
// Share lifecycle
// ---------------------------------------------------------------------------------------------

interface NativeSession {
  room: Room
  opts: StartShareOptions
  preset: SharePreset
  /**
   * token: asking the server for the stream token (no share of ours exists yet: every event is stale)
   * starting: start() sent; events are buffered until it resolves with our shareId
   * running: events with our shareId apply
   * over: stopped or failed
   */
  phase: 'token' | 'starting' | 'running' | 'over'
  /** From start(); main tags every event of this share with it. */
  shareId: number | null
  /** Events received while start() was pending, replayed (ours only) once the id is known. */
  buffered: NativeShareEvent[]
  live: boolean
  /** Window shares only: an idle monitor legitimately delivers no frames, so fps says nothing there. */
  watchCapture: boolean
  low: CaptureLowDetector
  liveTimer: number | undefined
  /** Ended by release(): the helper is shutting down, no stop() needed. */
  released: boolean
  /** Last `error`: main and the helper send it right before the `ended` it explains. */
  lastError: NativeShareError | null
  /** Resolves the startShare() call: live, stopped, or failed (after the Chromium retry, if any). */
  settle(): void
}

let active: NativeSession | null = null
/** Every stop()/release() sent to the helper and not answered yet. A new start() waits for them (main
 *  runs one share at a time and would answer `busy`). */
let stopping: Promise<void> = Promise.resolve()

function queueStop(call: () => Promise<void>): void {
  const p = call().catch(() => undefined)
  stopping = Promise.all([stopping, p]).then(() => undefined)
}

export function nativeShareActive(): boolean {
  return active !== null
}

const FALLBACK_CODES: readonly NativeShareErrorCode[] = [
  'encoder-unavailable',
  'capture-failed',
  'helper-crashed',
  'helper-unavailable',
]

/** start() rejects with `{ code, message, fallback }` (a plain object from preload); anything else is 'internal'. */
function toNativeError(e: unknown): NativeShareError {
  const o = (e && typeof e === 'object' ? e : {}) as { code?: unknown; message?: unknown; fallback?: unknown }
  const code = (typeof o.code === 'string' ? o.code : 'internal') as NativeShareErrorCode
  const message = typeof o.message === 'string' && o.message ? o.message : typeof e === 'string' ? e : 'failed'
  // Main sets `fallback`; when it doesn't, follow SPEC-BETA §8.3's list.
  const fallback = typeof o.fallback === 'boolean' ? o.fallback : FALLBACK_CODES.includes(code)
  return { code, message, fallback }
}

/**
 * Starts a native share. Resolves once it is live, stopped, or failed. A failure that main marks
 * `fallback` is retried once on the Chromium engine before resolving, so the "toggle screen share"
 * hotkey sees the final outcome. `useVoice().shareStarting` is already set by the caller.
 */
export async function startNativeShare(
  r: Room,
  opts: StartShareOptions,
  preset: SharePreset,
  caps: NativeShareCapabilities,
): Promise<void> {
  const h = host
  const b = nativeBridge()
  const channelId = h?.voice.getState().channelId
  if (!h || !b || !channelId || !opts.sourceId) {
    h?.voice.setState({ shareStarting: false })
    return
  }
  let settle!: () => void
  const settled = new Promise<void>((resolve) => (settle = resolve))
  const session: NativeSession = {
    room: r,
    opts,
    preset,
    phase: 'token',
    shareId: null,
    buffered: [],
    live: false,
    watchCapture: opts.sourceId.startsWith('window:'),
    low: createCaptureLowDetector(preset, STATS_INTERVAL_MS),
    liveTimer: undefined,
    released: false,
    lastError: null,
    settle,
  }
  active = session
  useNativeShare.setState({ state: 'starting', audioFailed: false })

  let creds: { url: string; token: string }
  try {
    creds = await request('voice:streamToken', { channelId })
  } catch (e) {
    if (active !== session) return
    // An older server has no voice:streamToken (the request times out): stream with Chromium instead.
    const message = `no stream token (${e instanceof Error && e.message ? e.message : 'request failed'})`
    return fail(session, { code: 'internal', message, fallback: true })
  }
  await stopping
  if (active !== session) return

  session.phase = 'starting'
  const isScreen = opts.sourceId.startsWith('screen:')
  let started: { shareId: number }
  try {
    started = await b.nativeShare.start({
      sourceId: opts.sourceId,
      preset: {
        width: preset.width,
        height: preset.height,
        fps: preset.fps,
        maxBitrate: preset.maxBitrate,
        contentHint: preset.contentHint,
      },
      cursor: true,
      // nativeCapabilitiesFor() sends shares with audio to Chromium when the helper can't capture it.
      withAudio: opts.withAudio && caps.features?.processLoopback === true,
      hideNexo: isScreen && (opts.hideNexo ?? true),
      livekit: { url: creds.url, token: creds.token },
    })
  } catch (e) {
    if (active !== session) return
    return fail(session, toNativeError(e))
  }
  if (active !== session) {
    // Stopped while main was starting it: our stop() may have arrived before the share existed, so make
    // sure it doesn't stay up. (After a release() the helper is going away anyway.)
    if (!session.released) queueStop(() => b.nativeShare.stop())
    return
  }

  const { shareId } = started
  session.shareId = shareId
  session.phase = 'running'
  for (const ev of session.buffered.splice(0)) {
    if (active !== session) break
    if (ev.shareId === shareId) handleEvent(session, ev)
  }
  if (active === session && !session.live) {
    session.liveTimer = window.setTimeout(() => {
      if (active === session && !session.live) {
        // A helper stuck before `live` is an engine problem: give Chromium a go.
        void fail(session, { code: 'internal', message: 'the stream did not go live', fallback: true })
      }
    }, LIVE_TIMEOUT_MS)
  }
  return settled
}

/** stopShare(), or a new share replacing this one. */
export async function stopNativeShare(announceChange: boolean): Promise<void> {
  const s = active
  if (!s) return
  finish(s, announceChange)
  await stopping
}

/**
 * Leaving voice (or losing the room): stop any share and shut the helper down. The capabilities are
 * fetched again on the next join.
 */
export function releaseNativeShare(): void {
  const s = active
  const touched = !!s || !!capsPromise
  if (s) {
    s.released = true
    finish(s, false)
  }
  capsPromise = null
  useNativeShare.setState({ capabilities: null, state: 'idle', audioFailed: false })
  const b = nativeBridge()
  if (b && touched) queueStop(() => b.nativeShare.release())
}

/**
 * Events belong to the share whose id they carry. Without a share of ours, or before it asked main for one
 * (token), they are the tail of an earlier share. While start() is pending our id isn't known yet: they wait.
 */
function onEvent(ev: NativeShareEvent): void {
  const s = active
  if (!s) return
  if (s.phase === 'starting') {
    s.buffered.push(ev)
    return
  }
  if (s.phase === 'running' && ev.shareId === s.shareId) handleEvent(s, ev)
}

function handleEvent(s: NativeSession, ev: NativeShareEvent): void {
  switch (ev.type) {
    case 'state':
      useNativeShare.setState({ state: ev.state })
      if (ev.state === 'live' && !s.live) goLive(s)
      break
    case 'stats':
      if (s.live) applyStats(s, ev.stats)
      break
    case 'error':
      if (ev.error.code === 'audio-failed') {
        // The video keeps going; the stream is just silent. The "You're live" card says so too.
        console.warn('[native-share] stream audio failed', ev.error)
        if (!useNativeShare.getState().audioFailed) {
          useNativeShare.setState({ audioFailed: true })
          toast(`Stream audio stopped: ${ev.error.message}. Viewers still see your stream, without sound.`, 'error')
        }
        break
      }
      // Errors don't end a share by themselves: the `ended` that follows does, and this explains it.
      console.warn('[native-share] helper error', ev.error)
      s.lastError = ev.error
      break
    case 'ended': {
      if (ev.reason === 'stopped') {
        // Not asked by us (stopNativeShare() detaches the session first), e.g. main released the helper.
        finish(s, true)
        break
      }
      if (ev.reason === 'source-closed') {
        finish(s, true)
        toast('The shared window was closed, so the stream ended.', 'info')
        break
      }
      if (ev.reason === 'device-lost') {
        // The helper already rebuilt its GPU device in place and gave up: Chromium captures differently.
        void fail(s, { code: 'capture-failed', message: 'the graphics device was lost (driver reset or GPU change)', fallback: true })
        break
      }
      // error / crashed: explained by the `error` sent right before.
      if (s.lastError) {
        void fail(s, s.lastError)
        break
      }
      finish(s, true)
      report(s, `Screen share ended: ${endReasonText(ev.reason)}`)
      break
    }
  }
}

function endReasonText(reason: NativeShareEndReason): string {
  return reason === 'crashed' ? 'the capture helper stopped unexpectedly' : 'the capture failed'
}

function goLive(s: NativeSession): void {
  const h = host
  if (!h) return
  window.clearTimeout(s.liveTimer)
  s.live = true
  h.voice.setState({
    sharing: true,
    shareStarting: false,
    sharePresetId: s.preset.id,
    shareEngine: 'native',
    shareStats: null,
    shareCaptureLow: false,
  })
  h.rememberShare(s.opts)
  h.announce()
  s.settle()
}

function applyStats(s: NativeSession, st: NativeShareStats): void {
  const h = host
  if (!h) return
  let warn = false
  // Static content, not a problem: a monitor only delivers frames when something on it changes.
  const idle = !s.watchCapture && !st.stalled && st.captureFps < IDLE_CAPTURE_FPS
  if (s.watchCapture && !st.stalled) {
    warn = s.low.sample(st.captureFps, h.voice.getState().shareCaptureLow)
    if (warn && !h.voice.getState().shareCaptureLow) console.warn('[native-share] screen capture starved', st)
  } else {
    // Minimized (stalled) or a monitor: no frames is expected, not a starved capture.
    s.low.reset()
  }
  const stats: ShareStats = {
    captureFps: Math.round(st.captureFps),
    sendFps: Math.round(st.encodeFps),
    width: st.width,
    height: st.height,
    // The helper lowers its target on LiveKit's congestion feedback (SPEC-BETA §4.9).
    limitation: st.targetBitrate < s.preset.maxBitrate / 2 ? 'bandwidth' : 'none',
    encoder: st.encoder || null,
    bitrate: st.sentBitrate ?? st.targetBitrate,
    stalled: st.stalled,
    idle,
  }
  h.voice.setState({ shareStats: stats, shareCaptureLow: warn })
}

/**
 * Detaches the session and resets the share state. Sends stop() to the helper (unless release() follows),
 * which is a no-op when the helper already ended the share. `settle` is false when a failure handler still
 * has to run (the startShare() call then waits for the Chromium retry too).
 */
function finish(s: NativeSession, announceChange: boolean, settle = true): void {
  if (s.phase === 'over') return
  s.phase = 'over'
  window.clearTimeout(s.liveTimer)
  if (active === s) active = null
  useNativeShare.setState({ state: 'idle', audioFailed: false })
  const b = nativeBridge()
  if (b && !s.released) queueStop(() => b.nativeShare.stop())
  const h = host
  if (h && h.room() === s.room) {
    const wasSharing = h.voice.getState().sharing
    h.voice.setState({
      sharing: false,
      shareStarting: false,
      sharePresetId: null,
      shareEngine: null,
      shareStats: null,
      shareCaptureLow: false,
    })
    if (announceChange && wasSharing) h.announce()
  }
  if (settle) s.settle()
}

async function fail(s: NativeSession, err: NativeShareError): Promise<void> {
  if (s.phase === 'over') return
  finish(s, true, false)
  try {
    await afterFailure(s, err)
  } finally {
    s.settle()
  }
}

/** One Chromium retry when main says it makes sense; otherwise just say what happened. */
async function afterFailure(s: NativeSession, err: NativeShareError): Promise<void> {
  const h = host
  const r = h?.room()
  if (!h || !r || r !== s.room) return // left voice meanwhile
  const v = h.voice.getState()
  if (!err.fallback || v.sharing || v.shareStarting || active) {
    if (!v.sharing && !active) report(s, `Screen share: ${err.message}`)
    return
  }
  console.warn('[native-share] falling back to Chromium capture', err)
  toast(`Native capture failed: ${err.message} — using Chromium capture`, 'info')
  // Main may have turned native off for the session (e.g. the helper crashed twice): ask it again before
  // the next share instead of trusting the capabilities cached at join.
  invalidateCapabilities()
  h.voice.setState({ shareStarting: true, error: null })
  await h.startChromium(r, s.opts, s.preset)
}

function report(s: NativeSession, message: string): void {
  const h = host
  if (h && h.room() === s.room) h.voice.setState({ error: message }) // useVoice toasts every new error
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offEvents?.()
    offEvents = undefined
  })
}
