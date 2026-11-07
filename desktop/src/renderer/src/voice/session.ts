// Owner: workstream D — voice & streaming.
// One LiveKit Room per voice channel, kept at module level (never in React state). The zustand store
// `useVoice` mirrors the small amount of state the UI needs; `useParticipants` (participants.ts)
// mirrors the participants/tracks.
import { create } from 'zustand'
import {
  AudioPresets,
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type LocalTrackPublication,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type TrackPublishOptions,
  type VideoEncoding,
} from 'livekit-client'
import { emit, onConnected, request } from '@renderer/net/socket'
import { toast } from '@renderer/lib/toast'
import type { NexoBridge } from '../../../preload/api'
import { idealDevice, saveDevicePref, useDevicePrefs, type DeviceKind } from './devices'
import {
  rebuildParticipantsNow,
  resetParticipants,
  scheduleParticipantsRebuild,
  useParticipants,
} from './participants'

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface SharePreset {
  id: 'smooth' | 'game' | 'sharp' | 'source'
  label: string
  width: number
  height: number
  fps: number
  maxBitrate: number
  contentHint: 'motion' | 'detail'
}

export interface StartShareOptions {
  /** CaptureSource.id, or null when the OS picker is used */
  sourceId: string | null
  presetId: SharePreset['id']
  withAudio: boolean
}

export interface VoiceSessionState {
  status: VoiceStatus
  error: string | null
  /** Voice channel we're connected to (null when idle). */
  channelId: string | null
  muted: boolean
  deafened: boolean
  camera: boolean
  sharing: boolean
  /** A screen share is being acquired / published. */
  shareStarting: boolean
  /** Preset of the active share (null when not sharing). */
  sharePresetId: SharePreset['id'] | null
  /** Browser blocked audio autoplay; call `resumeAudio()` from a click. */
  audioBlocked: boolean
  /** Share picker modal visibility (rendered by <SharePickerHost/>). */
  pickerOpen: boolean
  join(channelId: string): Promise<void>
  leave(): Promise<void>
  toggleMute(): void
  toggleDeafen(): void
  toggleCamera(): Promise<void>
  startShare(opts: StartShareOptions): Promise<void>
  stopShare(): Promise<void>
  openSharePicker(): void
  closeSharePicker(): void
  clearError(): void
}

/** SPEC §6.2 screen share quality presets. */
export const SHARE_PRESETS: readonly SharePreset[] = [
  { id: 'smooth', label: 'Smooth', width: 1280, height: 720, fps: 60, maxBitrate: 4_000_000, contentHint: 'motion' },
  { id: 'game', label: 'Game', width: 1920, height: 1080, fps: 60, maxBitrate: 8_000_000, contentHint: 'motion' },
  { id: 'sharp', label: 'Sharp', width: 1920, height: 1080, fps: 30, maxBitrate: 5_000_000, contentHint: 'detail' },
  { id: 'source', label: 'Source', width: 2560, height: 1440, fps: 60, maxBitrate: 12_000_000, contentHint: 'motion' },
]
export const DEFAULT_SHARE_PRESET: SharePreset['id'] = 'game'

export function getSharePreset(id: SharePreset['id']): SharePreset {
  return SHARE_PRESETS.find((p) => p.id === id) ?? SHARE_PRESETS[1]
}

// ---------------------------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------------------------

let room: Room | null = null
/** Bumped by every join/leave so stale async continuations can bail out. */
let joinSeq = 0
let mutedBeforeDeafen = false

interface ActiveShare {
  stream: MediaStream
  videoMst: MediaStreamTrack
  video: LocalVideoTrack
  audio: LocalAudioTrack | null
}
let share: ActiveShare | null = null

/** trackSid -> hidden <audio> element playing a remote audio track. */
const audioElements = new Map<string, { el: HTMLAudioElement; track: RemoteAudioTrack; identity: string }>()
let audioContainer: HTMLDivElement | null = null

export function getBridge(): NexoBridge | undefined {
  return (window as { nexo?: NexoBridge }).nexo
}

