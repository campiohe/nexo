// Animated profile pictures (AVATAR_ANIMATED_* in shared/protocol.ts): detect an animated GIF / WebP / PNG,
// decode its frames with WebCodecs' ImageDecoder, crop + scale each one to AVATAR_ANIMATED_SIZE and
// re-encode a GIF under AVATAR_ANIMATED_MAX_BYTES (lib/gifFit.ts does the encoding and simplifying).
import { AVATAR_ANIMATED_MAX_BYTES, AVATAR_ANIMATED_SIZE } from '@shared/protocol'
import { encodeFittedGif, mergeFrames, type FitResult, type RgbaFrame } from './gifFit'
import type { GifWorkerMessage, GifWorkerRequest } from './gifFit.worker'
import GifWorker from './gifFit.worker?worker&inline'
import type { CropRect } from './imageCrop'

/** At most this many frames and this much time go into the encoder. */
export const ANIMATED_MAX_FRAMES = 120
export const ANIMATED_MAX_MS = 10_000
/** Browsers play delays of 10 ms or less as 100 ms; do the same so the result looks like the source. */
const DEFAULT_FRAME_MS = 100

/** The real type from the file's bytes (names can lie), for the formats that can be animated. */
async function sniffAnimatable(blob: Blob): Promise<'image/gif' | 'image/webp' | 'image/png' | null> {
  const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
  const ascii = (s: number, e: number) => String.fromCharCode(...b.subarray(s, e))
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png'
  return null
}

function hasImageDecoder(): boolean {
  return typeof ImageDecoder !== 'undefined'
}

/**
 * The decoder type when `file` is an animation (more than one frame) this machine can decode, else null
 * (a still image, or no ImageDecoder support: the caller then takes the still-picture path).
 */
export async function animatedTypeOf(file: Blob): Promise<string | null> {
  if (!hasImageDecoder()) return null
  const type = await sniffAnimatable(file)
  if (!type) return null
  try {
    if (!(await ImageDecoder.isTypeSupported(type))) return null
    const decoder = new ImageDecoder({ data: file.stream(), type, preferAnimation: true })
    try {
      await decoder.completed
      const track = decoder.tracks.selectedTrack
      return track && track.animated && track.frameCount > 1 ? type : null
    } finally {
      decoder.close()
    }
  } catch {
    return null
  }
}

export interface AnimatedAvatar {
  /** image/gif */
  blob: Blob
  /** What was given up to fit the size limit, for telling the user ([] = nothing). */
  simplified: string[]
}

