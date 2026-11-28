// The app icon variant chosen in Settings → Appearance (lib/appIcon.ts), drawn like renderAppIcon draws it for main:
// the accent's dark-palette shade in any theme, so it matches the taskbar. Used by the title bar and the settings tiles.
import { useId } from 'react'
import { ICON_GEOMETRY, iconColors, type AppIconChoice } from '../lib/appIcon'

export function AppIconArt({
  choice,
  className,
  outline = false,
}: {
  choice: AppIconChoice
  className?: string
  /** A hairline around the tile, so one the color of the page (Mono on Midnight, Paper on Light) stays visible. */
  outline?: boolean
}) {
  const mask = `app-icon-${useId().replace(/:/g, '')}`
  const { tile, ring, cut, dot } = ICON_GEOMETRY
  const colors = iconColors(choice, 'var(--accent-d)', 'var(--accent-ink-d)')
  return (
    <svg className={className} viewBox={`${tile.x} ${tile.y} ${tile.size} ${tile.size}`} aria-hidden="true" focusable="false">
      <defs>
        <mask id={mask}>
          <rect width={ICON_GEOMETRY.size} height={ICON_GEOMETRY.size} fill="#fff" />
          <circle cx={cut.cx} cy={cut.cy} r={cut.r} fill="#000" />
        </mask>
      </defs>
      <rect
        x={tile.x}
        y={tile.y}
        width={tile.size}
        height={tile.size}
        rx={tile.radius}
        fill={colors.tile}
        {...(outline ? { stroke: 'var(--line-strong)', strokeWidth: 12 } : {})}
      />
      <circle cx={ring.cx} cy={ring.cy} r={ring.r} fill="none" stroke={colors.ring} strokeWidth={ring.width} mask={`url(#${mask})`} />
      <circle cx={dot.cx} cy={dot.cy} r={dot.r} fill={colors.dot} />
    </svg>
  )
}
