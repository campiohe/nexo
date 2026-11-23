import { useEffect } from 'react'
import { useApp } from '../store/app'
import { useUi } from '../store/ui'
import { VoiceStage } from './voice/VoiceStage'
import { PipLayer } from './voice/PipPlayer'
import { canManageChannels } from '../lib/permissions'
import { Sidebar } from './Sidebar'
import { TextChannel } from './TextChannel'
import { MemberList } from './MemberList'
import { UpdateBanner } from './UpdateBanner'
import { AccessRequestBanners } from './AccessRequestBanners'
import { HashIcon, SpeakerIcon, UsersIcon } from './icons'
import { PinIcon } from './chatIcons'
import { SearchBox } from './SearchBox'
import { SearchPanel } from './SearchPanel'
import { PinsPanel } from './PinsPanel'
import { useChatPanels } from '../store/chatPanels'
import { domKeyMatches, isTypingTarget } from '../lib/keybinds'
import { useKeybinds } from '../voice/prefs'
import '../styles/panels.css'

export function MainLayout() {
  const membersOpen = useUi((s) => s.membersOpen)
  // Search results / pinned messages take the member list's place while open.
  const panel = useChatPanels((s) => s.panel)
  useChatShortcuts()
  return (
    <div className={`layout ${panel ? 'has-panel' : membersOpen ? 'has-members' : ''}`}>
      <Sidebar />
      <Center />
      {panel === 'search' ? <SearchPanel /> : panel === 'pins' ? <PinsPanel /> : membersOpen && <MemberList />}
      <PipLayer />
    </div>
  )
}

/** Ctrl/Cmd+F focuses the search box; Escape closes the side panel (unless something else uses it). */
function useChatShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const ui = useUi.getState()
      const blocked = ui.settingsOpen || ui.switcherOpen || !!document.querySelector('.modal-backdrop')
      if (e.code === 'KeyF' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        // A user-assigned in-app shortcut on the same keys wins.
        const { quickSwitcher, openSettings } = useKeybinds.getState()
        if (blocked || domKeyMatches(quickSwitcher, e) || domKeyMatches(openSettings, e)) return
        e.preventDefault()
        useChatPanels.getState().focusSearch()
        return
      }
      if (e.key === 'Escape' && useChatPanels.getState().panel && !blocked) {
        const t = e.target
        // Typing somewhere else (composer, editor) keeps its own Escape.
        if (isTypingTarget(t) && !(t instanceof Element && t.closest('.side-panel'))) return
        e.preventDefault()
        useChatPanels.getState().openPanel(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function Center() {
  const channel = useApp((s) => s.channels.find((c) => c.id === s.selectedChannelId) ?? null)
  const serverName = useApp((s) => s.serverName)
  const connection = useApp((s) => s.connection)
  const membersOpen = useUi((s) => s.membersOpen)
  const toggleMembers = useUi((s) => s.toggleMembers)
  const panel = useChatPanels((s) => s.panel)
  const membersShown = membersOpen && !panel
  const canManage = useApp((s) => canManageChannels(s.me))

  useEffect(() => {
    document.title = channel ? `${channel.type === 'text' ? '#' : ''}${channel.name} · ${serverName}` : serverName
  }, [channel, serverName])

  return (
    <main className="center">
      <header className="center-header">
        {channel && (
          <>
            {channel.type === 'text' ? <HashIcon size={20} className="center-icon" /> : <SpeakerIcon size={20} className="center-icon" />}
            <h1 className="center-title">{channel.name}</h1>
          </>
        )}
        <span className="grow" />
        {channel?.type === 'text' && (
          <button
            className={`icon-btn ${panel === 'pins' ? 'is-active' : ''}`}
            onClick={() => useChatPanels.getState().openPanel(panel === 'pins' ? null : 'pins')}
            aria-pressed={panel === 'pins'}
            aria-label="Pinned messages"
            title="Pinned messages"
          >
            <PinIcon size={18} />
          </button>
        )}
        <button
          className={`icon-btn ${membersShown ? 'is-active' : ''}`}
          onClick={() => {
            // With a side panel open, the button brings the member list back.
            if (panel) {
              useChatPanels.getState().openPanel(null)
              if (!membersOpen) toggleMembers()
            } else {
              toggleMembers()
            }
          }}
          aria-pressed={membersShown}
          aria-label="Toggle member list"
          title={membersShown ? 'Hide members' : 'Show members'}
        >
          <UsersIcon size={18} />
        </button>
        <SearchBox />
      </header>
      {connection !== 'connected' && (
        <div className="connection-banner" role="status">
          <span className="spinner" />
          {connection === 'error' ? 'Connection problem. Retrying…' : 'Reconnecting…'}
        </div>
      )}
      <AccessRequestBanners />
      <UpdateBanner />
      <div className="center-body">
        {!channel ? (
          <div className="empty-state">
            <h2>No channel selected</h2>
            <p className="muted">
              {canManage ? 'Create a channel with the + button in the sidebar.' : 'There are no channels yet. Ask an admin to create one.'}
            </p>
          </div>
        ) : channel.type === 'text' ? (
          <TextChannel key={channel.id} channelId={channel.id} channelName={channel.name} />
        ) : (
          <VoiceStage key={channel.id} channelId={channel.id} />
        )}
      </div>
    </main>
  )
}
