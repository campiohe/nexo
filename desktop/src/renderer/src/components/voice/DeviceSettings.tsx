// Owner: workstream D. Mic / speaker / camera selection + mic level meter + input mode (push to talk).
// Noise suppression selector + mic test through the same chain as the call: workstream N (SPEC §13.3).
// Rendered by workstream C inside the Settings modal. Changes apply live when in voice.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { saveNoiseMode, saveSoundEffects, useDevicePrefs, type DeviceKind } from '../../voice/devices'
import { effectiveNoiseMode, NOISE_MODES, noiseConstraints, RnnoiseGraph, useNoiseStatus } from '../../voice/noise'
import { actionLabel, findConflict } from '../../lib/keybinds'
import { allKeybinds, PTT_RELEASE_DELAY_MAX, setInputPrefs, useInputPrefs, type InputMode } from '../../voice/prefs'
import { cancelCapture, captureBinding, usePtt } from '../../voice/ptt'
import { getLocalMicTrack, setPreferredDevice, useMicTrackRev, useVoice } from '../../voice/session'
import { playVoiceSound } from '../../voice/sounds'
import { AlertIcon, CameraIcon, MicIcon, SpeakerIcon } from './icons'
import './voice.css'

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

const supportsSinkId = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

async function listDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  let devices = await navigator.mediaDevices.enumerateDevices()
  // Labels are empty until the page has media permission: ask once, then re-list.
  const needAudio = devices.some((d) => d.kind === 'audioinput' && !d.label)
  const needVideo = devices.some((d) => d.kind === 'videoinput' && !d.label)
  if (needAudio || needVideo) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: needAudio, video: needVideo })
      s.getTracks().forEach((t) => t.stop())
    } catch {
      if (needAudio && needVideo) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true })
          s.getTracks().forEach((t) => t.stop())
        } catch {
          /* no permission: show generic names */
        }
      }
    }
    devices = await navigator.mediaDevices.enumerateDevices()
  }
  return devices
}

function deviceLabel(d: MediaDeviceInfo, index: number): string {
  if (d.label) return d.label
  const kind = d.kind === 'audioinput' ? 'Microphone' : d.kind === 'audiooutput' ? 'Speaker' : 'Camera'
  return `${kind} ${index + 1}`
}

export function DeviceSettings() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const prefs = useDevicePrefs()

  const refresh = useCallback(async () => {
    try {
      setDevices(await listDevices())
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const md = navigator.mediaDevices
    if (!md) return
    const onChange = () => void navigator.mediaDevices.enumerateDevices().then(setDevices)
    md.addEventListener('devicechange', onChange)
    return () => md.removeEventListener('devicechange', onChange)
  }, [refresh])

  const ofKind = (kind: DeviceKind) =>
    devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')

  return (
    <div className="vx-devices">
      <DeviceSelect
        icon={<MicIcon size={16} />}
        label="Microphone"
        kind="audioinput"
        devices={ofKind('audioinput')}
        value={prefs.audioinput}
        loaded={loaded}
      />
      <NoiseSuppressionSection />
      <MicMeter deviceId={prefs.audioinput} outputId={prefs.audiooutput} />
      <InputModeSection />

      <DeviceSelect
        icon={<SpeakerIcon size={16} />}
        label="Speaker"
        kind="audiooutput"
        devices={ofKind('audiooutput')}
        value={prefs.audiooutput}
        loaded={loaded}
        disabledReason={supportsSinkId ? undefined : 'Output selection is not supported here; the system default is used.'}
      />
      <SpeakerTest deviceId={prefs.audiooutput} />
      <SoundEffectsToggle />

      <DeviceSelect
        icon={<CameraIcon size={16} />}
        label="Camera"
        kind="videoinput"
        devices={ofKind('videoinput')}
        value={prefs.videoinput}
        loaded={loaded}
      />
    </div>
  )
}

interface DeviceSelectProps {
  icon: ReactNode
  label: string
  kind: DeviceKind
  devices: MediaDeviceInfo[]
  value: string | null
  loaded: boolean
  disabledReason?: string
}

