// Message content -> a flat list of nodes for MessageContent. Text-only: nothing here ever becomes HTML.
// Passes run in order, each splitting the remaining `text` nodes further: links first (a URL may contain
// "@everyone"; `<@id>` can't be inside one, URLs stop at angle brackets), then mentions. More passes
// (markdown, emoji…) can be added to PASSES later.
import { EVERYONE_RE, MENTION_TOKEN_RE } from '@shared/protocol'
import { linkify } from './linkify'

export type ContentNode =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'mention'; userId: string }
  | { type: 'everyone' }

type Pass = (text: string) => ContentNode[]

const linkPass: Pass = (text) => linkify(text)

const MENTION_OR_EVERYONE = new RegExp(`${MENTION_TOKEN_RE.source}|${EVERYONE_RE.source}`, 'gu')

const mentionPass: Pass = (text) => {
  if (!text.includes('@')) return [{ type: 'text', text }]
  const out: ContentNode[] = []
  let last = 0
  for (const m of text.matchAll(MENTION_OR_EVERYONE)) {
    const start = m.index ?? 0
    if (start > last) out.push({ type: 'text', text: text.slice(last, start) })
    out.push(m[1] ? { type: 'mention', userId: m[1] } : { type: 'everyone' })
    last = start + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

const PASSES: Pass[] = [linkPass, mentionPass]

export function tokenizeContent(text: string): ContentNode[] {
  let nodes: ContentNode[] = [{ type: 'text', text }]
  for (const pass of PASSES) nodes = nodes.flatMap((n) => (n.type === 'text' ? pass(n.text) : [n]))
  return nodes.filter((n) => n.type !== 'text' || n.text !== '')
}
