// Owner: workstream D. Center pane for a voice channel: participant + stream tiles.
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { ConnectionQuality } from 'livekit-client'
import type { User } from '@shared/protocol'
import { useApp } from '@renderer/store/app'
import { Avatar } from '@renderer/components/Avatar'
import {
  getSharePreset,
  resumeAudio,
  setStreamVolume,
  stopWatching,
  useUserVolume,
  useVoice,
  watchStream,
} from '../../voice/session'
import { useParticipants, type ParticipantView } from '../../voice/participants'
import { useNativeShare } from '../../voice/nativeShare'
import { CameraButton, DeafenButton, LeaveButton, MuteButton, ShareButton } from './ControlButtons'
import { SharePickerHost } from './SharePicker'
import { VideoTrackView, useVideoStats } from './VideoTrackView'
import { UserVolumePopover } from './UserVolumePopover'
import {
  AlertIcon,
  CollapseIcon,
  ExpandIcon,
  EyeIcon,
  EyeOffIcon,
  FullscreenIcon,
  HeadphonesOffIcon,
  MicOffIcon,
  VolumeIcon,
  VolumeOffIcon,
} from './icons'
import './voice.css'

export function VoiceStage({ channelId }: { channelId: string }) {
  const inThisChannel = useVoice(
    (s) => s.channelId === channelId && (s.status === 'connecting' || s.status === 'connected' || s.status === 'reconnecting'),
  )
  return inThisChannel ? <Stage /> : <JoinCard channelId={channelId} />
}

// ---------------------------------------------------------------------------------------------
// Not connected: join card
// ---------------------------------------------------------------------------------------------

