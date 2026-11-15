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

/** Where a floating card opens: next to this element's box (viewport coordinates). */
export interface AnchorRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** The profile card (opened by clicking someone's name or avatar). */
export interface ProfileCardState {
  userId: string
  anchor: AnchorRect
  /** Which side of the anchor to open on (it flips when there's no room). */
  side: 'left' | 'right' | 'top'
}

/** Settings sections that can be opened directly (SettingsModal's tab ids). */
export type SettingsTab = 'profile' | 'av' | 'keybinds' | 'notifications' | 'activity' | 'app' | 'members' | 'server'

export function anchorOf(el: Element): AnchorRect {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

/** A just-closed card isn't reopened by the click that closed it (pointerdown closes, click would reopen). */
let lastClosed: { userId: string; at: number } | null = null
let statusMenuClosedAt = 0

interface UiState {
  /** Section shown when Settings opens (and while it's open). */
  settingsTab: SettingsTab
  setSettingsTab(tab: SettingsTab): void
  profileCard: ProfileCardState | null
  openProfileCard(userId: string, anchor: AnchorRect, side?: ProfileCardState['side']): void
  closeProfileCard(): void
  /** Status menu of the user panel (bottom left), anchored there. */
  statusMenuOpen: boolean
  openStatusMenu(open: boolean): void
  settingsOpen: boolean
  switcherOpen: boolean
  membersOpen: boolean
  volumePopover: VolumePopoverState | null
  /** `tab`: also switch to that section. */
  openSettings(open: boolean, tab?: SettingsTab): void
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
  openSettings: (open, tab) => set(tab ? { settingsOpen: open, settingsTab: tab } : { settingsOpen: open }),
  settingsTab: 'profile',
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  profileCard: null,
  openProfileCard: (userId, anchor, side = 'right') => {
    if (lastClosed?.userId === userId && Date.now() - lastClosed.at < 300) return
    set({ profileCard: { userId, anchor, side }, statusMenuOpen: false, volumePopover: null })
  },
  closeProfileCard: () => {
    const cur = get().profileCard
    if (!cur) return
    lastClosed = { userId: cur.userId, at: Date.now() }
    set({ profileCard: null })
  },
  statusMenuOpen: false,
  openStatusMenu: (open) => {
    if (open) {
      if (Date.now() - statusMenuClosedAt < 300) return
      set({ statusMenuOpen: true, profileCard: null })
    } else if (get().statusMenuOpen) {
      statusMenuClosedAt = Date.now()
      set({ statusMenuOpen: false })
    }
  },
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