/** The live Room (null when not in voice). For read-only use by voice components. */
export function getRoom(): Room | null {
  return room
}

/** The local microphone MediaStreamTrack when in voice (used by the settings mic meter). */
export function getLocalMicTrack(): MediaStreamTrack | null {
  const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone)
  return pub?.track?.mediaStreamTrack ?? null
}

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message
  if (typeof e === 'string' && e) return e
  return fallback
}

function isUserCancel(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')
}

function mediaErrorMessage(e: unknown, what: string): string {
  if (e instanceof DOMException) {
    if (e.name === 'NotAllowedError') return `${what}: permission denied`
    if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') return `${what}: device not found`
    if (e.name === 'NotReadableError') return `${what}: device is in use by another app`
  }
  return `${what}: ${errorMessage(e, 'failed')}`
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export const useVoice = create<VoiceSessionState>()((set, get) => ({
  status: 'idle',
  error: null,
  channelId: null,
  muted: false,
  deafened: false,
  camera: false,
  sharing: false,
  shareStarting: false,
  sharePresetId: null,
  audioBlocked: false,
  pickerOpen: false,

  async join(channelId) {
    const s = get()
    if (s.channelId === channelId && (s.status === 'connecting' || s.status === 'connected' || s.status === 'reconnecting')) {
      return
    }
    // Switching channels: tear down the old room without announcing "left" (the new state follows).
    if (room || s.channelId) await teardown(false)

    const seq = ++joinSeq
    set({ status: 'connecting', channelId, error: null, camera: false, sharing: false, shareStarting: false, sharePresetId: null })

    let r: Room | null = null
    try {
      const creds = await request('voice:token', { channelId })
      if (seq !== joinSeq) return

      const prefs = useDevicePrefs.getState()
      const micId = idealDevice(prefs.audioinput)
      const camId = idealDevice(prefs.videoinput)
      r = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(micId ? { deviceId: micId } : {}),
        },
        videoCaptureDefaults: {
          resolution: VideoPresets.h720.resolution,
          ...(camId ? { deviceId: camId } : {}),
        },
        ...(prefs.audiooutput ? { audioOutput: { deviceId: prefs.audiooutput } } : {}),
        publishDefaults: {
          audioPreset: AudioPresets.music,
          red: true,
          dtx: true,
        },
        disconnectOnPageLeave: true,
      })
      room = r
      wireRoom(r)

      // Screen shares are opt-in ("Watch stream"), so subscriptions are managed manually.
      await r.connect(creds.url, creds.token, { autoSubscribe: false })
      if (seq !== joinSeq || room !== r) return

      set({ status: 'connected', audioBlocked: !r.canPlaybackAudio })
      syncAllSubscriptions(r)
      rebuildParticipantsNow(r)
      r.startAudio().catch(() => {})
      announce()

      if (!get().muted) {
        try {
          await r.localParticipant.setMicrophoneEnabled(true)
        } catch (e) {
          if (room !== r) return
          set({ muted: true, error: mediaErrorMessage(e, 'Microphone') })
          announce()
        }
      }
    } catch (e) {
      if (seq !== joinSeq) return
      if (r && room === r) {
        room = null
        r.removeAllListeners()
        await r.disconnect().catch(() => {})
      }
      cleanupLocalMedia()
      resetParticipants()
      set({
        status: 'error',
        channelId: null,
        camera: false,
        sharing: false,
        error: `Couldn't join voice: ${errorMessage(e, 'connection failed')}`,
      })
    }
  },

  async leave() {
    await teardown(true)
  },

  toggleMute() {
    const s = get()
    if (s.deafened) {
      // Unmuting while deafened also un-deafens (you can't talk without hearing).
      set({ deafened: false, muted: false })
      applyRemoteVolumes()
    } else {
      set({ muted: !s.muted })
    }
    void applyMic()
    announce()
  },

  toggleDeafen() {
    const s = get()
    if (!s.deafened) {
      mutedBeforeDeafen = s.muted
      set({ deafened: true, muted: true })
    } else {
      set({ deafened: false, muted: mutedBeforeDeafen })
    }
    applyRemoteVolumes()
    void applyMic()
    announce()
  },

  async toggleCamera() {
    const r = room
    if (!r) return
    const next = !get().camera
    set({ camera: next })
    try {
      await r.localParticipant.setCameraEnabled(
        next,
        { resolution: VideoPresets.h720.resolution },
        { videoEncoding: VideoPresets.h720.encoding, simulcast: true },
      )
    } catch (e) {
      if (room !== r) return
      set({ camera: false, error: mediaErrorMessage(e, 'Camera') })
      r.localParticipant.setCameraEnabled(false).catch(() => {})
    }
    if (room === r) announce()
  },

  async startShare(opts) {
    const r = room
    if (!r || get().shareStarting) return
    if (share) await stopShareInternal(false)

    const preset = getSharePreset(opts.presetId)
    const bridge = getBridge()
    const withAudio = opts.withAudio && (bridge ? bridge.supportsSystemAudio : true)
    set({ shareStarting: true, error: null, pickerOpen: false })

    let stream: MediaStream
    try {
      // Electron main answers getDisplayMedia with the source chosen here.
      if (bridge) await bridge.capture.selectSource(opts.sourceId, withAudio)
      stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions(preset, withAudio, !bridge))
    } catch (e) {
      set({ shareStarting: false, ...(isUserCancel(e) ? {} : { error: mediaErrorMessage(e, 'Screen share') }) })
      return
    }
    if (room !== r) {
      stream.getTracks().forEach((t) => t.stop())
      set({ shareStarting: false })
      return
    }

    const videoMst = stream.getVideoTracks()[0]
    if (!videoMst) {
      stream.getTracks().forEach((t) => t.stop())
      set({ shareStarting: false, error: 'Screen share: no video track was captured' })
      return
    }
    // Encoder hint: 'motion' keeps frame rate for games, 'detail' keeps text crisp.
    videoMst.contentHint = preset.contentHint
    // Fallback in case the display-media handler ignored the constraints passed above.
    await videoMst.applyConstraints(videoConstraints(preset)).catch(() => {})

    const audioMst = stream.getAudioTracks()[0] ?? null
    const video = new LocalVideoTrack(videoMst, undefined, true)
    const audio = audioMst ? new LocalAudioTrack(audioMst, undefined, true) : null
    share = { stream, videoMst, video, audio }
    // User pressed the OS / browser "Stop sharing" button.
    videoMst.addEventListener('ended', onShareEnded)

    try {
      await publishScreenVideo(r, video, preset)
    } catch (e) {
      if (room !== r || share?.video !== video) return // left or stopped meanwhile
      await stopShareInternal(false)
      set({ shareStarting: false, error: `Screen share: ${errorMessage(e, 'publishing failed')}` })
      return
    }
    if (share?.video !== video) {
      // Stopped (e.g. OS "Stop sharing") while publishing: make sure nothing stays published.
      await r.localParticipant.unpublishTrack(video, true).catch(() => undefined)
      return
    }

    if (audio) {
      try {
        await r.localParticipant.publishTrack(audio, {
          source: Track.Source.ScreenShareAudio,
          name: 'screen-audio',
          audioPreset: AudioPresets.musicHighQualityStereo,
          dtx: false,
          red: false,
          forceStereo: true,
        })
      } catch (e) {
        // Keep the video going; the stream is just silent.
        console.warn('[voice] stream audio publish failed', e)
        set({ error: `Stream audio: ${errorMessage(e, 'publishing failed')}` })
        audio.stop()
        if (share?.video === video) share.audio = null
      }
    }
    if (share?.video !== video) {
      await r.localParticipant.unpublishTrack(video, true).catch(() => undefined)
      if (audio) await r.localParticipant.unpublishTrack(audio, true).catch(() => undefined)
      return
    }

    set({ sharing: true, shareStarting: false, sharePresetId: preset.id })
    announce()
  },

  async stopShare() {
    await stopShareInternal(true)
  },

  openSharePicker() {
    if (room) set({ pickerOpen: true })
  },
  closeSharePicker() {
    set({ pickerOpen: false })
  },
  clearError() {
    set((s) => ({ error: null, status: s.status === 'error' ? 'idle' : s.status }))
  },
}))

