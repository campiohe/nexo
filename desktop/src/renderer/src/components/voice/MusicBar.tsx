// Music plugin UI on the voice stage and around it: the now-playing bar (artwork, title, shared progress that
// can be dragged to seek, transport, volume + ducking, queue), the "Play music" pill when nothing plays, the
// toolbar button, the line in the sidebar voice panel and the "♪ Title — Artist" line under voice channels.
// Playback: voice/musicPlayer.ts; requests and the panel's state: voice/musicActions.ts; panel: MusicPanel.tsx.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { MusicState, MusicTrack, User } from '@shared/protocol'
import { useApp } from '../../store/app'
import { useMusic } from '../../store/music'
import { usePlugins } from '../../store/plugins'
import { anchorOf } from '../../store/ui'
import { useVoice } from '../../voice/session'
import { serverNow } from '../../voice/musicClock'
import { expectedPositionMs, formatDuration, isMusicPlaying } from '../../voice/musicSync'
import { musicControl, toggleMusicPanel, useMusicPanel, type MusicTab } from '../../voice/musicActions'
import { resumeMusic, retryMusic, useMusicPlayer } from '../../voice/musicPlayer'
import { saveMusicPrefs, useMusicPrefs } from '../../voice/musicPrefs'
import { PlayIcon, VolumeIcon, VolumeOffIcon, AlertIcon } from './icons'
import { DuckIcon, MusicIcon, PauseIcon, QueueIcon, SkipNextIcon, SkipPrevIcon } from './musicIcons'
import { tKnown, useT, type Translate } from '../../i18n'
import '../../styles/music.css'

/** Width of the music panel (music.css .mu-panel), used to center it over the button that opens it. */
export const MUSIC_PANEL_W = 440

function openPanel(channelId: string, el: Element, from: string, tab?: MusicTab): void {
  const r = anchorOf(el)
  const mid = (r.left + r.right) / 2
  toggleMusicPanel(channelId, { ...r, left: mid - MUSIC_PANEL_W / 2, right: mid + MUSIC_PANEL_W / 2 }, from, tab)
}

/** In `channelId` on this device (connected / reconnecting): allowed to control its music. */
export function useInMusicChannel(channelId: string | null): boolean {
  return useVoice(
    (s) => !!channelId && s.channelId === channelId && (s.status === 'connected' || s.status === 'reconnecting'),
  )
}

/** Who added a track, for "added by {name}". */
export function addedByName(users: Record<string, User>, userId: string, meId: string | undefined, t: Translate): string {
  if (userId === meId) return t('you // added by')
  return users[userId]?.name ?? t('someone // added by')
}

/** The shared position of the current track, re-rendering a few times a second while it plays. */
function useSharedPosition(state: MusicState | undefined): number {
  const playing = isMusicPlaying(state)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!playing) return
    const t = window.setInterval(() => tick((n) => n + 1), 250)
    return () => window.clearInterval(t)
  }, [playing])
  return expectedPositionMs(state, serverNow()) ?? 0
}

