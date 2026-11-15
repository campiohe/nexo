import { Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { Attachment } from '@shared/protocol'
import { openExternal } from '../lib/linkify'
import { UNKNOWN_USER } from '../lib/mentions'
import { parseContent, type Block, type Inline } from '../lib/messageTokens'
import { highlightRanges } from '../lib/highlight'
import { toast } from '../lib/toast'
import { attachmentUrl } from '../net/attachments'
import { useApp } from '../store/app'
import '../styles/mentions.css'
import '../styles/markdown.css'

/**
 * Message text with Discord-style markdown (lib/messageTokens), rendered as React elements and text nodes
 * only (never HTML). A lone paragraph stays inline, so MessageList's "(edited)" follows the text; code
 * blocks, quotes, headings and lists are blocks. Newlines are preserved via CSS (pre-wrap).
 */
export const MessageContent = memo(function MessageContent({
  text,
  highlight,
}: {
  text: string
  /** Search words (lib/highlight searchWords) to mark in the text. Keep the array stable (memo). */
  highlight?: readonly string[]
}) {
  const parsed = useMemo(() => parseContent(text), [text])
  const hl = highlight?.length ? highlight : undefined
  return (
    <div className={`message-content ${parsed.jumbo ? 'is-jumbo' : ''}`}>{renderBlocks(parsed.blocks, 'b', hl)}</div>
  )
})

/** `text` with the search hits wrapped in <mark> (text nodes and elements only). */
function marked(text: string, hl: readonly string[] | undefined, key: string): ReactNode {
  if (!hl) return text
  const ranges = highlightRanges(text, hl)
  if (ranges.length === 0) return text
  const out: ReactNode[] = []
  let last = 0
  ranges.forEach(([s, e], i) => {
    if (s > last) out.push(text.slice(last, s))
    out.push(
      <mark key={`${key}m${i}`} className="search-hit">
        {text.slice(s, e)}
      </mark>,
    )
    last = e
  })
  if (last < text.length) out.push(text.slice(last))
  return out
}

function renderBlocks(blocks: Block[], key: string, hl?: readonly string[]): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}${i}`
    switch (b.type) {
      case 'paragraph':
        return <span key={k}>{renderInline(b.children, k, hl)}</span>
      case 'heading':
        return (
          <div key={k} className={`md-heading md-h${b.level}`} role="heading" aria-level={b.level}>
            {renderInline(b.children, k, hl)}
          </div>
        )
      case 'list':
        return (
          <ul key={k} className="md-list">
            {b.items.map((item, j) => (
              <li key={j}>{renderInline(item, `${k}.${j}`, hl)}</li>
            ))}
          </ul>
        )
      case 'quote':
        return (
          <blockquote key={k} className="md-quote">
            {renderBlocks(b.children, `${k}.`, hl)}
          </blockquote>
        )
      case 'codeblock':
        return <CodeBlock key={k} lang={b.lang} text={b.text} hl={hl} />
    }
  })
}

function renderInline(nodes: Inline[], key: string, hl?: readonly string[]): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}-${i}`
    switch (n.type) {
      case 'text':
        return hl ? <Fragment key={k}>{marked(n.text, hl, k)}</Fragment> : n.text
      case 'link':
        return (
          <a
            key={k}
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
            {marked(n.text, hl, k)}
          </a>
        )
      case 'mention':
        return <MentionPill key={k} userId={n.userId} />
      case 'everyone':
        return (
          <span key={k} className="mention is-everyone" title="Notifies everyone">
            @everyone
          </span>
        )
      case 'code':
        return (
          <code key={k} className="md-code">
            {marked(n.text, hl, k)}
          </code>
        )
      case 'bold':
        return <strong key={k}>{renderInline(n.children, k, hl)}</strong>
      case 'italic':
        return <em key={k}>{renderInline(n.children, k, hl)}</em>
      case 'underline':
        return (
          <span key={k} className="md-underline">
            {renderInline(n.children, k, hl)}
          </span>
        )
      case 'strike':
        return <s key={k}>{renderInline(n.children, k, hl)}</s>
      case 'spoiler':
        return <Spoiler key={k}>{renderInline(n.children, k, hl)}</Spoiler>
    }
  })
}

/** Hidden until clicked (or Enter / Space when focused); links and mentions inside don't react until then. */
function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false)
  if (shown) return <span className="md-spoiler is-shown">{children}</span>
  const reveal = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setShown(true)
  }
  return (
    <span
      className="md-spoiler"
      role="button"
      tabIndex={0}
      aria-label="Spoiler, press to reveal"
      title="Spoiler: click to reveal"
      // Capture: a hidden link or mention must not be clicked through the cover.
      onClickCapture={reveal}
      onAuxClickCapture={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') reveal(e)
      }}
    >
      <span className="md-spoiler-content" aria-hidden="true">
        {children}
      </span>
    </span>
  )
}

/** A fenced code block: monospace, scrolls sideways, language tag and a Copy button on hover. */
function CodeBlock({ lang, text, hl }: { lang: string; text: string; hl?: readonly string[] }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      toast("Couldn't copy to the clipboard", 'error')
    }
  }
  return (
    <div className="md-codeblock">
      <pre tabIndex={0} aria-label={lang ? `${lang} code` : 'Code'}>
        <code>{marked(text, hl, 'c')}</code>
      </pre>
      <div className="md-codeblock-bar">
        {lang && <span className="md-codeblock-lang">{lang}</span>}
        <button className={`md-codeblock-copy ${copied ? 'is-done' : ''}`} onClick={() => void copy()} aria-label="Copy code">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
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
