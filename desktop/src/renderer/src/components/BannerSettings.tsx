// Settings › Profile › Banner: preview at the profile card's aspect, upload (cropped to BANNER_ASPECT, GIFs stay
// animated) / remove, and the built-in styles shown when there's no upload. Hidden on servers without banners.
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { BANNER_PRESETS, type BannerPreset } from '@shared/protocol'
import { useApp } from '../store/app'
import { toast, useToasts } from '../lib/toast'
import { AVATAR_INPUT_TYPES, loadImageFile, type LoadedImage } from '../lib/imageCrop'
import { removeBanner, setBannerPreset, uploadBanner } from '../net/banner'
import { BannerCropDialog } from './AvatarCropDialog'
import { BANNER_PRESET_LABEL, ProfileBanner, supportsBanners } from './ProfileBanner'
import { useT } from '../i18n'
import '../styles/banners.css'

export function BannerField() {
  const t = useT()
  const me = useApp((s) => s.me)
  const [saving, setSaving] = useState<BannerPreset | null>(null)
  if (!me || !supportsBanners(me)) return null
  const current = me.bannerPreset

  const pick = async (preset: BannerPreset) => {
    if (preset === current || saving) return
    setSaving(preset)
    try {
      await setBannerPreset(preset)
    } catch (err) {
      toast(err, 'error')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="field banner-field">
      <span className="field-label">{t('Banner')}</span>
      <div className="banner-editor">
        <span className="banner-editor-preview">
          <ProfileBanner user={me} />
          {me.banner && me.bannerAnimated && (
            <span className="avatar-gif-badge" title={t('Animated banner: it plays while your profile card is open')}>
              GIF
            </span>
          )}
        </span>
        <BannerActions hasBanner={!!me.banner} />
      </div>
      <div className="banner-presets" role="radiogroup" aria-label={t('Banner style')}>
        {BANNER_PRESETS.map((preset) => {
          const selected = preset === current
          return (
            <button
              key={preset}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`banner-preset ${selected ? 'is-selected' : ''}`}
              onClick={() => void pick(preset)}
              disabled={!!saving}
            >
              <ProfileBanner user={me} preset={preset} className="banner-preset-swatch" />
              <span className="banner-preset-label">{t(BANNER_PRESET_LABEL[preset])}</span>
            </button>
          )
        })}
      </div>
      <span className="muted small">
        {me.banner ? t('Your uploaded banner shows instead of a style. Remove it to use one.') : t('Styles use your color.')}
      </span>
    </div>
  )
}

function BannerActions({ hasBanner }: { hasBanner: boolean }) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement>(null)
  const [image, setImage] = useState<LoadedImage | null>(null)
  const [busy, setBusy] = useState(false)

  // Free the decoded image's blob: URL when the dialog closes (or Settings unmounts).
  useEffect(() => () => image?.release(), [image])

  const pickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // picking the same file again should still fire `change`
    if (!file) return
    try {
      setImage(await loadImageFile(file))
    } catch (err) {
      toast(err, 'error')
    }
  }

  const upload = async (picture: Blob) => {
    const pending = toast(t('Uploading banner…'), 'info', 30_000)
    try {
      await uploadBanner(picture)
      setImage(null)
      toast(t('Banner updated'), 'success')
    } finally {
      useToasts.getState().dismiss(pending)
    }
  }

  const remove = async () => {
    if (busy) return
    setBusy(true)
    try {
      await removeBanner()
      toast(t('Banner removed'), 'success')
    } catch (err) {
      toast(err, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-actions banner-actions">
      <input
        ref={fileRef}
        type="file"
        accept={AVATAR_INPUT_TYPES.join(',')}
        onChange={pickFile}
        hidden
        tabIndex={-1}
        aria-hidden="true"
      />
      <button className="btn btn-primary btn-sm" onClick={() => fileRef.current?.click()} disabled={busy}>
        {t('Upload banner')}
      </button>
      {hasBanner && (
        <button className="btn btn-ghost btn-sm" onClick={remove} disabled={busy}>
          {t('Remove')}
        </button>
      )}
      {image && <BannerCropDialog image={image} onCancel={() => setImage(null)} onConfirm={upload} />}
    </div>
  )
}
