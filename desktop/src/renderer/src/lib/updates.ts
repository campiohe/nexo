// Auto-update state mirrored from the main process (window.nexo.updates). Shared by the update banner,
// Settings → App and anything else that wants to know about a pending update.
import { create } from 'zustand'
import type { UpdateState } from '../../../preload/api'
import { useVoice } from '../voice/session'

interface UpdatesStore {
  /** null until the first state arrives, or when not running in Electron. */
  state: UpdateState | null
  /** A manual check from Settings is running. */
  checking: boolean
  /** The banner was dismissed (until the next app start; the update still installs on quit). */
  bannerDismissed: boolean
  check(): Promise<void>
  install(): void
  /** Test build: switch to regular releases (Settings → App). */
  leaveTestBuilds(): Promise<void>
  dismissBanner(): void
}

const bridge = () => (typeof window.nexo?.updates?.getState === 'function' ? window.nexo.updates : null)

export const hasUpdates = (): boolean => bridge() !== null

export const useUpdates = create<UpdatesStore>()((set, get) => ({
  state: null,
  checking: false,
  bannerDismissed: false,
  async check() {
    const updates = bridge()
    if (!updates || get().checking) return
    set({ checking: true })
    try {
      set({ state: await updates.check() })
    } catch (err) {
      console.warn('[updates] check failed', err)
    } finally {
      set({ checking: false })
    }
  },
  install() {
    bridge()?.install()
  },
  async leaveTestBuilds() {
    const updates = bridge()
    if (!updates || get().checking) return
    set({ checking: true })
    try {
      set({ state: await updates.leaveTestBuilds() })
    } catch (err) {
      console.warn('[updates] leaving test builds failed', err)
    } finally {
      set({ checking: false })
    }
  },
  dismissBanner: () => set({ bannerDismissed: true }),
}))

/** True while connected (or connecting) to a voice channel: restarting would leave the call. */
export function useInCall(): boolean {
  return useVoice((s) => !!s.channelId && (s.status === 'connecting' || s.status === 'connected' || s.status === 'reconnecting'))
}

// Subscribe once at module load (StrictMode can't duplicate it).
const updates = bridge()
if (updates) {
  updates.onState((state) => useUpdates.setState({ state }))
  updates
    .getState()
    // A pushed state may already have arrived; it is at least as new as this one.
    .then((state) => {
      if (!useUpdates.getState().state) useUpdates.setState({ state })
    })
    .catch((err: unknown) => console.warn('[updates] getState failed', err))
}
