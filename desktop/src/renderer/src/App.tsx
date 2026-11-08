// App shell: onboarding vs main layout (sidebar | center | members).
import { useEffect } from 'react'
import { useApp } from './store/app'
import { useUi } from './store/ui'
import { Onboarding } from './components/Onboarding'
import { Splash } from './components/Splash'
import { MainLayout } from './components/MainLayout'
import { SettingsModal } from './components/SettingsModal'
import { QuickSwitcher } from './components/QuickSwitcher'
import { Toasts } from './components/Toasts'
import { UserVolumePopover } from '@renderer/components/voice/UserVolumePopover'
import { domKeyMatches, domMouseMatches, isTypingTarget, typesText } from './lib/keybinds'
import type { Keybind } from '../../preload/api'
import { useKeybinds } from './voice/prefs'
import { setHotkeyHandler, type GlobalToggleAction } from './voice/ptt'
import { useVoice } from './voice/session'

let started = false

/** Global hotkeys other than push to talk (SPEC §13.2), from the system-wide hook or the in-window fallback. */
function runGlobalHotkey(action: GlobalToggleAction): void {
  const v = useVoice.getState()
  switch (action) {
    case 'toggleMute':
      v.toggleMute()
      break
    case 'toggleDeafen':
      v.toggleDeafen()
      break
    case 'leaveVoice':
      if (v.channelId) void v.leave()
      break
    case 'toggleShare':
      if (v.sharing) {
        void v.stopShare()
        break
      }
      if ((v.status !== 'connected' && v.status !== 'reconnecting') || v.shareStarting) break
      v.openSharePicker()
      // Bring Nexo to the front (even from the tray) so the picker is visible over a game.
      window.nexo?.hotkeys?.focusWindow()
      break
  }
}

/** In-app shortcuts only fire in the main view; bare keys (no Ctrl/Alt/Cmd) don't fire while typing. */
function inAppHit(binding: Keybind | null, e: KeyboardEvent | MouseEvent): boolean {
  if (!binding || useApp.getState().view !== 'main' || !useApp.getState().me) return false
  if (e instanceof KeyboardEvent) return domKeyMatches(binding, e) && !(isTypingTarget(e.target) && typesText(binding))
  return domMouseMatches(binding, e)
}

function runInAppShortcut(e: KeyboardEvent | MouseEvent): void {
  const { quickSwitcher, openSettings } = useKeybinds.getState()
  const repeat = e instanceof KeyboardEvent && e.repeat
  if (inAppHit(quickSwitcher, e)) {
    e.preventDefault()
    if (repeat) return
    const ui = useUi.getState()
    ui.openSwitcher(!ui.switcherOpen)
  } else if (inAppHit(openSettings, e)) {
    e.preventDefault()
    if (!repeat) useUi.getState().openSettings(true)
  }
}

export function App() {
  const view = useApp((s) => s.view)
  const hasSession = useApp((s) => s.me !== null)
  const volumePopover = useUi((s) => s.volumePopover)

  useEffect(() => {
    if (started) return // StrictMode runs effects twice in dev.
    started = true
    void useApp.getState().init()
  }, [])

  useEffect(() => setHotkeyHandler(runGlobalHotkey), [])

  useEffect(() => {
    window.addEventListener('keydown', runInAppShortcut)
    window.addEventListener('mousedown', runInAppShortcut)
    return () => {
      window.removeEventListener('keydown', runInAppShortcut)
      window.removeEventListener('mousedown', runInAppShortcut)
    }
  }, [])

  return (
    <div className="app">
      {view === 'boot' ? (
        <div className="splash" />
      ) : view === 'onboarding' ? (
        <Onboarding />
      ) : hasSession ? (
        <>
          <MainLayout />
          <SettingsModal />
          <QuickSwitcher />
          {volumePopover && (
            <UserVolumePopover
              // Remount per open so a new right-click repositions it from scratch.
              key={`${volumePopover.userId}:${volumePopover.anchor.x}:${volumePopover.anchor.y}`}
              userId={volumePopover.userId}
              anchor={volumePopover.anchor}
              onClose={() => useUi.getState().closeVolumePopover()}
            />
          )}
        </>
      ) : (
        <Splash />
      )}
      <Toasts />
    </div>
  )
}
