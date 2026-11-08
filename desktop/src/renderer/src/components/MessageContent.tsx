import { memo, useState } from 'react'
import type { Attachment } from '@shared/protocol'
import { linkify, openExternal } from '../lib/linkify'
import { attachmentUrl } from '../net/attachments'

/** Message text rendered as React text nodes (never HTML). Newlines are preserved via CSS (pre-wrap). */
export const MessageContent = memo(function MessageContent({ text }: { text: string }) {
  const parts = linkify(text)
  return (
    <div className="message-content">
      {parts.map((p, i) =>
        p.type === 'text' ? (
          <span key={i}>{p.text}</span>
        ) : (
          <a
            key={i}
            href={p.href}
            className="message-link"
            title={p.href}
            onClick={(e) => {
              e.preventDefault()
              openExternal(p.href)
            }}
            onAuxClick={(e) => {
              e.preventDefault()
              if (e.button === 1) openExternal(p.href)
            }}
          >
            {p.text}
          </a>
        ),
      )}
    </div>
  )
})

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
