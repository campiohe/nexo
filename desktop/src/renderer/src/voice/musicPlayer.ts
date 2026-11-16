// Music plugin playback ("listen together", docs/SPEC.md): every client in the voice channel plays the channel's
// current track itself, at the position derived from the shared MusicState (store/music.ts) and the server clock
// (voice/musicClock.ts). Audio comes from the main process (window.nexo.music.streamUrl → nexo-music://), played
// by one <audio> element created here (never in React), on the selected speaker. Nothing goes through voice.
//
// Active only while this device is in a voice channel whose session has a current track, the plugin is on and
// "Play music on this device" is on. Deafened = muted (kept in sync, so undeafening is instant).
//
// Sync: on every state change the element is put where the session says (new track: load, then seek once the
// metadata is in and play; paused: pause at pausedAt; seek: jump). While playing, drift = local position -
// expected position is checked every ~2 s (voice/musicSync.ts driftDecision): over 750 ms → hard seek (aimed a
// little ahead, learned from the previous seek's latency), 80–750 ms → playbackRate 0.97 / 1.03 until within
// 40 ms. Nothing is corrected while buffering / seeking, nor for a moment after playback resumes.
//
// Errors (engine / media) only affect this client: a notice in the now-playing bar, silence until the next track
// (or Retry). Never skips for everyone. Loaded lazily (net/socket.ts, the music UI): module-level subscriptions
// are fine here, this module is never part of the store/app ↔ net/socket import cycle.
import { create } from 'zustand'
import type { MusicState, MusicTrack } from '@shared/protocol'
import { useApp } from '../store/app'
import { useMusic } from '../store/music'
import { usePlugins } from '../store/plugins'
import { useDevicePrefs } from './devices'
import { speakingIdentities, useParticipants } from './participants'
import { useVoice } from './session'
import { useMusicPrefs } from './musicPrefs'
import { onClockChange, resetMusicClock, serverNow, startMusicClock, stopMusicClock, whenClockReady } from './musicClock'
import { driftDecision, expectedPositionMs, HARD_SEEK_MS, nextSeekLead } from './musicSync'
import { musicEngine, musicErrorText, resetMusicPanel, type MusicErrorCode } from './musicActions'

// ---------------------------------------------------------------------------------------------
// UI-facing state

export interface MusicPlayerUi {
  /** This device can't play the current track (queueId `key`): shown in the now-playing bar. */
  notice: { key: string; text: string } | null
  /** play() was refused (no user gesture yet): the bar shows "Click to start music". */
  blocked: boolean
  /** Loading / buffering the current track. */
  buffering: boolean
}

export const useMusicPlayer = create<MusicPlayerUi>()(() => ({ notice: null, blocked: false, buffering: false }))

function setUi(patch: Partial<MusicPlayerUi>): void {
  const cur = useMusicPlayer.getState()
  if ((Object.keys(patch) as (keyof MusicPlayerUi)[]).every((k) => cur[k] === patch[k])) return
  useMusicPlayer.setState(patch)
}

// ---------------------------------------------------------------------------------------------
// Tunables

const TICK_MS = 250
const CHECK_EVERY_MS = 2000
const CHECK_NUDGING_MS = 500
/** No drift correction this long after playback (re)starts: currentTime settles first. */
const RESUME_GRACE_MS = 1000
/** Prefetch the next queued track this long before the current one ends. */
const PREFETCH_BEFORE_MS = 20_000
/** Within this much of the end, a stopped element isn't restarted (the server advances shortly). */
const END_MARGIN_MS = 300
/** Ducking: music level while someone talks, ramp down / up times, and a short hold between words. */
const DUCK_LEVEL = 0.35
const DUCK_IN_MS = 150
const DUCK_OUT_MS = 600
const DUCK_HOLD_MS = 250
const RAMP_STEP_MS = 20

// ---------------------------------------------------------------------------------------------
// Module state

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

let audio: SinkAudio | null = null
/** queueId of the track loaded (or that failed) in the element; null when unloaded. */
let loadedKey: string | null = null
let loadedUrl = ''
/** Bumped by every load / unload, so stale async continuations bail out. */
let loadSeq = 0
let metaReady = false
/** The current track failed on this device: stay silent until the session moves to another track. */
let failedKey: string | null = null
let buffering = false
let graceUntil = 0
let nextCheckAt = 0
/** Head start (ms) for hard seeks, learned from the residual drift after the previous one. */
let seekLead = 0
let pendingSeekCheck = false
let prefetchedKey: string | null = null
let tickTimer: number | undefined
let appliedSink: string | null = null

