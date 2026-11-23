// Emoji for the picker and reactions: the curated set in lib/emojiData.ts, parsed once, plus search,
// "Recent" and the skin tone preference (both in localStorage; everything works without it), and
// `:shortcodes:` for the composer (autocomplete, replacement as you type and on send).
// Every emoji offered here passes EMOJI_RE (what the server accepts for reactions).
import { EMOJI_RE } from '@shared/protocol'
import { EMOJI_DATA } from './emojiData'
import { msg } from '../i18n/core'

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
  /** A message key: show it with t(). */
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
/** Message keys: show them with t(). */
export const SKIN_TONE_LABELS = [
  msg('Default // skin tone'),
  msg('Light // skin tone'),
  msg('Medium-light // skin tone'),
  msg('Medium // skin tone'),
  msg('Medium-dark // skin tone'),
  msg('Dark // skin tone'),
]

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

// ---- :shortcodes: (composer autocomplete and auto-replace) ----

/**
 * Common Discord / Slack names, so muscle memory works (`:joy:`, `:+1:`, `:sob:`…). Every other emoji gets
 * a snake_case shortcode from its name ("face with tears of joy" -> `:face_with_tears_of_joy:`). Entries
 * whose emoji isn't in the set are skipped. The first alias of an emoji is the name shown for it.
 */
