import { memo } from 'react'
import { linkify, openExternal } from '../lib/linkify'

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
