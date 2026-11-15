// Normalization of free text that other people see (status text, activity names, sound names, link preview
// titles). Shared by the socket handlers (server.ts) and the HTTP routes.

/**
 * Free text shown to others: NFC, any whitespace run (newlines, tabs…) becomes one space, other
 * control/format/unassigned characters (\p{C}: bidi overrides, zero-width spaces…) are removed except the
 * zero-width joiner that emoji sequences need and the tag characters (U+E0020–E007F) right after a black
 * flag (U+1F3F4), which make subdivision flags (England: 1F3F4 E0067 E0062 E0065 E006E E0067 E007F); then
 * trimmed. Lengths are then checked in UTF-16 units, like an <input maxLength>.
 */
export function normalizeDisplayText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/(\u{1F3F4}[\u{E0020}-\u{E007F}]+)|(?!\u200d)\p{C}/gu, (_, flag: string | undefined) => flag ?? '')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/** `text` cut to `max` UTF-16 units without splitting a surrogate pair, then trimmed. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).trim()
}
