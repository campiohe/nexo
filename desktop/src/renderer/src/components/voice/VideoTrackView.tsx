// Owner: workstream D. Attaches a LiveKit video track to a <video> element for as long as it's mounted.
// With adaptiveStream, LiveKit observes the element's size/visibility and only receives what's shown.
import { useEffect, useRef, useState } from 'react'
import type { VideoTrack } from '../../voice/participants'

export interface VideoStats {
  width: number
  height: number
  fps: number
}

interface Props {
  track: VideoTrack
  fit: 'contain' | 'cover'
  mirror?: boolean
  className?: string
  /** Poll resolution / frame rate once per second. */
  onStats?(stats: VideoStats | null): void
  /** Receives the <video> element once mounted (and null on unmount), e.g. for picture-in-picture. */
  onElement?(el: HTMLVideoElement | null): void
}

export function VideoTrackView({ track, fit, mirror, className, onStats, onElement }: Props) {
  const ref = useRef<HTMLVideoElement>(null)
  const statsRef = useRef(onStats)
  statsRef.current = onStats
  const wantStats = !!onStats
  const elementRef = useRef(onElement)
  elementRef.current = onElement

  useEffect(() => {
    elementRef.current?.(ref.current)
    return () => elementRef.current?.(null)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    track.attach(el)
    return () => {
      track.detach(el)
    }
  }, [track])

  useEffect(() => {
    if (!wantStats) return
    const el = ref.current
    if (!el) return
    let lastFrames = el.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    let lastAt = performance.now()
    const id = window.setInterval(() => {
      const frames = el.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
      const now = performance.now()
      const fps = ((frames - lastFrames) * 1000) / Math.max(1, now - lastAt)
      lastFrames = frames
      lastAt = now
      statsRef.current?.(el.videoWidth ? { width: el.videoWidth, height: el.videoHeight, fps: Math.round(fps) } : null)
    }, 1000)
    return () => window.clearInterval(id)
  }, [wantStats, track])

  return (
    <video
      ref={ref}
      className={`vx-video ${className ?? ''}`}
      style={{ objectFit: fit, transform: mirror ? 'scaleX(-1)' : undefined }}
      autoPlay
      playsInline
      muted
    />
  )
}

/** Small hook for a stats readout next to a VideoTrackView. */
export function useVideoStats() {
  const [stats, setStats] = useState<VideoStats | null>(null)
  return [stats, setStats] as const
}
