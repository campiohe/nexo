import { memo, useState, type CSSProperties } from 'react'
import type { Attachment } from '@shared/protocol'
import { openExternal } from '../lib/linkify'
import { UNKNOWN_USER } from '../lib/mentions'
import { tokenizeContent, type ContentNode } from '../lib/messageTokens'
import { attachmentUrl } from '../net/attachments'
import { useApp } from '../store/app'
import '../styles/mentions.css'

/**
 * Message text rendered as React text nodes (never HTML): links, `<@id>` mentions and `@everyone` become
 * elements, everything else stays text. Newlines are preserved via CSS (pre-wrap).
 */
export const MessageContent = memo(function MessageContent({ text }: { text: string }) {
  const nodes = tokenizeContent(text)
  return <div className="message-content">{nodes.map((n, i) => renderNode(n, i))}</div>
})

function renderNode(n: ContentNode, key: number) {
  switch (n.type) {
    case 'text':
      return <span key={key}>{n.text}</span>
    case 'link':
      return (
        <a
          key={key}
          href={n.href}
          className="message-link"
          title={n.href}
          onClick={(e) => {
            e.preventDefault()
            openExternal(n.href)
          }}
          onAuxClick={(e) => {
            e.preventDefault()
            if (e.button === 1) openExternal(n.href)
          }}
        >
          {n.text}
        </a>
      )
    case 'mention':
      return <MentionPill key={key} userId={n.userId} />
    case 'everyone':
      return (
        <span key={key} className="mention is-everyone" title="Notifies everyone">
          @everyone
        </span>
      )
  }
}

/** "@Name" in the user's colour (live: follows renames and colour changes); brighter when it's you. */
function MentionPill({ userId }: { userId: string }) {
  const user = useApp((s) => s.users[userId])
  const isMe = useApp((s) => s.me?.id === userId)
  if (!user) return <span className="mention is-unknown">@{UNKNOWN_USER}</span>
  return (
    <span
      className={`mention ${isMe ? 'is-me' : ''}`}
      style={{ '--mention-color': user.color } as CSSProperties}
      title={user.name}
    >
      @{user.name}
    </span>
  )
}

/** Display box per image: one image may be large, several share a compact grid. */
const SINGLE_MAX = { w: 400, h: 300 }
const GRID_MAX = { w: 200, h: 200 }

/** Size that fits `att` in `max` without upscaling (keeps the aspect ratio). */
function fit(att: Attachment, max: { w: number; h: number }) {
  const scale = Math.min(1, max.w / att.width, max.h / att.height)
  return { width: Math.max(1, Math.round(att.width * scale)), height: Math.max(1, Math.round(att.height * scale)) }
}

/**
 * A message's images, laid out from the stored dimensions so nothing shifts while they load.
 * `serverUrl` builds the image URLs; `onOpen` shows one full size.
 */
export const MessageAttachments = memo(function MessageAttachments({
  attachments,
  serverUrl,
  onOpen,
}: {
  attachments: Attachment[]
  serverUrl: string | null
  onOpen(att: Attachment): void
}) {
  if (attachments.length === 0) return null
  const max = attachments.length === 1 ? SINGLE_MAX : GRID_MAX
  return (
    <div className={`message-images ${attachments.length > 1 ? 'is-grid' : ''}`}>
      {attachments.map((att) => (
        <MessageImage key={att.id} att={att} url={attachmentUrl(serverUrl, att.id)} size={fit(att, max)} onOpen={onOpen} />
      ))}
    </div>
  )
})

function MessageImage({
  att,
  url,
  size,
  onOpen,
}: {
  att: Attachment
  url: string | null
  size: { width: number; height: number }
  onOpen(att: Attachment): void
}) {
  const [broken, setBroken] = useState(false)
  return (
    <button
      className={`message-image ${broken ? 'is-broken' : ''}`}
      // Width plus aspect-ratio (not a fixed height) so narrow windows scale the box down instead of cropping.
      style={{ width: size.width, aspectRatio: `${att.width} / ${att.height}` }}
      onClick={() => !broken && onOpen(att)}
      aria-label={`Open image (${att.width}×${att.height})`}
      title={broken ? "This image couldn't be loaded" : 'Click to enlarge'}
    >
      {url && !broken ? (
        <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} />
      ) : (
        <span className="message-image-missing">Image unavailable</span>
      )}
    </button>
  )
}