export function Artwork({ src, size, className }: { src: string | null; size: number; className?: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  return (
    <span className={`mu-art ${className ?? ''}`} style={{ width: size, height: size }}>
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <MusicIcon size={Math.round(size * 0.45)} />
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------
// Stage: bar / pill

export function MusicBar({ channelId }: { channelId: string }) {
  const on = usePlugins((s) => s.plugins.music)
  const state = useMusic((s) => s.byChannel[channelId])
  // Nothing playing: no bar. Music is started from the toolbar's music button (and the sidebar's voice panel).
  if (!on || !state?.current) return null
  return <NowPlaying channelId={channelId} state={state} track={state.current} />
}

function NowPlaying({ channelId, state, track }: { channelId: string; state: MusicState; track: MusicTrack }) {
  const t = useT()
  const users = useApp((s) => s.users)
  const meId = useApp((s) => s.me?.id)
  const canAct = useInMusicChannel(channelId)
  const playing = isMusicPlaying(state)
  const notice = useMusicPlayer((s) => (s.notice?.key === track.queueId ? s.notice.text : null))
  const blocked = useMusicPlayer((s) => s.blocked)
  const buffering = useMusicPlayer((s) => s.buffering)
  const enabled = useMusicPrefs((s) => s.musicEnabled)
  const panelOpen = useMusicPanel((s) => s.open?.from === 'stage-queue')

  const togglePlay = () => void musicControl(channelId, playing ? 'pause' : 'play')
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== ' ' || e.repeat || !canAct) return
    // Buttons and inputs keep Space for themselves.
    const target = e.target as HTMLElement
    if (target !== e.currentTarget && target.closest('button, input, textarea, select')) return
    e.preventDefault()
    togglePlay()
  }

  return (
    <section className="mu-bar" tabIndex={0} aria-label={t('Music: {title}', { title: track.title })} onKeyDown={onKeyDown}>
      <div className="mu-bar-main">
        <Artwork src={track.artwork} size={48} />
        <div className="mu-meta">
          <span className="mu-title" title={track.title}>
            {track.title}
          </span>
          <span className="mu-sub">
            <span className="mu-sub-artist" title={track.artist}>
              {track.artist || t('Unknown artist')}
            </span>
            <span className="mu-sub-added"> · {t('added by {name}', { name: addedByName(users, track.addedBy, meId, t) })}</span>
          </span>
        </div>
        <div className="mu-transport">
          <button
            className="mu-btn"
            onClick={() => void musicControl(channelId, 'previous')}
            disabled={!canAct}
            title={t('Previous (restarts the song after its first 3 seconds)')}
            aria-label={t('Previous')}
          >
            <SkipPrevIcon size={16} />
          </button>
          <button
            className={`mu-btn mu-btn-play ${buffering && playing && enabled ? 'is-buffering' : ''}`}
            onClick={togglePlay}
            disabled={!canAct}
            title={playing ? t('Pause for everyone (Space)') : t('Play for everyone (Space)')}
            aria-label={playing ? t('Pause') : t('Play')}
          >
            {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
          </button>
          <button
            className="mu-btn"
            onClick={() => void musicControl(channelId, 'skip')}
            disabled={!canAct}
            title={state.queue.length ? t('Skip to “{title}”', { title: state.queue[0]!.title }) : t('Skip (nothing queued: stops)')}
            aria-label={t('Skip')}
          >
            <SkipNextIcon size={16} />
          </button>
        </div>
        <div className="mu-side">
          <MusicVolume />
          <button
            className={`mu-btn mu-btn-queue ${panelOpen ? 'is-on' : ''}`}
            onClick={(e) => openPanel(channelId, e.currentTarget, 'stage-queue', 'queue')}
            title={t('Queue and search')}
            aria-label={t('Queue ({count})', { count: state.queue.length })}
            aria-haspopup="dialog"
            aria-expanded={panelOpen}
          >
            <QueueIcon size={16} />
            {state.queue.length > 0 && <span className="mu-badge">{state.queue.length}</span>}
          </button>
        </div>
      </div>
      <Seekbar
        state={state}
        durationMs={track.durationMs}
        disabled={!canAct}
        rev={state.rev}
        onSeek={(ms) => void musicControl(channelId, 'seek', { positionMs: Math.round(ms) })}
      />
      {!enabled ? (
        <div className="mu-note">
          <VolumeOffIcon size={14} />
          <span>{t("Music doesn't play on this device.")}</span>
          <button className="mu-link" onClick={() => saveMusicPrefs({ musicEnabled: true })}>
            {t('Play it here')}
          </button>
        </div>
      ) : notice ? (
        <div className="mu-note is-error" role="status">
          <AlertIcon size={14} />
          <span>{t("Can't play this here: {reason}", { reason: tKnown(notice) })}</span>
          <button className="mu-link" onClick={retryMusic}>
            {t('Retry')}
          </button>
        </div>
      ) : blocked ? (
        <button className="mu-note is-action" onClick={resumeMusic}>
          <PlayIcon size={12} /> {t('Click to start music')}
        </button>
      ) : null}
    </section>
  )
}

/** Shared progress; click or drag to seek (one `seek` on release), arrows ±5 s. */
function Seekbar(props: { state: MusicState; durationMs: number; disabled: boolean; rev: number; onSeek(ms: number): void }) {
  const { state, durationMs, disabled, rev, onSeek } = props
  const t = useT()
  // Ticks here only, not in the whole bar.
  const positionMs = useSharedPosition(state)
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  // After a release, show where it was dropped until the server's new state arrives (or a moment passes).
  const [pending, setPending] = useState<{ ms: number; rev: number } | null>(null)
  useEffect(() => {
    if (!pending) return
    if (rev !== pending.rev) return setPending(null)
    const timer = window.setTimeout(() => setPending(null), 1500)
    return () => window.clearTimeout(timer)
  }, [pending, rev])

  const shown = drag ?? (pending && pending.rev === rev ? pending.ms : positionMs)
  const dur = Math.max(1, durationMs)
  const pct = Math.min(100, Math.max(0, (shown / dur) * 100))

  const msAt = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r || r.width === 0) return 0
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * dur
  }
  const commit = (ms: number) => {
    setPending({ ms, rev })
    onSeek(ms)
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag(msAt(e.clientX))
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag !== null) setDrag(msAt(e.clientX))
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag === null) return
    const ms = msAt(e.clientX)
    setDrag(null)
    commit(ms)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const step = e.key === 'ArrowRight' ? 5000 : e.key === 'ArrowLeft' ? -5000 : null
    if (step !== null) {
      e.preventDefault()
      // One seek per press: holding the key would hit the server's rate limit.
      if (e.repeat) return
      commit(Math.min(dur, Math.max(0, shown + step)))
    } else if (e.key === 'Home') {
      e.preventDefault()
      commit(0)
    }
  }

  return (
    <div className="mu-progress">
      <span className="mu-time">{formatDuration(shown)}</span>
      <div
        ref={ref}
        className={`mu-seek ${disabled ? 'is-disabled' : ''} ${drag !== null ? 'is-dragging' : ''}`}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={t('Position')}
        aria-valuemin={0}
        aria-valuemax={Math.round(dur / 1000)}
        aria-valuenow={Math.round(shown / 1000)}
        aria-valuetext={t('{position} of {duration}', { position: formatDuration(shown), duration: formatDuration(dur) })}
        aria-disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={onKeyDown}
      >
        <span className="mu-seek-track">
          <span className="mu-seek-fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="mu-seek-thumb" style={{ left: `${pct}%` }} />
      </div>
      <span className="mu-time">{formatDuration(durationMs)}</span>
    </div>
  )
}

