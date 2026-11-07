// Owner: workstream D. React-facing view of the LiveKit room's participants.
// Rebuilt (coalesced per microtask) from RoomEvents by session.ts. Entries are plain objects that are
// reused when nothing changed, so memoized tiles only re-render for the participant that changed.
import { create } from 'zustand'
import {
  ConnectionQuality,
  Track,
  type LocalVideoTrack,
  type Participant,
  type RemoteVideoTrack,
  type Room,
} from 'livekit-client'

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
  /** Participant publishes a screen share (whether or not we're watching it). */
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
  /** Identities whose stream we opted to watch (including our own preview). */
  watching: Record<string, true>
  /** Per-stream audio volume (0..1), keyed by identity. Default 1. */
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

function viewOf(p: Participant): ParticipantView {
  const mic = p.getTrackPublication(Track.Source.Microphone)
  const cam = p.getTrackPublication(Track.Source.Camera)
  const screen = p.getTrackPublication(Track.Source.ScreenShare)
  const screenAudio = p.getTrackPublication(Track.Source.ScreenShareAudio)
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
  const remotes = [...room.remoteParticipants.values()].sort(
    (a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0),
  )
  return [room.localParticipant, ...remotes].map(viewOf)
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