export interface AnimatedProgress {
  /** 0..1 */
  fraction: number
  /** True once the first attempt didn't fit and the animation is being simplified. */
  simplifying: boolean
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** The encoder worker sent nothing (no progress, no result) for this long: it is presumed dead. */
const WORKER_STALL_MS = 30_000
const STALLED = 'Preparing the animation stopped responding. Try again, or pick a shorter or smaller animation.'

const abortError = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('Aborted', 'AbortError')

/** Whether `err` comes from aborting (the user cancelled): nothing to report then. */
export const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError'

/**
 * Decode `file` (an animation, see animatedTypeOf), crop `crop` (in the source's pixels, as shown by the
 * crop dialog, whose picture is `sourceWidth` wide) out of every frame and encode the GIF to upload.
 * Aborting `signal` stops it (rejects with an AbortError, see isAbort). Fails with a clear error when the
 * encoder worker stops responding for WORKER_STALL_MS.
 */
export async function encodeAnimatedAvatar(
  file: Blob,
  type: string,
  crop: CropRect,
  sourceWidth: number,
  onProgress?: (p: AnimatedProgress) => void,
  signal?: AbortSignal,
): Promise<AnimatedAvatar> {
  if (signal?.aborted) throw abortError(signal)
  const S = AVATAR_ANIMATED_SIZE
  const decoder = new ImageDecoder({ data: file.stream(), type, preferAnimation: true })
  const simplified: string[] = []
  let frames: RgbaFrame[] = []
  /** Source frames were folded together before encoding (too many of them). */
  let merged = false
  try {
    await decoder.completed
    const track = decoder.tracks.selectedTrack
    if (!track) throw new Error("Couldn't read that animation")
    const total = track.frameCount
    const canvas = new OffscreenCanvas(S, S)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error("Couldn't process that animation")
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    // Frames past ANIMATED_MAX_FRAMES * 2 are folded in pairs on the fly (`stride` source frames per kept
    // frame) so a long, fast animation never holds hundreds of decoded frames in memory.
    let stride = 1
    let pending = 0
    let elapsed = 0
    let last = performance.now()
    let i = 0
    for (; i < total && elapsed < ANIMATED_MAX_MS; i++) {
      if (signal?.aborted) throw abortError(signal)
      const { image } = await decoder.decode({ frameIndex: i, completeFramesOnly: true })
      try {
        const us = image.duration
        const raw = us == null ? 0 : us / 1000
        const duration = Math.min(raw > 10 ? raw : DEFAULT_FRAME_MS, ANIMATED_MAX_MS - elapsed)
        elapsed += duration
        if (pending === 0) {
          // The crop is in the dialog's image pixels; the decoded frame should be the same size, but scale anyway.
          const k = image.displayWidth / sourceWidth || 1
          ctx.clearRect(0, 0, S, S)
          ctx.drawImage(image, crop.x * k, crop.y * k, crop.size * k, crop.size * k, 0, 0, S, S)
          frames.push({ data: ctx.getImageData(0, 0, S, S).data, duration })
        } else {
          frames[frames.length - 1].duration += duration
        }
      } finally {
        image.close()
      }
      pending = (pending + 1) % stride
      if (pending === 0 && frames.length >= ANIMATED_MAX_FRAMES * 2) {
        frames = mergeFrames(frames, 2)
        stride *= 2
        merged = true
      }
      onProgress?.({ fraction: 0.35 * ((i + 1) / total), simplifying: false })
      if (performance.now() - last > 12) {
        await nextTask()
        last = performance.now()
      }
    }
    if (i < total) simplified.push(`shortened to ${ANIMATED_MAX_MS / 1000} seconds`)
  } catch (err) {
    if (isAbort(err) || (signal?.aborted && err === signal.reason)) throw err
    if (err instanceof Error && err.message.startsWith("Couldn't")) throw err
    throw new Error("Couldn't read that animation")
  } finally {
    decoder.close()
  }

  if (frames.length > ANIMATED_MAX_FRAMES) {
    frames = mergeFrames(frames, Math.ceil(frames.length / ANIMATED_MAX_FRAMES))
    merged = true
  }
  if (frames.length < 2) throw new Error("Couldn't read that animation")

  const result = await encodeGif(
    frames,
    (fraction, simplifying) => onProgress?.({ fraction: 0.35 + 0.65 * fraction, simplifying }),
    signal,
  )
  if (merged || result.step > 1) simplified.push('lower frame rate')
  if (result.colors < 256) simplified.push('fewer colours')
  return { blob: new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: 'image/gif' }), simplified }
}

/**
 * Encode in a worker; on the main thread (with yields) if the worker can't start or crashes. The frames are
 * copied, not transferred, so that fallback still has them (~12 MB, a few ms). A worker that goes silent
 * (no progress for WORKER_STALL_MS, e.g. killed without an error event) fails the encode with a clear
 * error instead of leaving the caller waiting forever; aborting `signal` terminates it.
 */
async function encodeGif(
  frames: RgbaFrame[],
  onProgress: (fraction: number, simplifying: boolean) => void,
  signal?: AbortSignal,
): Promise<Omit<FitResult, 'bytes'> & { bytes: Uint8Array }> {
  const opts = { size: AVATAR_ANIMATED_SIZE, maxBytes: AVATAR_ANIMATED_MAX_BYTES }
  let worker: Worker | null = null
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    worker = new GifWorker()
    const w = worker
    const result = await new Promise<FitResult | null>((resolve, reject) => {
      const arm = () => {
        clearTimeout(watchdog)
        watchdog = setTimeout(() => reject(new Error(STALLED)), WORKER_STALL_MS)
      }
      onAbort = () => reject(abortError(signal!))
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      w.onmessage = (e: MessageEvent<GifWorkerMessage>) => {
        arm()
        const msg = e.data
        if (msg.kind === 'progress') onProgress(msg.fraction, msg.simplifying)
        else if (msg.kind === 'error') reject(new Error(msg.message))
        else resolve({ bytes: new Uint8Array(msg.bytes), frames: msg.frames, colors: msg.colors, step: msg.step })
      }
      w.onerror = (e) => {
        e.preventDefault()
        resolve(null)
      }
      const request: GifWorkerRequest = {
        frames: frames.map((f) => ({ data: f.data.buffer as ArrayBuffer, duration: f.duration })),
        ...opts,
      }
      w.postMessage(request)
      arm()
    })
    if (result) return result
  } catch (err) {
    // A message from the encoder (e.g. "too detailed"), a stall or an abort is the answer; anything else
    // means no worker.
    if (worker && (err instanceof Error || isAbort(err) || signal?.aborted)) throw err
  } finally {
    clearTimeout(watchdog)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    worker?.terminate()
  }
  return encodeFittedGif(frames, { ...opts, onProgress, signal })
}
