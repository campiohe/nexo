#!/usr/bin/env node
// Translation checker (src/renderer/src/i18n/README.md). Needs Node 23.6+ (loads the .ts dictionaries directly).
//
//   npm run i18n:check -w desktop                  missing pt-BR translations per area, unused keys, errors
//   npm run i18n:check -w desktop -- --todo        also: strings that look like UI text but aren't wrapped yet
//   npm run i18n:check -w desktop -- --todo=chat   the same for one area (or a path prefix: --todo=components/voice)
//   npm run i18n:check -w desktop -- --strict      exit 1 when a translation is missing too (default: only on errors)
//
// Keys are found in t('…'), t.rich('…') and msg('…') calls with a literal first argument (main: tm('…')). Errors:
// a message that doesn't parse, a translation whose {values} / <tags> differ from its key's, the same key translated
// differently in two area files, a key built with + or ${}.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const desktop = fileURLToPath(new URL('..', import.meta.url))
const rendererRoot = join(desktop, 'src/renderer/src')
const mainRoot = join(desktop, 'src/main')
const dictRoot = join(rendererRoot, 'i18n/pt-BR')

const { parseMessage, messageArguments, sourceText } = await import(join(rendererRoot, 'i18n/core.ts'))

/**
 * Which pt-BR/<area>.ts file holds the translations for a source file: the first prefix that matches (paths relative
 * to src/renderer/src). Keep in sync with the table in i18n/README.md.
 */
const AREAS = [
  ['common', ['lib/time.ts', 'lib/toast.ts', 'i18n/']],
  [
    'settings',
    [
      'components/SettingsModal.tsx',
      'components/LanguageSettings.tsx',
      'components/AppearanceSettings.tsx',
      'components/AccentPicker.tsx',
      'lib/appearance.ts',
      'lib/appIcon.ts',
      'lib/locale.ts',
      'lib/keybinds.ts',
    ],
  ],
  [
    'shell',
    [
      'App.tsx',
      'main.tsx',
      'components/TitleBar.tsx',
      'components/MainLayout.tsx',
      'components/Sidebar.tsx',
      'components/QuickSwitcher.tsx',
      'components/Toasts.tsx',
      'components/UpdateBanner.tsx',
      'components/Splash.tsx',
      'components/Modal.tsx',
      'components/Floating.tsx',
      'components/icons.tsx',
      'lib/updates.ts',
      'lib/notify.ts',
      'lib/url.ts',
      'store/ui.ts',
      'store/unread.ts',
      'store/settings.ts',
    ],
  ],
  [
    'accounts',
    [
      'components/Onboarding.tsx',
      'components/SignInSteps.tsx',
      'components/AccessRequestBanners.tsx',
      'store/app.ts',
      'store/admin.ts',
      'store/signin.ts',
      'store/logins.ts',
      'net/accounts.ts',
      'net/socket.ts',
      'lib/permissions.ts',
    ],
  ],
  [
    'people',
    [
      'components/MemberList.tsx',
      'components/MembersSection.tsx',
      'components/ProfileCard.tsx',
      'components/ProfileBanner.tsx',
      'components/BannerSettings.tsx',
      'components/StatusMenu.tsx',
      'components/ActivitySettings.tsx',
      'components/Avatar.tsx',
      'components/AvatarCropDialog.tsx',
      'components/ColorSwatches.tsx',
      'components/peopleIcons.tsx',
      'store/presence.ts',
      'lib/presenceSync.ts',
      'lib/activity.ts',
      'lib/avatar',
      'lib/gif',
      'lib/imageCrop.ts',
      'lib/imageEncode.ts',
      'lib/colors.ts',
      'lib/idleAnimations.ts',
      'net/avatar.ts',
      'net/banner.ts',
    ],
  ],
  ['plugins', ['components/PluginsSettings.tsx', 'store/plugins.ts']],
  ['music', ['components/voice/Music', 'components/voice/musicIcons.tsx', 'voice/music', 'store/music.ts']],
  ['emulator', ['components/emulator/', 'emulator/', 'store/emulator.ts']],
  ['voice', ['components/voice/', 'voice/', 'store/sounds.ts', 'net/sounds.ts']],
  [
    'chat',
    [
      'components/TextChannel.tsx',
      'components/Message',
      'components/PanelMessage.tsx',
      'components/PinsPanel.tsx',
      'components/Composer.tsx',
      'components/AutocompletePopup.tsx',
      'components/EmojiPicker.tsx',
      'components/Reactions.tsx',
      'components/EmbedCard.tsx',
      'components/ImageLightbox.tsx',
      'components/Search',
      'components/TypingLine.tsx',
      'components/chatIcons.tsx',
      'lib/messageTokens.ts',
      'lib/mentions.ts',
      'lib/searchQuery.ts',
      'lib/linkify.ts',
      'lib/highlight.ts',
      'lib/emoji',
      'net/attachments.ts',
      'net/embeds.ts',
      'store/compose.ts',
      'store/chatPanels.ts',
      'store/chatPrefs.ts',
    ],
  ],
]
/** Area files whose keys aren't t() calls (exact text from the server, looked up by tKnown): never "unused". */
const EXTERNAL_AREAS = new Set(['server'])

