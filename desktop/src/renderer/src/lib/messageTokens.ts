// Message content -> a small markdown tree for MessageContent (a Discord-flavoured subset). Text-only:
// nothing here ever becomes HTML; MessageContent turns every node into React elements and text nodes.
//
// Blocks: ```fenced code``` (anywhere, optional language on the first line), `> ` quote lines and `>>> `
// (rest of the message), `# `..`### ` headings, `- ` / `* ` bullet lists, and paragraphs (newlines kept).
// Inline: `code` / ``code``, **bold**, *italic* / _italic_, __underline__, ~~strike~~, ||spoiler||, links,
// `<@id>` mentions and @everyone, backslash escapes. Code is never parsed further (no mentions in it).
//
// Inline formatting uses a delimiter stack (as in CommonMark's emphasis algorithm) instead of regexes, so
// any input (e.g. 4000 asterisks) is parsed in roughly linear time. Underscores inside words (snake_case)
// never open or close; links, mentions and code spans are atoms that formatting can't cut through.
import { EMOJI_RE, EVERYONE_RE, MENTION_TOKEN_RE } from '@shared/protocol'

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'mention'; userId: string }
  | { type: 'everyone' }
  | { type: 'code'; text: string }
  | { type: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'; children: Inline[] }

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { type: 'list'; items: Inline[][] }
  | { type: 'quote'; children: Block[] }
  | { type: 'codeblock'; lang: string; text: string }

export interface ParsedContent {
  blocks: Block[]
  /** Only 1-3 emoji (and spaces): shown large. The text is then a single paragraph with one text node. */
  jumbo: boolean
}

export function parseContent(text: string): ParsedContent {
  if (isJumbo(text)) return { blocks: [{ type: 'paragraph', children: [{ type: 'text', text: text.trim() }] }], jumbo: true }
  return { blocks: parseBlocks(text, false), jumbo: false }
}

// ── Jumbo emoji ───────────────────────────────────────────────────────────────────────────────────────

const JUMBO_MAX = 3
/** Something that is drawn as an emoji by default (not "©" or "™", which are text unless qualified). */
const EMOJI_LOOK_RE = /\p{Emoji_Presentation}|\u{FE0F}|\u{20E3}|\p{Emoji_Modifier}/u
let segmenter: Intl.Segmenter | null = null

function isJumbo(text: string): boolean {
  const t = text.trim()
  // At most 3 graphemes of at most 32 UTF-16 units (EMOJI_RE's limit for reactions) plus spaces.
  if (!t || t.length > JUMBO_MAX * 33 || /[\p{L}\p{N}\p{P}]/u.test(t.replace(/[#*0-9]\u{FE0F}?\u{20E3}/gu, ''))) return false
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  let n = 0
  for (const { segment } of segmenter.segment(t)) {
    if (/^\s+$/.test(segment)) continue
    if (++n > JUMBO_MAX || !EMOJI_RE.test(segment) || !EMOJI_LOOK_RE.test(segment)) return false
  }
  return n > 0
}

// ── Blocks ────────────────────────────────────────────────────────────────────────────────────────────

const FENCE = '```'
const LANG_RE = /^([A-Za-z0-9_+#.-]{1,32})\n/
const HEADING_RE = /^(#{1,3}) +(\S.*)$/
const LIST_RE = /^ *[-*] +(\S.*)$/

function parseBlocks(src: string, inQuote: boolean): Block[] {
  const out: Block[] = []
  let pos = 0
  let open = src.indexOf(FENCE)
  while (open !== -1) {
    const close = src.indexOf(FENCE, open + 3)
    if (close === -1) break
    const code = codeFence(src.slice(open + 3, close))
    if (!code) {
      // "``````" or only whitespace inside: the opener is text; the closer may open the next block.
      open = close
      continue
    }
    // The newline right before / after a block belongs to the block.
    textBlocks(src, pos, src[open - 1] === '\n' && open - 1 >= pos ? open - 1 : open, inQuote, out)
    out.push(code)
    pos = close + 3
    if (src[pos] === '\n') pos++
    open = src.indexOf(FENCE, pos)
  }
  textBlocks(src, pos, src.length, inQuote, out)
  return out
}

function codeFence(raw: string): Block | null {
  let lang = ''
  let body = raw
  const m = LANG_RE.exec(raw)
  if (m && raw.length > m[0].length) {
    lang = m[1]
    body = raw.slice(m[0].length)
  } else if (body.startsWith('\n')) body = body.slice(1)
  if (body.endsWith('\n')) body = body.slice(0, -1)
  return body.trim() ? { type: 'codeblock', lang, text: body } : null
}

/** Line-based blocks of src[from, to): quotes, headings, lists; runs of other lines are paragraphs. */
function textBlocks(src: string, from: number, to: number, inQuote: boolean, out: Block[]): void {
  if (from >= to) return
  let paraStart = -1
  let paraEnd = -1
  let quote: string[] | null = null
  let list: Inline[][] | null = null
  const flush = (keep?: 'quote' | 'list') => {
    if (paraStart !== -1) {
      if (src.slice(paraStart, paraEnd).trim()) out.push({ type: 'paragraph', children: parseInline(src, paraStart, paraEnd) })
      paraStart = -1
    }
    if (quote && keep !== 'quote') {
      out.push({ type: 'quote', children: parseBlocks(quote.join('\n'), true) })
      quote = null
    }
    if (list && keep !== 'list') {
      out.push({ type: 'list', items: list })
      list = null
    }
  }
  let start = from
  while (start <= to) {
    let end = src.indexOf('\n', start)
    if (end === -1 || end > to) end = to
    const line = src.slice(start, end)
    let m: RegExpExecArray | null
    if (!inQuote && line.startsWith('>>> ')) {
      flush()
      out.push({ type: 'quote', children: parseBlocks(src.slice(start + 4, to), true) })
      return
    } else if (!inQuote && (line.startsWith('> ') || (line === '>' && quote))) {
      flush('quote')
      ;(quote ??= []).push(line.slice(2))
    } else if ((m = HEADING_RE.exec(line))) {
      flush()
      out.push({ type: 'heading', level: m[1].length as 1 | 2 | 3, children: parseInline(src, end - m[2].length, end) })
    } else if ((m = LIST_RE.exec(line))) {
      flush('list')
      ;(list ??= []).push(parseInline(src, end - m[1].length, end))
    } else {
      if (quote || list) flush()
      if (paraStart === -1) paraStart = start
      paraEnd = end
    }
    if (end >= to) break
    start = end + 1
  }
  flush()
}

// ── Inline ────────────────────────────────────────────────────────────────────────────────────────────

type DelimChar = '*' | '_' | '~' | '|'

/** One entry of the inline list: a finished node, or a run of delimiter characters. */
interface Item {
  node: Inline | null
  delim: Delim | null
  prev: Item | null
  next: Item | null
}

interface Delim {
  item: Item
  ch: DelimChar
  /** Characters of the run not used up yet. */
  n: number
  open: boolean
  close: boolean
  prev: Delim | null
  next: Delim | null
}

/** What a backslash can escape (the escaped character is shown as is, without the backslash). */
const ESCAPABLE = new Set('\\`*_~|>#-:<@'.split(''))
/** Characters where plain text may stop: everything else is copied in bulk. */
const SPECIAL_RE = /[\\`<@hHwW*_~|]/g
const MENTION_AT = new RegExp(MENTION_TOKEN_RE.source, 'y')
// Same rules as the server (shared EVERYONE_RE): the look-behind sees the real text before the range.
const EVERYONE_AT = new RegExp(EVERYONE_RE.source, 'uy')
// Like lib/linkify, but `_https://…_` / `*https://…*` link too (no \b), and markdown closers are trimmed.
const URL_AT = /(?<![\p{L}\p{N}])(?:https?:\/\/|www\.)[^\s<>"]+/iuy
const URL_TRAIL = new Set('.,;:!?\'")]}*_~|'.split(''))
const WORD_RE = /[\p{L}\p{N}]/u
const SPACE_RE = /\s/u

const KIND: Record<DelimChar, [Inline['type'], Inline['type']]> = {
  '*': ['italic', 'bold'],
  _: ['italic', 'underline'],
  '~': ['strike', 'strike'],
  '|': ['spoiler', 'spoiler'],
}

/** Inline nodes of src[from, to). Characters outside the range are only looked at as context. */
export function parseInline(src: string, from: number, to: number): Inline[] {
  const head: Item = { node: null, delim: null, prev: null, next: null }
  let tail = head
  let firstDelim: Delim | null = null
  let lastDelim: Delim | null = null
  let text = ''
  const append = (node: Inline | null, delim: Delim | null): Item => {
    const item: Item = { node, delim, prev: tail, next: null }
    tail.next = item
    tail = item
    return item
  }
  const flushText = () => {
    if (text) append({ type: 'text', text }, null)
    text = ''
  }
  /** Backtick run lengths known to have no closing run further on. */
  const noCloser = new Set<number>()

  let i = from
  while (i < to) {
    const c = src[i]
    if (c === '\\') {
      const next = src[i + 1]
      if (i + 1 < to && ESCAPABLE.has(next)) {
        text += next
        i += 2
      } else {
        text += c
        i++
      }
      continue
    }
    if (c === '`') {
      const len = runLength(src, i, to, '`')
      const close = noCloser.has(len) ? -1 : findBacktickRun(src, i + len, to, len)
      if (close === -1) {
        noCloser.add(len)
        text += src.slice(i, i + len)
      } else {
        let code = src.slice(i + len, close)
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1)
        flushText()
        append({ type: 'code', text: code }, null)
        i = close + len
        continue
      }
      i += len
      continue
    }
    if (c === '<' || c === '@') {
      const re = c === '<' ? MENTION_AT : EVERYONE_AT
      re.lastIndex = i
      const m = re.exec(src)
      if (m && i + m[0].length <= to) {
        flushText()
        append(c === '<' ? { type: 'mention', userId: m[1] } : { type: 'everyone' }, null)
        i += m[0].length
        continue
      }
      text += c
      i++
      continue
    }
    if (c === 'h' || c === 'H' || c === 'w' || c === 'W') {
      const url = urlAt(src, i, to)
      if (url) {
        flushText()
        append({ type: 'link', text: url, href: /^https?:\/\//i.test(url) ? url : `https://${url}` }, null)
        i += url.length
        continue
      }
      text += c
      i++
      continue
    }
    if (c === '*' || c === '_' || c === '~' || c === '|') {
      const len = runLength(src, i, to, c)
      if ((c === '~' || c === '|') && len < 2) {
        text += c
        i++
        continue
      }
      const before = i > from ? src[i - 1] : ' '
      const after = i + len < to ? src[i + len] : ' '
      const leftFlank = !SPACE_RE.test(after)
      const rightFlank = !SPACE_RE.test(before)
      let open = true
      let close = true
      if (c === '*') {
        open = leftFlank
        close = rightFlank
      } else if (c === '_') {
        // Not inside a word: snake_case_names stay as they are.
        open = leftFlank && !WORD_RE.test(before)
        close = rightFlank && !WORD_RE.test(after)
      }
      if (!open && !close) {
        text += src.slice(i, i + len)
        i += len
        continue
      }
      flushText()
      const d: Delim = { item: null as unknown as Item, ch: c, n: len, open, close, prev: lastDelim, next: null }
      d.item = append(null, d)
      if (lastDelim) lastDelim.next = d
      else firstDelim = d
      lastDelim = d
      i += len
      continue
    }
    // Plain text up to the next character that might mean something.
    SPECIAL_RE.lastIndex = i + 1
    const m = SPECIAL_RE.exec(src)
    const stop = m && m.index < to ? m.index : to
    text += src.slice(i, stop)
    i = stop
  }
  flushText()
  if (firstDelim) processEmphasis(firstDelim)
  return collect(head.next, null)
}

function runLength(src: string, i: number, to: number, ch: string): number {
  let j = i
  while (j < to && src[j] === ch) j++
  return j - i
}

/** Start of the next run of exactly `len` backticks in src[from, to), or -1. */
function findBacktickRun(src: string, from: number, to: number, len: number): number {
  let j = from
  for (;;) {
    const k = src.indexOf('`', j)
    if (k === -1 || k >= to) return -1
    const n = runLength(src, k, to, '`')
    if (n === len) return k
    j = k + n
  }
}

/** The URL starting at `i` (trailing punctuation and markdown markers trimmed), or null. */
function urlAt(src: string, i: number, to: number): string | null {
  URL_AT.lastIndex = i
  const m = URL_AT.exec(src)
  if (!m) return null
  const url = m[0].slice(0, to - i)
  // Trim trailing punctuation / markdown markers from the end, but keep a ")" that closes a "(" of the URL
  // (Wikipedia links). One backward pass: linear even for "((((…))))".
  let opens = 0
  let closes = 0
  for (const ch of url) {
    if (ch === '(') opens++
    else if (ch === ')') closes++
  }
  let end = url.length
  while (end > 0) {
    const ch = url[end - 1]
    if (!URL_TRAIL.has(ch)) break
    if (ch === ')') {
      if (opens >= closes) break // it closes one of the URL's own "("
      closes--
    }
    end--
  }
  const trimmed = url.slice(0, end)
  return /^(?:https?:\/\/|www\.)./i.test(trimmed) ? trimmed : null
}

/**
 * Pairs delimiter runs (closer looks back for the nearest compatible opener) and wraps what's between in a
 * formatting node. `bottom` remembers, per character, below which delimiter there is no opener left, so a
 * long run of unmatched closers stays linear.
 */
function processEmphasis(first: Delim): void {
  const bottom = new Map<DelimChar, Delim | null>()
  const remove = (d: Delim) => {
    if (d.prev) d.prev.next = d.next
    if (d.next) d.next.prev = d.prev
  }
  let closer: Delim | null = first
  while (closer) {
    if (!closer.close) {
      closer = closer.next
      continue
    }
    const ch: DelimChar = closer.ch
    const floor = bottom.has(ch) ? bottom.get(ch)! : null
    let opener: Delim | null = closer.prev
    while (opener && opener !== floor && !(opener.ch === ch && opener.open && opener.n >= minRun(ch))) opener = opener.prev
    if (opener && opener !== floor) {
      const use = ch === '~' || ch === '|' ? 2 : opener.n >= 2 && closer.n >= 2 ? 2 : 1
      const type = KIND[ch][use - 1] as 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'
      // Delimiters in between can't match anything outside anymore.
      opener.next = closer
      closer.prev = opener
      const children = collect(opener.item.next, closer.item)
      const wrapped: Item = { node: { type, children }, delim: null, prev: opener.item, next: closer.item }
      opener.item.next = wrapped
      closer.item.prev = wrapped
      opener.n -= use
      closer.n -= use
      if (opener.n === 0) {
        unlink(opener.item)
        remove(opener)
      }
      if (closer.n === 0) {
        const next: Delim | null = closer.next
        unlink(closer.item)
        remove(closer)
        closer = next
      }
    } else {
      bottom.set(ch, closer.prev)
      const next: Delim | null = closer.next
      if (!closer.open) remove(closer)
      closer = next
    }
  }
}

function minRun(ch: DelimChar): number {
  return ch === '~' || ch === '|' ? 2 : 1
}

function unlink(item: Item): void {
  if (item.prev) item.prev.next = item.next
  if (item.next) item.next.prev = item.prev
}

/** Nodes from `start` up to (not including) `end`; leftover delimiters become text, adjacent texts merge. */
function collect(start: Item | null, end: Item | null): Inline[] {
  const out: Inline[] = []
  for (let it = start; it && it !== end; it = it.next) {
    const node: Inline | null = it.node ?? (it.delim && it.delim.n > 0 ? { type: 'text', text: it.delim.ch.repeat(it.delim.n) } : null)
    if (!node) continue
    const last = out[out.length - 1]
    if (node.type === 'text' && last?.type === 'text') out[out.length - 1] = { type: 'text', text: last.text + node.text }
    else out.push(node)
  }
  return out
}
