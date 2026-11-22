// Shared toolkit for game views: a pixel-perfect canvas at a fixed retro resolution (scaled up crisp), a 5×7
// bitmap font, and chiptune sound effects (Web Audio oscillators on the selected speaker, silent while
// deafened or muted in the game area). Game views use these so all games look and sound like one console.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useDevicePrefs } from '../voice/devices'

// ---------------------------------------------------------------------------------------------
// RetroCanvas

export interface RetroCanvasProps {
  /** Logical resolution (e.g. 320×180 for 16:9, 256×224 for a 4:3-ish console). */
  width: number
  height: number
  /** Called every animation frame with the 2D context (no smoothing, transform reset) and performance.now(). */
  draw(ctx: CanvasRenderingContext2D, now: number): void
  /** Optional pointer input in logical pixels (menus, cards). */
  onPointer?(e: { type: 'down' | 'move' | 'up'; x: number; y: number }): void
  className?: string
  style?: CSSProperties
}

/**
 * A canvas of `width`×`height` logical pixels, scaled by the largest whole factor that fits its container
 * (any factor below 1×), centered, `image-rendering: pixelated`. It fills its parent, so give the parent a size.
 */
export function RetroCanvas({ width, height, draw, onPointer, className, style }: RetroCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawRef = useRef(draw)
  drawRef.current = draw
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => {
      const fit = Math.min(el.clientWidth / width, el.clientHeight / height)
      setScale(fit >= 1 ? Math.floor(fit) : Math.max(0.25, fit))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [width, height])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    let raf = 0
    const frame = (now: number) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.imageSmoothingEnabled = false
      try {
        drawRef.current(ctx, now)
      } catch (err) {
        console.error('[games] draw failed', err)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const pointer = (type: 'down' | 'move' | 'up') => (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onPointer) return
    const r = e.currentTarget.getBoundingClientRect()
    onPointer({ type, x: ((e.clientX - r.left) / r.width) * width, y: ((e.clientY - r.top) / r.height) * height })
  }

  return (
    <div ref={wrapRef} className={`gm-retro ${className ?? ''}`} style={style}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ width: width * scale, height: height * scale }}
        onPointerDown={pointer('down')}
        onPointerMove={pointer('move')}
        onPointerUp={pointer('up')}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// 5×7 bitmap font (uppercase; lowercase is drawn as uppercase). 6 px advance per glyph at scale 1.

// prettier-ignore
const GLYPHS: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a], X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04], Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ' ': [0, 0, 0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 0, 0x0c, 0x0c], ',': [0, 0, 0, 0, 0x0c, 0x04, 0x08],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0, 0x04], '?': [0x0e, 0x11, 0x01, 0x02, 0x04, 0, 0x04],
  ':': [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0], '-': [0, 0, 0, 0x1f, 0, 0, 0], '+': [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0],
  '/': [0, 0x01, 0x02, 0x04, 0x08, 0x10, 0], "'": [0x04, 0x04, 0x08, 0, 0, 0, 0], '"': [0x0a, 0x0a, 0, 0, 0, 0, 0],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02], ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '%': [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03], '#': [0x0a, 0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0x0a],
  '*': [0, 0x04, 0x15, 0x0e, 0x15, 0x04, 0], '<': [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  '>': [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08], '=': [0, 0, 0x1f, 0, 0x1f, 0, 0], '_': [0, 0, 0, 0, 0, 0, 0x1f],
}
const ALIASES: Record<string, string> = { '–': '-', '—': '-', '×': 'X', '’': "'", '“': '"', '”': '"' }

export const FONT_W = 5
export const FONT_H = 7
export const FONT_ADVANCE = 6

/** Width in logical pixels of `text` drawn at `scale`. */
export function textWidth(text: string, scale = 1): number {
  return text.length === 0 ? 0 : (text.length * FONT_ADVANCE - 1) * scale
}

export interface TextOptions {
  color?: string
  scale?: number
  align?: 'left' | 'center' | 'right'
  /** A 1-px drop shadow in this color (readable on busy backgrounds). */
  shadow?: string
}

/** Draws `text` with its top-left (or top-center / top-right) at x, y. Unknown characters show as '?'. */
export function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, opts: TextOptions = {}): void {
  const { color = '#ffffff', scale = 1, align = 'left', shadow } = opts
  const w = textWidth(text, scale)
  const cx = Math.round(align === 'center' ? x - w / 2 : align === 'right' ? x - w : x)
  const cy = Math.round(y)
  const paint = (ox: number, oy: number, fill: string) => {
    ctx.fillStyle = fill
    let px = cx + ox
    for (const raw of text) {
      const ch = ALIASES[raw] ?? raw.toUpperCase()
      const rows = GLYPHS[ch] ?? GLYPHS['?']
      for (let r = 0; r < FONT_H; r++) {
        const bits = rows[r]
        if (!bits) continue
        for (let c = 0; c < FONT_W; c++) if (bits & (1 << (FONT_W - 1 - c))) ctx.fillRect(px + c * scale, cy + oy + r * scale, scale, scale)
      }
      px += FONT_ADVANCE * scale
    }
  }
  if (shadow) paint(scale, scale, shadow)
  paint(0, 0, color)
}

