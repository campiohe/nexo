// The emulator's sound path, on its own AudioContext (on the host's selected speaker):
//
//   frame samples ──postMessage──▶ worklet (resample to the context rate) ─┬─▶ local gain ─▶ speakers
//                                                                           └─▶ MediaStreamAudioDestination (stream)
//
// The worklet's consumption reports drive the emulator's clock (see audio-worklet.js and runner in ../engine.ts).
import workletUrl from './audio-worklet.js?url&no-inline'
import { useDevicePrefs } from '../../voice/devices'

type SinkAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

function wantedSink(): string {
  const id = useDevicePrefs.getState().audiooutput
  return id && id !== 'default' ? id : '' // '' = system default output
}

export class EmulatorAudio {
  readonly ctx: SinkAudioContext
  private readonly node: AudioWorkletNode
  private readonly local: GainNode
  private readonly dest: MediaStreamAudioDestinationNode
  /** Source frames handed to the worklet / consumed by it (cumulative). */
  private sent = 0
  private consumed = 0
  /** performance.now() of the worklet's latest report (0 = none yet). */
  lastReport = 0
  /** Output device the context is on ('' = system default, where a new context starts). */
  private appliedSink = ''
  private readonly unsubscribe: () => void
  private closed = false

  private constructor(ctx: SinkAudioContext, node: AudioWorkletNode, onReport: () => void) {
    this.ctx = ctx
    this.node = node
    this.local = new GainNode(ctx, { gain: 1 })
    this.dest = new MediaStreamAudioDestinationNode(ctx, { channelCount: 2, channelCountMode: 'explicit' })
    node.connect(this.local).connect(ctx.destination)
    node.connect(this.dest)
    node.port.onmessage = (e: MessageEvent<number>) => {
      this.consumed = e.data
      this.lastReport = performance.now()
      onReport()
    }
    this.applySink()
    this.unsubscribe = useDevicePrefs.subscribe((s, prev) => {
      if (s.audiooutput !== prev.audiooutput) this.applySink()
    })
  }

  /** `onReport` runs every time the worklet reports progress (~190 times a second while the context runs). */
  static async create(sourceRate: number, onReport: () => void): Promise<EmulatorAudio> {
    const ctx: SinkAudioContext = new AudioContext({ latencyHint: 'interactive' })
    try {
      await ctx.audioWorklet.addModule(workletUrl)
      const node = new AudioWorkletNode(ctx, 'nexo-emulator-audio', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { sourceRate },
      })
      // Autoplay is allowed in Nexo's window; resume() in case the context still starts suspended.
      void ctx.resume().catch(() => {})
      return new EmulatorAudio(ctx, node, onReport)
    } catch (e) {
      void ctx.close().catch(() => {})
      throw e
    }
  }

  /** Source frames queued in the worklet and not yet played (approximate: the last report is ≤ 6 ms old). */
  get queued(): number {
    return this.sent - this.consumed
  }

  /** One frame's sound: interleaved stereo int16 (`frames` frames). */
  push(interleaved: Int16Array, frames: number): void {
    if (this.closed || frames <= 0) return
    const l = new Float32Array(frames)
    const r = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      l[i] = interleaved[2 * i] / 32768
      r[i] = interleaved[2 * i + 1] / 32768
    }
    this.sent += frames
    this.node.port.postMessage({ type: 'samples', l, r }, [l.buffer, r.buffer])
  }

  /** Drop what's queued (pause: the sound stops right away instead of draining). */
  clear(): void {
    if (this.closed) return
    this.node.port.postMessage({ type: 'clear' })
  }

  get stream(): MediaStream {
    return this.dest.stream
  }

  setLocalVolume(volume: number): void {
    const v = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1
    this.local.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015)
  }

  private applySink(): void {
    const ctx = this.ctx
    if (this.closed || !ctx.setSinkId) return
    const id = wantedSink()
    if (id === this.appliedSink) return
    this.appliedSink = id
    ctx.setSinkId(id).catch((e: unknown) => console.warn('[emulator] setSinkId failed', e))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    this.node.port.onmessage = null
    this.node.port.postMessage({ type: 'stop' })
    this.node.disconnect()
    this.local.disconnect()
    for (const t of this.dest.stream.getTracks()) t.stop()
    void this.ctx.close().catch(() => {})
  }
}
