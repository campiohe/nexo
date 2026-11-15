// Icons for pins, search and link previews (same style as icons.tsx: stroke-based, 24px grid, currentColor).
import type { IconProps } from './icons'

const svgProps = (size: number) =>
  ({
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
  }) as const

/** A push pin, tilted. */
export const PinIcon = ({ size = 18, ...rest }: IconProps) => (
  <svg {...svgProps(size)} {...rest}>
    <g transform="rotate(30 12 12)">
      <path d="M12 17v5" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </g>
  </svg>
)

/** Unpin: the pin crossed out. */
export const PinOffIcon = ({ size = 18, ...rest }: IconProps) => (
  <svg {...svgProps(size)} {...rest}>
    <g transform="rotate(30 12 12)">
      <path d="M12 17v5" />
      <path d="M15 9.34V6h1a2 2 0 0 0 0-4H7.89" />
      <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" />
    </g>
    <path d="m3 3 18 18" />
  </svg>
)

/** Filled play triangle (video thumbnails). */
export const PlayIcon = ({ size = 18, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...rest}>
    <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
  </svg>
)