// ---------------------------------------------------------------------------------------------
// Signaling to the Nexo server
// ---------------------------------------------------------------------------------------------

function announce(): void {
  const s = useVoice.getState()
  if (!room || !s.channelId || (s.status !== 'connected' && s.status !== 'reconnecting')) return
  emit('voice:state', {
    channelId: s.channelId,
    muted: s.muted,
    deafened: s.deafened,
    camera: s.camera,
    streaming: s.sharing,
  })
}

function announceLeft(): void {
  const s = useVoice.getState()
  emit('voice:state', { channelId: null, muted: s.muted, deafened: s.deafened, camera: false, streaming: false })
}

// The server forgets voice state when our socket drops; re-announce after every (re)connect.
onConnected(() => announce())

// Surface every new voice error as a toast as well (the message stays in `useVoice().error`).
useVoice.subscribe((s, prev) => {
  if (s.error && s.error !== prev.error) toast(s.error, 'error')
})

// ---------------------------------------------------------------------------------------------
// Room wiring
// ---------------------------------------------------------------------------------------------

function wireRoom(r: Room): void {
  const rebuild = () => scheduleParticipantsRebuild(r)

  r.on(RoomEvent.ParticipantConnected, (p) => {
    syncParticipantSubscriptions(p)
    rebuild()
  })
    .on(RoomEvent.ParticipantDisconnected, rebuild)
    .on(RoomEvent.TrackPublished, (pub, p) => {
      syncPublication(pub, p)
      rebuild()
    })
    .on(RoomEvent.TrackUnpublished, (pub, p) => {
      // The streamer stopped sharing (they're still here): drop our "watching" opt-in.
      if (pub.source === Track.Source.ScreenShare && r.remoteParticipants.get(p.identity) === p) {
        unwatch(p.identity)
      }
      rebuild()
    })
    .on(RoomEvent.TrackSubscribed, (track, _pub, p) => {
      if (track instanceof RemoteAudioTrack) attachAudio(track, p.identity)
      rebuild()
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      detachAudio(track)
      rebuild()
    })
    .on(RoomEvent.TrackMuted, rebuild)
    .on(RoomEvent.TrackUnmuted, rebuild)
    .on(RoomEvent.LocalTrackPublished, rebuild)
    .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
      // LiveKit auto-unpublishes a screen share whose track ended; keep our state in sync.
      if (share && pub.track === share.video) void stopShareInternal(true)
      rebuild()
    })
    .on(RoomEvent.ActiveSpeakersChanged, rebuild)
    .on(RoomEvent.ConnectionQualityChanged, rebuild)
    .on(RoomEvent.ParticipantMetadataChanged, rebuild)
    .on(RoomEvent.ParticipantNameChanged, rebuild)
    .on(RoomEvent.Reconnecting, () => {
      if (room === r) useVoice.setState({ status: 'reconnecting' })
    })
    .on(RoomEvent.SignalReconnecting, () => {
      if (room === r) useVoice.setState({ status: 'reconnecting' })
    })
    .on(RoomEvent.Reconnected, () => {
      if (room !== r) return
      useVoice.setState({ status: 'connected' })
      syncAllSubscriptions(r)
      rebuild()
      announce()
    })
    .on(RoomEvent.Disconnected, (reason) => {
      if (room !== r) return // we initiated it
      // A failed initial connect rejects connect(); join() reports that error itself.
      if (useVoice.getState().status === 'connecting') return
      void handleUnexpectedDisconnect(reason)
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (room === r) useVoice.setState({ audioBlocked: !r.canPlaybackAudio })
    })
    .on(RoomEvent.MediaDevicesError, (e, kind) => {
      if (room !== r) return
      const what = kind === 'videoinput' ? 'Camera' : kind === 'audiooutput' ? 'Speaker' : 'Microphone'
      useVoice.setState({ error: mediaErrorMessage(e, what) })
    })
}

