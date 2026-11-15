// The header search box's little query language: free text plus `from:Name` (or `from:"Two Words"`) and
// `in:#channel` filters, like Discord. Parsing and the autocomplete token at the caret.
import type { Channel, User } from '@shared/protocol'

const FILTER_RE = /(^|\s)(from|in):(?:"([^"]*)"?|(\S*))/gi

export interface ParsedSearch {
  text: string
  /** Raw names as typed (resolved by resolveSearch). Last one wins. */
  from: string | null
  in: string | null
}

export function parseSearch(input: string): ParsedSearch {
  let from: string | null = null
  let inName: string | null = null
  const text = input
    .replace(FILTER_RE, (_whole, lead: string, kind: string, quoted: string | undefined, bare: string | undefined) => {
      const v = (quoted ?? bare ?? '').trim()
      if (kind.toLowerCase() === 'from') from = v
      else inName = v.replace(/^#/, '')
      return lead
    })
    .replace(/\s+/g, ' ')
    .trim()
  return { text, from, in: inName }
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLocaleLowerCase()

export function findUserByName(users: Record<string, User>, name: string): User | null {
  const n = fold(name.replace(/^@/, '').trim())
  if (!n) return null
  return Object.values(users).find((u) => fold(u.name) === n) ?? null
}

export function findTextChannelByName(channels: Channel[], name: string): Channel | null {
  const n = fold(name.replace(/^#/, '').trim())
  if (!n) return null
  return channels.find((c) => c.type === 'text' && fold(c.name) === n) ?? null
}

/** What the autocomplete completes at the caret. `start` = index where the replaced token begins. */
export type SearchToken =
  | { kind: 'from'; start: number; partial: string }
  | { kind: 'in'; start: number; partial: string }
  | { kind: 'options'; start: number; partial: string }

export function tokenAtCaret(value: string, caret: number): SearchToken | null {
  const before = value.slice(0, caret)
  let m = /(^|\s)from:(?:"([^"]*)|(\S*))$/i.exec(before)
  if (m) return { kind: 'from', start: m.index + m[1].length, partial: m[2] ?? m[3] ?? '' }
  m = /(^|\s)in:#?(\S*)$/i.exec(before)
  if (m) return { kind: 'in', start: m.index + m[1].length, partial: m[2] ?? '' }
  // Empty box: offer the filters.
  if (!value.trim()) return { kind: 'options', start: 0, partial: '' }
  return null
}

/** `from:` value for a name (quoted when it has spaces). */
export const fromToken = (name: string) => `from:${/\s/.test(name) ? `"${name}"` : name}`

/** Users whose name matches `partial` (prefix matches first), at most `max`. */
export function matchUsers(users: Record<string, User>, partial: string, max: number): User[] {
  const q = fold(partial)
  const list = Object.values(users).filter((u) => fold(u.name).includes(q))
  list.sort((a, b) => {
    const pa = fold(a.name).startsWith(q) ? 0 : 1
    const pb = fold(b.name).startsWith(q) ? 0 : 1
    return pa - pb || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return list.slice(0, max)
}

export function matchTextChannels(channels: Channel[], partial: string, max: number): Channel[] {
  const q = fold(partial)
  return channels.filter((c) => c.type === 'text' && fold(c.name).includes(q)).slice(0, max)
}
