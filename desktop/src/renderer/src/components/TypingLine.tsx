import { useEffect, useState } from 'react'
import { useApp } from '../store/app'
import { useT, type Translate } from '../i18n'

export function typingText(names: string[], t: Translate): string {
  if (names.length === 0) return ''
  if (names.length === 1) return t('{name} is typing…', { name: names[0]! })
  if (names.length === 2) return t('{a} and {b} are typing…', { a: names[0]!, b: names[1]! })
  if (names.length === 3) return t('{a}, {b} and {c} are typing…', { a: names[0]!, b: names[1]!, c: names[2]! })
  return t('Several people are typing…')
}

export function TypingLine({ channelId }: { channelId: string }) {
  const t = useT()
  const entries = useApp((s) => s.typing[channelId])
  const users = useApp((s) => s.users)
  const meId = useApp((s) => s.me?.id)
  const [now, setNow] = useState(() => Date.now())

  const hasEntries = !!entries && Object.keys(entries).length > 0
  useEffect(() => {
    if (!hasEntries) return
    const timer = setInterval(() => {
      setNow(Date.now())
      useApp.getState().pruneTyping()
    }, 500)
    return () => clearInterval(timer)
  }, [hasEntries])

  const names = Object.entries(entries ?? {})
    .filter(([uid, exp]) => exp > now && uid !== meId)
    .map(([uid]) => users[uid]?.name ?? t('Someone'))
    .sort()

  return (
    <div className="typing-line" aria-live="polite">
      {names.length > 0 && (
        <>
          <span className="typing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>{typingText(names, t)}</span>
        </>
      )}
    </div>
  )
}
