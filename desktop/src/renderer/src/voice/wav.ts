// Soundboard clip encoding (no DOM: unit-tested from node). Clips are uploaded as 16-bit PCM WAV, mono,
// SOUNDBOARD_RATE Hz: exact trims, encoded synchronously in a few ms, decodable everywhere, and the size is
// known up front. 5 s (SOUND_MAX_MS) at 32 kHz × 2 bytes = 320,000 bytes + a 44-byte header = 320,044 bytes
// (≈ 313 KiB), well inside SOUND_MAX_BYTES (512 KiB). 32 kHz keeps everything up to 16 kHz, plenty for clips.
import { SOUND_MAX_BYTES, SOUND_MAX_MS } from '@shared/protocol'

export const SOUNDBOARD_RATE = 32_000
export const WAV_HEADER_BYTES = 44

/** Bytes of a 16-bit mono WAV with `samples` samples. */
export function wavBytes(samples: number): number {
  return WAV_HEADER_BYTES + samples * 2
}

/** Most samples a clip may have at `rate`: limited by SOUND_MAX_MS and by SOUND_MAX_BYTES. */
export function maxClipSamples(rate: number = SOUNDBOARD_RATE): number {
  const byTime = Math.floor((rate * SOUND_MAX_MS) / 1000)
  const bySize = Math.floor((SOUND_MAX_BYTES - WAV_HEADER_BYTES) / 2)
  return Math.min(byTime, bySize)
}

/** The duration reported to the server for `samples` samples at `rate` (1..SOUND_MAX_MS). */
export function clipDurationMs(samples: number, rate: number = SOUNDBOARD_RATE): number {
  return Math.min(SOUND_MAX_MS, Math.max(1, Math.round((samples / rate) * 1000)))
}

/**
 * Encode mono float samples (-1..1, clamped) as a 16-bit PCM WAV file. Samples beyond maxClipSamples(rate)
 * are dropped so the result always fits the server's limits.
 */
export function encodeWav(samples: Float32Array, rate: number = SOUNDBOARD_RATE): ArrayBuffer {
  const n = Math.min(samples.length, maxClipSamples(rate))
  const dataBytes = n * 2
  const buf = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const v = new DataView(buf)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true) // fmt chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  v.setUint32(40, dataBytes, true)
  let at = WAV_HEADER_BYTES
  for (let i = 0; i < n; i++, at += 2) {
    const s = samples[i]
    const c = s > 1 ? 1 : s < -1 ? -1 : s || 0 // NaN → 0
    v.setInt16(at, c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff), true)
  }
  return buf
}

/**
 * In place: scale down so the peak is at most `ceiling` (never boosts), and fade the first/last `fadeSamples`
 * in/out so a clip cut mid-waveform doesn't click.
 */
export function finishClip(samples: Float32Array, fadeSamples: number, ceiling = 0.95): void {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    if (a > peak) peak = a
  }
  const scale = peak > ceiling ? ceiling / peak : 1
  const n = samples.length
  const fade = Math.min(fadeSamples, Math.floor(n / 2))
  for (let i = 0; i < n; i++) {
    let g = scale
    if (i < fade) g *= i / fade
    else if (i >= n - fade) g *= (n - 1 - i) / fade
    samples[i] *= g
  }
}