// ---------------------------------------------------------------------------------------------
// What should play

/** The voice channel this device is in (connected / reconnecting), or null. */
function voiceChannel(): string | null {
  const v = useVoice.getState()
  return v.channelId && (v.status === 'connected' || v.status === 'reconnecting') ? v.channelId : null
}

function pluginOn(): boolean {
  return usePlugins.getState().plugins.music
}

/** The session this device should be playing (with a current track), or null. */
function activeState(): (MusicState & { current: MusicTrack }) | null {
  const ch = voiceChannel()
  if (!ch || !pluginOn() || !useMusicPrefs.getState().musicEnabled) return null
  const st = useMusic.getState().byChannel[ch]
  return st?.current ? (st as MusicState & { current: MusicTrack }) : null
}

// ---------------------------------------------------------------------------------------------
// Element

function wantedSink(): string {
  const id = useDevicePrefs.getState().audiooutput
  return id && id !== 'default' ? id : ''
}

function applySink(): void {
  const a = audio
  if (!a?.setSinkId) return
  const id = wantedSink()
  if (id === appliedSink) return
  appliedSink = id
  a.setSinkId(id).catch((e: unknown) => {
    console.warn('[music] setSinkId failed', e)
    appliedSink = null
  })
}

function getAudio(): SinkAudio {
  if (audio) return audio
  const a = new Audio() as SinkAudio
  a.preload = 'auto'
  a.preservesPitch = true
  a.addEventListener('loadedmetadata', onLoadedMetadata)
  a.addEventListener('waiting', () => setBuffering(true))
  a.addEventListener('playing', onPlaying)
  a.addEventListener('error', onMediaError)
  audio = a
  appliedSink = null
  applySink()
  applyVolume()
  return a
}

function setBuffering(b: boolean): void {
  buffering = b
  setUi({ buffering: b })
}

function setRate(rate: number): void {
  if (audio && audio.playbackRate !== rate) audio.playbackRate = rate
}

function startTick(): void {
  if (tickTimer !== undefined) return
  tickTimer = window.setInterval(tick, TICK_MS)
}

function stopTick(): void {
  window.clearInterval(tickTimer)
  tickTimer = undefined
}

/** Stop and empty the element (keeps it for the next track). */
function unload(): void {
  loadSeq++
  loadedKey = null
  loadedUrl = ''
  metaReady = false
  pendingSeekCheck = false
  stopTick()
  const a = audio
  if (a) {
    a.pause()
    if (a.hasAttribute('src')) {
      a.removeAttribute('src')
      a.load()
    }
    setRate(1)
  }
  setBuffering(false)
}

function load(track: MusicTrack): void {
  unload()
  const engine = musicEngine()
  loadedKey = track.queueId
  if (!engine) {
    fail(track.queueId, "this version of Nexo can't play music.")
    return
  }
  const a = getAudio()
  loadedUrl = engine.streamUrl(track.videoId)
  setBuffering(true)
  a.src = loadedUrl
  a.load()
  startTick()
}

function onLoadedMetadata(): void {
  if (!audio || !loadedUrl || audio.getAttribute('src') !== loadedUrl) return
  const seq = loadSeq
  metaReady = true
  // Don't start at a guessed position: wait for the first clock sync (bounded).
  void whenClockReady().then(() => {
    if (seq === loadSeq) applyPlayState()
  })
}

function onPlaying(): void {
  setBuffering(false)
  setUi({ blocked: false })
  graceUntil = performance.now() + RESUME_GRACE_MS
  nextCheckAt = graceUntil
}

function fail(key: string, text: string): void {
  failedKey = key
  setUi({ notice: { key, text: `Can't play this here: ${text}` }, buffering: false })
}

function onMediaError(): void {
  const a = audio
  const key = loadedKey
  // An error of a source we already dropped.
  if (!a || !key || !loadedUrl || a.getAttribute('src') !== loadedUrl) return
  const url = loadedUrl
  const code = a.error?.code
  const seq = loadSeq
  console.warn('[music] playback error', code, a.error?.message)
  unload()
  loadedKey = key // still "this track", so reconcile doesn't retry it in a loop
  fail(key, code === MediaError.MEDIA_ERR_NETWORK ? musicErrorText('network') : "the song couldn't be loaded.")
  // The engine explains its failures in the response (JSON MusicEngineError): refine the notice when it does.
  void diagnose(url).then((c) => {
    if (c && seq + 1 === loadSeq && failedKey === key) fail(key, musicErrorText(c))
  })
}