const ALIASES: [string, string][] = [
  ['smile', '😄'], ['smiley', '😃'], ['grinning', '😀'], ['grin', '😁'], ['laughing', '😆'], ['satisfied', '😆'],
  ['sweat_smile', '😅'], ['rofl', '🤣'], ['joy', '😂'], ['slight_smile', '🙂'], ['slightly_smiling_face', '🙂'],
  ['upside_down', '🙃'], ['melting_face', '🫠'], ['wink', '😉'], ['blush', '😊'], ['innocent', '😇'],
  ['smiling_face_with_3_hearts', '🥰'], ['heart_eyes', '😍'], ['star_struck', '🤩'], ['kissing_heart', '😘'],
  ['relaxed', '☺️'], ['yum', '😋'], ['stuck_out_tongue', '😛'], ['stuck_out_tongue_winking_eye', '😜'],
  ['zany_face', '🤪'], ['money_mouth', '🤑'], ['hugging', '🤗'], ['hugs', '🤗'], ['hand_over_mouth', '🤭'],
  ['shushing_face', '🤫'], ['thinking', '🤔'], ['salute', '🫡'], ['zipper_mouth', '🤐'], ['raised_eyebrow', '🤨'],
  ['neutral_face', '😐'], ['expressionless', '😑'], ['no_mouth', '😶'], ['smirk', '😏'], ['unamused', '😒'],
  ['rolling_eyes', '🙄'], ['grimacing', '😬'], ['lying_face', '🤥'], ['relieved', '😌'], ['pensive', '😔'],
  ['sleepy', '😪'], ['drooling_face', '🤤'], ['sleeping', '😴'], ['mask', '😷'], ['nauseated_face', '🤢'],
  ['vomiting', '🤮'], ['sneezing_face', '🤧'], ['hot_face', '🥵'], ['cold_face', '🥶'], ['woozy_face', '🥴'],
  ['dizzy_face', '😵'], ['exploding_head', '🤯'], ['cowboy', '🤠'], ['partying_face', '🥳'], ['sunglasses', '😎'],
  ['nerd', '🤓'], ['monocle_face', '🧐'], ['confused', '😕'], ['worried', '😟'], ['slight_frown', '🙁'],
  ['frowning', '☹️'], ['open_mouth', '😮'], ['hushed', '😯'], ['astonished', '😲'], ['flushed', '😳'],
  ['pleading_face', '🥺'], ['fearful', '😨'], ['cold_sweat', '😰'], ['cry', '😢'], ['sob', '😭'], ['scream', '😱'],
  ['confounded', '😖'], ['persevere', '😣'], ['disappointed', '😞'], ['sweat', '😓'], ['weary', '😩'],
  ['tired_face', '😫'], ['yawning_face', '🥱'], ['triumph', '😤'], ['rage', '😡'], ['angry', '😠'],
  ['cursing_face', '🤬'], ['smiling_imp', '😈'], ['imp', '👿'], ['skull', '💀'], ['poop', '💩'], ['hankey', '💩'],
  ['clown', '🤡'], ['ghost', '👻'], ['alien', '👽'], ['robot', '🤖'], ['see_no_evil', '🙈'], ['hear_no_evil', '🙉'],
  ['speak_no_evil', '🙊'], ['heart', '❤️'], ['orange_heart', '🧡'], ['yellow_heart', '💛'], ['green_heart', '💚'],
  ['blue_heart', '💙'], ['purple_heart', '💜'], ['black_heart', '🖤'], ['white_heart', '🤍'], ['broken_heart', '💔'],
  ['two_hearts', '💕'], ['sparkling_heart', '💖'], ['100', '💯'], ['boom', '💥'], ['sparkles', '✨'], ['star', '⭐'],
  ['fire', '🔥'], ['zzz', '💤'], ['sweat_drops', '💦'], ['dash', '💨'], ['wave', '👋'], ['ok_hand', '👌'],
  ['pinching_hand', '🤏'], ['v', '✌️'], ['crossed_fingers', '🤞'], ['fingers_crossed', '🤞'], ['metal', '🤘'],
  ['call_me', '🤙'], ['point_left', '👈'], ['point_right', '👉'], ['point_up', '☝️'], ['point_up_2', '👆'],
  ['point_down', '👇'], ['middle_finger', '🖕'], ['thumbsup', '👍'], ['+1', '👍'], ['thumbs_up', '👍'],
  ['thumbsdown', '👎'], ['-1', '👎'], ['thumbs_down', '👎'], ['fist', '✊'], ['punch', '👊'], ['clap', '👏'],
  ['raised_hands', '🙌'], ['open_hands', '👐'], ['handshake', '🤝'], ['pray', '🙏'], ['muscle', '💪'],
  ['writing_hand', '✍️'], ['nail_care', '💅'], ['eyes', '👀'], ['eye', '👁️'], ['brain', '🧠'], ['shrug', '🤷'],
  ['person_shrugging', '🤷'], ['facepalm', '🤦'], ['person_facepalming', '🤦'], ['tada', '🎉'],
  ['confetti_ball', '🎊'], ['balloon', '🎈'], ['gift', '🎁'], ['birthday', '🎂'], ['trophy', '🏆'], ['medal', '🏅'],
  ['crown', '👑'], ['gem', '💎'], ['moneybag', '💰'], ['money_with_wings', '💸'], ['white_check_mark', '✅'],
  ['check', '✅'], ['heavy_check_mark', '✔️'], ['x', '❌'], ['warning', '⚠️'], ['question', '❓'],
  ['exclamation', '❗'], ['no_entry', '⛔'], ['rocket', '🚀'], ['zap', '⚡'], ['rainbow', '🌈'], ['sunny', '☀️'],
  ['crescent_moon', '🌙'], ['snowflake', '❄️'], ['cloud', '☁️'], ['coffee', '☕'], ['tea', '🍵'], ['beer', '🍺'],
  ['beers', '🍻'], ['wine_glass', '🍷'], ['pizza', '🍕'], ['hamburger', '🍔'], ['fries', '🍟'], ['popcorn', '🍿'],
  ['cake', '🍰'], ['cookie', '🍪'], ['dog', '🐶'], ['cat', '🐱'], ['monkey', '🐒'], ['snake', '🐍'], ['unicorn', '🦄'],
  ['bug', '🐛'], ['goat', '🐐'], ['clown_face', '🤡'], ['bulb', '💡'], ['lock', '🔒'], ['key', '🔑'], ['bell', '🔔'],
  ['mute', '🔇'], ['headphones', '🎧'], ['microphone', '🎤'], ['video_game', '🎮'], ['joystick', '🕹️'],
  ['computer', '💻'], ['keyboard', '⌨️'], ['hourglass', '⌛'], ['alarm_clock', '⏰'], ['pushpin', '📌'],
  ['memo', '📝'], ['link', '🔗'], ['wrench', '🔧'], ['hammer', '🔨'], ['gear', '⚙️'], ['bomb', '💣'],
  ['knife', '🔪'], ['pill', '💊'], ['trumpet', '🎺'], ['guitar', '🎸'], ['notes', '🎶'], ['musical_note', '🎵'],
  ['soccer', '⚽'], ['basketball', '🏀'], ['crab', '🦀'], ['flag_br', '🇧🇷'], ['flag_us', '🇺🇸'], ['flag_pt', '🇵🇹'],
]

