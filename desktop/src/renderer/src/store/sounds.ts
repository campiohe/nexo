// The server's soundboard (docs/SPEC.md): from bootstrap, kept current by `sound:upsert` / `sound:deleted`
// (net/socket.ts). Session state: emptied on server change / sign out (resetSounds).
// No imports from store/app or net/socket: net/socket imports this module, store/app imports net/socket,
// so a top-level `useApp.subscribe` here ran while useApp was still undefined (blank window at startup).
import { create } from 'zustand'
import type { Sound } from '@shared/protocol'

interface SoundsState {
  /** False until a bootstrap with `sounds` (older servers have no soundboard). */
  supported: boolean
  /** Oldest first. */
  sounds: Sound[]
}

export const useSounds = create<SoundsState>()(() => ({ supported: false, sounds: [] }))

const byAge = (a: Sound, b: Sound) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)

export function setBootstrapSounds(list: Sound[] | undefined): void {
  useSounds.setState({ supported: Array.isArray(list), sounds: Array.isArray(list) ? [...list].sort(byAge) : [] })
}

export function upsertSound(s: Sound): void {
  if (!s || typeof s.id !== 'string') return
  useSounds.setState((st) => ({ supported: true, sounds: [...st.sounds.filter((x) => x.id !== s.id), s].sort(byAge) }))
}

export function removeSound(soundId: string): void {
  useSounds.setState((st) =>
    st.sounds.some((x) => x.id === soundId) ? { sounds: st.sounds.filter((x) => x.id !== soundId) } : {},
  )
}

export function findSound(soundId: string): Sound | undefined {
  return useSounds.getState().sounds.find((s) => s.id === soundId)
}

/** Another server, or signed out: the list belongs to the old session (store/app.ts, net/socket.ts, store/signin.ts). */
export function resetSounds(): void {
  useSounds.setState({ supported: false, sounds: [] })
}
