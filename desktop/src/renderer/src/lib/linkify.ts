// Split text into plain-text and URL segments. Rendering stays text-only (no HTML).

export type Segment = { type: 'text'; text: string } | { type: 'link'; text: string; href: string }

// http(s) URLs or bare www. hosts. Stops at whitespace and angle brackets.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi
// Trailing punctuation that is usually not part of the URL.
const TRAILING_RE = /[.,;:!?'")\]}]+$/

export function linkify(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0
    let url = match[0]
    // Trim trailing punctuation, but keep balanced closing parens (e.g. wikipedia links).
    const trail = url.match(TRAILING_RE)?.[0] ?? ''
    if (trail) {
      let keep = url.slice(0, url.length - trail.length)
      let rest = trail
      while (rest.startsWith(')') && count(keep, '(') > count(keep, ')')) {
        keep += ')'
        rest = rest.slice(1)
      }
      url = keep
    }
    if (!url) continue
    if (start > last) out.push({ type: 'text', text: text.slice(last, start) })
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`
    out.push({ type: 'link', text: url, href })
    last = start + url.length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

function count(s: string, ch: string): number {
  let n = 0
  for (const c of s) if (c === ch) n++
  return n
}

/** Open a URL in the system browser (falls back to window.open outside Electron). */
export function openExternal(href: string): void {
  if (!/^https?:\/\//i.test(href)) return
  if (window.nexo?.openExternal) window.nexo.openExternal(href)
  else window.open(href, '_blank', 'noopener,noreferrer')
}