function DeviceSelect({ icon, label, kind, devices, value, loaded, disabledReason }: DeviceSelectProps) {
  const id = `vx-dev-${kind}`
  // A saved device that's currently unplugged stays visible so the choice isn't silently lost.
  const missing = value && !devices.some((d) => d.deviceId === value)
  return (
    <div className="vx-field">
      <label htmlFor={id} className="vx-field-label">
        {icon} {label}
      </label>
      <select
        id={id}
        className="vx-select"
        value={value ?? ''}
        disabled={!!disabledReason}
        onChange={(e) => void setPreferredDevice(kind, e.target.value || null)}
      >
        <option value="">System default</option>
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {deviceLabel(d, i)}
          </option>
        ))}
        {missing && <option value={value}>Unavailable device</option>}
      </select>
      {disabledReason && <p className="vx-field-hint">{disabledReason}</p>}
      {!disabledReason && loaded && devices.length === 0 && (
        <p className="vx-field-hint">No {label.toLowerCase()} found.</p>
      )}
    </div>
  )
}

/** Off / Standard / Enhanced (RNNoise). Applies live to the call's mic and to the mic test below. */
function NoiseSuppressionSection() {
  const mode = useDevicePrefs((s) => s.noiseMode)
  const failed = useNoiseStatus((s) => s.enhanced === 'failed')
  const active = NOISE_MODES.find((m) => m.id === mode) ?? NOISE_MODES[2]
  return (
    <div className="vx-field">
      <span className="vx-field-label" id="vx-noise-label">
        Noise suppression
      </span>
      <div className="vx-seg" role="radiogroup" aria-labelledby="vx-noise-label">
        {NOISE_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            className={`vx-seg-btn ${mode === m.id ? 'is-active' : ''}`}
            onClick={() => saveNoiseMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="vx-field-hint">{active.hint}</p>
      {failed && mode === 'enhanced' && (
        <p className="vx-warn-box" role="status">
          <AlertIcon size={15} />
          <span>Enhanced couldn’t start on this computer, so Standard is used. Restart Nexo to try again.</span>
        </p>
      )}
    </div>
  )
}

/**
 * Mic test: live input level from the selected mic, optionally played back ("Hear yourself") through
 * the selected speaker. Uses the call's own (processed) mic track while unmuted in voice; otherwise
 * captures the mic with the same processing chain as the call (noise mode constraints + RNNoise).
 */
function MicMeter({ deviceId, outputId }: { deviceId: string | null; outputId: string | null }) {
  const barRef = useRef<HTMLDivElement>(null)
  const inVoice = useVoice((s) => s.status === 'connected' || s.status === 'reconnecting')
  const muted = useVoice((s) => s.muted || s.deafened)
  // In push-to-talk mode the call's track is silent while the key is up: meter a separate stream.
  const ptt = useInputPrefs((s) => s.inputMode === 'ptt')
  // Re-read when the noise mode (or its availability) changes, or the call's mic track is replaced.
  const mode = useDevicePrefs((s) => s.noiseMode)
  const enhancedFailed = useNoiseStatus((s) => s.enhanced === 'failed')
  const micRev = useMicTrackRev((s) => s.rev)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let ownStream: MediaStream | null = null
    let graph: RnnoiseGraph | null = null
    let ctx: AudioContext | null = null
    let player: SinkAudio | null = null
    let raf = 0
    const effective = effectiveNoiseMode(mode)

    const start = async () => {
      setError(null)
      let track = inVoice && !muted && !ptt ? getLocalMicTrack() : null
      if (!track || track.readyState === 'ended') {
        try {
          ownStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
              ...noiseConstraints(effective),
            },
          })
        } catch (e) {
          if (!cancelled) setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Microphone permission denied' : 'Could not open the microphone')
          return
        }
        if (cancelled) {
          ownStream.getTracks().forEach((t) => t.stop())
          return
        }
        track = ownStream.getAudioTracks()[0] ?? null
        if (track && effective === 'enhanced') {
          try {
            const g = await RnnoiseGraph.create()
            if (cancelled) {
              g.close()
              return
            }
            graph = g
            g.setInput(track)
            track = g.track
          } catch {
            // Reported by noise.ts (toast + Standard fallback), which re-runs this effect.
            return
          }
        }
      }
      if (!track || cancelled) return
      ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(new MediaStream([track]))
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      let smooth = 0
      const tick = () => {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        const rms = Math.sqrt(sum / buf.length)
        // Map -60 dB..0 dB to 0..1.
        const db = 20 * Math.log10(Math.max(rms, 1e-6))
        const level = Math.min(1, Math.max(0, (db + 60) / 60))
        smooth = level > smooth ? level : smooth * 0.85 + level * 0.15
        if (barRef.current) barRef.current.style.clipPath = `inset(0 ${((1 - smooth) * 100).toFixed(1)}% 0 0)`
        raf = requestAnimationFrame(tick)
      }
      tick()

      if (listening) {
        const el: SinkAudio = new Audio()
        player = el
        el.srcObject = new MediaStream([track])
        try {
          if (outputId && el.setSinkId) await el.setSinkId(outputId)
          if (!cancelled) await el.play()
        } catch {
          /* ignore: the meter still works */
        }
      }
    }

    // Small delay so a just-switched device has replaced the call's track.
    const t = window.setTimeout(() => void start(), 150)
    return () => {
      cancelled = true
      window.clearTimeout(t)
      cancelAnimationFrame(raf)
      if (player) {
        player.pause()
        player.srcObject = null
      }
      graph?.close()
      ownStream?.getTracks().forEach((tr) => tr.stop())
      void ctx?.close().catch(() => {})
      if (barRef.current) barRef.current.style.clipPath = 'inset(0 100% 0 0)'
    }
  }, [deviceId, outputId, inVoice, muted, ptt, mode, enhancedFailed, micRev, listening])

  return (
    <div className="vx-meter-wrap">
      <div className="vx-meter" role="meter" aria-label="Microphone level">
        <div className="vx-meter-fill" ref={barRef} />
      </div>
      <div className="vx-keybind-row">
        <button
          type="button"
          className={`vx-btn vx-btn-sm ${listening ? 'is-active' : ''}`}
          aria-pressed={listening}
          onClick={() => setListening((v) => !v)}
        >
          {listening ? 'Stop listening' : 'Hear yourself'}
        </button>
        <p className="vx-field-hint">
          {error ?? (listening ? 'Use headphones to avoid feedback.' : 'Speak to test your microphone.')}
        </p>
      </div>
    </div>
  )
}