function JoinCard({ channelId }: { channelId: string }) {
  const channelName = useApp((s) => s.channels.find((c) => c.id === channelId)?.name ?? 'Voice')
  const voice = useApp((s) => s.voice)
  const users = useApp((s) => s.users)
  const otherChannelId = useVoice((s) => (s.status !== 'idle' && s.status !== 'error' ? s.channelId : null))
  const otherName = useApp((s) => s.channels.find((c) => c.id === otherChannelId)?.name)
  const status = useVoice((s) => s.status)
  const error = useVoice((s) => s.error)
  const members = voice.filter((v) => v.channelId === channelId)

  return (
    <div className="vx-stage vx-stage-idle">
      <div className="vx-join">
        <div className="vx-join-avatars">
          {members.length === 0 ? (
            <span className="vx-join-empty-ring" aria-hidden="true" />
          ) : (
            members.slice(0, 6).map((m) => <Avatar key={m.userId} user={users[m.userId]} size={52} />)
          )}
          {members.length > 6 && <span className="vx-join-more">+{members.length - 6}</span>}
        </div>
        <h2 className="vx-join-title">{channelName}</h2>
        <p className="vx-join-sub">
          {members.length === 0
            ? 'Nobody is here yet. Hop in and others will see you in the sidebar.'
            : members
                .map((m) => users[m.userId]?.name ?? 'Someone')
                .slice(0, 4)
                .join(', ') + (members.length > 4 ? ` and ${members.length - 4} more` : '') + (members.length === 1 ? ' is here' : ' are here')}
        </p>
        {members.some((m) => m.streaming) && (
          <p className="vx-join-live">
            <span className="vx-live-badge">LIVE</span>
            {members
              .filter((m) => m.streaming)
              .map((m) => users[m.userId]?.name ?? 'Someone')
              .join(', ')}{' '}
            streaming
          </p>
        )}
        <button className="vx-btn vx-btn-primary vx-btn-lg" onClick={() => void useVoice.getState().join(channelId)}>
          {otherChannelId ? `Switch to ${channelName}` : `Join ${channelName}`}
        </button>
        {otherChannelId && otherName && <p className="vx-join-note">You'll leave {otherName}.</p>}
        {status === 'error' && error && (
          <p className="vx-join-error">
            <AlertIcon size={15} /> {error}
          </p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Connected: stage
// ---------------------------------------------------------------------------------------------

type TileSpec =
  | { key: string; kind: 'stream'; view: ParticipantView }
  | { key: string; kind: 'user'; view: ParticipantView }

function Stage() {
  const status = useVoice((s) => s.status)
  const audioBlocked = useVoice((s) => s.audioBlocked)
  const deafened = useVoice((s) => s.deafened)
  const list = useParticipants((s) => s.list)
  const watching = useParticipants((s) => s.watching)
  const volumes = useParticipants((s) => s.streamVolumes)
  // Our own native stream is published by the helper's `#stream` participant, which we never subscribe
  // to: its tile is the "You're live" card, driven by the share state instead of the room.
  const selfNative = useVoice((s) => s.sharing && s.shareEngine === 'native')
  const users = useApp((s) => s.users)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [volumeMenu, setVolumeMenu] = useState<{ userId: string; x: number; y: number } | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const openVolumeMenu = useCallback((userId: string, x: number, y: number) => setVolumeMenu({ userId, x, y }), [])
  const closeVolumeMenu = useCallback(() => setVolumeMenu(null), [])

  const tiles: TileSpec[] = [
    ...list
      .filter((p) => p.isStreaming || (p.isLocal && selfNative))
      .map((p) => ({ key: `stream:${p.identity}`, kind: 'stream' as const, view: p })),
    ...list.map((p) => ({ key: `user:${p.identity}`, kind: 'user' as const, view: p })),
  ]
  const focused = focusKey ? tiles.find((t) => t.key === focusKey) ?? null : null

  useEffect(() => {
    if (focusKey && !focused) setFocusKey(null)
  }, [focusKey, focused])

  // When you start watching someone, open their stream large right away.
  const prevWatching = useRef(watching)
  useEffect(() => {
    const started = Object.keys(watching).find((id) => !prevWatching.current[id])
    prevWatching.current = watching
    if (started) setFocusKey(`stream:${started}`)
  }, [watching])

  const layout = useGridLayout(gridRef, focused ? 0 : tiles.length)

  const renderTile = (t: TileSpec, mode: 'grid' | 'focus' | 'strip') => {
    const user = users[t.view.identity]
    const isFocused = focusKey === t.key
    const toggleFocus = () => setFocusKey(isFocused ? null : t.key)
    if (t.kind === 'stream' && t.view.isLocal && selfNative) {
      return <LiveCard key={t.key} view={t.view} user={user} mode={mode} />
    }
    if (t.kind === 'stream') {
      return (
        <StreamTile
          key={t.key}
          view={t.view}
          user={user}
          watching={!!watching[t.view.identity]}
          volume={volumes[t.view.identity] ?? 1}
          deafened={deafened}
          mode={mode}
          focused={isFocused}
          onToggleFocus={toggleFocus}
        />
      )
    }
    return (
      <UserTile
        key={t.key}
        view={t.view}
        user={user}
        mode={mode}
        focused={isFocused}
        onToggleFocus={toggleFocus}
        onVolumeMenu={t.view.isLocal ? undefined : openVolumeMenu}
      />
    )
  }

  return (
    <div className="vx-stage">
      {status === 'connecting' && (
        <div className="vx-stage-banner">
          <span className="vx-spinner" /> Connecting to voice…
        </div>
      )}
      {status === 'reconnecting' && (
        <div className="vx-stage-banner is-warn">
          <span className="vx-spinner" /> Connection interrupted — reconnecting…
        </div>
      )}
      {audioBlocked && (
        <button className="vx-stage-banner is-action" onClick={() => void resumeAudio()}>
          <VolumeIcon size={16} /> Audio is paused by the system. Click to enable sound.
        </button>
      )}

      {focused ? (
        <div className="vx-focus">
          <div className="vx-focus-main">{renderTile(focused, 'focus')}</div>
          <div className="vx-strip" role="list">
            {tiles.filter((t) => t.key !== focused.key).map((t) => renderTile(t, 'strip'))}
          </div>
        </div>
      ) : (
        <div className="vx-grid-wrap" ref={gridRef}>
          <div
            className="vx-grid"
            style={{ gridTemplateColumns: `repeat(${layout.cols}, ${layout.width}px)`, gridAutoRows: `${layout.height}px` }}
          >
            {tiles.map((t) => renderTile(t, 'grid'))}
          </div>
        </div>
      )}

      <div className="vx-toolbar" role="toolbar" aria-label="Voice controls">
        <MuteButton size="lg" />
        <DeafenButton size="lg" />
        <CameraButton size="lg" />
        <ShareButton size="lg" />
        <span className="vx-toolbar-sep" />
        <LeaveButton size="lg" />
      </div>
      <SharePickerHost />
      {volumeMenu && (
        <UserVolumePopover
          key={`${volumeMenu.userId}:${volumeMenu.x}:${volumeMenu.y}`}
          userId={volumeMenu.userId}
          anchor={{ x: volumeMenu.x, y: volumeMenu.y }}
          onClose={closeVolumeMenu}
        />
      )}
    </div>
  )
}

/** Pick the column count that maximizes 16:9 tile size inside the container. */
function useGridLayout(ref: RefObject<HTMLDivElement | null>, count: number) {
  const [size, setSize] = useState({ w: 800, h: 450 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, count === 0])

  const gap = 12
  const n = Math.max(1, count)
  let best = { cols: 1, width: 160, height: 90 }
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const maxW = (size.w - gap * (cols - 1)) / cols
    const maxH = (size.h - gap * (rows - 1)) / rows
    const width = Math.floor(Math.min(maxW, (maxH * 16) / 9))
    if (width > best.width || cols === 1) best = { cols, width: Math.max(width, 120), height: Math.floor((Math.max(width, 120) * 9) / 16) }
  }
  return best
}

// ---------------------------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------------------------

function colorOf(view: ParticipantView, user: User | undefined): string {
  return view.color ?? user?.color ?? '#3a4152'
}

function nameOf(view: ParticipantView, user: User | undefined): string {
  return user?.name ?? view.name
}

/** The full User when known (so profile pictures show), else name + color from the token. */
function avatarUser(view: ParticipantView, user: User | undefined) {
  return user ?? { id: view.identity, name: view.name, color: colorOf(view, undefined) }
}

function toggleFullscreen(el: HTMLElement | null) {
  if (!el) return
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  else void el.requestFullscreen().catch(() => {})
}

function stop(e: MouseEvent) {
  e.stopPropagation()
}

interface TileShellProps {
  className: string
  mode: 'grid' | 'focus' | 'strip'
  focusable: boolean
  focused: boolean
  onToggleFocus(): void
  onContextMenu?(e: MouseEvent): void
  label: string
  children: ReactNode
}

function TileShell({ className, mode, focusable, focused, onToggleFocus, onContextMenu, label, children }: TileShellProps) {
  const ref = useRef<HTMLDivElement>(null)
  const clickTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(clickTimer.current), [])
  // Single click focuses, double click goes fullscreen: delay the click so a double click
  // doesn't first toggle focus twice (which would remount the tile under the cursor).
  const onClick = () => {
    window.clearTimeout(clickTimer.current)
    clickTimer.current = window.setTimeout(onToggleFocus, 220)
  }
  const onDoubleClick = () => {
    window.clearTimeout(clickTimer.current)
    toggleFullscreen(ref.current)
  }
  return (
    <div
      ref={ref}
      role="listitem"
      aria-label={label}
      className={`vx-tile is-${mode} ${className} ${focusable ? 'is-focusable' : ''} ${focused ? 'is-focused' : ''}`}
      onClick={focusable ? onClick : undefined}
      onDoubleClick={focusable ? onDoubleClick : undefined}
      onContextMenu={onContextMenu}
    >
      {children}
      {focusable && mode !== 'strip' && (
        <div className="vx-tile-actions" onClick={stop} onDoubleClick={stop}>
          <button className="vx-tile-btn" onClick={onToggleFocus} title={focused ? 'Back to grid' : 'Focus'} aria-label={focused ? 'Back to grid' : 'Focus'}>
            {focused ? <CollapseIcon size={16} /> : <ExpandIcon size={16} />}
          </button>
          <button className="vx-tile-btn" onClick={() => toggleFullscreen(ref.current)} title="Fullscreen (double-click)" aria-label="Fullscreen">
            <FullscreenIcon size={16} />
          </button>
        </div>
      )}
    </div>
  )
}

interface UserTileProps {
  view: ParticipantView
  user: User | undefined
  mode: 'grid' | 'focus' | 'strip'
  focused: boolean
  onToggleFocus(): void
  /** Right-click handler for remote users (opens the per-user volume card). */
  onVolumeMenu?(userId: string, x: number, y: number): void
}

const UserTile = memo(function UserTile({ view, user, mode, focused, onToggleFocus, onVolumeMenu }: UserTileProps) {
  const name = nameOf(view, user)
  const color = colorOf(view, user)
  const selfMuted = useVoice((s) => view.isLocal && s.muted)
  const selfNativeLive = useVoice((s) => view.isLocal && s.sharing && s.shareEngine === 'native')
  const deafenedSelf = useVoice((s) => view.isLocal && s.deafened)
  const serverState = useApp((s) => s.voice.find((v) => v.userId === view.identity))
  const deafened = (serverState?.deafened ?? false) || deafenedSelf
  // The mute icon reflects the explicit mute (server voice state), not LiveKit's track mute,
  // which is also set while a push-to-talk user isn't holding their key.
  const muted = view.isLocal ? selfMuted : serverState ? serverState.muted : view.micMuted
  const { volume: userVolume, muted: mutedForMe } = useUserVolume(view.identity)
  const volumeAdjusted = !view.isLocal && (mutedForMe || userVolume !== 1)
  const onContextMenu = onVolumeMenu
    ? (e: MouseEvent) => {
        e.preventDefault()
        onVolumeMenu(view.identity, e.clientX, e.clientY)
      }
    : undefined
  const poor = view.connectionQuality === ConnectionQuality.Poor || view.connectionQuality === ConnectionQuality.Lost
  const avatarSize = mode === 'strip' ? 44 : mode === 'focus' ? 120 : 76

  return (
    <TileShell
      className={`vx-user ${view.isSpeaking && !view.micMuted ? 'is-speaking' : ''}`}
      mode={mode}
      focusable={!!view.cameraTrack}
      focused={focused}
      onToggleFocus={onToggleFocus}
      onContextMenu={onContextMenu}
      label={name}
    >
      {view.cameraTrack ? (
        <VideoTrackView track={view.cameraTrack} fit={mode === 'focus' ? 'contain' : 'cover'} mirror={view.isLocal} />
      ) : (
        <div className="vx-user-bg" style={{ ['--tile-color' as string]: color }}>
          <span className="vx-ring">
            <Avatar user={avatarUser(view, user)} size={avatarSize} />
          </span>
        </div>
      )}
      <div className="vx-tile-label">
        {(muted || deafened) && (
          <span className="vx-label-icon is-danger" title={deafened ? 'Deafened' : 'Muted'}>
            {deafened ? <HeadphonesOffIcon size={13} /> : <MicOffIcon size={13} />}
          </span>
        )}
        <span className="vx-label-name">
          {name}
          {view.isLocal && <span className="vx-label-you"> (you)</span>}
        </span>
        {volumeAdjusted && (
          <span
            className={`vx-label-icon ${mutedForMe ? 'is-danger' : 'is-adjusted'}`}
            title={mutedForMe ? 'Muted for you (right-click to change)' : `Volume ${Math.round(userVolume * 100)}% (right-click to change)`}
          >
            {mutedForMe ? <VolumeOffIcon size={13} /> : <VolumeIcon size={13} />}
          </span>
        )}
        {(view.isStreaming || selfNativeLive) && <span className="vx-live-badge is-small">LIVE</span>}
        {poor && (
          <span className="vx-label-icon is-warn" title="Poor connection">
            <AlertIcon size={13} />
          </span>
        )}
      </div>
    </TileShell>
  )
})

function mbps(bps: number): string {
  return `${(bps / 1_000_000).toFixed(bps < 10_000_000 ? 1 : 0)} Mbps`
}

interface LiveCardProps {
  view: ParticipantView
  user: User | undefined
  mode: 'grid' | 'focus' | 'strip'
}

/**
 * Our own native share (SPEC-BETA §8.3): no self-preview, which would mean downloading our own upload.
 * Shows what the helper reports instead.
 */
const LiveCard = memo(function LiveCard({ view, user, mode }: LiveCardProps) {
  const color = colorOf(view, user)
  const presetId = useVoice((s) => s.sharePresetId)
  const stats = useVoice((s) => s.shareStats)
  // The card only shows once live, so 'connecting' here means main is resuming after a helper crash.
  const reconnecting = useNativeShare((s) => s.state === 'reconnecting' || s.state === 'connecting')
  const preset = presetId ? getSharePreset(presetId) : null
  const compact = mode === 'strip'

  return (
    <div
      role="listitem"
      aria-label="Your stream"
      className={`vx-tile is-${mode} vx-stream is-unwatched vx-livecard`}
      style={{ ['--tile-color' as string]: color }}
    >
      <div className="vx-unwatched">
        <span className="vx-unwatched-title">
          <span className="vx-live-badge">LIVE</span> You're live
        </span>
        {!compact && preset && (
          <span className="vx-livecard-preset">
            {preset.label} · {preset.height}p{preset.fps}
          </span>
        )}
        {!compact &&
          (stats ? (
            <span
              className="vx-livecard-stats"
              title={`Capturing ${stats.captureFps} fps, sending ${stats.sendFps} fps${
                stats.width ? ` at ${stats.width}×${stats.height}` : ''
              }`}
            >
              {stats.sendFps} fps{stats.bitrate ? ` · ${mbps(stats.bitrate)}` : ''}
              {stats.encoder ? ` · ${stats.encoder}` : ''}
            </span>
          ) : (
            <span className="vx-livecard-stats">Measuring…</span>
          ))}
        {reconnecting ? (
          <span className="vx-livecard-notice">
            <span className="vx-spinner" /> Reconnecting…
          </span>
        ) : (
          stats?.stalled && (
            <span className="vx-livecard-notice" title="Viewers keep seeing the last frame until it updates again.">
              <AlertIcon size={13} /> Window minimized / no new frames
            </span>
          )
        )}
        {!compact && (
          <button className="vx-btn" onClick={() => void useVoice.getState().stopShare()}>
            Stop streaming
          </button>
        )}
      </div>
    </div>
  )
})

interface StreamTileProps {
  view: ParticipantView
  user: User | undefined
  watching: boolean
  volume: number
  deafened: boolean
  mode: 'grid' | 'focus' | 'strip'
  focused: boolean
  onToggleFocus(): void
}

const StreamTile = memo(function StreamTile({ view, user, watching, volume, deafened, mode, focused, onToggleFocus }: StreamTileProps) {
  const name = nameOf(view, user)
  const color = colorOf(view, user)
  const [stats, setStats] = useVideoStats()
  const track = watching ? view.screenTrack : null

  if (!watching) {
    return (
      <div role="listitem" aria-label={`${name}'s stream`} className={`vx-tile is-${mode} vx-stream is-unwatched`} style={{ ['--tile-color' as string]: color }}>
        <div className="vx-unwatched">
          {mode !== 'strip' && <Avatar user={avatarUser(view, user)} size={mode === 'focus' ? 72 : 48} />}
          <span className="vx-unwatched-title">
            <span className="vx-live-badge">LIVE</span> {view.isLocal ? "You're live" : `${name} is streaming`}
          </span>
          <button className="vx-btn vx-btn-primary" onClick={() => watchStream(view.identity)}>
            <EyeIcon size={16} /> {view.isLocal ? 'Preview' : 'Watch stream'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <TileShell
      className="vx-stream"
      mode={mode}
      focusable={!!track}
      focused={focused}
      onToggleFocus={onToggleFocus}
      label={`${name}'s stream`}
    >
      {track ? (
        <VideoTrackView track={track} fit="contain" onStats={mode === 'strip' ? undefined : setStats} />
      ) : (
        <div className="vx-stream-loading">
          <span className="vx-spinner" /> Loading stream…
        </div>
      )}
      <div className="vx-stream-top">
        <span className="vx-live-badge">LIVE</span>
        <span className="vx-stream-name">{view.isLocal ? 'Your stream' : name}</span>
        {stats && mode !== 'strip' && (
          <span className="vx-stream-stats">
            {stats.width}×{stats.height} · {stats.fps} fps
          </span>
        )}
      </div>
      {mode !== 'strip' && (
        <div className="vx-stream-bottom" onClick={stop} onDoubleClick={stop}>
          {view.hasScreenAudio && !view.isLocal && (
            <label className="vx-volume" title={deafened ? 'You are deafened' : `Stream volume ${Math.round(volume * 100)}%`}>
              <button
                className="vx-tile-btn"
                onClick={() => setStreamVolume(view.identity, volume > 0 ? 0 : 1)}
                aria-label={volume > 0 ? 'Mute stream' : 'Unmute stream'}
              >
                {volume === 0 || deafened ? <VolumeOffIcon size={16} /> : <VolumeIcon size={16} />}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(volume * 100)}
                onChange={(e) => setStreamVolume(view.identity, Number(e.target.value) / 100)}
                aria-label="Stream volume"
                style={{ ['--fill' as string]: `${Math.round(volume * 100)}%` }}
              />
            </label>
          )}
          <span className="vx-grow" />
          <button className="vx-tile-btn is-text" onClick={() => stopWatching(view.identity)} title="Stop watching">
            <EyeOffIcon size={16} /> {view.isLocal ? 'Hide preview' : 'Stop watching'}
          </button>
        </div>
      )}
    </TileShell>
  )
})
