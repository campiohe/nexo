// Local UI state (not synced with the server).
import { create } from 'zustand'

const KEY_MEMBERS = 'nexo:ui:membersOpen'

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

/** Per-user volume popover (opened by right-clicking someone who is in voice). */
export interface VolumePopoverState {
  userId: string
  /** Viewport coordinates (clientX/clientY) of the right-click. */
  anchor: { x: number; y: number }
}

interface UiState {
  settingsOpen: boolean
  switcherOpen: boolean
  membersOpen: boolean
  volumePopover: VolumePopoverState | null
  openSettings(open: boolean): void
  openSwitcher(open: boolean): void
  toggleMembers(): void
  openVolumePopover(userId: string, anchor: { x: number; y: number }): void
  closeVolumePopover(): void
}

export const useUi = create<UiState>()((set, get) => ({
  settingsOpen: false,
  switcherOpen: false,
  membersOpen: readBool(KEY_MEMBERS, true),
  volumePopover: null,
  openSettings: (open) => set({ settingsOpen: open }),
  openVolumePopover: (userId, anchor) => set({ volumePopover: { userId, anchor } }),
  closeVolumePopover: () => set({ volumePopover: null }),
  openSwitcher: (open) => set({ switcherOpen: open }),
  toggleMembers: () => {
    const next = !get().membersOpen
    set({ membersOpen: next })
    try {
      localStorage.setItem(KEY_MEMBERS, next ? '1' : '0')
    } catch {
      /* ignore */
    }
  },
}))
