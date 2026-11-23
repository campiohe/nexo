// Owner: workstream D. Voice control buttons shared by the sidebar panel and the stage toolbar.
import { ConnectionQuality } from 'livekit-client'
import { msg, useT } from '../../i18n'
import { useInputPrefs } from '../../voice/prefs'
import { useMicLive, useVoice } from '../../voice/session'
import {
  CameraIcon,
  CameraOffIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  ScreenShareIcon,
  ScreenStopIcon,
} from './icons'

type Size = 'sm' | 'lg'

interface CtlProps {
  size?: Size
}

const iconSize = (size: Size) => (size === 'lg' ? 20 : 18)

export function MuteButton({ size = 'sm' }: CtlProps) {
  const t = useT()
  const muted = useVoice((s) => s.muted)
  const deafened = useVoice((s) => s.deafened)
  const ptt = useInputPrefs((s) => s.inputMode === 'ptt')
  const pttLabel = useInputPrefs((s) => s.pttBinding?.label ?? null)
  const live = useMicLive()
  const label = muted ? t('Unmute') : t('Mute')
  const title = deafened
    ? t('Unmute (also undeafens)')
    : ptt && !muted
      ? pttLabel
        ? t('Mute · push to talk ({key})', { key: pttLabel })
        : t('Mute · push to talk: no key set')
      : label
  return (
    <button
      className={`vx-ctl vx-ctl-${size} ${muted ? 'is-danger' : ''} ${ptt && live ? 'is-transmitting' : ''}`}
      onClick={() => useVoice.getState().toggleMute()}
      title={title}
      aria-label={label}
      aria-pressed={muted}
    >
      {muted ? <MicOffIcon size={iconSize(size)} /> : <MicIcon size={iconSize(size)} />}
    </button>
  )
}

export function DeafenButton({ size = 'sm' }: CtlProps) {
  const t = useT()
  const deafened = useVoice((s) => s.deafened)
  const label = deafened ? t('Undeafen') : t('Deafen')
  return (
    <button
      className={`vx-ctl vx-ctl-${size} ${deafened ? 'is-danger' : ''}`}
      onClick={() => useVoice.getState().toggleDeafen()}
      title={label}
      aria-label={label}
      aria-pressed={deafened}
    >
      {deafened ? <HeadphonesOffIcon size={iconSize(size)} /> : <HeadphonesIcon size={iconSize(size)} />}
    </button>
  )
}

export function CameraButton({ size = 'sm' }: CtlProps) {
  const t = useT()
  const camera = useVoice((s) => s.camera)
  const disabled = useVoice((s) => s.status !== 'connected' && s.status !== 'reconnecting')
  const label = camera ? t('Turn off camera') : t('Turn on camera')
  return (
    <button
      className={`vx-ctl vx-ctl-${size} ${camera ? 'is-on' : ''}`}
      onClick={() => void useVoice.getState().toggleCamera()}
      title={label}
      aria-label={label}
      aria-pressed={camera}
      disabled={disabled}
    >
      {camera ? <CameraIcon size={iconSize(size)} /> : <CameraOffIcon size={iconSize(size)} />}
    </button>
  )
}

export function ShareButton({ size = 'sm' }: CtlProps) {
  const t = useT()
  const sharing = useVoice((s) => s.sharing)
  const starting = useVoice((s) => s.shareStarting)
  const disabled = useVoice((s) => s.status !== 'connected' && s.status !== 'reconnecting')
  if (sharing) {
    return (
      <button
        className={`vx-ctl vx-ctl-${size} is-live`}
        onClick={() => void useVoice.getState().stopShare()}
        title={t('Stop sharing')}
        aria-label={t('Stop sharing')}
      >
        <ScreenStopIcon size={iconSize(size)} />
      </button>
    )
  }
  return (
    <button
      className={`vx-ctl vx-ctl-${size} ${starting ? 'is-busy' : ''}`}
      onClick={() => useVoice.getState().openSharePicker()}
      title={starting ? t('Starting stream…') : t('Share your screen')}
      aria-label={t('Share your screen')}
      disabled={disabled || starting}
    >
      <ScreenShareIcon size={iconSize(size)} />
    </button>
  )
}

export function LeaveButton({ size = 'sm' }: CtlProps) {
  const t = useT()
  return (
    <button
      className={`vx-ctl vx-ctl-${size} vx-ctl-leave`}
      onClick={() => void useVoice.getState().leave()}
      title={t('Leave voice')}
      aria-label={t('Leave voice')}
    >
      <PhoneOffIcon size={iconSize(size)} />
    </button>
  )
}

const QUALITY_LEVEL: Record<ConnectionQuality, number> = {
  [ConnectionQuality.Excellent]: 3,
  [ConnectionQuality.Good]: 2,
  [ConnectionQuality.Poor]: 1,
  [ConnectionQuality.Lost]: 0,
  [ConnectionQuality.Unknown]: -1,
}

// Message keys (msg): translated where shown.
const QUALITY_LABEL: Record<ConnectionQuality, string> = {
  [ConnectionQuality.Excellent]: msg('Excellent connection'),
  [ConnectionQuality.Good]: msg('Good connection'),
  [ConnectionQuality.Poor]: msg('Poor connection'),
  [ConnectionQuality.Lost]: msg('Connection lost'),
  [ConnectionQuality.Unknown]: msg('Measuring connection…'),
}

export function QualityBars({ quality }: { quality: ConnectionQuality }) {
  const t = useT()
  const level = QUALITY_LEVEL[quality]
  const tone = level >= 3 ? 'good' : level === 2 ? 'ok' : level >= 0 ? 'bad' : 'unknown'
  return (
    <span className={`vx-bars is-${tone}`} title={t(QUALITY_LABEL[quality])} role="img" aria-label={t(QUALITY_LABEL[quality])}>
      {[1, 2, 3].map((n) => (
        <span key={n} className={`vx-bar ${level >= n ? 'is-lit' : ''}`} style={{ height: 3 + n * 3 }} />
      ))}
    </span>
  )
}
