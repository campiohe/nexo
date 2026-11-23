// Language and time preferences (Settings → Language & time), local to this device (localStorage + zustand).
// Kept apart from lib/appearance.ts: these change how text is written, not how the app looks.
// - Language: 'system' follows the OS's preferred languages (from main, see NexoBridge.locale). The module body sets
//   <html lang> before the first paint (main.tsx imports it first) and tells main the language in use (tray menu).
//   Strings are translated by src/i18n (t / useT), which reads `language` from this store.
// - Clock: lib/time.ts reads the choice; 'auto' follows the OS's regional format (`region`), not the language.
import { create } from 'zustand'
import { LANGUAGES, type Language } from '../../../preload/api'
import { msg } from '../i18n/core'

export type { Language }

/** Settings → Language & time → Language. */
export type LanguageChoice = 'system' | Language

/** Each language's name in that language (the picker shows them untranslated). */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  'pt-BR': 'Português (Brasil)',
}

/** How clock times are written: the OS region's convention, or forced 12-hour ("9:05 PM") / 24-hour ("21:05"). */
export type ClockChoice = 'auto' | '12h' | '24h'

/** Labels are message keys: show them with t(c.label). */
export const CLOCK_CHOICES: { id: ClockChoice; label: string }[] = [
  { id: 'auto', label: msg('Automatic') },
  { id: '12h', label: msg('12-hour') },
  { id: '24h', label: msg('24-hour') },
]

const KEY_CLOCK = 'nexo:clock'
const KEY_LANGUAGE = 'nexo:language'

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
}

function readClock(): ClockChoice {
  const v = lsGet(KEY_CLOCK)
  return CLOCK_CHOICES.some((c) => c.id === v) ? (v as ClockChoice) : 'auto'
}

function readLanguage(): LanguageChoice {
  const v = lsGet(KEY_LANGUAGE)
  return v === 'system' || LANGUAGES.includes(v as Language) ? (v as LanguageChoice) : 'system'
}

/** A locale tag Intl accepts, or null. */
function validTag(tag: string | null | undefined): string | null {
  if (!tag) return null
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null
  } catch {
    return null
  }
}

const bridge = () => (typeof window !== 'undefined' ? window.nexo?.locale : undefined)

/** The OS's preferred UI languages, most preferred first (from main; the browser's list outside Electron). */
export function systemLanguages(): readonly string[] {
  const fromMain = bridge()?.system.languages
  if (fromMain && fromMain.length > 0) return fromMain
  return typeof navigator !== 'undefined' ? navigator.languages : []
}

/**
 * The OS's regional format (e.g. "pt-BR" on an English Windows set to Brazil), or undefined for the default locale
 * (outside Electron, or when main couldn't tell).
 */
export const regionLocale: string | undefined = validTag(bridge()?.system.region) ?? undefined

/** 'system' → Portuguese when the OS's most preferred language is Portuguese, English otherwise. */
export function resolveLanguage(choice: LanguageChoice): Language {
  if (choice !== 'system') return choice
  return systemLanguages()[0]?.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en'
}

/**
 * The locale for Intl (dates, numbers, plural rules) in a language: pt-BR, or for English the user's own English
 * variant when the region or OS languages name one (en-GB writes "7 November"), else en-US.
 */
export function intlLocale(language: Language): string {
  if (language === 'pt-BR') return 'pt-BR'
  const english = [regionLocale, ...systemLanguages()].find((l) => l?.toLowerCase().startsWith('en-'))
  return validTag(english) ?? 'en-US'
}

function applyLanguage(language: Language): void {
  if (typeof document !== 'undefined') document.documentElement.lang = language
  // Main translates the tray menu and its other strings; an identical report is a no-op there.
  bridge()?.setLanguage?.(language)
}

interface LocaleStore {
  clock: ClockChoice
  /** What the user picked. */
  languageChoice: LanguageChoice
  /** The language in use (follows the OS while languageChoice is 'system'). */
  language: Language
  /** Intl locale for `language` (intlLocale()). */
  intl: string
  setClock(clock: ClockChoice): void
  setLanguage(choice: LanguageChoice): void
}

// ---- before the first paint ----
const initialChoice = readLanguage()
const initialLanguage = resolveLanguage(initialChoice)
applyLanguage(initialLanguage)

export const useLocale = create<LocaleStore>()((set) => ({
  clock: readClock(),
  languageChoice: initialChoice,
  language: initialLanguage,
  intl: intlLocale(initialLanguage),
  setClock: (clock) => {
    lsSet(KEY_CLOCK, clock)
    set({ clock })
  },
  setLanguage: (languageChoice) => {
    lsSet(KEY_LANGUAGE, languageChoice)
    const language = resolveLanguage(languageChoice)
    applyLanguage(language)
    set({ languageChoice, language, intl: intlLocale(language) })
  },
}))
