// Chat display preferences (local to this device, localStorage). Surface them in Settings → Appearance:
//   const on = useChatPrefs((s) => s.linkPreviews); useChatPrefs.getState().setLinkPreviews(checked)
import { create } from 'zustand'

const KEY_LINK_PREVIEWS = 'nexo:chat:linkPreviews'

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* ignore (private mode, quota) */
  }
}

interface ChatPrefsState {
  /** Show link previews (YouTube, Spotify… cards) under messages. Default on. */
  linkPreviews: boolean
  setLinkPreviews(on: boolean): void
}

export const useChatPrefs = create<ChatPrefsState>()((set) => ({
  linkPreviews: readBool(KEY_LINK_PREVIEWS, true),
  setLinkPreviews: (on) => {
    writeBool(KEY_LINK_PREVIEWS, on)
    set({ linkPreviews: on })
  },
}))

/** Hook form for a settings checkbox: `const [on, setOn] = useLinkPreviewsPref()`. */
export function useLinkPreviewsPref(): [boolean, (on: boolean) => void] {
  const on = useChatPrefs((s) => s.linkPreviews)
  return [on, useChatPrefs.getState().setLinkPreviews]
}
