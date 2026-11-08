// Owner: workstream N. SPEC §13.3 microphone noise suppression.
//
//   off      → getUserMedia noiseSuppression: false
//   standard → Chromium's built-in suppressor (noiseSuppression: true)
//   enhanced → Chromium's suppressor off + RNNoise (WASM in an AudioWorklet), applied as a LiveKit
//              audio TrackProcessor: mic track → AudioContext(48 kHz) → RnnoiseWorkletNode →
//              MediaStreamDestination, whose track is what gets published.
// Echo cancellation and AGC stay on in every mode.
//
// Assets: the worklet module is emitted as its own file (`?url`) and loaded from 'self'. The WASM is
// inlined as a data URL in a lazily loaded chunk and decoded in JS, because fetch() can't read file://
// URLs in the packaged app. Compiling it needs CSP script-src 'wasm-unsafe-eval' (index.html).
//
// If the WASM or the worklet can't be loaded (or the worklet crashes), Enhanced is marked unavailable
// for the rest of the session: callers fall back to Standard and the user gets one toast.
import { create } from 'zustand'
import { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client'
import { toast } from '@renderer/lib/toast'
import type { NoiseMode } from './devices'

export type { NoiseMode } from './devices'

export const NOISE_MODES: readonly { id: NoiseMode; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'No noise suppression. Your mic is sent as it is (echo cancellation stays on).' },
  { id: 'standard', label: 'Standard', hint: 'The browser’s built-in suppressor. Light on CPU, handles steady background hum.' },
  {
    id: 'enhanced',
    label: 'Enhanced',
    hint: 'RNNoise, a small neural network running on your PC. Removes keyboard clicks, fans and other noise.',
  },
]

/** RNNoise works on 480-sample frames at 48 kHz. */
const SAMPLE_RATE = 48_000

// ---------------------------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------------------------

export interface NoiseStatus {
  /** 'failed' is sticky for the session: Enhanced then behaves as Standard. */
  enhanced: 'unknown' | 'ready' | 'failed'
}

export const useNoiseStatus = create<NoiseStatus>()(() => ({ enhanced: 'unknown' }))

let failureToasted = false

/** Marks Enhanced as unavailable (once), with a single toast. Listeners re-apply the mode. */
export function reportEnhancedFailure(e: unknown): void {
  console.warn('[voice] RNNoise noise suppression unavailable, using Standard', e)
  if (useNoiseStatus.getState().enhanced !== 'failed') useNoiseStatus.setState({ enhanced: 'failed' })
  if (!failureToasted) {
    failureToasted = true
    toast('Enhanced noise suppression couldn’t start, so Standard is used instead.', 'error')
  }
}

/** The mode actually applied: Enhanced degrades to Standard once RNNoise has failed. */
export function effectiveNoiseMode(mode: NoiseMode): NoiseMode {
  return mode === 'enhanced' && useNoiseStatus.getState().enhanced === 'failed' ? 'standard' : mode
}

/** getUserMedia processing flags for an (effective) mode. */
export function noiseConstraints(mode: NoiseMode): {
  echoCancellation: true
  noiseSuppression: boolean
  autoGainControl: true
} {
  return { echoCancellation: true, noiseSuppression: mode === 'standard', autoGainControl: true }
}

// ---------------------------------------------------------------------------------------------
// WASM loading (once per session)
// ---------------------------------------------------------------------------------------------

/** Smallest module using a SIMD instruction (same probe as wasm-feature-detect / the library). */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
])

function supportsSimd(): boolean {
  try {
    return WebAssembly.validate(SIMD_PROBE)
  } catch {
    return false
  }
}

