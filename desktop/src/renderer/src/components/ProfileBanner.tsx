// A user's profile banner (profile card, Settings › Profile): their uploaded image when they have one, else
// their built-in preset (styles/banners.css), drawn from their color. Older servers send no banner fields:
// that's the plain color ('solid'), as before banners existed.
import { useState, type CSSProperties } from 'react'
import { isBannerPreset, type BannerPreset, type User } from '@shared/protocol'
import { bannerUrl } from '../lib/avatar'
import { usePrefersReducedMotion, useStillFrame } from '../lib/avatarStill'
import { useWindowActive } from '../lib/idleAnimations'
import { useApp } from '../store/app'
import { msg } from '../i18n'
import '../styles/banners.css'

/** Message keys (msg): show them with t(BANNER_PRESET_LABEL[preset]). */
export const BANNER_PRESET_LABEL: Record<BannerPreset, string> = {
  solid: msg('Solid'),
  flow: msg('Flow'),
  aurora: msg('Aurora'),
  waves: msg('Waves'),
  dots: msg('Dots'),
  swirl: msg('Swirl'),
}

/** The server supports banners (it sends `bannerPreset` on every user). */
export const supportsBanners = (user: Pick<User, 'bannerPreset'> | null | undefined): boolean =>
  !!user && typeof user.bannerPreset === 'string'

interface Props {
  user: Pick<User, 'color'> & Partial<Pick<User, 'id' | 'banner' | 'bannerAnimated' | 'bannerPreset'>>
  className?: string
  /** Show this preset instead of the user's banner (the preset picker's swatches). */
  preset?: BannerPreset
  /**
   * An animated upload plays while this is true (default), the window has focus and the OS doesn't ask for
   * reduced motion; otherwise its first frame shows. Presets follow CSS (paused when the window is inactive
   * or with reduced motion, see banners.css).
   */
  animate?: boolean
}

export function ProfileBanner({ user, className, preset, animate = true }: Props) {
  const serverUrl = useApp((s) => s.serverUrl)
  const url = preset ? null : bannerUrl(serverUrl, user)
  // Remember which URL failed so a new version is tried again; meanwhile the preset shows.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showImage = !!url && url !== failedUrl
  const animated = showImage && !!user.bannerAnimated
  const still = useStillFrame(animated ? url : null)
  const reducedMotion = usePrefersReducedMotion()
  const active = useWindowActive()
  const play = animated && ((animate && active && !reducedMotion) || still.failed)

  const chosen = preset ?? user.bannerPreset
  const kind: BannerPreset = isBannerPreset(chosen) ? chosen : 'solid'
  const style = { '--banner-c': user.color } as CSSProperties

  const img = (src: string, onError?: () => void) => (
    <img className="banner-img" src={src} alt="" draggable={false} decoding="async" onError={onError} />
  )

  return (
    <div className={`banner ${showImage ? 'has-image' : `banner-${kind}`} ${className ?? ''}`} style={style} aria-hidden="true">
      {!showImage
        ? null
        : !animated
          ? img(url, () => setFailedUrl(url))
          : (
              <>
                {still.url && img(still.url)}
                {/* Mounted only while playing (on top of the still frame), so an idle banner costs nothing. */}
                {play && img(url, () => setFailedUrl(url))}
              </>
            )}
    </div>
  )
}
