// A message as shown in the side panels (search results, pinned messages): channel and date, author,
// content (markdown, with search hits marked) and actions. Clicking it jumps to the message.
import { memo, type MouseEvent, type ReactNode } from 'react'
import type { Message } from '@shared/protocol'
import { useApp } from '../store/app'
import { useChatPanels } from '../store/chatPanels'
import { formatDay, formatFull, formatTime } from '../lib/time'
import { Avatar } from './Avatar'
import { MessageContent } from './MessageContent'
import { HashIcon } from './icons'

export const PanelMessage = memo(function PanelMessage({
  msg,
  highlight,
  showChannel,
  actions,
}: {
  msg: Message
  highlight?: readonly string[]
  showChannel?: boolean
  /** Extra buttons (e.g. Unpin), shown with "Jump" on hover. */
  actions?: ReactNode
}) {
  const author = useApp((s) => s.users[msg.userId])
  const channelName = useApp((s) => s.channels.find((c) => c.id === msg.channelId)?.name)
  const images = msg.attachments?.length ?? 0
  const jump = () => useChatPanels.getState().jumpTo(msg)
  const onClick = (e: MouseEvent) => {
    // Links, spoilers, mentions and the action buttons do their own thing.
    if ((e.target as HTMLElement).closest('a, button, .md-spoiler, .mention, .md-codeblock')) return
    if (window.getSelection()?.toString()) return // selecting text to copy
    jump()
  }
  const when = `${formatDay(msg.createdAt)} ${formatTime(msg.createdAt)}`
  return (
    <article className="panel-msg" onClick={onClick} aria-label={`Message from ${author?.name ?? 'Unknown user'}, ${when}`}>
      {showChannel && (
        <div className="panel-msg-channel">
          <HashIcon size={12} />
          <span>{channelName ?? 'deleted-channel'}</span>
        </div>
      )}
      <div className="panel-msg-row">
        <Avatar user={author} size={32} />
        <div className="panel-msg-body">
          <div className="panel-msg-head">
            <span className="panel-msg-author" style={{ color: author?.color }}>
              {author?.name ?? 'Unknown user'}
            </span>
            <time className="panel-msg-time" dateTime={new Date(msg.createdAt).toISOString()} title={formatFull(msg.createdAt)}>
              {when}
            </time>
          </div>
          {msg.content && <MessageContent text={msg.content} highlight={highlight} />}
          {images > 0 && <div className="panel-msg-meta">{images === 1 ? '1 image' : `${images} images`}</div>}
        </div>
      </div>
      <div className="panel-msg-actions">
        {actions}
        <button type="button" className="panel-msg-btn" onClick={jump}>
          Jump
        </button>
      </div>
    </article>
  )
})
