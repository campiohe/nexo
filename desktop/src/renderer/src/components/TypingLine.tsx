import { useEffect, useState } from 'react'
import { useApp } from '../store/app'

export function typingText(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing…`
  return 'Several people are typing…'
}

export function TypingLine({ channelId }: { channelId: string }) {
  const entries = useApp((s) => s.typing[channelId])
  const users = useApp((s) => s.users)
  const meId = useApp((s) => s.me?.id)
  const [now, setNow] = useState(() => Date.now())

  const hasEntries = !!entries && Object.keys(entries).length > 0
  useEffect(() => {
    if (!hasEntries) return
    const t = setInterval(() => {
      setNow(Date.now())
      useApp.getState().pruneTyping()
    }, 500)
    return () => clearInterval(t)
  }, [hasEntries])

  const names = Object.entries(entries ?? {})
    .filter(([uid, exp]) => exp > now && uid !== meId)
    .map(([uid]) => users[uid]?.name ?? 'Someone')
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
          <span>{typingText(names)}</span>
        </>
      )}
    </div>
  )
}
