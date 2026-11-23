// Owner: workstream D. Panel at the bottom of the sidebar while in voice:
// channel name + connection status, mute / deafen / camera / share / leave. Renders nothing when idle.
import { useEffect, useState } from 'react'
import { ConnectionQuality } from 'livekit-client'
import { useApp } from '@renderer/store/app'
import { useT, type Translate } from '../../i18n'
import { useInputPrefs } from '../../voice/prefs'
import { getSharePreset, useMicLive, useVoice, type ShareStats } from '../../voice/session'
import { useParticipants } from '../../voice/participants'
import { CameraButton, DeafenButton, LeaveButton, MuteButton, QualityBars, ShareButton } from './ControlButtons'
import { SharePickerHost } from './SharePicker'
import { SoundboardButton } from './Soundboard'
import { VoicePanelMusic } from './MusicBar'
import { AlertIcon, CloseIcon } from './icons'
import './voice.css'

/** Tooltip of the panel's fps readout: what's captured and sent, and what limits it. */
function captureTitle(t: Translate, stats: ShareStats): string {
  // Sizes as strings: a resolution is not formatted as a number ("1920", not "1.920").
  const values = { capture: stats.captureFps, send: stats.sendFps, width: String(stats.width), height: String(stats.height) }
  let line = stats.width
    ? t('Capturing {capture} fps, sending {send} fps at {width}×{height}', values)
    : t('Capturing {capture} fps, sending {send} fps', values)
  if (stats.encoder) line += ` (${stats.encoder})`
  if (stats.limitation !== 'none') {
    line = t('{details}, limited by {limitation, select, cpu {the CPU} bandwidth {bandwidth} other {{limitation}}}', {
      details: line,
      limitation: stats.limitation,
    })
  }
  return stats.idle
    ? t("Your screen isn't changing, so there are no new frames to capture. Viewers see changes as soon as they happen. {details}", {
        details: line,
      })
    : line
}

export function VoiceControls() {
  const t = useT()
  const status = useVoice((s) => s.status)
  const error = useVoice((s) => s.error)
  const channelId = useVoice((s) => s.channelId)
  const sharePresetId = useVoice((s) => s.sharePresetId)
  const channelName = useApp((s) => s.channels.find((c) => c.id === channelId)?.name) ?? t('Voice')
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
      <section className="vx-panel is-error" aria-label={t('Voice status')}>
        <div className="vx-panel-error">
          <AlertIcon size={16} />
          <span className="vx-panel-error-text">{error ?? t('Voice disconnected')}</span>
          <button
            className="vx-icon-btn"
            onClick={() => useVoice.getState().clearError()}
            title={t('Dismiss')}
            aria-label={t('Dismiss')}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      </section>
    )
  }

  const statusText =
    status === 'connecting' ? t('Connecting…') : status === 'reconnecting' ? t('Reconnecting…') : t('Voice connected')
  const preset = sharePresetId ? getSharePreset(sharePresetId) : null

  return (
    <section className={`vx-panel is-${status}`} aria-label={t('Voice controls')}>
      <div className="vx-panel-head">
        <div className="vx-panel-status">
          <span className="vx-panel-state">
            {status !== 'connected' && <span className="vx-spinner" aria-hidden="true" />}
            {statusText}
            {ptt && (
              <span
                className={`vx-ptt-badge ${micLive ? 'is-live' : ''}`}
                title={
                  pttLabel
                    ? t('Push to talk: hold {key}', { key: pttLabel })
                    : t('Push to talk: no key set (Settings → Audio & video)')
                }
              >
                PTT
              </span>
            )}
          </span>
          <button
            className="vx-panel-channel"
            onClick={() => channelId && useApp.getState().selectChannel(channelId)}
            title={t('Open the voice stage')}
          >
            {channelName}
          </button>
        </div>
        {status === 'connected' && <QualityBars quality={quality} />}
      </div>
      {preset && (
        <div className="vx-panel-live">
          <span className="vx-live-badge">{t('LIVE')}</span>
          <span className="vx-grow">
            {t(preset.label)} · {preset.height}p{preset.fps}
          </span>
          {shareStats && (
            <span
              className={`vx-panel-fps ${captureLow ? 'is-warn' : ''}`}
              title={captureTitle(t, shareStats)}
            >
              {captureLow && <AlertIcon size={12} />}
              {shareStats.idle ? t('idle') : `${shareStats.captureFps} fps`}
            </span>
          )}
        </div>
      )}
      {preset && captureLow && !hintDismissed && shareStats && (
        <div className="vx-panel-hint" role="status">
          <span>
            {t(
              "Only {capture} of {fps} fps are being captured. Streaming a game? Your GPU is likely maxed out, which leaves Windows no time to capture it. Lower the game's graphics or turn on upscaling, then cap its FPS a bit below what it reaches, so GPU usage stays under about 85%.",
              { capture: shareStats.captureFps, fps: preset.fps },
            )}
          </span>
          <button className="vx-icon-btn" onClick={() => setHintDismissed(true)} title={t('Dismiss')} aria-label={t('Dismiss')}>
            <CloseIcon size={12} />
          </button>
        </div>
      )}
      <VoicePanelMusic />
      <div className="vx-panel-buttons">
        <MuteButton />
        <DeafenButton />
        <CameraButton />
        <ShareButton />
        <SoundboardButton />
        <LeaveButton />
      </div>
      <SharePickerHost />
    </section>
  )
}