function disconnectReasonText(reason: DisconnectReason | undefined): string {
  switch (reason) {
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'You joined voice from another device'
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'You were removed from the voice channel'
    case DisconnectReason.ROOM_DELETED:
      return 'The voice channel was closed'
    case DisconnectReason.SERVER_SHUTDOWN:
      return 'The voice server shut down'
    default:
      return 'Lost connection to the voice server'
  }
}

async function handleUnexpectedDisconnect(reason: DisconnectReason | undefined): Promise<void> {
  const r = room
  room = null
  joinSeq++
  r?.removeAllListeners()
  cleanupLocalMedia()
  resetParticipants()
  useVoice.setState({
    status: 'error',
    channelId: null,
    camera: false,
    sharing: false,
    shareStarting: false,
    sharePresetId: null,
    pickerOpen: false,
    error: disconnectReasonText(reason),
  })
  announceLeft()
}

async function teardown(announceLeave: boolean): Promise<void> {
  joinSeq++
  const r = room
  room = null
  const wasInVoice = !!useVoice.getState().channelId
  if (share && r) {
    // Unpublish explicitly so viewers see the stream end immediately.
    await stopShareInternal(false, r)
  }
  cleanupLocalMedia()
  if (r) {
    r.removeAllListeners()
    await r.disconnect(true).catch(() => {})
  }
  resetParticipants()
  useVoice.setState({
    status: 'idle',
    channelId: null,
    camera: false,
    sharing: false,
    shareStarting: false,
    sharePresetId: null,
    pickerOpen: false,
    audioBlocked: false,
  })
  if (announceLeave && wasInVoice) announceLeft()
}