// ---------------------------------------------------------------------------------------------
// Sound effects

type SinkAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

let audio: SinkAudioContext | null = null
let master: GainNode | null = null
let appliedSink: string | null = null
let sfxMuted = false
let noiseBuffer: AudioBuffer | null = null

/** The game area mutes effects while you're deafened or turned them off. */
export function setSfxMuted(muted: boolean): void {
  sfxMuted = muted
}

function context(): SinkAudioContext | null {
  if (sfxMuted) return null
  if (!audio || audio.state === 'closed') {
    try {
      audio = new AudioContext({ latencyHint: 'interactive' })
    } catch {
      return null
    }
    master = audio.createGain()
    master.gain.value = 0.18
    master.connect(audio.destination)
    appliedSink = null
    noiseBuffer = null
  }
  const id = useDevicePrefs.getState().audiooutput
  const sink = id && id !== 'default' ? id : ''
  if (audio.setSinkId && sink !== appliedSink) {
    appliedSink = sink
    void audio.setSinkId(sink).catch(() => {})
  }
  if (audio.state === 'suspended') void audio.resume().catch(() => {})
  return audio
}

export interface ToneOptions {
  /** Start frequency (Hz). */
  freq: number
  /** Slide to this frequency by the end. */
  to?: number
  ms: number
  type?: OscillatorType
  /** 0..1 relative to the effects volume. */
  volume?: number
  /** Start this many ms from now. */
  delay?: number
}

function tone({ freq, to, ms, type = 'square', volume = 1, delay = 0 }: ToneOptions): void {
  const c = context()
  if (!c || !master) return
  const t0 = c.currentTime + delay / 1000
  const t1 = t0 + ms / 1000
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t0)
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t1)
  gain.gain.setValueAtTime(volume, t0)
  gain.gain.exponentialRampToValueAtTime(0.001, t1)
  osc.connect(gain).connect(master)
  osc.start(t0)
  osc.stop(t1 + 0.02)
}

function noise({ ms, volume = 1, delay = 0, lowpass = 4000 }: { ms: number; volume?: number; delay?: number; lowpass?: number }): void {
  const c = context()
  if (!c || !master) return
  if (!noiseBuffer) {
    noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate)
    const d = noiseBuffer.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  const t0 = c.currentTime + delay / 1000
  const src = c.createBufferSource()
  src.buffer = noiseBuffer
  const filter = c.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(lowpass, t0)
  filter.frequency.exponentialRampToValueAtTime(200, t0 + ms / 1000)
  const gain = c.createGain()
  gain.gain.setValueAtTime(volume, t0)
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + ms / 1000)
  src.connect(filter).connect(gain).connect(master)
  src.start(t0)
  src.stop(t0 + ms / 1000 + 0.02)
}

/**
 * Chiptune effects. Trigger them from changes between frames (e.g. a view's `events` list with ids, played once
 * each), never from React renders. Silent while muted / deafened.
 */
export const sfx = {
  tone,
  noise,
  blip: () => tone({ freq: 880, ms: 60, volume: 0.6 }),
  select: () => tone({ freq: 660, to: 990, ms: 90, volume: 0.6 }),
  jump: () => tone({ freq: 300, to: 700, ms: 140, volume: 0.7 }),
  hit: () => {
    noise({ ms: 90, volume: 0.9, lowpass: 3000 })
    tone({ freq: 180, to: 80, ms: 100, volume: 0.6 })
  },
  explode: () => {
    noise({ ms: 450, volume: 1, lowpass: 2500 })
    tone({ freq: 120, to: 40, ms: 350, type: 'triangle', volume: 0.9 })
  },
  coin: () => {
    tone({ freq: 988, ms: 70, volume: 0.6 })
    tone({ freq: 1319, ms: 160, volume: 0.6, delay: 70 })
  },
  powerup: () => [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, ms: 80, volume: 0.55, delay: i * 60 })),
  countdown: (final = false) => tone({ freq: final ? 1047 : 523, ms: final ? 350 : 150, volume: 0.6 }),
  win: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone({ freq: f, ms: 140, volume: 0.55, delay: i * 120 })),
  lose: () => [392, 330, 262, 196].forEach((f, i) => tone({ freq: f, ms: 180, type: 'triangle', volume: 0.6, delay: i * 160 })),
}

// ---------------------------------------------------------------------------------------------
// Small helpers

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Plays each new id of `events` once (views carry recent events with increasing ids). */
export function eventPlayer<E extends { id: number }>(play: (e: E) => void) {
  let last = -1
  return (events: readonly E[] | undefined) => {
    if (!events) return
    for (const e of events) {
      if (e.id <= last) continue
      last = e.id
      play(e)
    }
  }
}
