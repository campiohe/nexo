import { useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import { create } from 'zustand'
import type { Channel, ChannelType, VoiceState } from '@shared/protocol'
import { sortChannels, useApp } from '../store/app'
import { request } from '../net/socket'
import { isUnread, mentionBadgeLabel, unreadMentions, useUnread } from '../store/unread'
import '../styles/mentions.css'
import { anchorOf, useUi, type AnchorRect } from '../store/ui'
import { STATUS_LABEL, usePresence, usePresenceStore } from '../store/presence'
import { activityLabel } from '../lib/activity'
import { StatusMenuPopover } from './StatusMenu'
import { GamepadIcon } from './peopleIcons'
import { useStreamViewers } from './voice/StreamViewers'
import { EyeIcon } from './voice/icons'
import { useShallow } from 'zustand/react/shallow'
import { useVoice } from '../voice/session'
import { moveToChannel, nudge } from '../voice/voiceActions'
import { speakingIdentities, useParticipants } from '../voice/participants'
import { VoiceControls } from './voice/VoiceControls'
import { SoundboardHost } from './voice/Soundboard'
import '../styles/channel-reorder.css'
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

/**
 * Dragging a channel row up / down within its section to reorder (admins / owner). A distinct dataTransfer
 * type from voice members, so both drags can target the same rows. `over` = where the drop line is.
 */
const useChannelDrag = create<{
  id: string | null
  type: ChannelType | null
  over: { id: string; after: boolean } | null
  /** The dragged row is dimmed one frame later, so the drag image isn't. */
  dimmed: string | null
}>()(() => ({ id: null, type: null, over: null, dimmed: null }))
const CHANNEL_DRAG_TYPE = 'application/x-nexo-channel'

function endChannelDrag() {
  useChannelDrag.setState({ id: null, type: null, over: null, dimmed: null })
}

function idsOfType(type: ChannelType): string[] {
  return useApp
    .getState()
    .channels.filter((c) => c.type === type)
    .map((c) => c.id)
}

/** `ids` with `id` moved before / after `targetId`; null when that changes nothing. */
function movedOrder(ids: string[], id: string, targetId: string, after: boolean): string[] | null {
  if (id === targetId || !ids.includes(id)) return null
  const rest = ids.filter((x) => x !== id)
  const at = rest.indexOf(targetId)
  if (at < 0) return null
  rest.splice(after ? at + 1 : at, 0, id)
  return rest.every((x, i) => x === ids[i]) ? null : rest
}

/** Optimistic: positions follow `ids` at once, and go back if the server refuses. */
async function reorderChannels(type: ChannelType, ids: string[]): Promise<void> {
  const before = new Map(
    useApp
      .getState()
      .channels.filter((c) => c.type === type)
      .map((c) => [c.id, c.position] as const),
  )
  const pos = new Map(ids.map((id, i) => [id, i] as const))
  const apply = (positions: Map<string, number>) =>
    useApp.setState((st) => ({
      channels: sortChannels(
        st.channels.map((c) => {
          const p = c.type === type ? positions.get(c.id) : undefined
          return p === undefined || p === c.position ? c : { ...c, position: p }
        }),
      ),
    }))
  apply(pos)
  try {
    await request('channel:reorder', { type, ids })
  } catch (err) {
    apply(before)
    toast(err, 'error')
  }
}

/** Alt+↑ / Alt+↓ on a focused channel row. */
function moveChannelBy(channel: Channel, delta: -1 | 1) {
  const ids = idsOfType(channel.type)
  const i = ids.indexOf(channel.id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= ids.length) return
  const next = movedOrder(ids, channel.id, ids[j], delta > 0)
  if (!next) return
  void reorderChannels(channel.type, next)
  // The row's DOM node moves, which can drop focus: put it back.
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>(`li[data-channel-id="${CSS.escape(channel.id)}"] .channel-main`)?.focus(),
  )
}

