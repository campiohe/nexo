// Owner: workstream D. Inline stroke icons for the voice UI (24×24 grid, currentColor).
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
      {...rest}
    >
      {children}
    </svg>
  )
}

export const MicIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Svg>
)

export const MicOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3" />
    <path d="M5 11a7 7 0 0 0 11.4 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" />
  </Svg>
)

export const HeadphonesIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
    <rect x="3" y="14" width="5" height="7" rx="2" />
    <rect x="16" y="14" width="5" height="7" rx="2" />
  </Svg>
)

export const HeadphonesOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 15v-3a8 8 0 0 1 12.7-6.5M19.6 9.5c.3.8.4 1.6.4 2.5v3" />
    <rect x="3" y="14" width="5" height="7" rx="2" />
    <path d="M16 18v1a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3M3 3l18 18" />
  </Svg>
)

export const CameraIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="6" width="14" height="12" rx="3" />
    <path d="m16 10.5 6-3.5v10l-6-3.5" />
  </Svg>
)

export const CameraOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 6h3a3 3 0 0 1 3 3v3.5l6 3.5V7l-6 3.5M16 16a3 3 0 0 1-3 2H5a3 3 0 0 1-3-3V9a3 3 0 0 1 2-2.8M3 3l18 18" />
  </Svg>
)

export const ScreenIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </Svg>
)

export const ScreenShareIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4M12 14V8M9 10.5 12 7.5l3 3" />
  </Svg>
)

export const ScreenStopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4M9.5 8l5 5M14.5 8l-5 5" />
  </Svg>
)

export const PhoneOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 13.5c4.7-4.2 12.3-4.2 17 0l-1.8 2.7a1.2 1.2 0 0 1-1.5.4l-2.5-1.1a1.2 1.2 0 0 1-.7-1.1v-1.6a12 12 0 0 0-4 0v1.6c0 .5-.3.9-.7 1.1l-2.5 1.1a1.2 1.2 0 0 1-1.5-.4z" />
  </Svg>
)

export const VolumeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9h3l5-4v14l-5-4H4z" />
    <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />
  </Svg>
)

export const VolumeOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9h3l5-4v14l-5-4H4zM16 9.5l5 5M21 9.5l-5 5" />
  </Svg>
)

export const EyeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
)

export const EyeOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.4 3.3M6.6 6.6C3.6 8.5 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
  </Svg>
)

export const FullscreenIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
)

export const CollapseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
  </Svg>
)

export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" />
  </Svg>
)

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)

export const WindowIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
  </Svg>
)

export const SpeakerIcon = VolumeIcon

export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 2 20h20L12 3zM12 10v4M12 17h.01" />
  </Svg>
)

export const ExpandIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
  </Svg>
)