export interface ShortcodeMatch {
  emoji: Emoji
  /** The shortcode to show (the one that matched, else the emoji's main one), without colons. */
  code: string
}

interface ShortcodeIndex {
  byCode: Map<string, Emoji>
  primary: Map<Emoji, string>
  /** Every code: the aliases first, then names. */
  codes: [string, Emoji][]
  aliasCount: number
}
let shortcodes: ShortcodeIndex | null = null

/** "Face with tears of joy" -> "face_with_tears_of_joy", "flag: Côte d’Ivoire" -> "flag_cote_divoire". */
export function toShortcode(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9+]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function shortcodeIndex(): ShortcodeIndex {
  if (shortcodes) return shortcodes
  const idx: ShortcodeIndex = { byCode: new Map(), primary: new Map(), codes: [], aliasCount: 0 }
  const add = (code: string, e: Emoji) => {
    if (!code || idx.byCode.has(code)) return
    idx.byCode.set(code, e)
    idx.codes.push([code, e])
    if (!idx.primary.has(e)) idx.primary.set(e, code)
  }
  for (const [code, char] of ALIASES) {
    const e = findEmoji(qualify(char))
    if (e && e.char === qualify(char)) add(code, e)
  }
  idx.aliasCount = idx.codes.length
  for (const c of emojiCategories()) for (const e of c.emojis) add(toShortcode(e.name), e)
  shortcodes = idx
  return idx
}

/** The emoji for a shortcode (without colons, any case), if there is one. */
export function emojiByShortcode(code: string): Emoji | undefined {
  return shortcodeIndex().byCode.get(code.toLowerCase())
}

/** The main shortcode of an emoji of the set (without colons). */
export function shortcodeOf(e: Emoji): string {
  return shortcodeIndex().primary.get(e) ?? toShortcode(e.name)
}

/**
 * Emoji for a `:query` being typed: exact code first, then codes starting with it (aliases before names,
 * shorter first), then codes with a word starting with it (`:tears` -> face_with_tears_of_joy), then keywords.
 */
export function searchShortcodes(query: string, limit = 8): ShortcodeMatch[] {
  const q = query.toLowerCase()
  if (!q) return []
  const { byCode, codes, aliasCount } = shortcodeIndex()
  const out: ShortcodeMatch[] = []
  const seen = new Set<Emoji>()
  const take = (emoji: Emoji, code: string) => {
    if (out.length >= limit || seen.has(emoji)) return
    seen.add(emoji)
    out.push({ emoji, code })
  }
  const exact = byCode.get(q)
  if (exact) take(exact, q)
  const prefixed = codes
    .map(([code, e], i) => ({ code, e, rank: (i < aliasCount ? 0 : 1000) + code.length }))
    .filter((x) => x.code.startsWith(q))
    .sort((a, b) => a.rank - b.rank)
  for (const { code, e } of prefixed) take(e, code)
  for (const [code, e] of codes) if (code.includes(`_${q}`)) take(e, code)
  if (out.length < limit) for (const e of searchEmoji(q.replace(/_/g, ' '), limit * 2)) take(e, shortcodeOf(e))
  return out
}

/** Characters of a shortcode (between the colons). */
export const SHORTCODE_CHARS = /[a-z0-9_+-]/i
const SHORTCODE_RE = /(?<![\p{L}\p{N}]):([a-z0-9_+-]{1,48}):/giu
/**
 * A URL like lib/messageTokens.ts finds them (`https://…`, `http://…`, `www.…`, not after a letter or
 * digit), without its trailing-punctuation trimming: a little more is left alone, never less.
 */
