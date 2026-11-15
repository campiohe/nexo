// Search-hit highlighting: like the server's search, case and accent insensitive, each query word matching
// as a word prefix. Works on plain strings and returns ranges; callers render them as React elements
// (never HTML).

/** Lowercased, accents removed. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
}

/** Like the server: a word is a run of letters, digits or private-use characters. */
const WORD_CHAR = /[\p{L}\p{N}\p{Co}]/u
/** The server only uses a query's first words. */
const MAX_WORDS = 10

/** The words of a search query, folded (empty words dropped, longest first so they win at a position). */
export function searchWords(query: string): string[] {
  // Like the server: words are runs of letters, digits or private-use characters; only the first 10 count.
  const words = new Set(fold(query).split(/[^\p{L}\p{N}\p{Co}]+/u).filter(Boolean).slice(0, MAX_WORDS))
  return [...words].sort((a, b) => b.length - a.length)
}

/**
 * [start, end) ranges (UTF-16 indices into `text`) where a word of `words` (from searchWords) starts a
 * word of `text`. Sorted, non-overlapping.
 */
export function highlightRanges(text: string, words: readonly string[]): [number, number][] {
  if (!text || words.length === 0) return []
  // Folded text with a map back to the original indices (folding can change lengths: "é" -> "e").
  let folded = ''
  const start: number[] = []
  const end: number[] = []
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0
    const len = cp > 0xffff ? 2 : 1
    const f = fold(text.slice(i, i + len))
    for (let k = 0; k < f.length; k++) {
      start.push(i)
      end.push(i + len)
    }
    folded += f
    i += len
  }
  const out: [number, number][] = []
  let pos = 0
  while (pos < folded.length) {
    const atWordStart = WORD_CHAR.test(folded[pos]) && (pos === 0 || !WORD_CHAR.test(folded[pos - 1]))
    const w = atWordStart ? words.find((word) => folded.startsWith(word, pos)) : undefined
    if (w) {
      const s = start[pos]
      const e = end[pos + w.length - 1]
      const last = out[out.length - 1]
      if (last && last[1] >= s) last[1] = Math.max(last[1], e)
      else out.push([s, e])
      pos += w.length
    } else {
      pos++
    }
  }
  return out
}
