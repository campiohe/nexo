// Date and time formatting for the UI. Every clock time the renderer shows goes through here, so the
// Settings → Language & time choices apply everywhere: dates are written in the app language (lib/locale.ts `intl`:
// "sábado, 7 de novembro de 2026" in Portuguese), and the "Clock" choice picks 12- or 24-hour times ('auto' follows
// the OS's regional format, so an English Windows set to Brazil gets 24-hour times).
// Components that show times call useClock() and pass the result to formatTime / formatFull: it re-renders them when
// the clock choice or the language changes (without it, an already-rendered time would keep the old format).
import { t } from '../i18n'
import { regionLocale, useLocale, type ClockChoice } from './locale'

export type { ClockChoice }

/** The clock choice, subscribed (to the language too): pass it to formatTime / formatFull from a component. */
export function useClock(): ClockChoice {
  useLocale((s) => s.intl)
  return useLocale((s) => s.clock)
}

const currentClock = (): ClockChoice => useLocale.getState().clock

/** Whether the OS region writes 12-hour times (what 'auto' follows). */
let regionIs12h: boolean | null = null
function uses12h(clock: ClockChoice): boolean {
  if (clock !== 'auto') return clock === '12h'
  if (regionIs12h === null) {
    const cycle = new Intl.DateTimeFormat(regionLocale, { hour: 'numeric' }).resolvedOptions().hourCycle
    regionIs12h = cycle === 'h11' || cycle === 'h12'
  }
  return regionIs12h
}

/**
 * The hour cycle is always explicit: 'auto' follows the region, not the language. 'h23' rather than hour12: false,
 * which can print "24:05" at midnight. 24-hour times keep a leading zero ("09:05"), 12-hour ones don't ("9:05 AM").
 */
function hourOptions(clock: ClockChoice): Intl.DateTimeFormatOptions {
  return uses12h(clock) ? { hour: 'numeric', hour12: true } : { hour: '2-digit', hourCycle: 'h23' }
}

// Building a DateTimeFormat is slow next to using one; long message lists format hundreds of times per render.
const formats = new Map<string, Intl.DateTimeFormat>()

/** A cached formatter for the app language; `withTime` adds the hour (per the clock choice) to `options`. */
function format(name: string, clock: ClockChoice, options: Intl.DateTimeFormatOptions, withTime = true): Intl.DateTimeFormat {
  const locale = useLocale.getState().intl
  const key = `${locale}:${name}:${clock}`
  let f = formats.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, withTime ? { ...options, ...hourOptions(clock) } : options)
    formats.set(key, f)
  }
  return f
}

/** Clock time: "9:05 PM" or "21:05". */
export function formatTime(ts: number, clock: ClockChoice = currentClock()): string {
  return format('time', clock, { minute: '2-digit' }).format(ts)
}

/** Full date and time for tooltips: "Saturday, November 7, 2026 at 9:05 PM", "sábado, 7 de novembro de 2026 às 21:05". */
export function formatFull(ts: number, clock: ClockChoice = currentClock()): string {
  return format('full', clock, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    minute: '2-digit',
  }).format(ts)
}

export function isSameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/**
 * Label for a date separator: "Today", "Yesterday", or "Saturday, November 7" ("November 7, 2025" in another year);
 * in Portuguese "Hoje", "Ontem", "Sábado, 7 de novembro" ("7 de novembro de 2025").
 */
export function formatDay(ts: number, now = Date.now()): string {
  if (isSameDay(ts, now)) return t('Today')
  if (isSameDay(ts, now - 86_400_000)) return t('Yesterday')
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear()
  // Date only: the clock choice doesn't apply.
  const text = sameYear
    ? format('day', 'auto', { weekday: 'long', month: 'long', day: 'numeric' }, false).format(ts)
    : format('day-year', 'auto', { year: 'numeric', month: 'long', day: 'numeric' }, false).format(ts)
  // A separator starts with a capital in every language (Portuguese writes weekdays in lowercase).
  return text.charAt(0).toLocaleUpperCase(useLocale.getState().intl) + text.slice(1)
}