const URL_RE = /(?<![\p{L}\p{N}])(?:https?:\/\/|www\.)[^\s<>"]+/giu

/** Index of the next run of exactly `len` backticks at or after `from`, or -1 (like messageTokens). */
function backtickRunAt(text: string, from: number, len: number): number {
  for (let j = text.indexOf('`', from); j !== -1; ) {
    let k = j
    while (text[k] === '`') k++
    if (k - j === len) return j
    j = text.indexOf('`', k)
  }
  return -1
}

/**
 * [start, end) ranges where `:shortcodes:` are literal text: code and URLs. Code is a run of backticks of
 * any length up to the next run of the same length (``` blocks included), like lib/messageTokens.ts; a
 * backslash escapes a backtick. An unclosed ``` runs to the end (a block still being written). With
 * `typing`, an unclosed shorter run also counts, up to the end of its line (a code span being typed).
 */
function literalRanges(text: string, typing: boolean): [number, number][] {
  const out: [number, number][] = []
  const urls = (from: number, to: number) => {
    if (from >= to) return
    for (const m of text.slice(from, to).matchAll(URL_RE)) out.push([from + m.index, from + m.index + m[0].length])
  }
  /** Run lengths known to have no closer further on (keeps this linear on runs of lone backticks). */
  const noCloser = new Set<number>()
  let textFrom = 0
  for (let i = 0; i < text.length; ) {
    const c = text[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c !== '`') {
      i++
      continue
    }
    let len = 1
    while (text[i + len] === '`') len++
    const close = noCloser.has(len) ? -1 : backtickRunAt(text, i + len, len)
    let end: number
    if (close !== -1) end = close + len
    else {
      noCloser.add(len)
      if (len >= 3) end = text.length
      else if (typing) end = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i)
      else {
        i += len
        continue
      }
    }
    urls(textFrom, i)
    out.push([i, end])
    textFrom = i = end
  }
  urls(textFrom, text.length)
  return out.sort((x, y) => x[0] - y[0])
}

/** Replaces every known `:shortcode:` outside code and URLs with its emoji (skin tone applied); unknown ones stay. */
export function replaceShortcodes(text: string, tone = skinTone()): string {
  if (!text.includes(':')) return text
  const swap = (part: string) =>
    part.replace(SHORTCODE_RE, (whole, code: string) => {
      const e = emojiByShortcode(code)
      return e ? withTone(e, tone) : whole
    })
  let out = ''
  let last = 0
  for (const [start, end] of literalRanges(text, false)) {
    out += swap(text.slice(last, start)) + text.slice(start, end)
    last = end
  }
  return out + swap(text.slice(last))
}

/**
 * Whether `pos` is inside code (a closed or still-open backtick span or ``` block) or a URL, in text being
 * typed: no shortcode magic there.
 */
export function isInCode(text: string, pos: number): boolean {
  return literalRanges(text, true).some(([start, end]) => pos > start && pos < end)
}

/** A `:query` being typed (at least 2 characters after the colon): `start` is the index of the colon. */
export interface ShortcodeQuery {
  start: number
  query: string
}

/** The `:query` ending at the caret, if any. The colon can't follow a letter or digit (`12:30`, `re:x`). */
export function findShortcodeQuery(text: string, caret: number): ShortcodeQuery | null {
  let i = caret
  while (i > 0 && caret - i < 48 && SHORTCODE_CHARS.test(text[i - 1])) i--
  if (i === 0 || text[i - 1] !== ':' || caret - i < 2) return null
  const colon = i - 1
  if (colon > 0 && /[\p{L}\p{N}]/u.test(text[colon - 1])) return null
  if (isInCode(text, colon)) return null
  return { start: colon, query: text.slice(i, caret) }
}

/** A complete `:code:` (known) right before `caret`: its start and emoji, for replacing as you type. */
export function shortcodeBefore(text: string, caret: number): { start: number; emoji: Emoji } | null {
  if (text[caret - 1] !== ':') return null
  const m = /(?<![\p{L}\p{N}]):([a-z0-9_+-]{1,48}):$/iu.exec(text.slice(Math.max(0, caret - 52), caret))
  const emoji = m ? emojiByShortcode(m[1]) : undefined
  if (!m || !emoji) return null
  const start = caret - m[0].length
  return isInCode(text, start) ? null : { start, emoji }
}
