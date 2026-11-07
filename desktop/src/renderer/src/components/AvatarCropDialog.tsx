// Square crop for a new profile picture: drag to move, wheel/slider/keys to zoom, live round previews.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { drawCrop, encodeAvatar, type CropRect, type LoadedImage } from '../lib/imageCrop'
import { toast } from '../lib/toast'
import { Modal } from './Modal'

/** Viewport size in CSS px (the square that becomes the picture). */
const VIEW = 280
const MAX_ZOOM = 5
const PREVIEW_SIZES = [96, 40] as const

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

export function AvatarCropDialog({ image, onCancel, onConfirm }: Props) {
  const { width, height } = image
  /** Display scale at zoom 1: the short side exactly fills the viewport. */
  const base = VIEW / Math.min(width, height)

  const clamp = (v: View): View => {
    const zoom = Math.min(MAX_ZOOM, Math.max(1, v.zoom))
    const s = base * zoom
    return {
      zoom,
      x: Math.min(0, Math.max(VIEW - width * s, v.x)),
      y: Math.min(0, Math.max(VIEW - height * s, v.y)),
    }
  }

  const [view, setView] = useState<View>(() =>
    clamp({ zoom: 1, x: (VIEW - width * base) / 2, y: (VIEW - height * base) / 2 }),
  )
  const [busy, setBusy] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const previewRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const drag = useRef<{ id: number; startX: number; startY: number; from: View } | null>(null)

  /** Zoom to `zoom`, keeping the image point under viewport point (px, py) fixed. */
  const zoomAt = (zoom: number, px = VIEW / 2, py = VIEW / 2) =>
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
    const size = Math.min(VIEW / s, width, height)
    return {
      x: Math.min(width - size, Math.max(0, -view.x / s)),
      y: Math.min(height - size, Math.max(0, -view.y / s)),
      size,
    }
  }, [view, base, width, height])

  useEffect(() => {
    PREVIEW_SIZES.forEach((size, i) => {
      const canvas = previewRefs.current[i]
      // Draw at device resolution so the preview is as sharp as the real thing.
      if (canvas) drawCrop(canvas, image.img, crop, Math.round(size * (window.devicePixelRatio || 1)))
    })
  }, [crop, image])

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
      const picture = await encodeAvatar(image.img, crop)
      await onConfirm(picture)
    } catch (err) {
      toast(err, 'error')
      setBusy(false)
    }
  }

  const s = base * view.zoom
  return (
    <Modal
      title="Crop your picture"
      onClose={() => !busy && onCancel()}
      width={520}
      className="crop-modal"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy} data-autofocus>
            {busy ? 'Uploading…' : 'Save picture'}
          </button>
        </>
      }
    >
      <div className="crop">
        <div className="crop-editor">
          <div
            ref={viewportRef}
            className="crop-viewport"
            style={{ width: VIEW, height: VIEW }}
            tabIndex={0}
            role="group"
            aria-label="Picture position. Drag or use the arrow keys to move, + and - to zoom."
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
            <div className="crop-mask" aria-hidden="true" />
          </div>
          <label className="crop-zoom">
            <span className="field-label">Zoom</span>
            <input
              type="range"
              min={1}
              max={MAX_ZOOM}
              step={0.01}
              value={view.zoom}
              onChange={(e) => zoomAt(Number(e.target.value))}
              disabled={busy}
              aria-label="Zoom"
            />
          </label>
        </div>
        <div className="crop-previews">
          <span className="field-label">Preview</span>
          {PREVIEW_SIZES.map((size, i) => (
            <canvas
              key={size}
              ref={(el) => {
                previewRefs.current[i] = el
              }}
              className="crop-preview"
              style={{ width: size, height: size }}
              aria-hidden="true"
            />
          ))}
        </div>
      </div>
    </Modal>
  )
}