/** Stop local capture + remove every remote audio element. Safe to call repeatedly. */
function cleanupLocalMedia(): void {
  if (share) {
    share.videoMst.removeEventListener('ended', onShareEnded)
    share.stream.getTracks().forEach((t) => t.stop())
    share.video.stop()
    share.audio?.stop()
    share = null
  }
  for (const key of [...audioElements.keys()]) {
    const entry = audioElements.get(key)
    if (!entry) continue
    entry.track.detach(entry.el)
    entry.el.remove()
    audioElements.delete(key)
  }
}

// ---------------------------------------------------------------------------------------------
// Subscriptions (mic + camera always, screen share only while watching)
// ---------------------------------------------------------------------------------------------

function wantsSubscription(source: Track.Source, identity: string): boolean {
  switch (source) {
    case Track.Source.Microphone:
    case Track.Source.Camera:
      return true
    case Track.Source.ScreenShare:
    case Track.Source.ScreenShareAudio:
      return !!useParticipants.getState().watching[identity]
    default:
      return false
  }
}

function syncPublication(pub: RemoteTrackPublication, p: RemoteParticipant): void {
  const want = wantsSubscription(pub.source, p.identity)
  if (pub.isDesired !== want) pub.setSubscribed(want)
}

function syncParticipantSubscriptions(p: RemoteParticipant): void {
  p.trackPublications.forEach((pub) => syncPublication(pub, p))
}

function syncAllSubscriptions(r: Room): void {
  r.remoteParticipants.forEach((p) => syncParticipantSubscriptions(p))
}

/** Opt in to a participant's stream (subscribes to their screen share + stream audio). */
export function watchStream(identity: string): void {
  useParticipants.setState((s) => ({ watching: { ...s.watching, [identity]: true } }))
  const r = room
  if (!r) return
  const p = r.remoteParticipants.get(identity)
  if (p) syncParticipantSubscriptions(p)
  scheduleParticipantsRebuild(r)
}

/** Stop watching (unsubscribes so no bandwidth is used). */
export function stopWatching(identity: string): void {
  unwatch(identity)
  const r = room
  if (!r) return
  const p = r.remoteParticipants.get(identity)
  if (p) syncParticipantSubscriptions(p)
  scheduleParticipantsRebuild(r)
}

