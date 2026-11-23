// Encode already cropped/resized RGBA frames as a looping GIF that fits a byte budget (animated profile
// pictures and banners, see AVATAR_ANIMATED_* / BANNER_ANIMATED_* in shared/protocol.ts). No DOM: the caller decodes and crops the frames.
//
// Every frame is a full picture with its own (local) palette from gifenc's quantizer. Each frame is
// encoded once per colour count into a self-contained chunk (graphic control extension + image), so the
// exact file size of any "keep every Nth frame" variant is a sum of cached chunk sizes: simplifying never
// re-encodes a frame it already did.
import { GIFEncoder, applyPalette, quantize, type GifPalette } from 'gifenc'
import { msg } from '../i18n/core'

/**
 * An error for the user. Runs in a worker (no app language there): `message` is the English message key, and the
 * main thread (lib/gifAvatar.ts) translates it with `values`.
 */
export class GifFitError extends Error {
  constructor(
    readonly key: string,
    readonly values?: Readonly<Record<string, string | number>>,
  ) {
    super(key)
  }
}

export interface RgbaFrame {
  /** width × height × 4 bytes, straight (non-premultiplied) RGBA. */
  data: Uint8ClampedArray
  /** How long the frame shows, in ms. */
  duration: number
}

export interface FitOptions {
  /** Size of every frame, in pixels. */
  width: number
  height: number
  maxBytes: number
  /** Encoding progress of the current attempt, 0..1; `simplifying` once the first attempt didn't fit. */
  onProgress?(fraction: number, simplifying: boolean): void
  /** Called between frames so the UI stays responsive (default: a macrotask every ~12 ms of work). */
  yieldToUi?(): Promise<void>
  signal?: AbortSignal
}

export interface FitResult {
  bytes: Uint8Array
  /** Frames in the output. */
  frames: number
  /** Colours per frame (at most). */
  colors: number
  /** Every `step`-th input frame was kept (1 = all). */
  step: number
}

/**
 * Attempts, best first: [colours per frame, keep every Nth frame]. Halving the colours of a per-frame
 * palette is barely visible at 160 px; halving the frame rate of a 25+ fps GIF isn't either, so both are
 * tried before going further.
 */
const LADDER: readonly (readonly [number, number])[] = [
  [256, 1],
  [128, 1],
  [256, 2],
  [128, 2],
  [64, 2],
  [128, 3],
  [64, 3],
  [64, 4],
  [32, 4],
  [32, 6],
  [32, 8],
  [16, 12],
]
/** Give up on an attempt early when the frames done so far project this far over the budget. */
const PROJECTION_MARGIN = 1.15
const MIN_PROJECTION_FRAMES = 8
/** Browsers play delays under 20 ms as 100 ms; GIF stores centiseconds. */
const MIN_DELAY_CS = 2
const MAX_DELAY_CS = 0xffff

/** "GIF89a" + logical screen descriptor (no global palette) + NETSCAPE2.0 loop-forever extension. */
function header(width: number, height: number): Uint8Array {
  const b: number[] = [...'GIF89a'].map((c) => c.charCodeAt(0))
  b.push(width & 0xff, width >> 8, height & 0xff, height >> 8, 0x70, 0, 0)
  b.push(0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 0x03, 0x01, 0x00, 0x00, 0x00)
  return Uint8Array.from(b)
}
const TRAILER = 0x3b

function hasTransparency(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) return true
  return false
}

/**
 * One frame as a GIF chunk: graphic control extension (delay patched in later), image descriptor, local
 * colour table, LZW pixels.
 */
function encodeChunk(frame: RgbaFrame, width: number, height: number, colors: number, alpha: boolean): Uint8Array {
  // 4096-bin histograms: rgb565's 65536 bins make the quantizer ~30x slower on smooth gradients (~0.5 s per
  // 160 px frame) for a barely visible gain; palette entries are still full 8-bit averages.
  const format = alpha ? 'rgba4444' : 'rgb444'
  const palette: GifPalette = quantize(frame.data, colors, { format, oneBitAlpha: alpha })
  const index = applyPalette(frame.data, palette, format)
  const transparentIndex = alpha ? palette.findIndex((c) => c[3] === 0) : -1
  const enc = GIFEncoder({ auto: false, initialCapacity: width * height })
  enc.writeFrame(index, width, height, {
    palette,
    first: false,
    // Smaller LZW codes for small palettes.
    colorDepth: Math.max(2, Math.ceil(Math.log2(Math.max(2, palette.length)))),
    transparent: transparentIndex >= 0,
    transparentIndex: Math.max(0, transparentIndex),
    // With transparency every frame must clear the previous one (all frames are full pictures).
    dispose: alpha ? 2 : 1,
  })
  return enc.bytes()
}

