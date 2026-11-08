// Owner: workstream D. "Go live" modal: source grid (Screens / Windows), quality preset, stream audio.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import type { CaptureSource } from '../../../../preload/api'
import { DEFAULT_SHARE_PRESET, SHARE_PRESETS, getBridge, useVoice, type SharePreset } from '../../voice/session'
import { refreshNativeEngine, useNativeAudioSupported, useNativeEngineLikely } from '../../voice/nativeShare'
import { CloseIcon, EyeOffIcon, RefreshIcon, ScreenIcon, VolumeIcon, WindowIcon } from './icons'
import './voice.css'

const PRESET_KEY = 'nexo.sharePreset'
const AUDIO_KEY = 'nexo.shareAudio'
const HIDE_NEXO_KEY = 'nexo.shareHideNexo'

const PRESET_BLURB: Record<SharePreset['id'], string> = {
  smooth: 'Games on a weaker upload',
  game: 'Most games — smooth and sharp',
  sharp: 'Code, docs and slides — crisp text',
  source: 'LAN or a strong upload',
}

function readPreset(): SharePreset['id'] {
  try {
    const v = localStorage.getItem(PRESET_KEY)
    if (v && SHARE_PRESETS.some((p) => p.id === v)) return v as SharePreset['id']
  } catch {
    /* ignore */
  }
  return DEFAULT_SHARE_PRESET
}

function readAudio(): boolean {
  try {
    return localStorage.getItem(AUDIO_KEY) !== '0'
  } catch {
    return true
  }
}