/**
 * Ask main why the stream failed (it remembers the last failure per video: music.lastError). Over IPC, so the
 * renderer never has to fetch nexo-music:// itself (the CSP only allows it as media). null when unknown.
 */
async function diagnose(url: string): Promise<MusicErrorCode | null> {
  const videoId = /^nexo-music:\/\/track\/([A-Za-z0-9_-]{11})$/.exec(url)?.[1]
  const engine = musicEngine()
  if (!videoId || typeof engine?.lastError !== 'function') return null
  try {
    return (await engine.lastError(videoId))?.code ?? null
  } catch {
    return null
  }
}

function tryPlay(): void {
  const a = audio
  if (!a) return
  a.play().then(
    () => setUi({ blocked: false }),
    (e: unknown) => {
      const name = (e as { name?: string } | null)?.name
      if (name === 'NotAllowedError') setUi({ blocked: true, buffering: false })
      else if (name !== 'AbortError') console.warn('[music] play() failed', e)
    },
  )
}

function hardSeek(expectedMs: number): void {
  const a = audio
  if (!a) return
  const durMs = Number.isFinite(a.duration) ? a.duration * 1000 : Infinity
  a.currentTime = Math.max(0, Math.min(expectedMs + seekLead, durMs - 50)) / 1000
  setRate(1)
  pendingSeekCheck = true
  graceUntil = performance.now() + RESUME_GRACE_MS
  nextCheckAt = graceUntil
}

/** Put the element where the session says: paused at pausedAt, or playing at the shared position. */
function applyPlayState(): void {
  const st = activeState()
  const a = audio
  if (!st || !a || !metaReady || loadedKey !== st.current.queueId || failedKey === loadedKey) return
  if (st.startedAt === null) {
    if (!a.paused) a.pause()
    setRate(1)
    const want = (st.pausedAt ?? 0) / 1000
    if (Math.abs(a.currentTime - want) > 0.3) a.currentTime = want
    setBuffering(false)
    return
  }
  const expected = expectedPositionMs(st, serverNow()) ?? 0
  if (a.paused) {
    const durMs = Number.isFinite(a.duration) ? a.duration * 1000 : st.current.durationMs
    // Ended here: stay silent until the server advances (never loop or restart).
    if (expected >= Math.min(durMs, st.current.durationMs) - END_MARGIN_MS) {
      setBuffering(false)
      return
    }
    hardSeek(expected)
    tryPlay()
    return
  }
  checkDrift(true)
}

/**
 * Compare the element with the shared position. `immediate` (a state or clock change): only a big jump is
 * corrected right away, and even during the resume grace; the periodic check also nudges the rate.
 */
function checkDrift(immediate: boolean): void {
  const st = activeState()
  const a = audio
  if (!st || !a || !metaReady || st.startedAt === null || loadedKey !== st.current.queueId) return
  if (a.paused || a.seeking || a.ended || buffering) return
  const now = performance.now()
  if (!immediate && now < graceUntil) return
  const expected = expectedPositionMs(st, serverNow()) ?? 0
  const drift = a.currentTime * 1000 - expected
  if (pendingSeekCheck && !immediate) {
    pendingSeekCheck = false
    if (Math.abs(drift) <= HARD_SEEK_MS) seekLead = nextSeekLead(seekLead, drift)
  }
  const d = driftDecision(drift, a.playbackRate)
  if (d.kind === 'seek') {
    // The shared position is past the end (the server advances shortly): let it finish.
    if (expected >= st.current.durationMs - END_MARGIN_MS) return
    hardSeek(expected)
  } else if (!immediate) {
    setRate(d.rate)
    nextCheckAt = now + (d.rate !== 1 ? CHECK_NUDGING_MS : CHECK_EVERY_MS)
  }
}

