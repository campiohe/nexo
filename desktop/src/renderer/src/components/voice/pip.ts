// Picture-in-picture state: the floating in-app player (PipPlayer) and the OS-level pop-out window
// (browser Picture-in-Picture on a dedicated <video>, see PopOutHost in PipPlayer.tsx).
//
// Nothing here touches what we watch: `useParticipants.watching` stays the single source of truth, and
// navigating away from the call never stops watching (the floating player just shows what's there).
import { create } from 'zustand'
import { isAudiblySpeaking, useParticipants, type ParticipantView, type VideoTrack } from '../../voice/participants'
import { useVoice } from '../../voice/session'

export type PipKind = 'stream' | 'camera'

/** What the player shows: someone's stream or camera. Identity is always the owner's (= userId). */
export interface PipTarget {
  kind: PipKind
  identity: string
}

export interface PipSubject extends PipTarget {
  view: ParticipantView
  track: VideoTrack
}

interface PipState {
  /** Watched stream owners, oldest watch first (the floating player shows the newest one). */
  watchOrder: string[]
  /** Sticky camera choice: the last remote camera owner heard speaking. */
  cameraPick: string | null
  /** Floating player hidden by its close button for this subject key (see `dismissKey`). */
  dismissedKey: string | null
  /** What's in the OS picture-in-picture window, if anything. */
  poppedOut: PipTarget | null
}

export const usePip = create<PipState>()(() => ({
  watchOrder: [],
  cameraPick: null,
  dismissedKey: null,
  poppedOut: null,
}))

/**
 * Key the close button dismisses. All cameras share one key: the camera subject follows whoever speaks,
 * and a dismissed camera player shouldn't pop back up every time someone else talks.
 */
export function dismissKey(t: PipTarget): string {
  return t.kind === 'stream' ? `stream:${t.identity}` : 'camera'
}

/** The video track for a target in the current participant list (null when it's gone). */
export function trackFor(list: ParticipantView[], t: PipTarget): VideoTrack | null {
  const v = list.find((p) => p.identity === t.identity)
  if (!v) return null
  return t.kind === 'stream' ? v.screenTrack : v.cameraTrack
}

/**
 * The floating player's subject: the most recently watched stream we have video for, else a remote
 * camera (the last one heard speaking, else the first). Never our own camera, and never our own native
 * stream (no local preview exists; its view has no screenTrack). Our own Chromium-engine preview is a
 * watched stream like any other.
 */
export function pickSubject(list: ParticipantView[], watchOrder: string[], cameraPick: string | null): PipSubject | null {
  for (let i = watchOrder.length - 1; i >= 0; i--) {
    const view = list.find((p) => p.identity === watchOrder[i])
    if (view?.screenTrack) return { kind: 'stream', identity: view.identity, view, track: view.screenTrack }
  }
  const cams = list.filter((p) => !p.isLocal && p.cameraTrack)
  const view = cams.find((p) => p.identity === cameraPick) ?? cams[0]
  if (view?.cameraTrack) return { kind: 'camera', identity: view.identity, view, track: view.cameraTrack }
  return null
}

export function dismissPip(t: PipTarget): void {
  usePip.setState({ dismissedKey: dismissKey(t) })
}

export function clearPipDismissed(): void {
  if (usePip.getState().dismissedKey) usePip.setState({ dismissedKey: null })
}

export function supportsPopOut(): boolean {
  return typeof document !== 'undefined' && document.pictureInPictureEnabled === true
}

/** Show a stream/camera in the OS picture-in-picture window. Call from a click (needs user activation). */
export function popOut(t: PipTarget): void {
  if (!supportsPopOut()) return
  usePip.setState({ poppedOut: { kind: t.kind, identity: t.identity } })
}

export function closePopOut(): void {
  if (usePip.getState().poppedOut) usePip.setState({ poppedOut: null })
  if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {})
}

export function isPoppedOut(p: PipTarget | null, t: PipTarget): boolean {
  return !!p && p.kind === t.kind && p.identity === t.identity
}

// ---------------------------------------------------------------------------------------------
// Bookkeeping driven by the participants / voice stores (module-level, so it runs whether or not the
// player is on screen).
// ---------------------------------------------------------------------------------------------

useParticipants.subscribe((s, prev) => {
  if (s.watching !== prev.watching) {
    const { watchOrder } = usePip.getState()
    const kept = watchOrder.filter((id) => s.watching[id])
    const added = Object.keys(s.watching).filter((id) => !watchOrder.includes(id))
    if (added.length || kept.length !== watchOrder.length) usePip.setState({ watchOrder: [...kept, ...added] })
  }
  if (s.list !== prev.list) {
    const { cameraPick } = usePip.getState()
    const speaker = s.list.find((p) => !p.isLocal && p.cameraTrack && isAudiblySpeaking(p))
    if (speaker && speaker.identity !== cameraPick) usePip.setState({ cameraPick: speaker.identity })
  }
})

useVoice.subscribe((s, prev) => {
  const active = s.status === 'connected' || s.status === 'reconnecting' || s.status === 'connecting'
  const wasActive = prev.status === 'connected' || prev.status === 'reconnecting' || prev.status === 'connecting'
  // Left voice or switched channels: start fresh (watching is reset by the session too).
  if ((wasActive && !active) || s.channelId !== prev.channelId) {
    usePip.setState({ watchOrder: [], cameraPick: null, dismissedKey: null })
    if (usePip.getState().poppedOut) closePopOut()
  }
})
