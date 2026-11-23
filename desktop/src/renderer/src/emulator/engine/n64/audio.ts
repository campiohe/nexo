// The N64 engine's sound path: ../audio.ts's (same worklet, ../audio-worklet.js), except that the worklet's
// MessagePort is handed to the emulator's worker, which posts each frame's samples to it and reads its
// consumption reports (the emulator's clock) directly: the renderer's main thread isn't in the loop, so a busy UI
// can't make the game stutter. What stays here is the routing:
//
//   worker ──port──▶ worklet (resample to the context rate) ─┬─▶ local gain ─▶ speakers (host's output device)
//                                                             └─▶ MediaStreamAudioDestination (the stream)
import workletUrl from '../audio-worklet.js?url&no-inline'
import { useDevicePrefs } from '../../../voice/devices'

type SinkAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

function wantedSink(): string {
  const id = useDevicePrefs.getState().audiooutput
  return id && id !== 'default' ? id : '' // '' = system default output
}

export class N64Audio {
  readonly ctx: SinkAudioContext
  private readonly node: AudioWorkletNode
  private readonly local: GainNode
  private readonly dest: MediaStreamAudioDestinationNode
  private appliedSink = ''
  private readonly unsubscribe: () => void
  private closed = false

  private constructor(ctx: SinkAudioContext, node: AudioWorkletNode) {
    this.ctx = ctx
    this.node = node
    this.local = new GainNode(ctx, { gain: 1 })
    this.dest = new MediaStreamAudioDestinationNode(ctx, { channelCount: 2, channelCountMode: 'explicit' })
    node.connect(this.local).connect(ctx.destination)
    node.connect(this.dest)
    this.applySink()
    this.unsubscribe = useDevicePrefs.subscribe((s, prev) => {
      if (s.audiooutput !== prev.audiooutput) this.applySink()
    })
  }

  static async create(sourceRate: number): Promise<N64Audio> {
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
      return new N64Audio(ctx, node)
    } catch (e) {
      void ctx.close().catch(() => {})
      throw e
    }
  }

  /** The worklet's port, to transfer to the worker (once): it speaks audio-worklet.js's protocol. */
  get port(): MessagePort {
    return this.node.port
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
    this.node.disconnect()
    this.local.disconnect()
    for (const t of this.dest.stream.getTracks()) t.stop()
    void this.ctx.close().catch(() => {})
  }
}
