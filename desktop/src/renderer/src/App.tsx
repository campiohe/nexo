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

let started = false

export function App() {
  const view = useApp((s) => s.view)
  const hasSession = useApp((s) => s.me !== null)

  useEffect(() => {
    if (started) return // StrictMode runs effects twice in dev.
    started = true
    void useApp.getState().init()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        if (useApp.getState().view !== 'main' || !useApp.getState().me) return
        e.preventDefault()
        const ui = useUi.getState()
        ui.openSwitcher(!ui.switcherOpen)
      } else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        if (useApp.getState().view !== 'main' || !useApp.getState().me) return
        e.preventDefault()
        useUi.getState().openSettings(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
        </>
      ) : (
        <Splash />
      )}
      <Toasts />
    </div>
  )
}
