// Time formatting helpers for chat.

const pad = (n: number) => String(n).padStart(2, '0')

/** "21:04" */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Full date + time for tooltips, e.g. "Saturday, 7 November 2026 at 21:04". */
export function formatFull(ts: number): string {
  const d = new Date(ts)
  const date = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  return `${date} ${formatTime(ts)}`
}

export function isSameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/** Label for a date separator: "Today", "Yesterday", or "7 November 2026". */
export function formatDay(ts: number, now = Date.now()): string {
  if (isSameDay(ts, now)) return 'Today'
  if (isSameDay(ts, now - 86_400_000)) return 'Yesterday'
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(undefined, {
    weekday: sameYear ? 'long' : undefined,
    year: sameYear ? undefined : 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
