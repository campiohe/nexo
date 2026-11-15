// "Add sound": pick an audio file (anything Chromium decodes), choose up to SOUND_MAX_MS of it on a waveform,
// preview, name it (+ optional emoji), then upload it as a 16-bit mono WAV (voice/wav.ts explains why).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { SOUND_NAME_MAX } from '@shared/protocol'
import { toast } from '../../lib/toast'
import { uploadSound } from '../../net/sounds'
import { previewBuffer, stopPreviews } from '../../voice/soundboard'
import { clipDurationMs, encodeWav, finishClip, maxClipSamples, SOUNDBOARD_RATE } from '../../voice/wav'
import { EmojiPicker } from '../EmojiPicker'
import { Modal } from '../Modal'
import { CloseIcon, SmilePlusIcon } from '../icons'
import { PlayIcon, StopIcon, UploadIcon } from './icons'

// Decoding is all-or-nothing (decodeAudioData), and decoded audio is big: 32 kHz float is 128 KB per second
// per channel, so a whole album would take gigabytes. Limits, checked before decoding:
/** Files bigger than this are refused outright (15 MB ≈ 90 s of CD-quality WAV, or ≈ 15 min of 128 kbps MP3). */
const MAX_FILE_BYTES = 15 * 1024 * 1024
/**
 * Longest source file, seconds, read from the file's metadata first (an <audio> element on a blob: URL)
 * and checked again after decoding: ≤ 10 min ≈ 150 MB decoded in stereo.
 */
const MAX_SOURCE_SECONDS = 10 * 60
/**
 * When the metadata has no length (e.g. MediaRecorder WebM, or a format only Web Audio reads), only files
 * this small are decoded: even at a low 32 kbps that's ≤ ~22 min, ≈ 340 MB decoded in stereo (refused right after).
 */
const MAX_UNKNOWN_LENGTH_BYTES = 5 * 1024 * 1024
const PROBE_TIMEOUT_MS = 5000
/** Longest selection, seconds (5 s). */
const MAX_SEL = maxClipSamples(SOUNDBOARD_RATE) / SOUNDBOARD_RATE
const MIN_SEL = 0.1
const FADE_SAMPLES = Math.round(SOUNDBOARD_RATE * 0.005)
const WAVE_H = 96

interface Loaded {
  /** Per picked file, to key the waveform. */
  id: number
  name: string
  buffer: AudioBuffer
}

let loadSeq = 0

function defaultName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SOUND_NAME_MAX)
}

function fmt(t: number): string {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

/** The file's duration from its metadata (seconds), or null if the media element can't tell. */
function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const el = new Audio()
    const done = (d: number | null) => {
      window.clearTimeout(timer)
      el.onloadedmetadata = null
      el.onerror = null
      el.removeAttribute('src')
      el.load()
      URL.revokeObjectURL(url)
      resolve(d)
    }
    const timer = window.setTimeout(() => done(null), PROBE_TIMEOUT_MS)
    el.preload = 'metadata'
    el.muted = true
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null)
    el.onerror = () => done(null)
    el.src = url
  })
}

const tooLong = () => new Error(`That file is too long (max ${MAX_SOURCE_SECONDS / 60} minutes). Cut it shorter first.`)

async function decode(file: File): Promise<AudioBuffer> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`That file is too big (max ${MAX_FILE_BYTES / (1024 * 1024)} MB)`)
  const probed = await probeDuration(file)
  if (probed !== null && probed > MAX_SOURCE_SECONDS) throw tooLong()
  if (probed === null && file.size > MAX_UNKNOWN_LENGTH_BYTES) {
    throw new Error(`Couldn't tell how long that file is, so it's limited to ${MAX_UNKNOWN_LENGTH_BYTES / (1024 * 1024)} MB. Try an MP3, OGG or WAV file.`)
  }
  const bytes = await file.arrayBuffer()
  // Decoded straight at the upload rate: no quality lost, and long files take less memory.
  const c = new OfflineAudioContext(1, 1, SOUNDBOARD_RATE)
  let buffer: AudioBuffer
  try {
    buffer = await c.decodeAudioData(bytes)
  } catch {
    throw new Error("Couldn't read that file. Try an MP3, OGG, WAV, WebM or M4A file.")
  }
  // The metadata can be missing or wrong (VBR estimates).
  if (buffer.duration > MAX_SOURCE_SECONDS) throw tooLong()
  return buffer
}

