import { useEffect, useState } from 'react'
import type { Attachment } from '@shared/protocol'
import { openExternal } from '../lib/linkify'
import { attachmentUrl } from '../net/attachments'
import { Modal } from './Modal'

/** Panel chrome around the image: modal body padding plus header and footer heights. */
const CHROME_W = 44
const CHROME_H = 150
const MIN_W = 320

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

function useViewport() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

/** Full-size view of one image. Esc or a backdrop click closes it (Modal is stack-aware). */
export function ImageLightbox({ att, serverUrl, onClose }: { att: Attachment; serverUrl: string | null; onClose(): void }) {
  const viewport = useViewport()
  const url = attachmentUrl(serverUrl, att.id)
  // Largest size that fits the window (never upscaled), the modal width follows it.
  const scale = Math.min(1, (viewport.w - 48 - CHROME_W) / att.width, (viewport.h - 48 - CHROME_H) / att.height)
  const width = Math.max(1, Math.floor(att.width * scale))
  const height = Math.max(1, Math.floor(att.height * scale))

  return (
    <Modal
      title={`${att.width} × ${att.height} · ${formatSize(att.size)}`}
      onClose={onClose}
      width={Math.max(MIN_W, width + CHROME_W)}
      className="image-lightbox"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" disabled={!url} onClick={() => url && openExternal(url)}>
            Open original
          </button>
        </>
      }
    >
      {url && <img className="image-lightbox-img" src={url} alt="" width={width} height={height} draggable={false} />}
    </Modal>
  )
}
