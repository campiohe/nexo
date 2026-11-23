// Runs lib/gifFit.ts off the main thread (quantizing ~100 frames takes seconds; the UI must stay smooth).
// Loaded by lib/gifAvatar.ts as an inline (blob:) worker, which works from file:// in packaged builds.
import { encodeFittedGif, GifFitError } from './gifFit'

export interface GifWorkerRequest {
  frames: { data: ArrayBuffer; duration: number }[]
  width: number
  height: number
  maxBytes: number
}

export type GifWorkerMessage =
  | { kind: 'progress'; fraction: number; simplifying: boolean }
  | { kind: 'done'; bytes: ArrayBuffer; frames: number; colors: number; step: number }
  | { kind: 'error'; message: string; key?: string; values?: Readonly<Record<string, string | number>> }

const post = (msg: GifWorkerMessage, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

self.onmessage = async (e: MessageEvent<GifWorkerRequest>) => {
  const { frames, width, height, maxBytes } = e.data
  try {
    let lastPost = 0
    const result = await encodeFittedGif(
      frames.map((f) => ({ data: new Uint8ClampedArray(f.data), duration: f.duration })),
      {
        width,
        height,
        maxBytes,
        // Nothing to keep responsive in here.
        yieldToUi: async () => {},
        onProgress: (fraction, simplifying) => {
          const now = performance.now()
          if (now - lastPost < 50 && fraction < 1) return
          lastPost = now
          post({ kind: 'progress', fraction, simplifying })
        },
      },
    )
    const bytes = result.bytes.slice().buffer
    post({ kind: 'done', bytes, frames: result.frames, colors: result.colors, step: result.step }, [bytes])
  } catch (err) {
    if (err instanceof GifFitError) post({ kind: 'error', message: err.message, key: err.key, values: err.values })
    else post({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
