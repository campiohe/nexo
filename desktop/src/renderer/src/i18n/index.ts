// Translations for the renderer. English is the source language: a message's key is its English text, and a missing
// Brazilian Portuguese translation shows the English. How to use it: ./README.md. Message syntax: ./core.ts.
//
//   const t = useT()                              components: re-render when the language changes
//   t('Upload picture')                           plain
//   t('Signed in as {name}', { name })            values
//   t('{count, plural, one {# member} other {# members}}', { count })
//   t.rich('Remove <b>{name}</b>?', { name, b: (c) => <strong>{c}</strong> })
//   t('Clear')  in a plain module / event handler: the `t` export (current language, no subscription)
//   msg('Automatic')                              module-scope constants: mark now, t(label) where shown
import { createElement, Fragment, type ReactNode } from 'react'
import { useLocale, type Language } from '../lib/locale'
import { numberFormat, parseCached, renderNodes, sourceText, type Dict } from './core'

export { msg, type Dict } from './core'
export type { Language }

/** Every file in ./pt-BR (one per area of the app), merged. */
const PT_BR: Dict = Object.assign(
  {},
  ...Object.values(import.meta.glob<Dict>('./pt-BR/*.ts', { eager: true, import: 'default' })),
)

const DICTIONARIES: Record<Language, Dict | null> = { en: null, 'pt-BR': PT_BR }

/** Values for {name} placeholders and plural/select arguments. Numbers are formatted for the language. */
export type Values = Readonly<Record<string, string | number>>

/** Rich text: values may be elements, and each tag in the message is a function that wraps its contents. */
export type RichValues = Readonly<Record<string, ReactNode | ((chunks: ReactNode) => ReactNode)>>

export interface Translate {
  /** The message in this language, as a string. */
  (key: string, values?: Values): string
  /** The message as React nodes: for elements inside a sentence (a bold name, a link) without concatenation. */
  rich(key: string, values?: RichValues): ReactNode
  readonly language: Language
  /** The Intl locale for this language (dates, numbers, sorting). */
  readonly locale: string
}

function message(language: Language, key: string): string {
  return DICTIONARIES[language]?.[key] ?? sourceText(key)
}

function wrapTag(values: RichValues | undefined) {
  return (name: string, children: unknown[]): unknown => {
    const inner: ReactNode = children.length === 1 ? (children[0] as ReactNode) : createElement(Fragment, null, ...(children as ReactNode[]))
    const render = values?.[name]
    return typeof render === 'function' ? render(inner) : inner
  }
}

function translator(language: Language, locale: string): Translate {
  const translate = ((key: string, values?: Values): string =>
    renderNodes(parseCached(message(language, key)), locale, values).join('')) as Translate
  const rich = (key: string, values?: RichValues): ReactNode => {
    const parts = renderNodes(parseCached(message(language, key)), locale, values, wrapTag(values)) as ReactNode[]
    if (parts.length === 0) return ''
    if (parts.length === 1) return parts[0]
    // Passed as separate children: React doesn't ask for keys.
    return createElement(Fragment, null, ...parts)
  }
  return Object.assign(translate, { rich, language, locale })
}

const translators = new Map<string, Translate>()

function translatorFor(language: Language, locale: string): Translate {
  const id = `${language}|${locale}`
  let tr = translators.get(id)
  if (!tr) {
    tr = translator(language, locale)
    translators.set(id, tr)
  }
  return tr
}

const current = (): Translate => {
  const { language, intl } = useLocale.getState()
  return translatorFor(language, intl)
}

/**
 * The current language, for plain modules, event handlers, toasts and store actions. In a component use useT(),
 * which also re-renders it when the language changes.
 */
export const t: Translate = Object.defineProperties(
  Object.assign((key: string, values?: Values) => current()(key, values), {
    rich: (key: string, values?: RichValues) => current().rich(key, values),
  }),
  {
    language: { get: () => useLocale.getState().language },
    locale: { get: () => useLocale.getState().intl },
  },
) as Translate

/**
 * The translator for components: subscribes to the language, so the component re-renders when it changes. Its
 * identity changes with the language: put it in the deps of useMemo / useCallback that build translated text.
 */
export function useT(): Translate {
  const language = useLocale((s) => s.language)
  const intl = useLocale((s) => s.intl)
  return translatorFor(language, intl)
}

/**
 * Text that comes from elsewhere (the server's error messages, main's diagnostics), translated when a dictionary has
 * exactly that text as a key, else unchanged. Never parsed as a message, so any text is safe. lib/toast.ts applies it
 * to every error it shows; the server's messages are in pt-BR/server.ts.
 */
export function tKnown(text: string): string {
  return DICTIONARIES[useLocale.getState().language]?.[text] ?? text
}

/** The language in use, subscribed. */
export const useLanguage = (): Language => useLocale((s) => s.language)

/** A number for the UI in the current language ("1,234.5" / "1.234,5"). Components: call it after useT(). */
export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return numberFormat(useLocale.getState().intl, options).format(n)
}

const listFormats = new Map<string, Intl.ListFormat>()

/** "Ana, Bia and Caio" / "Ana, Bia e Caio" (type 'disjunction': "or" / "ou"). Components: call it after useT(). */
export function formatList(items: readonly string[], type: 'conjunction' | 'disjunction' = 'conjunction'): string {
  const locale = useLocale.getState().intl
  const id = `${locale}|${type}`
  let f = listFormats.get(id)
  if (!f) {
    f = new Intl.ListFormat(locale, { style: 'long', type })
    listFormats.set(id, f)
  }
  return f.format(items)
}
