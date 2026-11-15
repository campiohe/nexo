// First frame of animated profile pictures, so avatars stay still unless hovered / speaking (an animating
// GIF costs CPU on every frame, and people play games while Nexo runs). Each picture URL is fetched (the
// URL is versioned and cached forever, so the animated <img> later hits the HTTP cache), its first frame
// decoded once and kept as a PNG blob: URL shared by every Avatar showing it.
//
// Cache: entries in use are never dropped; up to MAX_IDLE unused ones are kept (least recently used
// evicted first, revoking their blob: URL).
import { useCallback, useSyncExternalStore } from 'react'

export interface StillFrame {
  /** blob: URL of the first frame, once ready. */
  url: string | null
  /** The first frame couldn't be made (show the picture itself instead). */
  failed: boolean
}

interface Entry {
  snapshot: StillFrame
  refs: number
  listeners: Set<() => void>
}

const MAX_IDLE = 48
const NONE: StillFrame = { url: null, failed: false }
/** Map order = least recently released first. */
const cache = new Map<string, Entry>()

async function firstFrame(src: string): Promise<string> {
  const res = await fetch(src)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // createImageBitmap on an animated image decodes its first frame only.
  const bitmap = await createImageBitmap(await res.blob())
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0)
    return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }))
  } finally {
    bitmap.close()
  }
}

function entryFor(src: string): Entry {
  let entry = cache.get(src)
  if (entry) return entry
  const created: Entry = { snapshot: NONE, refs: 0, listeners: new Set() }
  cache.set(src, created)
  const settle = (snapshot: StillFrame) => {
    if (cache.get(src) !== created) {
      // Evicted while loading.
      if (snapshot.url) URL.revokeObjectURL(snapshot.url)
      return
    }
    created.snapshot = snapshot
    created.listeners.forEach((l) => l())
  }
  firstFrame(src).then(
    (url) => settle({ url, failed: false }),
    () => settle({ url: null, failed: true }),
  )
  entry = created
  return entry
}

function evictIdle(): void {
  let idle = 0
  for (const e of cache.values()) if (e.refs === 0) idle++
  for (const [src, e] of cache) {
    if (idle <= MAX_IDLE) break
    if (e.refs > 0) continue
    cache.delete(src)
    if (e.snapshot.url) URL.revokeObjectURL(e.snapshot.url)
    idle--
  }
}

function subscribe(src: string, listener: () => void): () => void {
  const entry = entryFor(src)
  entry.refs++
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
    entry.refs--
    if (entry.refs === 0 && cache.get(src) === entry) {
      // Most recently used goes last.
      cache.delete(src)
      cache.set(src, entry)
      evictIdle()
    }
  }
}

const noop = () => () => {}

/** The still first frame of the picture at `src` (null = not an animated picture: nothing to do). */
export function useStillFrame(src: string | null): StillFrame {
  const sub = useCallback((l: () => void) => (src ? subscribe(src, l) : noop()), [src])
  return useSyncExternalStore(sub, () => (src ? entryFor(src).snapshot : NONE))
}

// ---------------------------------------------------------------------------------------------

const reducedMotionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

function subscribeReducedMotion(listener: () => void): () => void {
  reducedMotionQuery?.addEventListener('change', listener)
  return () => reducedMotionQuery?.removeEventListener('change', listener)
}

/** The OS asks for reduced motion: animated pictures never play. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => !!reducedMotionQuery?.matches)
}
