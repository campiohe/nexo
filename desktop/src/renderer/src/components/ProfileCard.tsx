// Profile card: clicking someone's name or avatar (message authors, member list, sidebar voice members)
// opens it next to what was clicked. Banner in their color, avatar with status, name and role, custom
// status, what they're playing, the voice channel they're in (Join / Go to channel), and actions:
// Mention and Wake up for others; Edit profile and your status for yourself.
// State: store/ui.ts `profileCard`; rendered once by App.tsx (ProfileCardLayer).
import { useEffect, useState } from 'react'
import { useApp } from '../store/app'
import { useUi } from '../store/ui'
import { STATUS_LABEL, usePresence } from '../store/presence'
import { useVoice } from '../voice/session'
import { nudge } from '../voice/voiceActions'
import { hasRoles, roleOf } from '../lib/permissions'
import { formatElapsed, useNow } from '../lib/activity'
import { toast } from '../lib/toast'
import { Avatar } from './Avatar'
import { Floating } from './Floating'
import { RoleBadge } from './MembersSection'
import { CustomStatusEditor, StatusOptions } from './StatusMenu'
import { BellIcon, ChevronIcon, HeadphonesOffIcon, MicOffIcon, PencilIcon, SpeakerIcon } from './icons'
import { AtIcon, GamepadIcon, StatusDot } from './peopleIcons'
import '../styles/people.css'

export function ProfileCardLayer() {
  const card = useUi((s) => s.profileCard)
  if (!card) return null
  return (
    <ProfileCard
      // Remount per open so a new click places it from scratch.
      key={`${card.userId}:${card.anchor.left}:${card.anchor.top}`}
      userId={card.userId}
      anchor={card.anchor}
      side={card.side}
    />
  )
}

/** Appends "@Name " to the composer of the text channel on screen. False when there is none. */
function mentionInComposer(name: string): boolean {
  const el = document.querySelector<HTMLTextAreaElement>('textarea.composer-input')
  if (!el || el.disabled) return false
  el.focus()
  const end = el.value.length
  el.setSelectionRange(end, end)
  const text = `${end > 0 && !/\s$/.test(el.value) ? ' ' : ''}@${name} `
  // insertText goes through the textarea's input event (React's onChange) and keeps undo working.
  return document.execCommand('insertText', false, text)
}

