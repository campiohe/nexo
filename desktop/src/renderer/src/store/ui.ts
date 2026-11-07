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

interface UiState {
  settingsOpen: boolean
  switcherOpen: boolean
  membersOpen: boolean
  openSettings(open: boolean): void
  openSwitcher(open: boolean): void
  toggleMembers(): void
}

export const useUi = create<UiState>()((set, get) => ({
  settingsOpen: false,
  switcherOpen: false,
  membersOpen: readBool(KEY_MEMBERS, true),
  openSettings: (open) => set({ settingsOpen: open }),
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