/** Remembered level for the mute button (per session). */
let lastAudibleVolume = 0.5

/** This device's music volume + the ducking toggle (also in Settings → Audio & video). */
export function MusicVolume() {
  const t = useT()
  const volume = useMusicPrefs((s) => s.musicVolume)
  const duck = useMusicPrefs((s) => s.musicDuck)
  const deafened = useVoice((s) => s.deafened)
  const pct = Math.round(volume * 100)
  if (volume > 0) lastAudibleVolume = volume
  return (
    <div className="mu-volume">
      <button
        className="mu-btn"
        onClick={() => saveMusicPrefs({ musicVolume: volume > 0 ? 0 : lastAudibleVolume || 0.5 })}
        title={deafened ? t("You're deafened") : volume > 0 ? t('Mute music (only for you)') : t('Unmute music')}
        aria-label={volume > 0 ? t('Mute music') : t('Unmute music')}
      >
        {volume === 0 || deafened ? <VolumeOffIcon size={16} /> : <VolumeIcon size={16} />}
      </button>
      <input
        type="range"
        className="mu-range"
        min={0}
        max={100}
        step={1}
        value={pct}
        onChange={(e) => saveMusicPrefs({ musicVolume: Number(e.target.value) / 100 })}
        aria-label={t('Music volume (only for you)')}
        title={t('Music volume {pct}% (only for you)', { pct })}
        style={{ ['--fill' as string]: `${pct}%` }}
      />
      <button
        className={`mu-btn ${duck ? 'is-on' : ''}`}
        onClick={() => saveMusicPrefs({ musicDuck: !duck })}
        aria-pressed={duck}
        title={duck ? t('Lowering music while people talk (click to turn off)') : t('Lower music while people talk')}
        aria-label={t('Lower music while people talk')}
      >
        <DuckIcon size={16} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Toolbar button, sidebar voice panel line, voice channel line

/** Stage toolbar: opens the music panel of the channel you're in. Hidden when the plugin is off. */
export function MusicButton({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  const t = useT()
  const on = usePlugins((s) => s.plugins.music)
  const channelId = useVoice((s) => s.channelId)
  const from = `toolbar-${size}`
  const open = useMusicPanel((s) => s.open?.from === from)
  if (!on || !channelId) return null
  return (
    <button
      className={`vx-ctl vx-ctl-${size} ${open ? 'is-on' : ''}`}
      onClick={(e) => openPanel(channelId, e.currentTarget, from)}
      title={t('Music')}
      aria-label={t('Music')}
      aria-haspopup="dialog"
      aria-expanded={open}
    >
      <MusicIcon size={size === 'lg' ? 20 : 18} />
    </button>
  )
}

/** Sidebar voice panel: what's playing in your channel (opens the panel), or a "Play music" link. */
export function VoicePanelMusic() {
  const t = useT()
  const on = usePlugins((s) => s.plugins.music)
  const channelId = useVoice((s) => s.channelId)
  const state = useMusic((s) => (channelId ? s.byChannel[channelId] : undefined))
  if (!on || !channelId) return null
  const cur = state?.current
  const playing = isMusicPlaying(state)
  return (
    <div className="mu-panel-line">
      <button
        className={`mu-panel-line-btn ${cur ? '' : 'is-idle'}`}
        onClick={(e) => openPanel(channelId, e.currentTarget, 'voice-panel', cur ? 'queue' : 'search')}
        title={
          cur
            ? playing
              ? `${cur.title} — ${cur.artist}`
              : t('{song} (paused)', { song: `${cur.title} — ${cur.artist}` })
            : t('Play music in this channel')
        }
      >
        <MusicIcon size={13} />
        <span className="mu-panel-line-text">{cur ? `${cur.title}${cur.artist ? ` — ${cur.artist}` : ''}` : t('Play music')}</span>
      </button>
      {cur && (
        <button
          className="vx-icon-btn mu-panel-line-play"
          onClick={() => void musicControl(channelId, playing ? 'pause' : 'play')}
          title={playing ? t('Pause for everyone') : t('Play for everyone')}
          aria-label={playing ? t('Pause music') : t('Play music')}
        >
          {playing ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
        </button>
      )}
    </div>
  )
}

/** Under a voice channel in the sidebar (visible to everyone): "♪ Title — Artist" while it has a song. */
export function ChannelMusicLine({ channelId }: { channelId: string }) {
  const t = useT()
  const on = usePlugins((s) => s.plugins.music)
  const cur = useMusic((s) => s.byChannel[channelId]?.current ?? null)
  const playing = useMusic((s) => isMusicPlaying(s.byChannel[channelId]))
  if (!on || !cur) return null
  const label = `${cur.title}${cur.artist ? ` — ${cur.artist}` : ''}`
  return (
    <div className={`mu-channel-line ${playing ? 'is-playing' : 'is-paused'}`} title={playing ? label : t('{song} (paused)', { song: label })}>
      <span className="mu-eq" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="mu-channel-line-text">
        <span className="sr-only">{playing ? t('Playing:') : t('Paused:')} </span>
        {label}
      </span>
    </div>
  )
}
