// Short synthesized UI sounds for mute / unmute / deafen / undeafen and sign-in requests (no audio files:
// Web Audio only).
// They play on the selected speaker through one lazily created AudioContext that is suspended again
// once idle, so nothing runs between sounds. The context only feeds its own destination, never the
// mic / WebRTC graph, so nobody in the call (or watching a stream) hears them.
import { useDevicePrefs } from './devices'

export type VoiceSound = 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'request'

interface Note {
  /** Hz. */
  freq: number
  /** Start offset, seconds. */
  at: number
  /** Length including the decay, seconds. */
  dur: number
}

/** Modest peak level (the speaker test in Settings uses 0.25). */
const PEAK = 0.11
/** Soft attack, long enough to avoid a click. */
const ATTACK = 0.008
/** The exponential decay reaches this (-41 dB from the peak) RELEASE seconds before the note ends... */
const FLOOR = 0.001
/** ...then a short linear fade to exactly 0, so stopping the oscillator can't click. */
const RELEASE = 0.015
/** Keep the context running this long after the last sound, then suspend it. */
const IDLE_SUSPEND_MS = 2000

// Mute/unmute: quick two-note blips (B5 ↔ E5), ~150 ms. Deafen/undeafen: lower, longer pair
// (G4 ↔ C4), ~210 ms. Descending = off, ascending = on.
const SOUNDS: Record<VoiceSound, readonly Note[]> = {
  mute: [
    { freq: 988, at: 0, dur: 0.075 },
    { freq: 659, at: 0.06, dur: 0.09 },
  ],
  unmute: [
    { freq: 659, at: 0, dur: 0.075 },
    { freq: 988, at: 0.06, dur: 0.09 },
  ],
  deafen: [
    { freq: 392, at: 0, dur: 0.1 },
    { freq: 262, at: 0.085, dur: 0.125 },
  ],
  undeafen: [
    { freq: 262, at: 0, dur: 0.1 },
    { freq: 392, at: 0.085, dur: 0.125 },
  ],
  // Someone asks to sign in (docs/SPEC-ACCOUNTS.md §4): a rising three-note chime (E5 A5 E6), ~330 ms,
  // unlike any voice sound.
  request: [
    { freq: 659, at: 0, dur: 0.1 },
    { freq: 880, at: 0.09, dur: 0.1 },
    { freq: 1319, at: 0.18, dur: 0.15 },
  ],
}

type SinkAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

let ctx: SinkAudioContext | null = null
/** Sine plus faint 2nd/3rd harmonics: still soft, but audible on small speakers at low pitches. */
let wave: PeriodicWave | null = null
/** Output device the context was last pointed at ('' = system default). */
let appliedSink: string | null = null
/** Resolves once the latest setSinkId settled, so the first sound doesn't start on the wrong device. */
let sinkReady: Promise<void> = Promise.resolve()
let idleTimer: number | undefined

function wantedSink(): string {
  const id = useDevicePrefs.getState().audiooutput
  // '' = system default output for AudioContext.setSinkId.
  return id && id !== 'default' ? id : ''
}

function applySink(): void {
  const c = ctx
  if (!c?.setSinkId) return
  const id = wantedSink()
  if (id === appliedSink) return
  appliedSink = id
  sinkReady = c.setSinkId(id).catch((e: unknown) => console.warn('[voice] sound effects setSinkId failed', e))
}

function getContext(): SinkAudioContext | null {
  if (ctx && ctx.state !== 'closed') return ctx
  try {
    ctx = new AudioContext({ latencyHint: 'interactive' })
  } catch {
    ctx = null
    return null
  }
  wave = null
  appliedSink = null
  sinkReady = Promise.resolve()
  applySink()
  return ctx
}

function closeContext(): void {
  window.clearTimeout(idleTimer)
  idleTimer = undefined
  if (ctx) void ctx.close().catch(() => {})
  ctx = null
  wave = null
  appliedSink = null
}

function schedule(c: AudioContext, notes: readonly Note[]): number {
  wave ??= c.createPeriodicWave(new Float32Array([0, 0, 0, 0]), new Float32Array([0, 1, 0.12, 0.04]))
  const t0 = c.currentTime + 0.01
  let end = 0
  for (const n of notes) {
    const start = t0 + n.at
    const stop = start + n.dur
    const osc = c.createOscillator()
    osc.setPeriodicWave(wave)
    osc.frequency.value = n.freq
    const g = c.createGain()
    // From silence, up to the peak, exponential decay back to (practically) silence: no clicks.
    g.gain.setValueAtTime(0, start)
    g.gain.linearRampToValueAtTime(PEAK, start + ATTACK)
    g.gain.exponentialRampToValueAtTime(FLOOR, stop - RELEASE)
    g.gain.linearRampToValueAtTime(0, stop)
    osc.connect(g)
    g.connect(c.destination)
    osc.onended = () => {
      osc.disconnect()
      g.disconnect()
    }
    osc.start(start)
    osc.stop(stop + 0.01)
    end = Math.max(end, n.at + n.dur)
  }
  return end
}

/**
 * Play a mute / deafen confirmation (or sign-in request) sound on the selected speaker (no-op when sound
 * effects are off).
 * Independent of deafen: remote voices are silenced on their own <audio> elements, not here.
 */
export function playVoiceSound(sound: VoiceSound): void {
  if (!useDevicePrefs.getState().soundEffects) return
  const c = getContext()
  if (!c) return
  window.clearTimeout(idleTimer)
  idleTimer = undefined
  const resumed = c.state === 'running' ? Promise.resolve() : c.resume()
  void Promise.all([sinkReady, resumed])
    .then(() => {
      if (ctx !== c || c.state !== 'running') return
      const secs = schedule(c, SOUNDS[sound])
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => {
        idleTimer = undefined
        if (ctx === c && c.state === 'running') void c.suspend().catch(() => {})
      }, secs * 1000 + IDLE_SUSPEND_MS)
    })
    .catch(() => {})
}

// Follow the speaker choice; drop the context entirely when sound effects are turned off.
const offPrefs = useDevicePrefs.subscribe((s, prev) => {
  if (!s.soundEffects && prev.soundEffects) closeContext()
  else if (s.audiooutput !== prev.audiooutput) applySink()
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offPrefs()
    closeContext()
  })
}