function unwatch(identity: string): void {
  const { watching } = useParticipants.getState()
  if (!watching[identity]) return
  const next = { ...watching }
  delete next[identity]
  useParticipants.setState({ watching: next })
}

// ---------------------------------------------------------------------------------------------
// Remote audio playback (hidden <audio> elements, outside React)
// ---------------------------------------------------------------------------------------------

function getAudioContainer(): HTMLDivElement {
  if (!audioContainer || !audioContainer.isConnected) {
    audioContainer = document.createElement('div')
    audioContainer.id = 'nexo-voice-audio'
    audioContainer.style.display = 'none'
    document.body.appendChild(audioContainer)
  }
  return audioContainer
}

function volumeFor(track: RemoteAudioTrack, identity: string): number {
  if (useVoice.getState().deafened) return 0
  if (track.source === Track.Source.ScreenShareAudio) {
    return useParticipants.getState().streamVolumes[identity] ?? 1
  }
  return 1
}

function attachAudio(track: RemoteAudioTrack, identity: string): void {
  const sid = track.sid ?? track.mediaStreamID
  const existing = audioElements.get(sid)
  if (existing?.track === track) return
  if (existing) {
    // Re-subscription (e.g. after a reconnect) delivered a new track object for the same sid.
    existing.track.detach(existing.el)
    existing.el.remove()
    audioElements.delete(sid)
  }
  const el = document.createElement('audio')
  el.autoplay = true
  getAudioContainer().appendChild(el)
  // attach() applies the room's speaker (sinkId) to the element.
  track.attach(el)
  track.setVolume(volumeFor(track, identity))
  audioElements.set(sid, { el, track, identity })
}

function detachAudio(track: RemoteTrack): void {
  for (const [sid, entry] of audioElements) {
    if (entry.track !== track) continue
    entry.track.detach(entry.el)
    entry.el.remove()
    audioElements.delete(sid)
  }
}

function applyRemoteVolumes(): void {
  for (const { track, identity } of audioElements.values()) {
    track.setVolume(volumeFor(track, identity))
  }
}

/** Per-stream audio volume (0..1) for a participant's ScreenShareAudio; default 1. */
export function setStreamVolume(identity: string, volume: number): void {
  const v = Math.min(1, Math.max(0, volume))
  useParticipants.setState((s) => ({ streamVolumes: { ...s.streamVolumes, [identity]: v } }))
  applyRemoteVolumes()
}

/** Retry audio playback after the browser blocked autoplay. Call from a user gesture. */
export async function resumeAudio(): Promise<void> {
  const r = room
  if (!r) return
  await r.startAudio().catch(() => {})
  useVoice.setState({ audioBlocked: !r.canPlaybackAudio })
}

// ---------------------------------------------------------------------------------------------
// Microphone / devices
// ---------------------------------------------------------------------------------------------

async function applyMic(): Promise<void> {
  const r = room
  if (!r || useVoice.getState().status === 'connecting') return // join() applies it after connect
  const enabled = !useVoice.getState().muted
  try {
    await r.localParticipant.setMicrophoneEnabled(enabled)
  } catch (e) {
    if (room !== r) return
    useVoice.setState({ muted: true, error: mediaErrorMessage(e, 'Microphone') })
    announce()
  }
}

/** Persist a device choice and apply it live when in voice. `null` = system default. */
export async function setPreferredDevice(kind: DeviceKind, deviceId: string | null): Promise<void> {
  saveDevicePref(kind, deviceId)
  const r = room
  if (!r) return
  try {
    if (kind === 'videoinput') {
      if (deviceId) {
        await r.switchActiveDevice(kind, deviceId)
      } else if (r.options.videoCaptureDefaults) {
        r.options.videoCaptureDefaults.deviceId = undefined
      }
    } else {
      await r.switchActiveDevice(kind, deviceId ?? 'default')
    }
  } catch (e) {
    const what = kind === 'videoinput' ? 'Camera' : kind === 'audiooutput' ? 'Speaker' : 'Microphone'
    useVoice.setState({ error: mediaErrorMessage(e, what) })
  }
}