/** The selection, mixed down to mono at SOUNDBOARD_RATE, faded and peak-limited, as a WAV blob. */
async function renderClip(buffer: AudioBuffer, start: number, len: number): Promise<{ blob: Blob; durationMs: number }> {
  const frames = Math.min(maxClipSamples(SOUNDBOARD_RATE), Math.max(1, Math.round(len * SOUNDBOARD_RATE)))
  const c = new OfflineAudioContext(1, frames, SOUNDBOARD_RATE)
  const src = c.createBufferSource()
  src.buffer = buffer
  src.connect(c.destination) // 1-channel destination: stereo is downmixed (L+R)/2
  src.start(0, start, frames / SOUNDBOARD_RATE)
  const rendered = await c.startRendering()
  const samples = rendered.getChannelData(0)
  finishClip(samples, FADE_SAMPLES)
  return { blob: new Blob([encodeWav(samples, SOUNDBOARD_RATE)], { type: 'audio/wav' }), durationMs: clipDurationMs(frames) }
}

/** Max |sample| over all channels for `cols` equal slices. */
function peaksOf(buffer: AudioBuffer, cols: number): Float32Array {
  const out = new Float32Array(cols)
  const per = buffer.length / cols
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch)
    for (let i = 0; i < cols; i++) {
      const from = Math.floor(i * per)
      const to = Math.min(d.length, Math.max(from + 1, Math.floor((i + 1) * per)))
      // Sparse sampling for long files keeps this fast; peaks are still representative at this width.
      const step = Math.max(1, Math.floor((to - from) / 400))
      let m = out[i]
      for (let j = from; j < to; j += step) {
        const a = Math.abs(d[j])
        if (a > m) m = a
      }
      out[i] = m
    }
  }
  return out
}