function tick(): void {
  const st = activeState()
  if (!st) return
  if (performance.now() >= nextCheckAt) {
    nextCheckAt = performance.now() + CHECK_EVERY_MS
    checkDrift(false)
  }
  // Prefetch the next track near the end of this one.
  const next = st.queue[0]
  if (next && prefetchedKey !== next.queueId && st.startedAt !== null) {
    const pos = expectedPositionMs(st, serverNow()) ?? 0
    if (st.current.durationMs - pos <= PREFETCH_BEFORE_MS) {
      prefetchedKey = next.queueId
      void musicEngine()?.prefetch(next.videoId).catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Volume and ducking

/** Slider position (0..1) → gain: squared, like the soundboard. */
const volumeGain = (v: number) => Math.min(1, Math.max(0, v)) ** 2

let duck = 1
let duckTarget = 1
let rampTimer: number | undefined
let holdTimer: number | undefined

function applyVolume(): void {
  const a = audio
  if (!a) return
  const deafened = useVoice.getState().deafened
  a.muted = deafened
  a.volume = Math.min(1, Math.max(0, volumeGain(useMusicPrefs.getState().musicVolume) * duck))
}

function rampTo(target: number, ms: number): void {
  if (target === duckTarget) return
  duckTarget = target
  window.clearInterval(rampTimer)
  const from = duck
  const start = performance.now()
  rampTimer = window.setInterval(() => {
    const t = Math.min(1, (performance.now() - start) / ms)
    duck = from + (target - from) * t
    applyVolume()
    if (t >= 1) {
      window.clearInterval(rampTimer)
      rampTimer = undefined
    }
  }, RAMP_STEP_MS)
}

function updateDuck(): void {
  const talking =
    useMusicPrefs.getState().musicDuck && !!voiceChannel() && speakingIdentities(useParticipants.getState()).length > 0
  if (talking) {
    window.clearTimeout(holdTimer)
    holdTimer = undefined
    rampTo(DUCK_LEVEL, DUCK_IN_MS)
  } else if (duckTarget !== 1 && holdTimer === undefined) {
    holdTimer = window.setTimeout(() => {
      holdTimer = undefined
      rampTo(1, DUCK_OUT_MS)
    }, DUCK_HOLD_MS)
  }
}

// ---------------------------------------------------------------------------------------------
// Reconcile

function reconcile(): void {
  if (voiceChannel() && pluginOn()) startMusicClock()
  else stopMusicClock()

  const st = activeState()
  if (!st) {
    if (loadedKey !== null || audio?.hasAttribute('src')) unload()
    failedKey = null
    setUi({ notice: null, blocked: false, buffering: false })
    return
  }
  const key = st.current.queueId
  if (loadedKey !== key) {
    failedKey = null
    setUi({ notice: null })
    load(st.current)
  } else {
    applyPlayState()
  }
  applyVolume()
}

/** Make sure the player follows the stores (net/socket.ts loads this module lazily and calls it). */
export function startMusicPlayer(): void {
  reconcile()
}

/** "Click to start music": retry play() from a user gesture. */
export function resumeMusic(): void {
  setUi({ blocked: false })
  const a = audio
  if (a && metaReady) {
    a.play().then(
      () => applyPlayState(),
      (e: unknown) => {
        if ((e as { name?: string } | null)?.name === 'NotAllowedError') setUi({ blocked: true })
      },
    )
  } else reconcile()
}

/** Try the current track again after it failed on this device. */
export function retryMusic(): void {
  failedKey = null
  loadedKey = null
  setUi({ notice: null })
  reconcile()
}

// ---------------------------------------------------------------------------------------------
// Subscriptions (module level: this module is only ever loaded lazily, see the header)

const offVoice = useVoice.subscribe((s, prev) => {
  if (s.channelId !== prev.channelId || s.status !== prev.status) {
    reconcile()
    updateDuck()
  }
  if (s.deafened !== prev.deafened) applyVolume()
})

const offMusic = useMusic.subscribe((s, prev) => {
  const ch = voiceChannel()
  if (ch && s.byChannel[ch] !== prev.byChannel[ch]) reconcile()
})

const offPlugins = usePlugins.subscribe((s, prev) => {
  if (s.plugins.music !== prev.plugins.music) reconcile()
})

const offPrefs = useMusicPrefs.subscribe((s, prev) => {
  if (s.musicEnabled !== prev.musicEnabled) reconcile()
  if (s.musicDuck !== prev.musicDuck) updateDuck()
  if (s.musicVolume !== prev.musicVolume) applyVolume()
})

const offDevices = useDevicePrefs.subscribe((s, prev) => {
  if (s.audiooutput !== prev.audiooutput) applySink()
})

const offParticipants = useParticipants.subscribe((s, prev) => {
  if (s.list !== prev.list) updateDuck()
})

const offClock = onClockChange(() => checkDrift(true))

// The clock and the panel's search belong to a server.
const offApp = useApp.subscribe((s, prev) => {
  if (s.serverUrl === prev.serverUrl && !(s.view === 'onboarding' && prev.view !== 'onboarding')) return
  resetMusicClock()
  resetMusicPanel()
  seekLead = 0
  reconcile()
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offVoice()
    offMusic()
    offPlugins()
    offPrefs()
    offDevices()
    offParticipants()
    offClock()
    offApp()
    unload()
    stopMusicClock()
    window.clearInterval(rampTimer)
    window.clearTimeout(holdTimer)
  })
}
