// Main's own strings (tray menu and tooltip, the tray hint, update and global hotkey messages) in the app language.
// The renderer owns the language choice (lib/locale.ts): it reports the language in use on start and on every change
// (IPC.localeSetLanguage). Main keeps the last one in prefs.json, so the tray starts in the right language on the
// next launch; before the renderer ever reported one, the OS's preferred language decides (like the renderer's
// "System" choice). Keys are the English text, as in the renderer (src/renderer/src/i18n/README.md); the
// translations are in i18n-pt-BR.ts.
import { ipcMain } from 'electron'
import { IPC, LANGUAGES, type Language } from '../preload/api'
import ptBR from './i18n-pt-BR'
import { systemLanguages } from './platform'
import { saveLanguage, savedLanguage } from './prefs'
import { isAppUrl } from './security'

let current: Language | null = null
const listeners = new Set<() => void>()

/** The renderer's 'system' rule: Portuguese if the OS's most preferred language is, English otherwise. */
const fromSystem = (): Language => (systemLanguages()[0]?.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en')

/** The language main's strings use now. */
export function language(): Language {
  current ??= savedLanguage() ?? fromSystem()
  return current
}

/**
 * Main's t(): the English `source` in the current language, with `{name}` placeholders filled from `vars`. Plurals:
 * pick between two keys in code (count === 1 ? '… mention' : '… mentions'), there are only a few.
 */
export function tm(source: string, vars?: Record<string, string | number>): string {
  const text = (language() === 'pt-BR' ? ptBR[source] : undefined) ?? source
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

/** Called after the language changed (rebuild menus, refresh cached messages). */
export function onLanguageChange(cb: () => void): void {
  listeners.add(cb)
}

export function installLanguage(): void {
  ipcMain.on(IPC.localeSetLanguage, (event, next: unknown) => {
    if (!isAppUrl(event.senderFrame?.url) || !LANGUAGES.includes(next as Language)) return
    const lang = next as Language
    saveLanguage(lang)
    if (lang === language()) return
    current = lang
    for (const cb of listeners) {
      try {
        cb()
      } catch (err) {
        console.warn('[nexo] language change listener failed:', err)
      }
    }
  })
}