/** Short two-tone chime through the selected output device. */
function SpeakerTest({ deviceId }: { deviceId: string | null }) {
  const [playing, setPlaying] = useState(false)
  const play = async () => {
    if (playing) return
    setPlaying(true)
    const ctx = new AudioContext()
    const dest = ctx.createMediaStreamDestination()
    const gain = ctx.createGain()
    gain.connect(dest)
    const now = ctx.currentTime
    gain.gain.setValueAtTime(0, now)
    ;[660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      osc.connect(gain)
      const t0 = now + i * 0.22
      gain.gain.setTargetAtTime(0.25, t0, 0.01)
      gain.gain.setTargetAtTime(0, t0 + 0.16, 0.03)
      osc.start(t0)
      osc.stop(t0 + 0.3)
    })
    const el: SinkAudio = new Audio()
    el.srcObject = dest.stream
    try {
      if (deviceId && el.setSinkId) await el.setSinkId(deviceId)
      await el.play()
    } catch {
      /* ignore */
    }
    window.setTimeout(() => {
      el.pause()
      el.srcObject = null
      void ctx.close().catch(() => {})
      setPlaying(false)
    }, 800)
  }
  return (
    <button className="vx-btn vx-btn-sm vx-speaker-test" onClick={() => void play()} disabled={playing}>
      {playing ? 'Playing…' : 'Play test sound'}
    </button>
  )
}

/** Mute / deafen confirmation sounds (voice/sounds.ts), played on the speaker above. */
function SoundEffectsToggle() {
  const on = useDevicePrefs((s) => s.soundEffects)
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        <span>Sound effects</span>
        <span className="muted small">
          Short sounds when you mute, unmute, deafen or undeafen, including from keybinds while a game has focus.
          Only you hear them.
        </span>
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={on}
        onChange={(e) => {
          saveSoundEffects(e.target.checked)
          // Preview on the selected speaker when turning them on.
          if (e.target.checked) playVoiceSound('unmute')
        }}
      />
    </label>
  )
}