export function SoundUploadDialog({ onClose }: { onClose(added: boolean): void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [decoding, setDecoding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState({ start: 0, len: MAX_SEL })
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState<string | null>(null)
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const pickerOpen = useRef(false)
  pickerOpen.current = !!pickerAnchor
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )

  const duration = loaded?.buffer.duration ?? 0

  const pickFile = useCallback(async (file: File | undefined) => {
    if (!file) return
    stopPreviews()
    setError(null)
    setDecoding(true)
    try {
      const buffer = await decode(file)
      if (buffer.duration < MIN_SEL) throw new Error('That clip is too short')
      setLoaded({ id: ++loadSeq, name: file.name, buffer })
      setSel({ start: 0, len: Math.min(MAX_SEL, buffer.duration) })
      setName((n) => n || defaultName(file.name))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDecoding(false)
    }
  }, [])

  useEffect(() => () => stopPreviews(), [])

  const submit = async () => {
    if (!loaded || busy) return
    const n = name.trim()
    if (!n) return
    setBusy(true)
    stopPreviews()
    try {
      const { blob, durationMs } = await renderClip(loaded.buffer, sel.start, sel.len)
      await uploadSound(blob, { name: n, emoji, durationMs })
      toast(`Added “${n}” to the soundboard`, 'success')
      if (mounted.current) onClose(true)
    } catch (err) {
      toast(err, 'error')
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <Modal
      title="Add a sound"
      width={540}
      className="sb-upload"
      // Escape while the emoji picker is open only closes the picker (it listens too).
      onClose={() => {
        if (!pickerOpen.current) onClose(false)
      }}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={!loaded || !name.trim() || busy}>
            {busy ? 'Uploading…' : 'Add to soundboard'}
          </button>
        </>
      }
    >
      <div
        className={`sb-drop ${dragOver ? 'is-over' : ''} ${loaded ? 'has-file' : ''}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          void pickFile(e.dataTransfer.files[0])
        }}
      >
        {loaded ? (
          <div className="sb-file-row">
            <span className="sb-file-name" title={loaded.name}>
              {loaded.name}
            </span>
            <span className="sb-file-dur">{fmt(duration)}</span>
            <button className="vx-btn vx-btn-sm" onClick={() => fileRef.current?.click()} disabled={decoding || busy}>
              Change file
            </button>
          </div>
        ) : (
          <button className="sb-drop-btn" onClick={() => fileRef.current?.click()} disabled={decoding} data-autofocus>
            {decoding ? <span className="vx-spinner" /> : <UploadIcon size={22} />}
            <span>{decoding ? 'Reading the file…' : 'Choose an audio file'}</span>
            <span className="muted small">or drop it here · MP3, OGG, WAV, WebM, M4A… (up to 10 min, 15 MB)</span>
          </button>
        )}
      </div>
      {error && (
        <p className="sb-error" role="alert">
          {error}
        </p>
      )}

      {loaded && (
        // Keyed per file: a new file starts with fresh peaks, playhead and drag state.
        <Waveform key={loaded.id} buffer={loaded.buffer} sel={sel} onChange={setSel} disabled={busy} />
      )}

      <div className="sb-fields">
        <div className="sb-field sb-field-emoji">
          <span className="sb-label">Emoji</span>
          <span className="sb-emoji-row">
            <button
              type="button"
              className="sb-emoji-btn"
              onClick={(e) => setPickerAnchor(pickerAnchor ? null : e.currentTarget)}
              aria-label={emoji ? `Emoji: ${emoji}. Change` : 'Choose an emoji'}
              title={emoji ? 'Change emoji' : 'Choose an emoji (optional)'}
              disabled={busy}
            >
              {emoji ?? <SmilePlusIcon size={18} />}
            </button>
            {emoji && (
              <button
                type="button"
                className="icon-btn sb-emoji-clear"
                onClick={() => setEmoji(null)}
                aria-label="Remove emoji"
                title="Remove emoji"
              >
                <CloseIcon size={12} />
              </button>
            )}
          </span>
        </div>
        <label className="sb-field sb-field-name">
          <span className="sb-label">Name</span>
          <input
            className="input"
            value={name}
            maxLength={SOUND_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            placeholder="Airhorn"
            disabled={busy}
            spellCheck={false}
          />
        </label>
      </div>
      {/* Last, so the Modal autofocuses the drop button rather than this hidden input. */}
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,video/mp4,video/webm,.mp3,.ogg,.oga,.opus,.wav,.webm,.m4a,.aac,.flac"
        hidden
        onChange={(e) => {
          void pickFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      {pickerAnchor && (
        <EmojiPicker
          anchor={pickerAnchor}
          onPick={(e) => setEmoji(e)}
          onClose={() => setPickerAnchor(null)}
          label="Sound emoji"
        />
      )}
    </Modal>
  )
}

interface WaveformProps {
  buffer: AudioBuffer
  sel: { start: number; len: number }
  onChange(sel: { start: number; len: number }): void
  disabled: boolean
}

type DragMode = 'move' | 'start' | 'end'

function Waveform({ buffer, sel, onChange, disabled }: WaveformProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playhead, setPlayhead] = useState<number | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const drag = useRef<{ mode: DragMode; x0: number; sel0: { start: number; len: number } } | null>(null)
  const dur = buffer.duration
  const maxLen = Math.min(MAX_SEL, dur)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Draw: bars, brighter inside the selection.
  const peaks = useRef<{ buffer: AudioBuffer; cols: number; data: Float32Array } | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width === 0) return
    const dpr = window.devicePixelRatio || 1
    const barW = 2
    const gap = 1
    const cols = Math.max(1, Math.floor(width / (barW + gap)))
    if (peaks.current?.buffer !== buffer || peaks.current.cols !== cols) peaks.current = { buffer, cols, data: peaksOf(buffer, cols) }
    const data = peaks.current.data
    let max = 0
    for (const p of data) if (p > max) max = p
    const norm = max > 0 ? 1 / max : 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(WAVE_H * dpr)
    const g = canvas.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, WAVE_H)
    const css = getComputedStyle(canvas)
    const on = css.getPropertyValue('--accent').trim() || '#3ee6b0'
    const off = css.getPropertyValue('--text-2').trim() || '#7c8598'
    const selFrom = (sel.start / dur) * width
    const selTo = ((sel.start + sel.len) / dur) * width
    const mid = WAVE_H / 2
    for (let i = 0; i < cols; i++) {
      const x = i * (barW + gap)
      const h = Math.max(1.5, data[i] * norm * (WAVE_H - 8))
      const inside = x + barW > selFrom && x < selTo
      g.fillStyle = inside ? on : off
      g.globalAlpha = inside ? 1 : 0.45
      g.fillRect(x, mid - h / 2, barW, h)
    }
    g.globalAlpha = 1
  }, [buffer, width, sel.start, sel.len, dur])

  const stop = useCallback(() => {
    stopRef.current?.()
    stopRef.current = null
  }, [])
  useEffect(() => stop, [stop, buffer])

  const toggle = async () => {
    if (playing) return stop()
    let raf = 0
    let live = true
    const started = await previewBuffer(buffer, sel.start, sel.len, () => {
      live = false
      cancelAnimationFrame(raf)
      setPlaying(false)
      setPlayhead(null)
      stopRef.current = null
    })
    if (!started || !live) return
    setPlaying(true)
    const tickFn = () => {
      const t = started.context.currentTime - started.startedAt
      if (!live || t > sel.len) return
      setPlayhead(sel.start + Math.max(0, t))
      raf = requestAnimationFrame(tickFn)
    }
    raf = requestAnimationFrame(tickFn)
    stopRef.current = () => {
      cancelAnimationFrame(raf)
      started.stop()
    }
  }

  const secPerPx = width > 0 ? dur / width : 0
  const clampSel = (start: number, len: number) => {
    const l = Math.min(maxLen, Math.max(Math.min(MIN_SEL, dur), len))
    return { start: Math.min(Math.max(0, start), Math.max(0, dur - l)), len: l }
  }

  const onPointerDown = (mode: DragMode | 'jump') => (e: PointerEvent<HTMLElement>) => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    stop()
    let sel0 = sel
    if (mode === 'jump') {
      // Click outside the window: center it there, then keep dragging it.
      const r = wrapRef.current!.getBoundingClientRect()
      const t = (e.clientX - r.left) * secPerPx
      sel0 = clampSel(t - sel.len / 2, sel.len)
      onChange(sel0)
    }
    drag.current = { mode: mode === 'jump' ? 'move' : mode, x0: e.clientX, sel0 }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    const dt = (e.clientX - d.x0) * secPerPx
    const { start, len } = d.sel0
    if (d.mode === 'move') onChange(clampSel(start + dt, len))
    else if (d.mode === 'start') {
      const end = start + len
      const s = Math.min(Math.max(0, start + dt, end - maxLen), end - MIN_SEL)
      onChange({ start: Math.max(0, s), len: end - Math.max(0, s) })
    } else {
      const end = Math.min(dur, start + maxLen, Math.max(start + MIN_SEL, start + len + dt))
      onChange({ start, len: end - start })
    }
  }

  const onPointerUp = () => {
    drag.current = null
  }

  const onHandleKey = (mode: DragMode) => (e: KeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? 0.5 : 0.05
    const delta = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
    if (!delta) return
    e.preventDefault()
    stop()
    if (mode === 'move') return onChange(clampSel(sel.start + delta, sel.len))
    if (mode === 'start') {
      const end = sel.start + sel.len
      const s = Math.max(0, end - maxLen, Math.min(end - MIN_SEL, sel.start + delta))
      return onChange({ start: s, len: end - s })
    }
    const end = Math.min(dur, sel.start + maxLen, Math.max(sel.start + MIN_SEL, sel.start + sel.len + delta))
    onChange({ start: sel.start, len: end - sel.start })
  }

  const left = dur > 0 ? (sel.start / dur) * 100 : 0
  const w = dur > 0 ? (sel.len / dur) * 100 : 100
  // Move / up bubble here from whichever part captured the pointer.
  const handlers = { onPointerMove, onPointerUp, onPointerCancel: onPointerUp }

  return (
    <div className="sb-wave-block">
      <div className="sb-wave" ref={wrapRef} style={{ height: WAVE_H }} onPointerDown={onPointerDown('jump')} {...handlers}>
        <canvas ref={canvasRef} className="sb-wave-canvas" style={{ width: '100%', height: WAVE_H }} />
        <div
          className="sb-sel"
          style={{ left: `${left}%`, width: `${w}%` }}
          onPointerDown={onPointerDown('move')}
          onKeyDown={onHandleKey('move')}
          tabIndex={0}
          role="group"
          aria-label={`Selection ${fmt(sel.start)} to ${fmt(sel.start + sel.len)}. Arrow keys move it.`}
        >
          <span
            className="sb-handle is-start"
            onPointerDown={onPointerDown('start')}
            onKeyDown={onHandleKey('start')}
            tabIndex={0}
            role="slider"
            aria-label="Selection start"
            aria-valuemin={0}
            aria-valuemax={Math.round(dur * 100) / 100}
            aria-valuenow={Math.round(sel.start * 100) / 100}
          />
          <span
            className="sb-handle is-end"
            onPointerDown={onPointerDown('end')}
            onKeyDown={onHandleKey('end')}
            tabIndex={0}
            role="slider"
            aria-label="Selection end"
            aria-valuemin={0}
            aria-valuemax={Math.round(dur * 100) / 100}
            aria-valuenow={Math.round((sel.start + sel.len) * 100) / 100}
          />
        </div>
        {playhead !== null && <span className="sb-playhead" style={{ left: `${(playhead / dur) * 100}%` }} />}
      </div>
      <div className="sb-wave-bar">
        <button className="vx-btn vx-btn-sm" onClick={() => void toggle()} disabled={disabled}>
          {playing ? <StopIcon size={12} /> : <PlayIcon size={12} />}
          {playing ? 'Stop' : 'Preview'}
        </button>
        <span className="sb-wave-info">
          {fmt(sel.start)} – {fmt(sel.start + sel.len)} · <strong>{sel.len.toFixed(2)} s</strong>
          {dur > MAX_SEL && <span className="muted"> (max {MAX_SEL} s)</span>}
        </span>
      </div>
    </div>
  )
}