async function urlToArrayBuffer(url: string): Promise<ArrayBuffer> {
  if (!url.startsWith('data:')) return (await fetch(url)).arrayBuffer() // dev server (http)
  const comma = url.indexOf(',')
  if (comma < 0 || !url.slice(0, comma).endsWith(';base64')) throw new Error('unexpected WASM data URL')
  const bin = atob(url.slice(comma + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

let wasmPromise: Promise<ArrayBuffer> | null = null

/**
 * The RNNoise WASM binary (SIMD build when supported). Compiled once here first, so a CSP or binary
 * problem shows up as a rejection instead of a worklet that silently outputs nothing.
 */
function loadRnnoiseWasm(): Promise<ArrayBuffer> {
  wasmPromise ??= (async () => {
    const mod = supportsSimd()
      ? await import('@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url&inline')
      : await import('@sapphi-red/web-noise-suppressor/rnnoise.wasm?url&inline')
    const binary = await urlToArrayBuffer(mod.default)
    await WebAssembly.compile(binary)
    return binary
  })()
  return wasmPromise
}

// ---------------------------------------------------------------------------------------------
// Audio graph
// ---------------------------------------------------------------------------------------------

/**
 * One RNNoise chain in its own 48 kHz AudioContext. `track` is the processed output and stays the
 * same for the graph's lifetime; the input can be swapped (device switch / track restart).
 * `close()` releases everything (closing the context also frees the worklet and its WASM memory).
 */
export class RnnoiseGraph {
  readonly track: MediaStreamTrack
  private source: MediaStreamAudioSourceNode | null = null
  private closed = false

  private constructor(
    private readonly ctx: AudioContext,
    private readonly node: RnnoiseWorkletNode,
    private readonly dest: MediaStreamAudioDestinationNode,
  ) {
    const out = dest.stream.getAudioTracks()[0]
    if (!out) throw new Error('no processed audio track')
    this.track = out
  }

  /**
   * Builds a chain. Failures to load the WASM/worklet are reported (sticky fallback + one toast)
   * before rethrowing. `onError` fires if the worklet crashes later.
   */
  static async create(onError?: (e: unknown) => void): Promise<RnnoiseGraph> {
    if (useNoiseStatus.getState().enhanced === 'failed') throw new Error('RNNoise is unavailable')
    let ctx: AudioContext | null = null
    try {
      const wasmBinary = await loadRnnoiseWasm()
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
      await ctx.audioWorklet.addModule(rnnoiseWorkletUrl)
      const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary })
      // Mic tracks can be stereo; RNNoise only processes channel 0, so downmix to mono first.
      node.channelCount = 1
      node.channelCountMode = 'explicit'
      node.channelInterpretation = 'speakers'
      const dest = ctx.createMediaStreamDestination()
      dest.channelCount = 1
      node.connect(dest)
      const graph = new RnnoiseGraph(ctx, node, dest)
      node.addEventListener('processorerror', (ev) => {
        if (graph.closed) return
        reportEnhancedFailure(ev)
        onError?.(ev)
      })
      if (ctx.state !== 'running') {
        // Autoplay is allowed in Nexo, but don't hang on it either way.
        await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 500))])
      }
      if (useNoiseStatus.getState().enhanced === 'unknown') useNoiseStatus.setState({ enhanced: 'ready' })
      return graph
    } catch (e) {
      if (ctx) void ctx.close().catch(() => {})
      reportEnhancedFailure(e)
      throw e
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Feeds `input` into the chain (replacing the previous input); null disconnects it. */
  setInput(input: MediaStreamTrack | null): void {
    if (this.closed) return
    if (this.source) {
      this.source.disconnect()
      this.source = null
    }
    if (!input || input.readyState === 'ended') return
    this.source = this.ctx.createMediaStreamSource(new MediaStream([input]))
    this.source.connect(this.node)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.source?.disconnect()
      this.node.disconnect()
      this.dest.disconnect()
      this.node.destroy()
    } catch {
      /* already torn down */
    }
    this.source = null
    this.track.stop()
    void this.ctx.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------------------------
// LiveKit processor
// ---------------------------------------------------------------------------------------------

export const RNNOISE_PROCESSOR_NAME = 'nexo-rnnoise'

/**
 * LiveKit audio TrackProcessor wrapping one RnnoiseGraph.
 *
 * LiveKit calls `init` from setProcessor, `restart` whenever the underlying mic MediaStreamTrack is
 * replaced (device switch, restartTrack, re-acquire on unmute, republish after a full reconnect) or the
 * room's AudioContext changes, and `destroy` from stopProcessor / track.stop() (unpublish, disconnect).
 * The graph uses its own 48 kHz context, not `opts.audioContext` (the room's runs at the output
 * device's rate), so a restart only swaps the graph's input and `processedTrack` stays the same.
 */
export class RnnoiseTrackProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = RNNOISE_PROCESSOR_NAME
  processedTrack?: MediaStreamTrack
  private graph: RnnoiseGraph | null = null
  private destroyed = false

  constructor(private readonly onError?: (e: unknown) => void) {}

  async init(opts: AudioProcessorOptions): Promise<void> {
    await this.build(opts)
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    if (this.graph && !this.graph.isClosed) {
      this.graph.setInput(opts.track)
      return
    }
    await this.build(opts)
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    this.graph?.close()
    this.graph = null
    this.processedTrack = undefined
  }

  private async build(opts: AudioProcessorOptions): Promise<void> {
    const graph = await RnnoiseGraph.create(this.onError)
    // destroy() (or track.stop(), which LiveKit doesn't serialise with setProcessor) may have run
    // while the graph was loading: don't leave an AudioContext behind.
    if (this.destroyed || opts.localTrack?.isStopped) {
      graph.close()
      return
    }
    graph.setInput(opts.track)
    this.graph?.close()
    this.graph = graph
    this.processedTrack = graph.track
  }
}