function ProfileCard({ userId, anchor, side }: { userId: string; anchor: { left: number; top: number; right: number; bottom: number }; side: 'left' | 'right' | 'top' }) {
  const close = () => useUi.getState().closeProfileCard()
  const user = useApp((s) => s.users[userId])
  const isMe = useApp((s) => s.me?.id === userId)
  const roles = useApp((s) => hasRoles(s.me))
  const presence = usePresence(userId)
  const voiceState = useApp((s) => s.voice.find((v) => v.userId === userId))
  const voiceChannel = useApp((s) => (voiceState ? s.channels.find((c) => c.id === voiceState.channelId) : undefined))
  const myVoiceChannel = useVoice((s) => s.channelId)
  const textChannelOnScreen = useApp((s) => s.channels.some((c) => c.id === s.selectedChannelId && c.type === 'text'))
  const now = useNow(30_000)
  const [statusOpen, setStatusOpen] = useState(false)
  const [nudging, setNudging] = useState(false)

  // Removed account: nothing to show.
  useEffect(() => {
    if (!user) useUi.getState().closeProfileCard()
  }, [user])
  if (!user) return null

  const role = roleOf(user)
  const activity = presence?.activity ?? null
  // Like the member list: a custom status only shows while they're online.
  const statusText = presence ? user.statusText?.trim() : undefined
  const hereInVoice = !!voiceChannel && myVoiceChannel === voiceChannel.id
  const canNudge = !isMe && !!voiceState && (voiceState.muted || voiceState.deafened)

  function goToVoice() {
    if (!voiceChannel) return
    useApp.getState().selectChannel(voiceChannel.id)
    if (!hereInVoice) {
      useVoice
        .getState()
        .join(voiceChannel.id)
        .catch((err) => toast(err, 'error'))
    }
    close()
  }

  function mention() {
    close()
    if (!mentionInComposer(user.name)) toast('Open a text channel to mention someone', 'info')
  }

  async function wakeUp() {
    setNudging(true)
    const ok = await nudge(userId)
    setNudging(false)
    if (ok) close()
  }

  return (
    <Floating anchor={anchor} side={side} onClose={close} className="pc" label={`Profile of ${user.name}`}>
      <div className="pc-banner" style={{ background: user.color }} />
      <div className="pc-avatar">
        <Avatar user={user} size={80} online={!!presence} status={presence?.status} animate />
      </div>
      <div className="pc-body">
        <div className="pc-name-row">
          <span className="pc-name" title={user.name}>
            {user.name}
          </span>
          {roles && role !== 'member' && <RoleBadge role={role} />}
        </div>
        <div className="pc-presence">
          <StatusDot status={presence?.status ?? 'offline'} size={8} />
          {presence ? STATUS_LABEL[presence.status] : 'Offline'}
        </div>
        {statusText && <p className="pc-status-text">{statusText}</p>}

        {activity && (
          <section className="pc-section">
            <h4 className="pc-label">Playing</h4>
            <div className="pc-row">
              <span className="pc-row-icon">
                <GamepadIcon size={18} />
              </span>
              <span className="pc-row-text">
                <strong title={activity.name}>{activity.name}</strong>
                <span className="pc-row-sub">{formatElapsed(activity.startedAt, now)}</span>
              </span>
            </div>
          </section>
        )}

        {voiceState && voiceChannel && (
          <section className="pc-section">
            <h4 className="pc-label">In voice</h4>
            <div className="pc-row">
              <span className="pc-row-icon">
                <SpeakerIcon size={18} />
              </span>
              <span className="pc-row-text">
                <strong title={voiceChannel.name}>{voiceChannel.name}</strong>
                {(voiceState.deafened || voiceState.muted || voiceState.streaming) && (
                  <span className="pc-row-sub pc-voice-flags">
                    {voiceState.streaming && <span className="live-pill">LIVE</span>}
                    {voiceState.deafened ? (
                      <>
                        <HeadphonesOffIcon size={12} /> Deafened
                      </>
                    ) : voiceState.muted ? (
                      <>
                        <MicOffIcon size={12} /> Muted
                      </>
                    ) : null}
                  </span>
                )}
              </span>
              {(hereInVoice || !isMe) && (
                <button className={`btn btn-xs ${hereInVoice ? 'btn-ghost' : 'btn-primary'}`} onClick={goToVoice}>
                  {hereInVoice ? 'Go to channel' : 'Join'}
                </button>
              )}
            </div>
          </section>
        )}

        {isMe ? (
          <div className="pc-self">
            <button
              type="button"
              className="pc-status-toggle"
              aria-expanded={statusOpen}
              onClick={() => setStatusOpen((v) => !v)}
            >
              <StatusDot status={presence?.status ?? 'online'} />
              <span>{presence ? STATUS_LABEL[presence.status] : 'Set status'}</span>
              <ChevronIcon size={14} className={`pc-chevron ${statusOpen ? 'is-open' : ''}`} />
            </button>
            {statusOpen && (
              <div className="pc-status-menu">
                <CustomStatusEditor />
                <StatusOptions />
              </div>
            )}
            <div className="pc-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  close()
                  useUi.getState().openSettings(true, 'profile')
                }}
              >
                <PencilIcon size={14} /> Edit profile
              </button>
            </div>
          </div>
        ) : (
          (textChannelOnScreen || canNudge) && (
            <div className="pc-actions">
              {textChannelOnScreen && (
                <button className="btn btn-ghost btn-sm" onClick={mention} title={`Mention ${user.name} in this channel`}>
                  <AtIcon size={14} /> Mention
                </button>
              )}
              {canNudge && (
                <button className="btn btn-ghost btn-sm" onClick={() => void wakeUp()} disabled={nudging} title="Get their attention">
                  <BellIcon size={14} /> {nudging ? 'Waking up…' : 'Wake up'}
                </button>
              )}
            </div>
          )
        )}
      </div>
    </Floating>
  )
}
