// Mentions (shared/protocol.ts MENTION_TOKEN_RE): on the wire a person is `<@userId>`, so renames keep
// working; in the text box it reads `@Name`. These convert between the two. Used by the composer, inline
// message editing, message rendering and notifications.
import type { Message, User } from '@shared/protocol'
import { EVERYONE_TOKEN, MENTION_TOKEN_RE, hasEveryoneMention } from '@shared/protocol'
import { msg, t } from '../i18n'

type Users = Record<string, Pick<User, 'id' | 'name'>>

/** Shown for a `<@id>` whose user is unknown (removed account, not loaded). A message key: show it with t(). */
export const UNKNOWN_USER = msg('unknown-user')

/** Fresh copy of MENTION_TOKEN_RE (the shared one is global, so `.exec`/`.test` on it would keep state). */
const tokenRe = () => new RegExp(MENTION_TOKEN_RE.source, 'g')

/** Characters a name is made of (server NAME_RE), minus space and dot, which also work as punctuation. */
const NAME_CHAR = '[\\p{L}\\p{M}\\p{N}_\\-]'

/** Wire content -> editable text: `<@id>` becomes `@Name` (unknown ids stay as they are). */
export function contentToEditable(content: string, users: Users): string {
  return content.replace(tokenRe(), (token, id: string) => {
    const u = users[id]
    return u ? `@${u.name}` : token
  })
}

/** Wire content -> plain readable text (notifications, previews): `<@id>` -> `@Name` or `@unknown-user`. */
export function contentToPlain(content: string, users: Users): string {
  return content.replace(tokenRe(), (_token, id: string) => `@${users[id]?.name ?? t(UNKNOWN_USER)}`)
}

/**
 * Editable text -> wire content: every `@Name` of a known user becomes `<@id>`. Longest names first, so
 * "@Ana Clara" wins over "@Ana"; matching is case-insensitive. The `@` must start a word (so `foo@Ana.com`
 * is left alone) and the name must not run on into more name characters (so "@Anabel" isn't "@Ana" + "bel").
 * `@everyone` is left as is (a user literally named "everyone" can't be mentioned by name).
 */
export function editableToContent(text: string, users: Users): string {
  if (!text.includes('@')) return text
  const list = Object.values(users)
    .filter((u) => u.name && u.name.toLocaleLowerCase() !== EVERYONE_TOKEN.slice(1))
    .sort((a, b) => b.name.length - a.name.length)
  if (list.length === 0) return text
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<!${NAME_CHAR})@(${list.map((u) => escape(u.name)).join('|')})(?!${NAME_CHAR})`, 'giu')
  const byName = new Map(list.map((u) => [u.name.toLocaleLowerCase(), u.id]))
  return text.replace(re, (whole, name: string) => {
    const id = byName.get(name.toLocaleLowerCase())
    return id ? `<@${id}>` : whole
  })
}

/**
 * Whether `msg` notifies `userId` (person mention, reply to them, or @everyone), never for own messages.
 * Servers older than mentions don't send `mentions`: then the content's tokens are checked instead.
 */
export function mentionsUser(
  msg: Pick<Message, 'userId' | 'mentions' | 'mentionsEveryone'> & { content?: string },
  userId: string | undefined,
): boolean {
  if (!userId || msg.userId === userId) return false
  if (msg.mentions === undefined && msg.mentionsEveryone === undefined && msg.content !== undefined) {
    if (hasEveryoneMention(msg.content)) return true
    for (const m of msg.content.matchAll(tokenRe())) if (m[1] === userId) return true
    return false
  }
  return !!msg.mentionsEveryone || !!msg.mentions?.includes(userId)
}

// ── Autocomplete ──────────────────────────────────────────────────────────────────────────────────────

/** An `@query` being typed: `start` is the index of the `@`, the query runs up to the caret. */
export interface MentionQuery {
  start: number
  query: string
}

/** Longest name (server LIMITS.nameMax) — a query can't be longer. */
const MAX_QUERY = 24

/**
 * The `@query` right before the caret, if any. The `@` must start a word; the query may contain spaces and
 * dots (names do) but not start with a space, nor span lines. Whether it still matches someone is the
 * caller's business (a query with a space that matches nobody should close the popup).
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const from = Math.max(0, caret - MAX_QUERY - 1)
  const at = text.lastIndexOf('@', caret - 1)
  if (at < from || at < 0) return null
  if (at > 0 && new RegExp(NAME_CHAR, 'u').test(text[at - 1])) return null
  const query = text.slice(at + 1, caret)
  if (query.startsWith(' ') || /[\n\r@<>]/.test(query)) return null
  if (!new RegExp(`^[\\p{L}\\p{M}\\p{N}_.\\- ]*$`, 'u').test(query)) return null
  return { start: at, query }
}

/** Whether `name` matches an autocomplete query: the name, or one of its words, starts with it. */
export function nameMatches(name: string, query: string): boolean {
  if (!query) return true
  const n = name.toLocaleLowerCase()
  const q = query.toLocaleLowerCase()
  if (n.startsWith(q)) return true
  return n.split(/[\s._-]+/).some((w) => w.startsWith(q))
}

export { EVERYONE_TOKEN }
