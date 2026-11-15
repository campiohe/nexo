#!/usr/bin/env node
// Checks that every emoji the picker offers (lib/emojiData.ts, all skin tones, the quick reactions) passes
// EMOJI_RE from shared/protocol.ts, i.e. the server will accept it as a reaction. Needs Node 23.6+ (runs
// the .ts sources directly).   node desktop/scripts/check-emoji.mjs
import { registerHooks } from 'node:module'

const shared = new URL('../../shared/', import.meta.url)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@shared/')) return next(new URL(`${spec.slice(8)}.ts`, shared).href, ctx)
    if (spec.startsWith('.') && !/\.[cm]?[jt]s$/.test(spec)) return next(`${spec}.ts`, ctx)
    return next(spec, ctx)
  },
})

const { EMOJI_RE } = await import('@shared/protocol')
const { emojiCategories, rejectedEmoji, withTone, SKIN_TONES, QUICK_REACTIONS } = await import(
  '../src/renderer/src/lib/emoji.ts'
)

const bad = [...rejectedEmoji]
let count = 0
for (const cat of emojiCategories()) {
  for (const e of cat.emojis) {
    count++
    for (let t = 0; t < SKIN_TONES.length; t++) {
      const c = withTone(e, t)
      if (!EMOJI_RE.test(c)) bad.push(c)
      if (e.tone && t > 0 && c === e.char) bad.push(`${e.char} (tone ${t} not applied)`)
    }
  }
}
for (const q of QUICK_REACTIONS) if (!EMOJI_RE.test(q)) bad.push(q)

if (bad.length) {
  console.error(`check-emoji: ${bad.length} problem(s):`, bad)
  process.exit(1)
}
console.log(`check-emoji: ${count} emoji in ${emojiCategories().length} categories, all pass EMOJI_RE`)
