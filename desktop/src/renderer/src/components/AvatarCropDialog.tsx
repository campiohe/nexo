// Crop for a new profile picture (square, live round previews) or banner (BANNER_ASPECT, previewed at the
// profile card's size): drag to move, wheel/slider/keys to zoom. Animations (GIF / animated WebP / APNG) play
// while cropping and are saved as an animated GIF.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { BANNER_ASPECT } from '@shared/protocol'
import { AVATAR_ANIMATED_TARGET, BANNER_ANIMATED_TARGET, encodeAnimated, isAbort } from '../lib/gifAvatar'
import {
  AVATAR_TARGET,
  BANNER_TARGET,
  drawCrop,
  encodeStill,
  type CropRect,
  type EncodeTarget,
  type LoadedImage,
} from '../lib/imageCrop'
import { toast } from '../lib/toast'
import { formatList, msg, useT } from '../i18n'
import { useApp } from '../store/app'
import { Avatar } from './Avatar'
import { Modal } from './Modal'
import './avatarMedia.css'

const MAX_ZOOM = 5

/** Profile card width in CSS px (styles/people.css .pc): banners are previewed at their real size. */
const CARD_WIDTH = 300

interface CropKind {
  /** Viewport size in CSS px (the rectangle that becomes the image). */
  viewW: number
  viewH: number
  /** Preview sizes (width × height in CSS px). */
  previews: readonly (readonly [number, number])[]
  still: EncodeTarget
  animated: EncodeTarget
  /** Message keys (msg), translated where shown. */
  title: string
  save: string
  /** Shown under the viewport for animations. */
  animNote: string
  positionLabel: string
  modalWidth: number
}

const KINDS: Record<'avatar' | 'banner', CropKind> = {
  avatar: {
    viewW: 280,
    viewH: 280,
    previews: [
      [96, 96],
      [40, 40],
    ],
    still: AVATAR_TARGET,
    animated: AVATAR_ANIMATED_TARGET,
    title: msg('Crop your picture'),
    save: msg('Save picture'),
    animNote: msg('Stays animated. It plays when someone hovers over you and while you talk.'),
    positionLabel: msg('Picture position. Drag or use the arrow keys to move, + and - to zoom.'),
    modalWidth: 520,
  },
  banner: {
    // Fills the 520 px modal's body.
    viewW: 470,
    viewH: Math.round(470 / BANNER_ASPECT),
    previews: [[CARD_WIDTH, Math.round(CARD_WIDTH / BANNER_ASPECT)]],
    still: BANNER_TARGET,
    animated: BANNER_ANIMATED_TARGET,
    title: msg('Crop your banner'),
    save: msg('Save banner'),
    animNote: msg('Stays animated. It plays while your profile card is open.'),
    positionLabel: msg('Banner position. Drag or use the arrow keys to move, + and - to zoom.'),
    modalWidth: 520,
  },
}

interface View {
  zoom: number
  /** Top-left of the displayed image relative to the viewport, in CSS px (always <= 0). */
  x: number
  y: number
}

interface Props {
  image: LoadedImage
  onCancel(): void
  /** Receives the encoded picture; the dialog stays open (busy) until this settles. */
  onConfirm(picture: Blob): Promise<void>
}

export function AvatarCropDialog(props: Props) {
  return <ImageCropDialog {...props} kind="avatar" />
}

/** Crops to BANNER_ASPECT; the preview shows the banner as the profile card does, with your avatar on it. */
export function BannerCropDialog(props: Props) {
  return <ImageCropDialog {...props} kind="banner" />
}

