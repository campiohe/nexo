// Short synthesized UI sounds for mute / unmute / deafen / undeafen, someone joining / leaving your voice
// channel, a "wake up" nudge, sign-in requests and chat notifications (no audio files: Web Audio only;
// the sounds themselves are designed in voice/soundKit.ts).
// They play on the selected speaker through one lazily created AudioContext that is suspended again
// once idle, so nothing runs between sounds. The context only feeds its own destination, never the
// mic / WebRTC graph, so nobody in the call (or watching a stream) hears them.
import { useDevicePrefs } from './devices'
import { createSoundKit, playSound, type SoundKit, type VoiceSound } from './soundKit'

export type { VoiceSound }

/** Keep the context running this long after the last sound (and its room tail) went silent, then suspend it. */
const IDLE_SUSPEND_MS = 2000

type SinkAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

let ctx: SinkAudioContext | null = null
/** Shared nodes (dry bus, room reverb) and buffers for `ctx`, built on the first sound. */
let kit: SoundKit | null = null
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
  kit = null
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
  kit = null
  appliedSink = null
}

/**
 * Play a mute / deafen confirmation, voice join / leave, nudge, sign-in request or chat notification sound
 * on the selected speaker (no-op when sound effects are off).
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
      if (kit?.ctx !== c) kit = createSoundKit(c)
      const secs = playSound(kit, sound)
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