const MODES: { id: InputMode; label: string }[] = [
  { id: 'voice', label: 'Voice activity' },
  { id: 'ptt', label: 'Push to talk' },
]

/** Voice activity vs push to talk, the PTT keybind and its release delay. */
function InputModeSection() {
  const mode = useInputPrefs((s) => s.inputMode)
  const binding = useInputPrefs((s) => s.pttBinding)
  const delay = useInputPrefs((s) => s.pttReleaseDelayMs)
  const status = usePtt((s) => s.status)
  const capturing = usePtt((s) => s.capturing)
  const held = usePtt((s) => s.open)
  const [conflict, setConflict] = useState<string | null>(null)

  // Leaving the settings mid-recording cancels it.
  useEffect(() => () => {
    if (usePtt.getState().capturing) cancelCapture()
  }, [])

  const record = async () => {
    if (capturing) {
      cancelCapture()
      return
    }
    setConflict(null)
    const b = await captureBinding()
    if (!b) return
    const other = findConflict(allKeybinds(), 'ptt', b)
    if (other) {
      setConflict(`${b.label} is already used by ${actionLabel(other)}. Change it in Settings → Keybinds first.`)
      return
    }
    setInputPrefs({ pttBinding: b })
  }

  const warning =
    mode === 'ptt' && binding && status && !status.active
      ? (status.reason ?? 'Global push to talk is not running.') + ' Push to talk still works while Nexo is focused.'
      : null

  return (
    <div className="vx-input-mode">
      <div className="vx-field">
        <span className="vx-field-label" id="vx-input-mode-label">
          Input mode
        </span>
        <div className="vx-seg" role="radiogroup" aria-labelledby="vx-input-mode-label">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              className={`vx-seg-btn ${mode === m.id ? 'is-active' : ''}`}
              onClick={() => setInputPrefs({ inputMode: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="vx-field-hint">
          {mode === 'ptt'
            ? 'Your mic is only sent while you hold the key, even when another app (like a game) has focus.'
            : 'Your mic is sent whenever you are unmuted.'}
        </p>
      </div>

      {mode === 'ptt' && (
        <>
          <div className="vx-field">
            <span className="vx-field-label">Push to talk key</span>
            <div className="vx-keybind-row">
              <button
                type="button"
                className={`vx-keybind ${capturing ? 'is-recording' : binding ? '' : 'is-empty'}`}
                onClick={() => void record()}
                aria-label={capturing ? 'Recording: press a key or mouse button, Esc to cancel' : 'Change push to talk key'}
              >
                {capturing ? 'Press any key or mouse button…' : (binding?.label ?? 'Click to set a key')}
              </button>
              {held && !capturing && <span className="vx-ptt-badge is-live">TALKING</span>}
            </div>
            <p className="vx-field-hint">
              {capturing
                ? 'Esc cancels. Left and right click can’t be used.'
                : conflict
                  ? conflict
                  : binding
                    ? 'Click to change. Mouse side buttons work too.'
                    : 'Choose the key or mouse button to hold while talking.'}
            </p>
          </div>

          <div className="vx-field">
            <label className="vx-field-label" htmlFor="vx-ptt-delay">
              Release delay
            </label>
            <div className="vx-range-row">
              <input
                id="vx-ptt-delay"
                type="range"
                className="vx-range"
                min={0}
                max={PTT_RELEASE_DELAY_MAX}
                step={10}
                value={delay}
                onChange={(e) => setInputPrefs({ pttReleaseDelayMs: Number(e.target.value) })}
                style={{ ['--fill' as string]: `${(delay / PTT_RELEASE_DELAY_MAX) * 100}%` }}
              />
              <span className="vx-range-value">{delay} ms</span>
            </div>
            <p className="vx-field-hint">Keeps the mic open briefly after you let go, so word endings aren’t cut off.</p>
          </div>

          {warning && (
            <p className="vx-warn-box" role="status">
              <AlertIcon size={15} />
              <span>{warning}</span>
            </p>
          )}
        </>
      )}
    </div>
  )
}