/** Merge consecutive frames in groups of `step`: the first frame's picture shows for the whole group. */
export function mergeFrames(frames: RgbaFrame[], step: number): RgbaFrame[] {
  if (step <= 1) return frames
  const out: RgbaFrame[] = []
  for (let i = 0; i < frames.length; i += step) {
    let duration = 0
    for (let j = i; j < Math.min(frames.length, i + step); j++) duration += frames[j].duration
    out.push({ data: frames[i].data, duration })
  }
  return out
}

/** Centisecond delays for the kept frames, rounded on the running total so the loop keeps its length. */
function delaysFor(frames: RgbaFrame[], step: number): number[] {
  const delays: number[] = []
  let elapsed = 0
  let prevCs = 0
  for (let i = 0; i < frames.length; i += step) {
    for (let j = i; j < Math.min(frames.length, i + step); j++) elapsed += frames[j].duration
    const endCs = Math.round(elapsed / 10)
    delays.push(Math.min(MAX_DELAY_CS, Math.max(MIN_DELAY_CS, endCs - prevCs)))
    prevCs = Math.max(endCs, prevCs + MIN_DELAY_CS)
  }
  return delays
}

function defaultYield(): () => Promise<void> {
  let last = performance.now()
  return async () => {
    if (performance.now() - last < 12) return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    last = performance.now()
  }
}

/**
 * Encode `frames` (at least 2) as a looping GIF of at most `maxBytes`, simplifying along LADDER until it
 * fits. Throws when even the simplest attempt is too big.
 */
export async function encodeFittedGif(frames: RgbaFrame[], opts: FitOptions): Promise<FitResult> {
  const { width, height, maxBytes, onProgress, signal } = opts
  const yieldToUi = opts.yieldToUi ?? defaultYield()
  if (frames.length < 2) throw new GifFitError(msg('An animation needs at least two frames'))
  const alpha = frames.some((f) => hasTransparency(f.data))
  const head = header(width, height)
  /** colours → chunk per input frame index (lazily filled). */
  const chunks = new Map<number, (Uint8Array | undefined)[]>()

  for (let attempt = 0; attempt < LADDER.length; attempt++) {
    const [colors, step] = LADDER[attempt]
    const kept = Math.ceil(frames.length / step)
    if (kept < 2) break
    let cache = chunks.get(colors)
    if (!cache) chunks.set(colors, (cache = new Array(frames.length)))

    let total = head.length + 1
    let done = 0
    let abandoned = false
    for (let i = 0; i < frames.length; i += step) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      let chunk = cache[i]
      if (!chunk) {
        chunk = cache[i] = encodeChunk(frames[i], width, height, colors, alpha)
        await yieldToUi()
      }
      total += chunk.length
      done++
      onProgress?.(done / kept, attempt > 0)
      if (total > maxBytes) {
        abandoned = true
        break
      }
      if (done >= MIN_PROJECTION_FRAMES && (total / done) * kept > maxBytes * PROJECTION_MARGIN) {
        abandoned = true
        break
      }
    }
    if (abandoned || total > maxBytes) continue

    const delays = delaysFor(frames, step)
    const out = new Uint8Array(total)
    out.set(head, 0)
    let at = head.length
    for (let i = 0, k = 0; i < frames.length; i += step, k++) {
      const chunk = cache[i]!
      out.set(chunk, at)
      // Graphic control extension: 21 F9 04 <packed> <delay lo> <delay hi> <transparent index> 00
      out[at + 4] = delays[k] & 0xff
      out[at + 5] = delays[k] >> 8
      at += chunk.length
    }
    out[at] = TRAILER
    return { bytes: out, frames: kept, colors, step }
  }
  throw new GifFitError(msg('This animation is too detailed to fit {size}, even simplified. Try a shorter or simpler one.'), {
    size: maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / (1024 * 1024))} MB` : `${Math.round(maxBytes / 1024)} KB`,
  })
}
