// Emoji for the picker and reactions: the curated set in lib/emojiData.ts, parsed once, plus search,
// "Recent" and the skin tone preference (both in localStorage; everything works without it).
// Every emoji offered here passes EMOJI_RE (what the server accepts for reactions).
import { EMOJI_RE } from '@shared/protocol'
import { EMOJI_DATA } from './emojiData'

export interface Emoji {
  /** The emoji, fully qualified (with the emoji variation selector where it's needed). */
  char: string
  name: string
  /** Lowercase "name keywords" for search. */
  search: string
  /** Accepts a skin tone modifier. */
  tone: boolean
}

export interface EmojiCategory {
  id: string
  label: string
  icon: string
  emojis: Emoji[]
}

/** Shown in the message hover bar (one click to react). */
export const QUICK_REACTIONS = ['👍', '😂', '❤️', '🔥']

const VS16 = '\u{FE0F}'
const ZWJ = '\u{200D}'
const PRESENTATION_RE = /^\p{Emoji_Presentation}$/u
const PICTO_RE = /^\p{Extended_Pictographic}$/u
const MODIFIER_RE = /^\p{Emoji_Modifier}$/u

/** Adds U+FE0F after text-default pictographs (❤ -> ❤️) in each part of a ZWJ sequence. */
export function qualify(raw: string): string {
  return raw
    .split(ZWJ)
    .map((part) => {
      const cps = [...part]
      const first = cps[0]
      if (!first || !PICTO_RE.test(first) || PRESENTATION_RE.test(first)) return part
      const next = cps[1]
      if (next === VS16 || (next && MODIFIER_RE.test(next))) return part
      return first + VS16 + cps.slice(1).join('')
    })
    .join(ZWJ)
}

/** Skin tones: 0 = default (yellow), 1..5 = light .. dark (U+1F3FB..U+1F3FF). */
export const SKIN_TONES = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'] as const
export const SKIN_TONE_LABELS = ['Default', 'Light', 'Medium-light', 'Medium', 'Medium-dark', 'Dark']

/** `e` with skin tone `tone` (after its first code point, replacing a variation selector). */
export function withTone(e: Emoji, tone: number): string {
  const mod = SKIN_TONES[tone]
  if (!e.tone || !mod) return e.char
  const cps = [...e.char]
  const rest = cps.slice(1)
  if (rest[0] === VS16) rest.shift()
  const toned = cps[0] + mod + rest.join('')
  return EMOJI_RE.test(toned) ? toned : e.char
}

let parsed: EmojiCategory[] | null = null
/** Lines of the data set that EMOJI_RE rejected (should stay empty; see desktop/scripts/check-emoji.mjs). */
export const rejectedEmoji: string[] = []

/** The emoji set by category (parsed on first use; duplicates and anything EMOJI_RE rejects are dropped). */
export function emojiCategories(): EmojiCategory[] {
  if (parsed) return parsed
  const seen = new Set<string>()
  parsed = EMOJI_DATA.map((cat) => {
    const emojis: Emoji[] = []
    for (const line of cat.list.split('\n')) {
      if (!line.trim()) continue
      const [rawChar = '', name = '', keywords = ''] = line.split('|')
      const tone = rawChar.endsWith('+')
      const char = qualify(tone ? rawChar.slice(0, -1) : rawChar)
      if (seen.has(char)) continue
      if (!EMOJI_RE.test(char)) {
        rejectedEmoji.push(char)
        continue
      }
      seen.add(char)
      emojis.push({ char, name, search: `${name} ${keywords}`.toLowerCase(), tone })
    }
    return { id: cat.id, label: cat.label, icon: qualify(cat.icon), emojis }
  })
  // `env` is absent when the check script loads this file under plain Node.
  if (rejectedEmoji.length && import.meta.env?.DEV) console.warn('[nexo] emoji rejected by EMOJI_RE:', rejectedEmoji)
  return parsed
}

let byChar: Map<string, Emoji> | null = null

/** Look up an emoji of the set (ignoring a skin tone), e.g. to name it in a tooltip. */
export function findEmoji(char: string): Emoji | undefined {
  if (!byChar) {
    byChar = new Map()
    for (const c of emojiCategories()) for (const e of c.emojis) byChar.set(e.char, e)
  }
  return byChar.get(char) ?? byChar.get(char.replace(/\p{Emoji_Modifier}/gu, '')) ?? byChar.get(qualify(char.replace(/\p{Emoji_Modifier}/gu, '')))
}

/** Emoji whose name or keywords match every word of `query` (name prefix first, then whole words). */
export function searchEmoji(query: string, limit = 120): Emoji[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const tiers: Emoji[][] = [[], [], []]
  for (const c of emojiCategories()) {
    for (const e of c.emojis) {
      if (!words.every((w) => e.search.includes(w))) continue
      const tier = e.name.startsWith(words[0]) ? 0 : e.search.split(' ').includes(words[0]) ? 1 : 2
      tiers[tier].push(e)
    }
  }
  return tiers.flat().slice(0, limit)
}

// ---- preferences (localStorage; failures just mean nothing is remembered) ----

const RECENT_KEY = 'nexo.emoji.recent'
const TONE_KEY = 'nexo.emoji.tone'
const RECENT_MAX = 18

/** Most recently used first (as picked, i.e. with their skin tone). */
export function recentEmoji(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && EMOJI_RE.test(x)).slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

export function noteRecentEmoji(char: string): void {
  try {
    const next = [char, ...recentEmoji().filter((x) => x !== char)].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // storage unavailable: no recents
  }
}

export function skinTone(): number {
  try {
    const n = Number(localStorage.getItem(TONE_KEY) ?? 0)
    return Number.isInteger(n) && n >= 0 && n < SKIN_TONES.length ? n : 0
  } catch {
    return 0
  }
}

export function setSkinTone(tone: number): void {
  try {
    localStorage.setItem(TONE_KEY, String(tone))
  } catch {
    // ignore
  }
}