function areaOf(rel) {
  const p = rel.split(sep).join('/')
  for (const [area, prefixes] of AREAS) if (prefixes.some((x) => p.startsWith(x))) return area
  return '(no area: add it to AREAS)'
}

const args = process.argv.slice(2)
const strict = args.includes('--strict')
const todoArg = args.find((a) => a.startsWith('--todo'))
const todoFilter = todoArg?.includes('=') ? todoArg.slice(todoArg.indexOf('=') + 1) : null

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || full === dictRoot || full === join(rendererRoot, 'emulator/engine')) continue
      walk(full, out)
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

const STRING = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\x60(?:[^\x60\\$]|\\.|\$(?!\{))*\x60`
const lineOf = (text, index) => text.slice(0, index).split('\n').length

/** Keys used in `files` through calls named `names` → Map<key, [{ file, line }]>; also reports dynamic keys. */
function collect(files, root, names, errors) {
  const used = new Map()
  const call = new RegExp(String.raw`(?<![\w$.])(?:${names.join('|')})\(\s*(${STRING})(\s*[+,)]?)`, 'g')
  const templ = new RegExp(String.raw`(?<![\w$.])(?:${names.join('|')})\(\s*\x60[^\x60]*\$\{`, 'g')
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const rel = relative(root, file)
    const lines = text.split('\n')
    const inComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(lines[line - 1])
    for (const m of text.matchAll(call)) {
      const line = lineOf(text, m.index)
      if (inComment(line)) continue
      if (m[2].trim() === '+') {
        errors.push(`${rel}:${line}: a key is built with "+": write the whole sentence with {values}`)
        continue
      }
      const key = vm.runInNewContext(m[1])
      if (!used.has(key)) used.set(key, [])
      used.get(key).push({ file: rel, line })
    }
    for (const m of text.matchAll(templ)) {
      if (inComment(lineOf(text, m.index))) continue
      errors.push(`${relative(root, file)}:${lineOf(text, m.index)}: a key uses \${…}: write {values} instead`)
    }
  }
  return used
}

async function loadDictionaries() {
  const dicts = new Map()
  for (const name of readdirSync(dictRoot).filter((n) => n.endsWith('.ts')).sort()) {
    const mod = await import(join(dictRoot, name))
    dicts.set(name.slice(0, -3), mod.default ?? {})
  }
  return dicts
}

function argsOf(text) {
  return [...messageArguments(parseMessage(text))].sort().join(' ')
}

/** Parse errors and {value}/<tag> mismatches between a key and its translation. */
function checkPair(key, value, where, errors) {
  try {
    parseMessage(sourceText(key))
  } catch (err) {
    errors.push(`${where}: the key doesn't parse: ${err.message}`)
    return
  }
  if (value === undefined) return
  try {
    const a = argsOf(sourceText(key))
    const b = argsOf(value)
    if (a !== b) errors.push(`${where}: ${JSON.stringify(key)} uses ${a || 'no values'} but the translation ${b || 'none'}`)
  } catch (err) {
    errors.push(`${where}: the translation doesn't parse: ${err.message}`)
  }
}

const errors = []
const report = []
let missingTotal = 0

// ---- renderer ----
const files = walk(rendererRoot)
const used = collect(files, rendererRoot, ['t', 't\\.rich', 'msg'], errors)
const dicts = await loadDictionaries()

const translated = new Map() // key → { area, value }
for (const [area, dict] of dicts) {
  for (const [key, value] of Object.entries(dict)) {
    const prev = translated.get(key)
    if (prev && prev.value !== value) {
      errors.push(`pt-BR/${area}.ts: ${JSON.stringify(key)} is translated differently in pt-BR/${prev.area}.ts (add " // context" to one key)`)
    }
    if (!prev) translated.set(key, { area, value })
    checkPair(key, value, `pt-BR/${area}.ts`, errors)
  }
}

const missingByArea = new Map()
for (const [key, uses] of used) {
  const first = uses[0]
  if (!translated.has(key)) {
    checkPair(key, undefined, `${first.file}:${first.line}`, errors)
    const area = areaOf(first.file)
    if (!missingByArea.has(area)) missingByArea.set(area, [])
    missingByArea.get(area).push({ key, where: `${first.file}:${first.line}` })
  }
}

report.push(`Renderer: ${used.size} keys in use, ${translated.size} translated to pt-BR (${dicts.size} area files).`)
for (const [area, list] of [...missingByArea].sort()) {
  missingTotal += list.length
  report.push(`\nMissing pt-BR, area "${area}" → i18n/pt-BR/${area}.ts (${list.length}):`)
  for (const { key, where } of list) report.push(`  ${JSON.stringify(key)}  (${where})`)
}
for (const [area, dict] of dicts) {
  if (EXTERNAL_AREAS.has(area)) continue
  const unused = Object.keys(dict).filter((k) => !used.has(k))
  if (unused.length) {
    report.push(`\nUnused keys in pt-BR/${area}.ts (${unused.length}): delete them, or the code lost its t() call:`)
    for (const k of unused) report.push(`  ${JSON.stringify(k)}`)
  }
}

// ---- main process ----
const mainFiles = walk(mainRoot).filter((f) => !f.endsWith('i18n-pt-BR.ts'))
const mainUsed = collect(mainFiles, mainRoot, ['tm'], errors)
const mainDict = (await import(join(mainRoot, 'i18n-pt-BR.ts'))).default
const mainMissing = [...mainUsed].filter(([k]) => !(k in mainDict))
const mainUnused = Object.keys(mainDict).filter((k) => !mainUsed.has(k))
for (const [key, value] of Object.entries(mainDict)) checkPair(key, value, 'main/i18n-pt-BR.ts', errors)
report.push(`\nMain: ${mainUsed.size} keys in use, ${mainUsed.size - mainMissing.length} translated (src/main/i18n-pt-BR.ts).`)
for (const [key, uses] of mainMissing) report.push(`  missing: ${JSON.stringify(key)}  (${uses[0].file}:${uses[0].line})`)
for (const key of mainUnused) report.push(`  unused: ${JSON.stringify(key)}`)
missingTotal += mainMissing.length

// ---- --todo: likely UI text not wrapped yet (a heuristic: expect some noise) ----
if (todoArg) {
  const candidates = [
    // JSX text between tags
    [/>\s*([^<>{}\n;=]*[A-Za-z]{2,}[^<>{}\n;=]*?)\s*</g, (m) => !/^\s*[\w.]+\s*$/.test(m[1]) || /^[A-Z][a-z]/.test(m[1].trim())],
    // UI attributes
    [/\b(?:title|aria-label|aria-description|placeholder|alt|label|confirmLabel|cancelLabel|hint|description)=(["'])([^"'{}]*[A-Za-z]{2,}[^"'{}]*)\1/g, () => true],
    // toasts and thrown errors with literal text
    [/\b(?:toast|new Error|setError|reject)\(\s*(['"`])([A-Z][^'"`]*\s[^'"`]*)\1/g, () => true],
    // object properties holding UI text
    [/\b(?:label|title|text|hint|reason|description|placeholder|message|name|empty|tooltip):\s*(['"`])([A-Z][^'"`]*\s[^'"`]*)\1/g, () => true],
  ]
  const byArea = new Map()
  for (const file of files) {
    const rel = relative(rendererRoot, file)
    const area = areaOf(rel)
    if (rel.startsWith(`i18n${sep}`)) continue
    if (todoFilter && area !== todoFilter && !rel.split(sep).join('/').startsWith(todoFilter)) continue
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    const hits = []
    for (const [re, keep] of candidates) {
      for (const m of text.matchAll(re)) {
        if (!keep(m)) continue
        const line = lineOf(text, m.index)
        const src = lines[line - 1]
        if (/console\.|i18n-ignore|^\s*(\/\/|\*|\/\*)|\b(?:t|msg|t\.rich)\(/.test(src)) continue
        hits.push({ line, text: (m[2] ?? m[1]).trim().slice(0, 90) })
      }
    }
    if (!hits.length) continue
    const uniq = [...new Map(hits.map((h) => [`${h.line}:${h.text}`, h])).values()].sort((a, b) => a.line - b.line)
    if (!byArea.has(area)) byArea.set(area, [])
    byArea.get(area).push({ rel, hits: uniq })
  }
  report.push('\nProbably not wrapped yet (heuristic; "// i18n-ignore" on a line silences it):')
  let total = 0
  for (const [area, list] of [...byArea].sort()) {
    const n = list.reduce((s, f) => s + f.hits.length, 0)
    total += n
    report.push(`\n[${area}] ${n} in ${list.length} files`)
    for (const { rel, hits } of list) {
      report.push(`  ${rel} (${hits.length})`)
      if (todoFilter) for (const h of hits) report.push(`    ${h.line}: ${h.text}`)
    }
  }
  report.push(`\nTotal: ${total}${todoFilter ? '' : ' (pass --todo=<area> to list the strings)'}`)
}

console.log(report.join('\n'))
if (errors.length) {
  console.log(`\nErrors (${errors.length}):`)
  for (const e of errors) console.log(`  ${e}`)
}
console.log(`\n${missingTotal} missing translation(s), ${errors.length} error(s).`)
process.exit(errors.length || (strict && missingTotal) ? 1 : 0)