// ---------------------------------------------------------------------------------------------
// Screen share
// ---------------------------------------------------------------------------------------------

function videoConstraints(preset: SharePreset): MediaTrackConstraints {
  return {
    width: { max: preset.width },
    height: { max: preset.height },
    frameRate: { ideal: preset.fps, max: preset.fps },
  }
}

function displayMediaOptions(preset: SharePreset, withAudio: boolean, plainBrowser: boolean): DisplayMediaStreamOptions {
  // Stream audio is music/game audio: no voice processing. `restrictOwnAudio` (Chromium) asks the
  // capturer to exclude Nexo's own playback (the voice chat) where supported — see SPEC R1.
  const audio: MediaTrackConstraints & { restrictOwnAudio?: boolean } = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
    restrictOwnAudio: true,
  }
  const opts: DisplayMediaStreamOptions & { systemAudio?: 'include' | 'exclude' } = {
    video: videoConstraints(preset),
    audio: withAudio ? audio : false,
  }
  if (plainBrowser && withAudio) opts.systemAudio = 'include'
  return opts
}

function canEncodeH264(): boolean {
  try {
    const caps = RTCRtpSender.getCapabilities?.('video')
    return !!caps?.codecs.some((c) => c.mimeType.toLowerCase() === 'video/h264')
  } catch {
    return false
  }
}

async function publishScreenVideo(r: Room, video: LocalVideoTrack, preset: SharePreset): Promise<void> {
  const encoding: VideoEncoding = { maxBitrate: preset.maxBitrate, maxFramerate: preset.fps, priority: 'high' }
  const base: TrackPublishOptions = {
    source: Track.Source.ScreenShare,
    name: 'screen',
    // LiveKit reads `screenShareEncoding` for ScreenShare sources; `videoEncoding` set for completeness.
    screenShareEncoding: encoding,
    videoEncoding: encoding,
    simulcast: false,
    degradationPreference: preset.contentHint === 'motion' ? 'maintain-framerate' : 'maintain-resolution',
  }
  if (canEncodeH264()) {
    try {
      // H.264 first (hardware encoders on gaming PCs); VP8 backup for subscribers that can't decode it.
      await r.localParticipant.publishTrack(video, {
        ...base,
        videoCodec: 'h264',
        backupCodec: { codec: 'vp8', encoding },
      })
      return
    } catch (e) {
      if (room !== r || video.isStopped) throw e
      console.warn('[voice] H.264 screen share publish failed, retrying with VP8', e)
    }
  }
  await r.localParticipant.publishTrack(video, { ...base, videoCodec: 'vp8', backupCodec: false })
}

function onShareEnded(): void {
  void stopShareInternal(true)
}

async function stopShareInternal(announceChange: boolean, r: Room | null = room): Promise<void> {
  const s = share
  share = null
  if (s) {
    s.videoMst.removeEventListener('ended', onShareEnded)
    if (r) {
      for (const t of [s.video, s.audio]) {
        if (!t) continue
        await r.localParticipant.unpublishTrack(t, true).catch(() => undefined)
      }
    }
    s.stream.getTracks().forEach((t) => t.stop())
    s.video.stop()
    s.audio?.stop()
    const self = r?.localParticipant.identity
    if (self) unwatch(self)
  }
  const wasSharing = useVoice.getState().sharing
  useVoice.setState({ sharing: false, shareStarting: false, sharePresetId: null })
  if (announceChange && wasSharing) announce()
  if (room) scheduleParticipantsRebuild(room)
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

window.addEventListener('beforeunload', () => {
  if (!room) return
  announceLeft()
  const r = room
  room = null
  cleanupLocalMedia()
  r.removeAllListeners()
  void r.disconnect(true)
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void teardown(true)
  })
}

/** For debugging in devtools. */
export function isRoomConnected(): boolean {
  return room?.state === ConnectionState.Connected
}
