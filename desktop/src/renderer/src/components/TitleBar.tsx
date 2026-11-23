// The window's title bar, drawn by the page on every view. On Windows it replaces the native one: main hides it
// (titleBarStyle 'hidden') and Windows draws only the caption buttons on the right, in the colors lib/appearance.ts
// sends (titleBarOverlay); the bar is the window's drag region. Elsewhere the OS keeps its frame and this is just
// the app's top bar.
import { useApp } from '../store/app'
import { useUi } from '../store/ui'
import { useAppearance } from '../lib/appearance'
import { useKeybinds } from '../voice/prefs'
import { useT } from '../i18n'
import { NexoMark, SearchIcon } from './icons'
import '../styles/titlebar.css'

const customFrame = window.nexo?.platform === 'win32'

export function TitleBar() {
  const t = useT()
  const view = useApp((s) => s.view)
  const inServer = useApp((s) => s.view === 'main' && s.me !== null)
  const serverName = useApp((s) => s.serverName)
  const style = useAppearance((s) => s.titleBar)
  const switcherKey = useKeybinds((s) => s.quickSwitcher)
  const title = inServer && serverName ? serverName : 'Nexo'

  return (
    <header className={`titlebar ${customFrame ? 'is-window-frame' : ''}`}>
      <div className="titlebar-brand">
        <NexoMark size={16} />
        <span className="titlebar-title" title={title}>
          {view === 'boot' ? '' : title}
        </span>
      </div>
      <div className="titlebar-center">
        {inServer && style === 'search' && (
          <button type="button" className="titlebar-jump" onClick={() => useUi.getState().openSwitcher(true)}>
            <SearchIcon size={14} />
            <span className="titlebar-jump-text">{t('Jump to a channel')}</span>
            {switcherKey && <kbd className="titlebar-jump-key">{switcherKey.label}</kbd>}
          </button>
        )}
      </div>
      {/* Space for the caption buttons Windows draws over the bar. */}
      <div className="titlebar-controls" aria-hidden="true" />
    </header>
  )
}
