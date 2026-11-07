import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Channel, ChannelType, VoiceState } from '@shared/protocol'
import { useApp } from '../store/app'
import { useUi } from '../store/ui'
import { useVoice } from '../voice/session'
import { VoiceControls } from './voice/VoiceControls'
import { toast } from '../lib/toast'
import { Avatar } from './Avatar'
import { ConfirmDialog } from './Modal'
import { GearIcon, HashIcon, HeadphonesOffIcon, MicOffIcon, NexoMark, PencilIcon, PlusIcon, SpeakerIcon, TrashIcon, VideoIcon } from './icons'

/** Select a channel; for voice channels also join it (unless already in it). */
export function openChannel(channel: Channel) {
  useApp.getState().selectChannel(channel.id)
  if (channel.type === 'voice' && useVoice.getState().channelId !== channel.id) {
    useVoice
      .getState()
      .join(channel.id)
      .catch((err) => toast(err, 'error'))
  }
}

export function Sidebar() {
  const serverName = useApp((s) => s.serverName)
  const channels = useApp((s) => s.channels)
  const text = channels.filter((c) => c.type === 'text')
  const voice = channels.filter((c) => c.type === 'voice')

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <NexoMark size={26} />
        <span className="sidebar-title" title={serverName}>
          {serverName}
        </span>
      </header>
      <nav className="sidebar-scroll" aria-label="Channels">
        <ChannelSection type="text" label="Text" channels={text} />
        <ChannelSection type="voice" label="Voice" channels={voice} />
      </nav>
      <VoiceControls />
      <UserPanel />
    </aside>
  )
}

function ChannelSection({ type, label, channels }: { type: ChannelType; label: string; channels: Channel[] }) {
  const [creating, setCreating] = useState(false)
  const createChannel = useApp((s) => s.createChannel)

  return (
    <section className="channel-section">
      <div className="section-header">
        <span className="section-label">{label}</span>
        <button
          className="icon-btn section-add"
          onClick={() => setCreating((v) => !v)}
          aria-label={`Create ${type} channel`}
          title={`Create ${type} channel`}
        >
          <PlusIcon size={16} />
        </button>
      </div>
      {creating && (
        <InlineNameForm
          type={type}
          initial=""
          placeholder={type === 'text' ? 'new-channel' : 'New voice channel'}
          submitLabel="Create"
          onCancel={() => setCreating(false)}
          onSubmit={async (name) => {
            const channel = await createChannel(name, type)
            setCreating(false)
            if (type === 'text') useApp.getState().selectChannel(channel.id)
          }}
        />
      )}
      <ul className="channel-list">
        {channels.map((c) => (
          <ChannelRow key={c.id} channel={c} />
        ))}
        {channels.length === 0 && !creating && <li className="channel-empty">No {type} channels yet</li>}
      </ul>
    </section>
  )
}

function ChannelRow({ channel }: { channel: Channel }) {
  const selected = useApp((s) => s.selectedChannelId === channel.id)
  const renameChannel = useApp((s) => s.renameChannel)
  const deleteChannel = useApp((s) => s.deleteChannel)
  const inThisVoice = useVoice((s) => s.channelId === channel.id)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const Icon = channel.type === 'text' ? HashIcon : SpeakerIcon

  return (
    <li>
      {renaming ? (
        <InlineNameForm
          type={channel.type}
          initial={channel.name}
          placeholder={channel.name}
          submitLabel="Save"
          onCancel={() => setRenaming(false)}
          onSubmit={async (name) => {
            if (name !== channel.name) await renameChannel(channel.id, name)
            setRenaming(false)
          }}
        />
      ) : (
        <div
          className={`channel-row ${selected ? 'is-selected' : ''} ${inThisVoice ? 'is-connected' : ''}`}
          onContextMenu={(e) => {
            e.preventDefault()
            setRenaming(true)
          }}
        >
          <button className="channel-main" onClick={() => openChannel(channel)} aria-current={selected ? 'page' : undefined}>
            <Icon size={17} className="channel-icon" />
            <span className="channel-name">{channel.name}</span>
          </button>
          <span className="channel-actions">
            <button className="icon-btn" onClick={() => setRenaming(true)} aria-label={`Rename ${channel.name}`} title="Rename">
              <PencilIcon size={14} />
            </button>
            <button
              className="icon-btn danger"
              onClick={() => setConfirming(true)}
              aria-label={`Delete ${channel.name}`}
              title="Delete"
            >
              <TrashIcon size={14} />
            </button>
          </span>
        </div>
      )}
      {channel.type === 'voice' && <VoiceMembers channelId={channel.id} />}
      {confirming && (
        <ConfirmDialog
          title={`Delete ${channel.type === 'text' ? '#' : ''}${channel.name}?`}
          message={
            channel.type === 'text' ? (
              <>This deletes the channel and <strong>all of its messages</strong> for everyone. This can't be undone.</>
            ) : (
              <>Everyone in this voice channel will be disconnected. This can't be undone.</>
            )
          }
          confirmLabel="Delete channel"
          danger
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            try {
              await deleteChannel(channel.id)
              setConfirming(false)
            } catch (err) {
              toast(err, 'error')
            }
          }}
        />
      )}
    </li>
  )
}

