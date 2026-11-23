// Profile banners: upload/removal over HTTP (PUT/DELETE /api/banner, see the BANNER_* block in
// shared/protocol.ts) and the built-in preset through `profile:update`.
import type { BannerPreset, User } from '@shared/protocol'
import { BANNER_ANIMATED_MAX_BYTES, BANNER_MAX_BYTES } from '@shared/protocol'
import { request } from './socket'
import { applyUser, authedImageRequest } from './avatar'
import { msg, t } from '../i18n'

const NO_BANNERS = msg("This server doesn't support banners yet (update the Nexo server)")
const mb = (n: number) => Math.round(n / (1024 * 1024))

/**
 * Upload an already cropped/resized banner: image/webp, image/png or image/jpeg (BANNER_MAX_BYTES), or an
 * animated image/gif (BANNER_ANIMATED_MAX_BYTES; the server then sets `bannerAnimated`).
 */
export function uploadBanner(image: Blob): Promise<User> {
  if (image.type === 'image/gif') {
    if (image.size > BANNER_ANIMATED_MAX_BYTES) {
      return Promise.reject(new Error(t('Animated banners are limited to {size} MB', { size: mb(BANNER_ANIMATED_MAX_BYTES) })))
    }
  } else if (image.size > BANNER_MAX_BYTES) {
    return Promise.reject(new Error(t('Banners are limited to {size} MB', { size: mb(BANNER_MAX_BYTES) })))
  }
  return authedImageRequest('/api/banner', 'PUT', NO_BANNERS, image)
}

export function removeBanner(): Promise<User> {
  return authedImageRequest('/api/banner', 'DELETE', NO_BANNERS)
}

/** Pick the built-in banner shown while there's no uploaded one. */
export async function setBannerPreset(bannerPreset: BannerPreset): Promise<User> {
  const user = await request('profile:update', { bannerPreset })
  applyUser(user)
  return user
}