/** Drop handlers for a channel's <li>: a dragged channel of the same type, or (voice) a dragged member. */
function channelDropHandlers(channel: Channel) {
  const voice = channel.type === 'voice' ? voiceDropHandlers(channel.id) : null
  const channelDrag = (e: DragEvent<HTMLLIElement>) => {
    const d = useChannelDrag.getState()
    return !!d.id && d.type === channel.type && e.dataTransfer.types.includes(CHANNEL_DRAG_TYPE) ? d.id : null
  }
  return {
    onDragOver(e: DragEvent<HTMLLIElement>) {
      const dragged = channelDrag(e)
      if (!dragged) return voice?.onDragOver(e)
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const r = e.currentTarget.getBoundingClientRect()
      const after = e.clientY > r.top + r.height / 2
      // No line where dropping wouldn't change anything (right next to itself).
      const over = movedOrder(idsOfType(channel.type), dragged, channel.id, after) ? { id: channel.id, after } : null
      const cur = useChannelDrag.getState().over
      if (cur?.id !== over?.id || cur?.after !== over?.after) useChannelDrag.setState({ over })
    },
    onDragLeave(e: DragEvent<HTMLLIElement>) {
      if (useChannelDrag.getState().id) {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        if (useChannelDrag.getState().over?.id === channel.id) useChannelDrag.setState({ over: null })
        return
      }
      voice?.onDragLeave(e)
    },
    onDrop(e: DragEvent<HTMLLIElement>) {
      const dragged = channelDrag(e)
      if (!dragged) return voice?.onDrop(e)
      e.preventDefault()
      const over = useChannelDrag.getState().over
      endChannelDrag()
      if (!over || over.id !== channel.id) return
      const next = movedOrder(idsOfType(channel.type), dragged, channel.id, over.after)
      if (next) void reorderChannels(channel.type, next)
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
      <SoundboardHost />
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
  // A string so the selector result compares by value ('' = no unread mention).
  const mentionLabel = useUnread((s) => {
    if (channel.type !== 'text') return ''
    const m = unreadMentions(s, channel.id)
    return m.count > 0 ? mentionBadgeLabel(m) : ''
  })
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
  const dropEdge = useChannelDrag((s) => (s.over?.id === channel.id ? (s.over.after ? 'after' : 'before') : null))
  const dragging = useChannelDrag((s) => s.dimmed === channel.id)
  const canDrag = canManage && !renaming

  return (
    <li
      className={
        [dropTarget && 'is-drop-target', dropEdge && `is-drop-${dropEdge}`, dragging && 'is-dragging'].filter(Boolean).join(' ') ||
        undefined
      }
      data-channel-id={channel.id}
      {...channelDropHandlers(channel)}
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
          draggable={canDrag}
          onDragStart={
            canDrag
              ? (e) => {
                  e.dataTransfer.setData(CHANNEL_DRAG_TYPE, channel.id)
                  e.dataTransfer.effectAllowed = 'move'
                  useChannelDrag.setState({ id: channel.id, type: channel.type, over: null })
                  requestAnimationFrame(() => {
                    if (useChannelDrag.getState().id === channel.id) useChannelDrag.setState({ dimmed: channel.id })
                  })
                }
              : undefined
          }
          onDragEnd={canDrag ? endChannelDrag : undefined}
          onKeyDown={
            canDrag
              ? (e) => {
                  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
                  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
                  e.preventDefault()
                  moveChannelBy(channel, e.key === 'ArrowUp' ? -1 : 1)
                }
              : undefined
          }
          onContextMenu={
            canManage
              ? (e) => {
                  e.preventDefault()
                  setRenaming(true)
                }
              : undefined
          }
        >
          <button
            className="channel-main"
            onClick={() => openChannel(channel)}
            aria-current={selected ? 'page' : undefined}
            aria-keyshortcuts={canDrag ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
          >
            <Icon size={17} className="channel-icon" />
            <span className="channel-name">{channel.name}</span>
            {unread && <span className="sr-only">, unread messages</span>}
            {mentionLabel && (
              <span
                className="mention-badge"
                title={mentionLabel === '@' ? 'You were mentioned' : `${mentionLabel} unread mention${mentionLabel === '1' ? '' : 's'}`}
              >
                {mentionLabel}
                <span className="sr-only">, mentioned</span>
              </span>
            )}
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
  // "Playing X" under each name (yours from this device, others' from the server).
  const presences = usePresenceStore((s) => s.byUser)
  const ownActivity = usePresenceStore((s) => s.activity)
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
          const hint = isSelf
            ? 'Click for your profile; right-click or drag to move to another channel'
            : 'Click for profile; right-click for volume and actions'
          const activity = isSelf ? ownActivity : (presences[v.userId]?.activity ?? null)
          return (
            <li
              key={v.userId}
              className={`voice-member people-click ${hasMenu ? 'has-menu' : ''} ${speaking.includes(v.userId) ? 'is-speaking' : ''} ${activity ? 'has-activity' : ''}`}
              // Left click: profile card; right click: the voice user card (volume, wake up, move).
              onClick={(e) => useUi.getState().openProfileCard(v.userId, anchorOf(e.currentTarget), 'right')}
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
              title={hasMenu ? (canDrag && !isSelf ? `${hint}; drag to move` : hint) : 'Click for your profile'}
            >
              <Avatar user={user} size={20} animate={speaking.includes(v.userId)} />
              {activity ? (
                <span className="voice-member-text">
                  <span className="voice-member-name">{name}</span>
                  <span className="people-sub voice-member-activity" title={activityLabel(activity)}>
                    <GamepadIcon size={11} />
                    <span className="people-sub-text">{activity.name}</span>
                  </span>
                </span>
              ) : (
                <span className="voice-member-name">{name}</span>
              )}
              {speaking.includes(v.userId) && <span className="voice-member-sr">, speaking</span>}
              {canNudge && (
                <button
                  className="icon-btn voice-member-nudge"
                  onClick={(e) => {
                    e.stopPropagation()
                    void nudge(v.userId)
                  }}
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

/** "👁 3" next to the LIVE pill: how many people watch this stream (nothing when nobody does). */
function ViewerCount({ streamerId }: { streamerId: string }) {
  const viewers = useStreamViewers(streamerId)
  const users = useApp((s) => s.users)
  if (viewers.length === 0) return null
  const label = `${viewers.length} watching: ${viewers.map((id) => users[id]?.name ?? 'Someone').join(', ')}`
  return (
    <span className="voice-viewers" title={label} aria-label={label} role="img">
      <EyeIcon size={12} />
      {viewers.length}
    </span>
  )
}

export function VoiceBadges({ state }: { state: VoiceState }) {
  return (
    <span className="voice-badges">
      {state.streaming && <span className="live-pill" title="Streaming">LIVE</span>}
      {state.streaming && <ViewerCount streamerId={state.userId} />}
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
  const menuOpen = useUi((s) => s.statusMenuOpen)
  const presence = usePresence(me?.id)
  const panelRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  const connected = connection === 'connected'
  const statusText = me?.statusText?.trim()
  const activity = presence?.activity ?? null
  const status = !connected
    ? connection === 'reconnecting'
      ? 'Reconnecting…'
      : connection === 'connecting'
        ? 'Connecting…'
        : 'Offline'
    : activity
      ? activityLabel(activity)
      : statusText || STATUS_LABEL[presence?.status ?? 'online']

  const toggleMenu = () => {
    const ui = useUi.getState()
    if (ui.statusMenuOpen) return ui.openStatusMenu(false)
    if (panelRef.current) setAnchor(anchorOf(panelRef.current))
    ui.openStatusMenu(true)
  }

  return (
    <div className="user-panel" ref={panelRef}>
      <button
        type="button"
        className="user-panel-me"
        onClick={toggleMenu}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        title="Set your status"
      >
        <Avatar user={me} size={32} online={connected} status={presence?.status} />
        <span className="user-panel-text">
          <span className="user-panel-name">{me?.name}</span>
          <span
            className={`user-panel-status ${!connected ? 'is-warn' : activity ? 'is-activity' : ''}`}
            title={connected ? status : undefined}
          >
            {status}
          </span>
        </span>
      </button>
      <button className="icon-btn" onClick={() => openSettings(true)} aria-label="Settings" title="Settings">
        <GearIcon size={18} />
      </button>
      {menuOpen && anchor && <StatusMenuPopover anchor={anchor} />}
    </div>
  )
}
