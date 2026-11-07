// Owner: workstream D. Panel at the bottom of the sidebar while in voice:
// channel name + connection status, mute / deafen / camera / share / leave. Renders nothing when idle.
import { useEffect, useState } from 'react'
import { ConnectionQuality } from 'livekit-client'
import { useApp } from '@renderer/store/app'
import { useInputPrefs } from '../../voice/prefs'
import { getSharePreset, useMicLive, useVoice } from '../../voice/session'
import { useParticipants } from '../../voice/participants'
import { CameraButton, DeafenButton, LeaveButton, MuteButton, QualityBars, ShareButton } from './ControlButtons'
import { SharePickerHost } from './SharePicker'
import { AlertIcon, CloseIcon } from './icons'
import './voice.css'

export function VoiceControls() {
  const status = useVoice((s) => s.status)
  const error = useVoice((s) => s.error)
  const channelId = useVoice((s) => s.channelId)
  const sharePresetId = useVoice((s) => s.sharePresetId)
  const channelName = useApp((s) => s.channels.find((c) => c.id === channelId)?.name ?? 'Voice')
  const quality = useParticipants((s) => s.list.find((p) => p.isLocal)?.connectionQuality ?? ConnectionQuality.Unknown)
  const ptt = useInputPrefs((s) => s.inputMode === 'ptt')
  const pttLabel = useInputPrefs((s) => s.pttBinding?.label ?? null)
  const micLive = useMicLive()
  const shareStats = useVoice((s) => s.shareStats)
  const captureLow = useVoice((s) => s.shareCaptureLow)
  const sharing = useVoice((s) => s.sharing)
  // The starved-capture hint can be dismissed for the rest of the current share.
  const [hintDismissed, setHintDismissed] = useState(false)
  useEffect(() => {
    if (!sharing) setHintDismissed(false)
  }, [sharing])

  if (status === 'idle') return null

  if (status === 'error') {
    return (
      <section className="vx-panel is-error" aria-label="Voice status">
        <div className="vx-panel-error">
          <AlertIcon size={16} />
          <span className="vx-panel-error-text">{error ?? 'Voice disconnected'}</span>
          <button
            className="vx-icon-btn"
            onClick={() => useVoice.getState().clearError()}
            title="Dismiss"
            aria-label="Dismiss"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      </section>
    )
  }

  const statusText =
    status === 'connecting' ? 'Connecting…' : status === 'reconnecting' ? 'Reconnecting…' : 'Voice connected'
  const preset = sharePresetId ? getSharePreset(sharePresetId) : null

  return (
    <section className={`vx-panel is-${status}`} aria-label="Voice controls">
      <div className="vx-panel-head">
        <div className="vx-panel-status">
          <span className="vx-panel-state">
            {status !== 'connected' && <span className="vx-spinner" aria-hidden="true" />}
            {statusText}
            {ptt && (
              <span
                className={`vx-ptt-badge ${micLive ? 'is-live' : ''}`}
                title={pttLabel ? `Push to talk: hold ${pttLabel}` : 'Push to talk: no key set (Settings → Audio & video)'}
              >
                PTT
              </span>
            )}
          </span>
          <button
            className="vx-panel-channel"
            onClick={() => channelId && useApp.getState().selectChannel(channelId)}
            title="Open the voice stage"
          >
            {channelName}
          </button>
        </div>
        {status === 'connected' && <QualityBars quality={quality} />}
      </div>
      {preset && (
        <div className="vx-panel-live">
          <span className="vx-live-badge">LIVE</span>
          <span className="vx-grow">
            {preset.label} · {preset.height}p{preset.fps}
          </span>
          {shareStats && (
            <span
              className={`vx-panel-fps ${captureLow ? 'is-warn' : ''}`}
              title={`Capturing ${shareStats.captureFps} fps, sending ${shareStats.sendFps} fps${
                shareStats.width ? ` at ${shareStats.width}×${shareStats.height}` : ''
              }${shareStats.encoder ? ` (${shareStats.encoder})` : ''}${
                shareStats.limitation !== 'none' ? `, limited by ${shareStats.limitation}` : ''
              }`}
            >
              {captureLow && <AlertIcon size={12} />}
              {shareStats.captureFps} fps
            </span>
          )}
        </div>
      )}
      {preset && captureLow && !hintDismissed && shareStats && (
        <div className="vx-panel-hint" role="status">
          <span>
            Only {shareStats.captureFps} of {preset.fps} fps are being captured. Streaming a game? Cap its frame rate
            (V-Sync or a max FPS setting). An uncapped game leaves Windows no GPU time to capture it.
          </span>
          <button className="vx-icon-btn" onClick={() => setHintDismissed(true)} title="Dismiss" aria-label="Dismiss">
            <CloseIcon size={12} />
          </button>
        </div>
      )}
      <div className="vx-panel-buttons">
        <MuteButton />
        <DeafenButton />
        <CameraButton />
        <ShareButton />
        <LeaveButton />
      </div>
      <SharePickerHost />
    </section>
  )
}
