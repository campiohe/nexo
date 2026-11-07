import { useEffect } from 'react'
import { useApp } from '../store/app'
import { useUi } from '../store/ui'
import { useVoice } from '../voice/session'
import { VoiceStage } from './voice/VoiceStage'
import { toast } from '../lib/toast'
import { Sidebar } from './Sidebar'
import { TextChannel } from './TextChannel'
import { MemberList } from './MemberList'
import { UpdateBanner } from './UpdateBanner'
import { HashIcon, SpeakerIcon, UsersIcon } from './icons'

export function MainLayout() {
  const membersOpen = useUi((s) => s.membersOpen)
  return (
    <div className={`layout ${membersOpen ? 'has-members' : ''}`}>
      <Sidebar />
      <Center />
      {membersOpen && <MemberList />}
    </div>
  )
}

function Center() {
  const channel = useApp((s) => s.channels.find((c) => c.id === s.selectedChannelId) ?? null)
  const serverName = useApp((s) => s.serverName)
  const connection = useApp((s) => s.connection)
  const membersOpen = useUi((s) => s.membersOpen)
  const toggleMembers = useUi((s) => s.toggleMembers)
  const inThisVoice = useVoice((s) => !!channel && s.channelId === channel.id)

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
            {channel.type === 'voice' && !inThisVoice && (
              <button
                className="btn btn-primary btn-sm"
                onClick={() =>
                  useVoice
                    .getState()
                    .join(channel.id)
                    .catch((err) => toast(err, 'error'))
                }
              >
                Join voice
              </button>
            )}
          </>
        )}
        <span className="grow" />
        <kbd className="kbd-hint" title="Jump to a channel">
          Ctrl K
        </kbd>
        <button
          className={`icon-btn ${membersOpen ? 'is-active' : ''}`}
          onClick={toggleMembers}
          aria-pressed={membersOpen}
          aria-label="Toggle member list"
          title={membersOpen ? 'Hide members' : 'Show members'}
        >
          <UsersIcon size={18} />
        </button>
      </header>
      {connection !== 'connected' && (
        <div className="connection-banner" role="status">
          <span className="spinner" />
          {connection === 'error' ? 'Connection problem — retrying…' : 'Reconnecting…'}
        </div>
      )}
      <UpdateBanner />
      <div className="center-body">
        {!channel ? (
          <div className="empty-state">
            <h2>No channel selected</h2>
            <p className="muted">Create a channel with the + button in the sidebar.</p>
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
