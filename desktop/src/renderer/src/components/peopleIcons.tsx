// Icons used by the people features (profile card, status menu, activity). Same style as ./icons.tsx.
import type { ReactNode } from 'react'
import type { IconProps } from './icons'

function Svg({ size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const GamepadIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 11h4M8 9v4" />
    <path d="M15 12h.01M18 10h.01" />
    <path d="M17.3 5H6.7a4 4 0 0 0-3.96 3.43l-.7 4.95A2.9 2.9 0 0 0 7 15.8L8.6 14h6.8l1.6 1.8a2.9 2.9 0 0 0 4.96-2.42l-.7-4.95A4 4 0 0 0 17.3 5Z" />
  </Svg>
)

export const AtIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
  </Svg>
)

export const SmileIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14a4 4 0 0 0 7 0" />
    <path d="M9 9.5h.01M15 9.5h.01" />
  </Svg>
)

/** A filled status dot (online / idle / dnd) for menus and labels. */
export function StatusDot({ status, size = 10 }: { status: 'online' | 'idle' | 'dnd' | 'offline'; size?: number }) {
  return <span className={`status-dot is-${status}`} style={{ width: size, height: size }} aria-hidden="true" />
}
