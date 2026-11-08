// Owner: workstream D. React-facing view of the LiveKit room's participants.
// Rebuilt (coalesced per microtask) from RoomEvents by session.ts. Entries are plain objects that are
// reused when nothing changed, so memoized tiles only re-render for the participant that changed.
//
// Native shares (Windows beta, docs/SPEC-BETA.md D6) are published by a second participant
// `<userId>#stream`. That participant is never a member of its own: its ScreenShare / ScreenShareAudio
// publications are folded into the owner's view, so the stage, "Watch", stream volume and the LIVE badge
// work the same for alpha (ScreenShare on the main participant) and beta streamers.
import { create } from 'zustand'
import {
  ConnectionQuality,
  Track,
  type LocalVideoTrack,
  type Participant,
  type RemoteVideoTrack,
  type Room,
} from 'livekit-client'
import { isStreamIdentity, streamIdentity, streamOwner } from '@shared/stream'

export type VideoTrack = LocalVideoTrack | RemoteVideoTrack

export interface ParticipantView {
  /** LiveKit identity = Nexo userId */
  identity: string
  name: string
  /** From the token metadata `{color}` (null when absent; fall back to useApp users). */
  color: string | null
  isLocal: boolean
  isSpeaking: boolean
  /** True when there is no mic publication or it is muted. */
  micMuted: boolean
  /** Camera video, only when published, unmuted and (for remote) subscribed. */
  cameraTrack: VideoTrack | null
  /**
   * Participant publishes a screen share (whether or not we're watching it), either itself (Chromium
   * engine) or through its `#stream` participant (native engine). For the local participant this only
   * covers the Chromium engine: our own native stream is shown from `useVoice` (see VoiceStage).
   */
  isStreaming: boolean
  /** Screen share video track, available locally or when we're subscribed (= watching). */
  screenTrack: VideoTrack | null
  /** Participant publishes stream audio alongside the screen share. */
  hasScreenAudio: boolean
  connectionQuality: ConnectionQuality
}

export interface ParticipantsState {
  /** Local participant first, then remote participants in join order. */
  list: ParticipantView[]
  /** Bumped on every rebuild that changed something. */
  version: number
  /** Identities whose stream we opted to watch (including our own preview). Always the owner's identity. */
  watching: Record<string, true>
  /** Per-stream audio volume (0..1), keyed by the owner's identity. Default 1. */
  streamVolumes: Record<string, number>
}

export const useParticipants = create<ParticipantsState>()(() => ({
  list: [],
  version: 0,
  watching: {},
  streamVolumes: {},
}))

function parseColor(metadata: string | undefined): string | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata) as { color?: unknown }
    return typeof parsed.color === 'string' ? parsed.color : null
  } catch {
    return null
  }
}

/** Owner identity for a participant identity: `X#stream` → `X`, anything else unchanged. */
export function ownerIdentity(identity: string): string {
  return streamOwner(identity) ?? identity
}

/**
 * The participant that holds `owner`'s stream: the owner itself when it publishes a ScreenShare (alpha
 * clients, the Chromium engine and its fallback), else its `#stream` participant when that publishes one.
 * The owner wins when both do: a Chromium fallback starts while the helper's participant is still leaving.
 */
export function streamHolder(room: Room, owner: string): Participant | null {
  const self = room.localParticipant.identity === owner ? room.localParticipant : room.remoteParticipants.get(owner)
  if (self?.getTrackPublication(Track.Source.ScreenShare)) return self
  // Our own `#stream` is never folded in: we never subscribe to it (it would download our own upload).
  if (room.localParticipant.identity === owner) return null
  const stream = room.remoteParticipants.get(streamIdentity(owner))
  return stream?.getTrackPublication(Track.Source.ScreenShare) ? stream : null
}

function viewOf(p: Participant, holder: Participant | null): ParticipantView {
  const mic = p.getTrackPublication(Track.Source.Microphone)
  const cam = p.getTrackPublication(Track.Source.Camera)
  const screen = holder?.getTrackPublication(Track.Source.ScreenShare)
  const screenAudio = holder?.getTrackPublication(Track.Source.ScreenShareAudio)
  const camTrack = cam && !cam.isMuted ? (cam.videoTrack ?? null) : null
  return {
    identity: p.identity,
    name: p.name || p.identity,
    color: parseColor(p.metadata),
    isLocal: p.isLocal,
    isSpeaking: p.isSpeaking,
    micMuted: !mic || mic.isMuted,
    cameraTrack: camTrack,
    isStreaming: !!screen,
    screenTrack: screen?.videoTrack ?? null,
    hasScreenAudio: !!screenAudio,
    connectionQuality: p.connectionQuality,
  }
}

function sameView(a: ParticipantView, b: ParticipantView): boolean {
  for (const key of Object.keys(a) as (keyof ParticipantView)[]) {
    if (a[key] !== b[key]) return false
  }
  return true
}

function build(room: Room | null): ParticipantView[] {
  if (!room) return []
  // `#stream` participants are not members; one that arrives before its owner simply stays invisible
  // until the owner joins (and its stream is folded into the owner's view then).
  const remotes = [...room.remoteParticipants.values()]
    .filter((p) => !isStreamIdentity(p.identity))
    .sort((a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0))
  return [room.localParticipant, ...remotes].map((p) => viewOf(p, streamHolder(room, p.identity)))
}

let pendingRoom: Room | null = null
let scheduled = false

/** Coalesce many LiveKit events into one store update. */
export function scheduleParticipantsRebuild(room: Room | null): void {
  pendingRoom = room
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    rebuildParticipantsNow(pendingRoom)
  })
}

export function rebuildParticipantsNow(room: Room | null): void {
  const prev = useParticipants.getState().list
  const prevById = new Map(prev.map((v) => [v.identity, v]))
  let changed = false
  const next = build(room).map((v) => {
    const old = prevById.get(v.identity)
    if (old && sameView(old, v)) return old
    changed = true
    return v
  })
  if (!changed && next.length === prev.length && next.every((v, i) => v === prev[i])) return
  useParticipants.setState((s) => ({ list: next, version: s.version + 1 }))
}

export function resetParticipants(): void {
  useParticipants.setState((s) => ({ list: [], version: s.version + 1, watching: {} }))
}
