// "The capture is starved" detection, shared by the Chromium engine (sender stats polled every 2 s) and
// the native engine (helper stats at 1 Hz). Kept time-based so both warn after the same delay.

/** How long the capture must stay low before warning, and good before clearing the warning. */
const CAPTURE_LOW_MS = 8000
const CAPTURE_OK_MS = 6000

export interface CaptureLowDetector {
  /** Feed one sample; returns whether `shareCaptureLow` should be on (starts from `current`). */
  sample(captureFps: number, current: boolean): boolean
  /** Forget the streaks (e.g. while a minimized window delivers no frames on purpose). */
  reset(): void
}

/**
 * Flags a capture that keeps delivering under half the preset's frame rate on a motion preset. On Windows
 * that is almost always a game with an uncapped frame rate: it floods the GPU queue and screen capture gets
 * starved (≈60 → 3–8 fps), while capping the game (V-Sync or any FPS limit) restores it.
 */
export function createCaptureLowDetector(
  preset: { fps: number; contentHint: 'motion' | 'detail' },
  sampleIntervalMs: number,
): CaptureLowDetector {
  const lowSamples = Math.max(1, Math.ceil(CAPTURE_LOW_MS / sampleIntervalMs))
  const okSamples = Math.max(1, Math.ceil(CAPTURE_OK_MS / sampleIntervalMs))
  let low = 0
  let ok = 0
  return {
    sample(captureFps, current) {
      let warn = current
      if (preset.contentHint === 'motion' && captureFps < preset.fps / 2) {
        ok = 0
        if (++low >= lowSamples && !warn) warn = true
      } else {
        low = 0
        ok = captureFps >= preset.fps * 0.75 ? ok + 1 : 0
        if (ok >= okSamples) warn = false
      }
      return warn
    },
    reset() {
      low = 0
      ok = 0
    },
  }
}