function ImageCropDialog({ image, onCancel, onConfirm, kind: kindId }: Props & { kind: 'avatar' | 'banner' }) {
  const t = useT()
  const kind = KINDS[kindId]
  const { viewW: VW, viewH: VH } = kind
  const { width, height } = image
  /** Display scale at zoom 1: the image exactly covers the viewport. */
  const base = Math.max(VW / width, VH / height)

  const clamp = (v: View): View => {
    const zoom = Math.min(MAX_ZOOM, Math.max(1, v.zoom))
    const s = base * zoom
    return {
      zoom,
      x: Math.min(0, Math.max(VW - width * s, v.x)),
      y: Math.min(0, Math.max(VH - height * s, v.y)),
    }
  }

  const [view, setView] = useState<View>(() =>
    clamp({ zoom: 1, x: (VW - width * base) / 2, y: (VH - height * base) / 2 }),
  )
  const [busy, setBusy] = useState(false)
  /** Animated pictures: encoding progress (0..100) while preparing the GIF, null otherwise. */
  const [prep, setPrep] = useState<{ percent: number; simplifying: boolean } | null>(null)
  /** Aborts the animation encode in progress (Cancel, or the dialog closing). */
  const encodeAbort = useRef<AbortController | null>(null)
  useEffect(() => () => encodeAbort.current?.abort(), [])
  const animated = !!image.animatedType
  const viewportRef = useRef<HTMLDivElement>(null)
  const previewRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const drag = useRef<{ id: number; startX: number; startY: number; from: View } | null>(null)

  /** Zoom to `zoom`, keeping the image point under viewport point (px, py) fixed. */
  const zoomAt = (zoom: number, px = VW / 2, py = VH / 2) =>
    setView((v) => {
      const s = base * v.zoom
      const next = Math.min(MAX_ZOOM, Math.max(1, zoom))
      const s2 = base * next
      const srcX = (px - v.x) / s
      const srcY = (py - v.y) / s
      return clamp({ zoom: next, x: px - srcX * s2, y: py - srcY * s2 })
    })

  const crop: CropRect = useMemo(() => {
    const s = base * view.zoom
    const w = Math.min(VW / s, width)
    const h = Math.min(VH / s, height)
    return {
      x: Math.min(width - w, Math.max(0, -view.x / s)),
      y: Math.min(height - h, Math.max(0, -view.y / s)),
      width: w,
      height: h,
    }
  }, [view, base, width, height, VW, VH])

  useEffect(() => {
    if (animated) return // previews are cropped <img>s that play the animation
    const dpr = window.devicePixelRatio || 1
    kind.previews.forEach(([w, h], i) => {
      const canvas = previewRefs.current[i]
      // Draw at device resolution so the preview is as sharp as the real thing.
      if (canvas) drawCrop(canvas, image.img, crop, Math.round(w * dpr), Math.round(h * dpr))
    })
  }, [crop, image, animated, kind])

  // Wheel zoom needs a non-passive listener to stop the modal from scrolling.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const factor = Math.exp(-e.deltaY * 0.0015)
      setView((v) => {
        const s = base * v.zoom
        const next = Math.min(MAX_ZOOM, Math.max(1, v.zoom * factor))
        const px = e.clientX - rect.left
        const py = e.clientY - rect.top
        const s2 = base * next
        return clamp({ zoom: next, x: px - ((px - v.x) / s) * s2, y: py - ((py - v.y) / s) * s2 })
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // clamp/base only depend on the image, which never changes for this dialog instance.
  }, [image])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || busy) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, from: view }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    setView(clamp({ ...d.from, x: d.from.x + e.clientX - d.startX, y: d.from.y + e.clientY - d.startY }))
  }
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 10
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }
    if (moves[e.key]) {
      e.preventDefault()
      const [dx, dy] = moves[e.key]
      setView((v) => clamp({ ...v, x: v.x + dx, y: v.y + dy }))
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      zoomAt(view.zoom * 1.15)
    } else if (e.key === '-') {
      e.preventDefault()
      zoomAt(view.zoom / 1.15)
    }
  }

  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      let picture: Blob
      if (image.animatedType) {
        setPrep({ percent: 0, simplifying: false })
        const abort = (encodeAbort.current = new AbortController())
        const result = await encodeAnimated(
          image.file,
          image.animatedType,
          crop,
          width,
          kind.animated,
          (p) => setPrep({ percent: Math.round(p.fraction * 100), simplifying: p.simplifying }),
          abort.signal,
        )
        encodeAbort.current = null
        setPrep(null)
        if (result.simplified.length > 0) {
          const limit = `${Math.round(kind.animated.maxBytes / (1024 * 1024))} MB`
          toast(t('Animation simplified to fit {limit}: {changes}', { limit, changes: formatList(result.simplified) }), 'info', 8000)
        }
        picture = result.blob
      } else {
        picture = await encodeStill(image.img, crop, kind.still)
      }
      await onConfirm(picture)
    } catch (err) {
      encodeAbort.current = null
      // Cancelled while preparing: the dialog is closing, nothing to report.
      if (isAbort(err)) return
      toast(err, 'error')
      setPrep(null)
      setBusy(false)
    }
  }

  /** Cancel works while the animation is being prepared (it stops that), not while uploading. */
  const cancel = () => {
    if (busy && !prep) return
    encodeAbort.current?.abort()
    onCancel()
  }

  const s = base * view.zoom
  return (
    <Modal
      title={t(kind.title)}
      onClose={cancel}
      width={kind.modalWidth}
      className={`crop-modal crop-${kindId}`}
      footer={
        <>
          <button className="btn btn-ghost" onClick={cancel} disabled={busy && !prep}>
            {t('Cancel')}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy} data-autofocus>
            {prep
              ? prep.simplifying
                ? t('Simplifying animation… {percent}%', { percent: prep.percent })
                : t('Preparing animation… {percent}%', { percent: prep.percent })
              : busy
                ? t('Uploading…')
                : t(kind.save)}
          </button>
        </>
      }
    >
      <div className="crop">
        <div className="crop-editor">
          <div
            ref={viewportRef}
            className="crop-viewport"
            style={{ width: VW, height: VH }}
            tabIndex={0}
            role="group"
            aria-label={t(kind.positionLabel)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onKeyDown}
          >
            <img
              className="crop-image"
              src={image.url}
              alt=""
              draggable={false}
              style={{ width: width * s, height: height * s, transform: `translate(${view.x}px, ${view.y}px)` }}
            />
            {kindId === 'avatar' && <div className="crop-mask" aria-hidden="true" />}
          </div>
          <label className="crop-zoom">
            <span className="field-label">{t('Zoom')}</span>
            <input
              type="range"
              min={1}
              max={MAX_ZOOM}
              step={0.01}
              value={view.zoom}
              onChange={(e) => zoomAt(Number(e.target.value))}
              disabled={busy}
              aria-label={t('Zoom')}
            />
          </label>
          {animated && (
            <p className="crop-anim-note">
              <span className="avatar-gif-badge">GIF</span>
              {t(kind.animNote)}
            </p>
          )}
        </div>
        <div className="crop-previews">
          <span className="field-label">{t('Preview')}</span>
          {kind.previews.map(([w, h], i) => {
            const preview = animated ? (
              <AnimatedPreview key={w} image={image} crop={crop} width={w} height={h} />
            ) : (
              <canvas
                key={w}
                ref={(el) => {
                  previewRefs.current[i] = el
                }}
                className="crop-preview"
                style={{ width: w, height: h }}
                aria-hidden="true"
              />
            )
            return kindId === 'banner' ? <BannerPreviewFrame key={w}>{preview}</BannerPreviewFrame> : preview
          })}
        </div>
      </div>
    </Modal>
  )
}

/** The banner preview as the profile card shows it: your avatar overlapping its bottom edge. */
function BannerPreviewFrame({ children }: { children: ReactNode }) {
  const me = useApp((s) => s.me)
  return (
    <div className="crop-banner-frame" aria-hidden="true">
      {children}
      {me && (
        <span className="crop-banner-avatar">
          <Avatar user={me} size={80} />
        </span>
      )}
    </div>
  )
}

/** The crop of the (playing) animation, scaled to a `width`×`height` preview. */
function AnimatedPreview({ image, crop, width, height }: { image: LoadedImage; crop: CropRect; width: number; height: number }) {
  const k = width / crop.width
  return (
    <span className="crop-preview crop-preview-anim" style={{ width, height }} aria-hidden="true">
      <img
        src={image.url}
        alt=""
        draggable={false}
        style={{
          width: image.width * k,
          height: image.height * k,
          transform: `translate(${-crop.x * k}px, ${-crop.y * k}px)`,
        }}
      />
    </span>
  )
}