/** "Hide Nexo from the stream" (native engine, screens): on unless turned off once. */
function readHideNexo(): boolean {
  try {
    return localStorage.getItem(HIDE_NEXO_KEY) !== '0'
  } catch {
    return true
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

function mbps(bps: number) {
  return `${(bps / 1_000_000).toFixed(0)} Mbps`
}

// ---------------------------------------------------------------------------------------------
// Host: both the sidebar panel and the stage mount one; only the first mounted renders the modal.
// ---------------------------------------------------------------------------------------------

const useHosts = create<{ ids: number[] }>()(() => ({ ids: [] }))
let hostSeq = 0

export function SharePickerHost() {
  const [id] = useState(() => ++hostSeq)
  const isOwner = useHosts((s) => s.ids[0] === id)
  const open = useVoice((s) => s.pickerOpen)
  useEffect(() => {
    useHosts.setState((s) => ({ ids: [...s.ids, id] }))
    return () => useHosts.setState((s) => ({ ids: s.ids.filter((x) => x !== id) }))
  }, [id])
  if (!isOwner || !open) return null
  return <SharePicker onClose={() => useVoice.getState().closeSharePicker()} />
}

// ---------------------------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------------------------

export function SharePicker({ onClose }: { onClose(): void }) {
  const bridge = getBridge()
  const systemPicker = !bridge || bridge.usesSystemPicker
  // Windows native engine (decided again in startShare; this only drives the labels). Until the helper's
  // capabilities arrive the picker shows the Chromium options rather than waiting for them.
  const native = useNativeEngineLikely() && !systemPicker
  const nativeAudio = useNativeAudioSupported()
  const audioSupported = native ? nativeAudio : bridge ? bridge.supportsSystemAudio : true

  const [tab, setTab] = useState<'screen' | 'window'>('screen')
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [loading, setLoading] = useState(!systemPicker)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [presetId, setPresetId] = useState<SharePreset['id']>(readPreset)
  const [withAudio, setWithAudio] = useState<boolean>(readAudio)
  const [hideNexo, setHideNexo] = useState<boolean>(readHideNexo)
  const starting = useVoice((s) => s.shareStarting)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const refresh = useCallback(async () => {
    if (!bridge || systemPicker) return
    try {
      const list = await bridge.capture.listSources()
      setSources(list)
      setListError(null)
      setSelectedId((cur) => {
        if (cur && list.some((s) => s.id === cur)) return cur
        return list.find((s) => s.kind === 'screen')?.id ?? list[0]?.id ?? null
      })
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Could not list screens and windows')
    } finally {
      setLoading(false)
    }
  }, [bridge, systemPicker])

  useEffect(() => {
    if (systemPicker) return
    void refresh()
    const id = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(id)
  }, [refresh, systemPicker])

  // The capture engine setting applies to the next share: re-read it whenever the picker opens.
  useEffect(() => refreshNativeEngine(), [])

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      prev?.focus?.()
    }
  }, [])

  const choosePreset = (id: SharePreset['id']) => {
    setPresetId(id)
    store(PRESET_KEY, id)
  }
  const toggleAudio = (v: boolean) => {
    setWithAudio(v)
    store(AUDIO_KEY, v ? '1' : '0')
  }
  const toggleHideNexo = (v: boolean) => {
    setHideNexo(v)
    store(HIDE_NEXO_KEY, v ? '1' : '0')
  }

  const audio = withAudio && audioSupported
  const canGo = !starting && (systemPicker || !!selectedId)
  const goLive = () => {
    if (!canGo) return
    void useVoice.getState().startShare({ sourceId: systemPicker ? null : selectedId, presetId, withAudio: audio, hideNexo })
  }
  // The selected source decides what the audio checkbox captures (it can sit on the other tab).
  const selectedKind = sources.find((s) => s.id === selectedId)?.kind ?? tab

  const shown = sources.filter((s) => s.kind === tab)
  const screenCount = sources.filter((s) => s.kind === 'screen').length
  const windowCount = sources.length - screenCount

  return createPortal(
    <div className="vx-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panelRef} className="vx-modal vx-picker" role="dialog" aria-modal="true" aria-label="Share your screen" tabIndex={-1}>
        <header className="vx-modal-head">
          <h2>Share your screen</h2>
          <button className="vx-icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="vx-modal-body">
          {systemPicker ? (
            <div className="vx-picker-system">
              <ScreenIcon size={28} />
              <div>
                <strong>Your system will ask what to share</strong>
                <p>
                  {bridge
                    ? 'On Wayland the desktop portal shows its own picker. Choose a quality below, then pick a screen or window.'
                    : 'The browser will show its own picker after you click Choose…'}
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="vx-picker-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={tab === 'screen'}
                  className={`vx-tab ${tab === 'screen' ? 'is-active' : ''}`}
                  onClick={() => setTab('screen')}
                >
                  <ScreenIcon size={16} /> Screens <span className="vx-count">{screenCount}</span>
                </button>
                <button
                  role="tab"
                  aria-selected={tab === 'window'}
                  className={`vx-tab ${tab === 'window' ? 'is-active' : ''}`}
                  onClick={() => setTab('window')}
                >
                  <WindowIcon size={16} /> Windows <span className="vx-count">{windowCount}</span>
                </button>
                <span className="vx-grow" />
                <button className="vx-icon-btn" onClick={() => void refresh()} title="Refresh" aria-label="Refresh sources">
                  <RefreshIcon size={16} />
                </button>
              </div>

              <div className="vx-sources" role="listbox" aria-label={tab === 'screen' ? 'Screens' : 'Windows'}>
                {loading && <div className="vx-sources-empty">Looking for screens and windows…</div>}
                {!loading && listError && <div className="vx-sources-empty is-error">{listError}</div>}
                {!loading && !listError && shown.length === 0 && (
                  <div className="vx-sources-empty">No {tab === 'screen' ? 'screens' : 'windows'} found.</div>
                )}
                {shown.map((s) => (
                  <button
                    key={s.id}
                    role="option"
                    aria-selected={selectedId === s.id}
                    className={`vx-source ${selectedId === s.id ? 'is-selected' : ''}`}
                    onClick={() => setSelectedId(s.id)}
                    onDoubleClick={() => {
                      setSelectedId(s.id)
                      void useVoice.getState().startShare({ sourceId: s.id, presetId, withAudio: audio, hideNexo })
                    }}
                    title={s.name}
                  >
                    <span className="vx-source-thumb">
                      {s.thumbnail ? <img src={s.thumbnail} alt="" draggable={false} /> : <ScreenIcon size={28} />}
                    </span>
                    <span className="vx-source-name">
                      {s.icon && <img src={s.icon} alt="" className="vx-source-icon" draggable={false} />}
                      <span>{s.name}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          <h3 className="vx-section-title">Quality</h3>
          <div className="vx-presets" role="radiogroup" aria-label="Stream quality">
            {SHARE_PRESETS.map((p) => (
              <button
                key={p.id}
                role="radio"
                aria-checked={presetId === p.id}
                className={`vx-preset ${presetId === p.id ? 'is-selected' : ''}`}
                onClick={() => choosePreset(p.id)}
              >
                <span className="vx-preset-top">
                  <strong>{p.label}</strong>
                  <span className="vx-preset-res">
                    {p.height}p{p.fps}
                  </span>
                </span>
                <span className="vx-preset-blurb">{PRESET_BLURB[p.id]}</span>
                <span className="vx-preset-rate">up to {mbps(p.maxBitrate)} upload</span>
              </button>
            ))}
          </div>

          <label className={`vx-check ${audioSupported ? '' : 'is-disabled'}`}>
            <input
              type="checkbox"
              checked={audio}
              disabled={!audioSupported}
              onChange={(e) => toggleAudio(e.target.checked)}
            />
            <span className="vx-check-box" aria-hidden="true" />
            <span className="vx-check-text">
              <span className="vx-check-label">
                <VolumeIcon size={15} />{' '}
                {!native ? 'Share audio' : selectedKind === 'window' ? 'App audio' : 'System audio (without Nexo)'}
              </span>
              {!audioSupported ? (
                <span className="vx-check-hint">
                  {native
                    ? "This version of Windows can't capture app audio — viewers will get video only."
                    : bridge?.platform === 'linux'
                      ? "System audio capture isn't available on Linux yet — viewers will get video only."
                      : "System audio capture isn't supported on this system — viewers will get video only."}
                </span>
              ) : native && audio ? (
                <span className="vx-check-hint">
                  {selectedKind === 'window'
                    ? 'Viewers hear only this app.'
                    : 'Viewers hear everything your PC plays except Nexo, so the call stays out of the stream.'}
                </span>
              ) : audio ? (
                <span className="vx-check-hint is-warn">
                  Viewers will hear everything your default output device plays — including this call. To keep
                  voices out of the stream, pick a different speaker for Nexo in Settings → Audio &amp; video.
                </span>
              ) : (
                <span className="vx-check-hint">Stream video only.</span>
              )}
            </span>
          </label>

          {native && selectedKind === 'screen' && (
            <label className="vx-check">
              <input type="checkbox" checked={hideNexo} onChange={(e) => toggleHideNexo(e.target.checked)} />
              <span className="vx-check-box" aria-hidden="true" />
              <span className="vx-check-text">
                <span className="vx-check-label">
                  <EyeOffIcon size={15} /> Hide Nexo from the stream
                </span>
                <span className="vx-check-hint">
                  Viewers won't see your chats or the member list. While you share, Nexo is also hidden from your own
                  screenshots and recordings.
                </span>
              </span>
            </label>
          )}
        </div>

        <footer className="vx-modal-foot">
          <button className="vx-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="vx-btn vx-btn-live" onClick={goLive} disabled={!canGo}>
            {starting ? 'Starting…' : systemPicker ? 'Choose…' : 'Go Live'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
