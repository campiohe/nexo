import { useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import { create } from 'zustand'
import type { Channel, ChannelType, VoiceState } from '@shared/protocol'
import { useApp } from '../store/app'
import { isUnread, useUnread } from '../store/unread'
import { useUi } from '../store/ui'
import { useShallow } from 'zustand/react/shallow'
import { useVoice } from '../voice/session'
import { moveToChannel, nudge } from '../voice/voiceActions'
import { speakingIdentities, useParticipants } from '../voice/participants'
import { VoiceControls } from './voice/VoiceControls'
import { toast } from '../lib/toast'
import { canManageChannels, canMoveMember } from '../lib/permissions'
import { Avatar } from './Avatar'
import { ConfirmDialog } from './Modal'
import { BellIcon, GearIcon, HashIcon, HeadphonesOffIcon, MicOffIcon, NexoMark, PencilIcon, PlusIcon, SpeakerIcon, TrashIcon, VideoIcon } from './icons'

/**
 * Dragging a voice member onto another voice channel to move them (admins / owner). The dragged user lives
 * here rather than in dataTransfer, which can't be read during dragover.
 */
const useVoiceDrag = create<{ userId: string | null; from: string | null; over: string | null }>()(() => ({
  userId: null,
  from: null,
  over: null,
}))
const VOICE_MEMBER_DRAG_TYPE = 'application/x-nexo-voice-member'

function endVoiceDrag() {
  useVoiceDrag.setState({ userId: null, from: null, over: null })
}

/** Drop target handlers for a voice channel (its row and its member list). Same channel: not a target. */
function voiceDropHandlers(channelId: string) {
  const accepts = () => {
    const d = useVoiceDrag.getState()
    return !!d.userId && d.from !== channelId
  }
  return {
    onDragOver(e: DragEvent<HTMLLIElement>) {
      if (!accepts()) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (useVoiceDrag.getState().over !== channelId) useVoiceDrag.setState({ over: channelId })
    },
    onDragLeave(e: DragEvent<HTMLLIElement>) {
      // Ignore moves between the channel's own children.
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
      if (useVoiceDrag.getState().over === channelId) useVoiceDrag.setState({ over: null })
    },
    onDrop(e: DragEvent<HTMLLIElement>) {
      const { userId } = useVoiceDrag.getState()
      if (!userId || !accepts()) return
      e.preventDefault()
      endVoiceDrag()
      moveToChannel(userId, channelId).catch((err) => toast(err, 'error'))
    },
  }
}

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
  const [creatingOpen, setCreating] = useState(false)
  const createChannel = useApp((s) => s.createChannel)
  const canManage = useApp((s) => canManageChannels(s.me))
  // Demoted while the form is open: it just goes away (and doesn't come back on a later promotion).
  const creating = creatingOpen && canManage
  useEffect(() => {
    if (!canManage) setCreating(false)
  }, [canManage])

  return (
    <section className="channel-section">
      <div className="section-header">
        <span className="section-label">{label}</span>
        {canManage && (
          <button
            className="icon-btn section-add"
            onClick={() => setCreating((v) => !v)}
            aria-label={`Create ${type} channel`}
            title={`Create ${type} channel`}
          >
            <PlusIcon size={16} />
          </button>
        )}
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
  const unread = useUnread((s) => channel.type === 'text' && isUnread(s, channel.id))
  const canManage = useApp((s) => canManageChannels(s.me))
  const [renamingOpen, setRenaming] = useState(false)
  const [confirmingOpen, setConfirming] = useState(false)
  // Demoted mid-edit: drop the rename form and the delete confirmation.
  const renaming = renamingOpen && canManage
  const confirming = confirmingOpen && canManage
  useEffect(() => {
    if (canManage) return
    setRenaming(false)
    setConfirming(false)
  }, [canManage])
  const Icon = channel.type === 'text' ? HashIcon : SpeakerIcon
  const dropTarget = useVoiceDrag((s) => channel.type === 'voice' && s.over === channel.id)

  return (
    <li
      className={dropTarget ? 'is-drop-target' : undefined}
      {...(channel.type === 'voice' ? voiceDropHandlers(channel.id) : {})}
    >
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
          className={`channel-row ${selected ? 'is-selected' : ''} ${inThisVoice ? 'is-connected' : ''} ${unread ? 'is-unread' : ''}`}
          onContextMenu={
            canManage
              ? (e) => {
                  e.preventDefault()
                  setRenaming(true)
                }
              : undefined
          }
        >
          <button className="channel-main" onClick={() => openChannel(channel)} aria-current={selected ? 'page' : undefined}>
            <Icon size={17} className="channel-icon" />
            <span className="channel-name">{channel.name}</span>
            {unread && <span className="sr-only">, unread messages</span>}
          </button>
          {canManage && (
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
          )}
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

const NO_SPEAKERS: string[] = []

function VoiceMembers({ channelId }: { channelId: string }) {
  const voice = useApp((s) => s.voice)
  const users = useApp((s) => s.users)
  const me = useApp((s) => s.me)
  const meId = me?.id
  const hasOtherVoiceChannel = useApp((s) => s.channels.filter((c) => c.type === 'voice').length > 1)
  // Speaking info only exists for the LiveKit room we're in, so only this channel can light up.
  const connectedHere = useVoice(
    (s) => s.channelId === channelId && (s.status === 'connecting' || s.status === 'connected' || s.status === 'reconnecting'),
  )
  // Shallow-compared array: re-renders only when who is speaking changes, not on every LiveKit event.
  const speaking = useParticipants(useShallow((s) => (connectedHere ? speakingIdentities(s) : NO_SPEAKERS)))
  const members = voice.filter((v) => v.channelId === channelId)
  if (members.length === 0) return null
  return (
    <ul className="voice-members">
      {members
        .map((v) => ({ v, user: users[v.userId] }))
        .sort((a, b) => (a.user?.name ?? '').localeCompare(b.user?.name ?? ''))
        .map(({ v, user }) => {
          const isSelf = v.userId === meId
          // Staff drag people (themselves too) onto another voice channel; right-click opens the user card.
          const canDrag = hasOtherVoiceChannel && canMoveMember(me, user)
          const hasMenu = !isSelf || canDrag
          const canNudge = !isSelf && (v.muted || v.deafened)
          const name = user?.name ?? 'Unknown'
          const hint = isSelf ? 'Right-click or drag to move to another channel' : 'Right-click for volume and actions'
          return (
            <li
              key={v.userId}
              className={`voice-member ${hasMenu ? 'has-menu' : ''} ${speaking.includes(v.userId) ? 'is-speaking' : ''}`}
              onContextMenu={(e) => {
                // Your own mic level lives in Audio & video settings; your own card only has "Move to".
                if (!hasMenu) return
                e.preventDefault()
                useUi.getState().openVolumePopover(v.userId, { x: e.clientX, y: e.clientY })
              }}
              draggable={canDrag}
              onDragStart={
                canDrag
                  ? (e) => {
                      e.dataTransfer.setData(VOICE_MEMBER_DRAG_TYPE, v.userId)
                      e.dataTransfer.effectAllowed = 'move'
                      useVoiceDrag.setState({ userId: v.userId, from: channelId, over: null })
                    }
                  : undefined
              }
              onDragEnd={canDrag ? endVoiceDrag : undefined}
              title={hasMenu ? (canDrag && !isSelf ? `${hint}; drag to move` : hint) : undefined}
            >
              <Avatar user={user} size={20} />
              <span className="voice-member-name">{name}</span>
              {speaking.includes(v.userId) && <span className="voice-member-sr">, speaking</span>}
              {canNudge && (
                <button
                  className="icon-btn voice-member-nudge"
                  onClick={() => void nudge(v.userId)}
                  aria-label={`Wake up ${name}`}
                  title="Wake up"
                >
                  <BellIcon size={13} />
                </button>
              )}
              <VoiceBadges state={v} />
            </li>
          )
        })}
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
