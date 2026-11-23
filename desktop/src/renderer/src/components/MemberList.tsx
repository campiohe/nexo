import type { Presence, Role, User, VoiceState } from '@shared/protocol'
import { DEFAULT_PRESENCE } from '@shared/protocol'
import { useApp } from '../store/app'
import { anchorOf, useUi } from '../store/ui'
import { usePresence, usePresenceStore } from '../store/presence'
import { activityLabel } from '../lib/activity'
import { GamepadIcon } from './peopleIcons'
import '../styles/people.css'
import { canMoveMember, hasRoles, roleOf } from '../lib/permissions'
import { Avatar } from './Avatar'
import { SpeakerIcon } from './icons'
import { useT } from '../i18n'

export function MemberList() {
  const t = useT()
  const users = useApp((s) => s.users)
  const online = useApp((s) => s.online)
  const voice = useApp((s) => s.voice)
  const channels = useApp((s) => s.channels)
  const me = useApp((s) => s.me)
  const meId = me?.id
  // Servers older than roles send none: show no badges there.
  const roles = useApp((s) => hasRoles(s.me))
  const presences = usePresenceStore((s) => s.byUser)
  const ownPresence = usePresence(meId)

  const voiceByUser = new Map(voice.map((v) => [v.userId, v]))
  const all = Object.values(users).sort((a, b) => a.name.localeCompare(b.name, t.locale, { sensitivity: 'base' }))
  const on = all.filter((u) => online[u.id])
  const off = all.filter((u) => !online[u.id])
  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? t('voice // fallback channel name')
  const hasOtherVoiceChannel = channels.filter((c) => c.type === 'voice').length > 1

  const renderUser = (u: User, isOnline: boolean) => {
    const v: VoiceState | undefined = voiceByUser.get(u.id)
    // The voice user card: volume and actions for others; for yourself only "Move to" (admins / owner).
    const canAdjust = !!v && (u.id !== meId || (hasOtherVoiceChannel && canMoveMember(me, u)))
    const role = roleOf(u)
    const presence: Presence | null = !isOnline ? null : u.id === meId ? ownPresence : (presences[u.id] ?? DEFAULT_PRESENCE)
    const activity = presence?.activity ?? null
    const statusText = isOnline ? u.statusText?.trim() : undefined
    // Second line: what they're playing, else their custom status, else the voice channel they're in.
    const sub = activity ? (
      <span className="people-sub" title={activityLabel(activity, t)}>
        <GamepadIcon size={12} />
        <span className="people-sub-text">
          {t.rich('Playing <b>{game}</b>', { game: activity.name, b: (c) => <strong>{c}</strong> })}
        </span>
      </span>
    ) : statusText ? (
      <span className="people-sub" title={statusText}>
        <span className="people-sub-text">{statusText}</span>
      </span>
    ) : null
    return (
      <li
        key={u.id}
        className={`member people-click ${isOnline ? '' : 'is-offline'} ${canAdjust ? 'has-menu' : ''}`}
        onClick={(e) => useUi.getState().openProfileCard(u.id, anchorOf(e.currentTarget), 'left')}
        onContextMenu={
          canAdjust
            ? (e) => {
                e.preventDefault()
                useUi.getState().openVolumePopover(u.id, { x: e.clientX, y: e.clientY })
              }
            : undefined
        }
        title={
          canAdjust
            ? u.id === meId
              ? t('Right-click to move to another channel')
              : t('Right-click for volume and actions')
            : undefined
        }
      >
        <Avatar user={u} size={30} online={isOnline} status={presence?.status} />
        <div className="member-text">
          <span className="member-name-row">
            <span className="member-name">
              {u.name}
              {u.id === meId && <span className="member-you"> {t('(you)')}</span>}
            </span>
            {roles && role !== 'member' && <RoleMark role={role} />}
          </span>
          {sub ??
            (v && (
              <span className="member-sub">
                <SpeakerIcon size={12} /> {channelName(v.channelId)}
              </span>
            ))}
        </div>
        {v?.streaming && <span className="live-pill">{t('LIVE')}</span>}
        {v && sub && (
          <span
            className="member-voice-icon"
            title={t('In {channel}', { channel: channelName(v.channelId) })}
            aria-label={t('In {channel}', { channel: channelName(v.channelId) })}
            role="img"
          >
            <SpeakerIcon size={13} />
          </span>
        )}
      </li>
    )
  }

  return (
    <aside className="members" aria-label={t('Members')}>
      <div className="members-scroll">
        <h3 className="members-heading">{t('Online · {count}', { count: on.length })}</h3>
        <ul className="member-list">{on.map((u) => renderUser(u, true))}</ul>
        {off.length > 0 && (
          <>
            <h3 className="members-heading">{t('Offline · {count}', { count: off.length })}</h3>
            <ul className="member-list">{off.map((u) => renderUser(u, false))}</ul>
          </>
        )}
      </div>
    </aside>
  )
}

/** Owner / admin next to a name: a small icon (crown / shield) with an accessible label instead of a pill. */
function RoleMark({ role }: { role: Exclude<Role, 'member'> }) {
  const t = useT()
  const label = role === 'owner' ? t('Server owner') : t('Admin')
  return (
    <span className={`member-role is-${role}`} title={label} aria-label={label} role="img">
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {role === 'owner' ? (
          <path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z" />
        ) : (
          <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z" />
        )}
      </svg>
    </span>
  )
}
