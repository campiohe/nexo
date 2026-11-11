import type { User, VoiceState } from '@shared/protocol'
import { useApp } from '../store/app'
import { useUi } from '../store/ui'
import { hasRoles, roleOf } from '../lib/permissions'
import { Avatar } from './Avatar'
import { RoleBadge } from './MembersSection'
import { SpeakerIcon } from './icons'

export function MemberList() {
  const users = useApp((s) => s.users)
  const online = useApp((s) => s.online)
  const voice = useApp((s) => s.voice)
  const channels = useApp((s) => s.channels)
  const meId = useApp((s) => s.me?.id)
  // Servers older than roles send none: show no badges there.
  const roles = useApp((s) => hasRoles(s.me))

  const voiceByUser = new Map(voice.map((v) => [v.userId, v]))
  const all = Object.values(users).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const on = all.filter((u) => online[u.id])
  const off = all.filter((u) => !online[u.id])
  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? 'voice'

  const renderUser = (u: User, isOnline: boolean) => {
    const v: VoiceState | undefined = voiceByUser.get(u.id)
    const canAdjust = !!v && u.id !== meId
    const role = roleOf(u)
    return (
      <li
        key={u.id}
        className={`member ${isOnline ? '' : 'is-offline'} ${canAdjust ? 'has-menu' : ''}`}
        onContextMenu={
          canAdjust
            ? (e) => {
                e.preventDefault()
                useUi.getState().openVolumePopover(u.id, { x: e.clientX, y: e.clientY })
              }
            : undefined
        }
        title={canAdjust ? 'Right-click to adjust volume' : undefined}
      >
        <Avatar user={u} size={30} online={isOnline} />
        <div className="member-text">
          <span className="member-name-row">
            <span className="member-name">
              {u.name}
              {u.id === meId && <span className="member-you"> (you)</span>}
            </span>
            {roles && role !== 'member' && <RoleBadge role={role} />}
          </span>
          {v && (
            <span className="member-sub">
              <SpeakerIcon size={12} /> {channelName(v.channelId)}
            </span>
          )}
        </div>
        {v?.streaming && <span className="live-pill">LIVE</span>}
      </li>
    )
  }

  return (
    <aside className="members" aria-label="Members">
      <div className="members-scroll">
        <h3 className="members-heading">Online — {on.length}</h3>
        <ul className="member-list">{on.map((u) => renderUser(u, true))}</ul>
        {off.length > 0 && (
          <>
            <h3 className="members-heading">Offline — {off.length}</h3>
            <ul className="member-list">{off.map((u) => renderUser(u, false))}</ul>
          </>
        )}
      </div>
    </aside>
  )
}
