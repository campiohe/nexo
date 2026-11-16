// Inline stroke icons for the music plugin UI (24×24 grid, currentColor), same style as ./icons.tsx.
import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

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

/** A vinyl record (the soundboard uses a music note, so the two toolbar buttons don't look alike). */
export const MusicIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M7.5 9.2a5.5 5.5 0 0 1 2.4-2.5M16.5 14.8a5.5 5.5 0 0 1-2.4 2.5" />
  </Svg>
)

export const PauseIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />
    <rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />
  </Svg>
)

export const SkipNextIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 5v14l10-7L5 5z" fill="currentColor" />
    <path d="M19 5v14" />
  </Svg>
)

export const SkipPrevIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 5v14L9 12l10-7z" fill="currentColor" />
    <path d="M5 5v14" />
  </Svg>
)

/** Queue: lines with a note. */
export const QueueIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h12M3 12h12M3 18h7" />
    <path d="M19 9v9" />
    <circle cx="17" cy="18" r="2" />
  </Svg>
)

/** "Play next": insert at the top of the queue. */
export const PlayNextIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h10M3 12h10M3 18h6" />
    <path d="M16 8l5 4-5 4V8z" fill="currentColor" />
  </Svg>
)

/** Lower music while people talk: a speech bubble with a down arrow. */
export const DuckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />
    <path d="M13 8.5v6M10.5 12l2.5 2.5 2.5-2.5" />
  </Svg>
)

export const GripIcon = (p: IconProps) => (
  <Svg {...p} strokeWidth={0}>
    {[7, 12, 17].map((y) => (
      <g key={y} fill="currentColor">
        <circle cx="9" cy={y} r="1.5" />
        <circle cx="15" cy={y} r="1.5" />
      </g>
    ))}
  </Svg>
)

export const BackIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
)

export const LinkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </Svg>
)