function InlineNameForm(props: {
  type: ChannelType
  initial: string
  placeholder: string
  submitLabel: string
  onSubmit(name: string): Promise<void>
  onCancel(): void
}) {
  const [value, setValue] = useState(props.initial)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    const name = value.trim()
    if (!name) return props.onCancel()
    setBusy(true)
    try {
      await props.onSubmit(name)
    } catch (err) {
      toast(err, 'error')
      setBusy(false)
      ref.current?.focus()
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      props.onCancel()
    }
  }

  const Icon = props.type === 'text' ? HashIcon : SpeakerIcon
  return (
    <form className="inline-name-form" onSubmit={submit}>
      <Icon size={16} className="channel-icon" />
      <input
        ref={ref}
        className="input input-sm"
        value={value}
        // Mirror the server's normalization for text channels so what you see is what you get.
        onChange={(e) => setValue(props.type === 'text' ? e.target.value.toLowerCase().replace(/\s+/g, '-') : e.target.value)}
        onKeyDown={onKey}
        onBlur={() => !busy && !value.trim() && props.onCancel()}
        placeholder={props.placeholder}
        maxLength={32}
        disabled={busy}
        aria-label="Channel name"
      />
      <button className="btn btn-primary btn-xs" type="submit" disabled={busy || !value.trim()}>
        {props.submitLabel}
      </button>
    </form>
  )
}

function VoiceMembers({ channelId }: { channelId: string }) {
  const voice = useApp((s) => s.voice)
  const users = useApp((s) => s.users)
  const meId = useApp((s) => s.me?.id)
  const members = voice.filter((v) => v.channelId === channelId)
  if (members.length === 0) return null
  return (
    <ul className="voice-members">
      {members
        .map((v) => ({ v, user: users[v.userId] }))
        .sort((a, b) => (a.user?.name ?? '').localeCompare(b.user?.name ?? ''))
        .map(({ v, user }) => (
          <li
            key={v.userId}
            className={`voice-member ${v.userId !== meId ? 'has-menu' : ''}`}
            onContextMenu={(e) => {
              // Right-click someone else: their volume (your own mic level lives in Audio & video settings).
              if (v.userId === meId) return
              e.preventDefault()
              useUi.getState().openVolumePopover(v.userId, { x: e.clientX, y: e.clientY })
            }}
            title={v.userId !== meId ? 'Right-click to adjust volume' : undefined}
          >
            <Avatar user={user} size={20} />
            <span className="voice-member-name">{user?.name ?? 'Unknown'}</span>
            <VoiceBadges state={v} />
          </li>
        ))}
    </ul>
  )
}

export function VoiceBadges({ state }: { state: VoiceState }) {
  return (
    <span className="voice-badges">
      {state.streaming && <span className="live-pill" title="Streaming">LIVE</span>}
      {state.camera && (
        <span className="voice-badge" title="Camera on" aria-label="Camera on" role="img">
          <VideoIcon size={14} />
        </span>
      )}
      {state.deafened ? (
        <span className="voice-badge is-off" title="Deafened" aria-label="Deafened" role="img">
          <HeadphonesOffIcon size={14} />
        </span>
      ) : state.muted ? (
        <span className="voice-badge is-off" title="Muted" aria-label="Muted" role="img">
          <MicOffIcon size={14} />
        </span>
      ) : null}
    </span>
  )
}

function UserPanel() {
  const me = useApp((s) => s.me)
  const connection = useApp((s) => s.connection)
  const openSettings = useUi((s) => s.openSettings)
  const status =
    connection === 'connected' ? 'Online' : connection === 'reconnecting' ? 'Reconnecting…' : connection === 'connecting' ? 'Connecting…' : 'Offline'
  return (
    <div className="user-panel">
      <Avatar user={me} size={32} online={connection === 'connected'} />
      <div className="user-panel-text">
        <span className="user-panel-name">{me?.name}</span>
        <span className={`user-panel-status ${connection !== 'connected' ? 'is-warn' : ''}`}>{status}</span>
      </div>
      <button className="icon-btn" onClick={() => openSettings(true)} aria-label="Settings" title="Settings">
        <GearIcon size={18} />
      </button>
    </div>
  )
}
