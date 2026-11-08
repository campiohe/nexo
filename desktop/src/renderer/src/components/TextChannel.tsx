import { useRef, useState, type DragEvent } from 'react'
import { MAX_ATTACHMENTS_PER_MESSAGE } from '@shared/protocol'
import { addImages } from '../net/attachments'
import { MessageList } from './MessageList'
import { TypingLine } from './TypingLine'
import { Composer, pickImageFiles } from './Composer'

/** Only file drags (not dragged text or links) show the drop zone. */
const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

export function TextChannel({ channelId, channelName }: { channelId: string; channelName: string }) {
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave fire for every child element crossed; count them to know when the drag really left.
  const depth = useRef(0)

  function onDragEnter(e: DragEvent) {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth.current++
    setDragging(true)
  }

  function onDragOver(e: DragEvent) {
    if (!hasFiles(e)) return
    e.preventDefault() // required for drop to fire
    e.dataTransfer.dropEffect = 'copy'
  }

  function onDragLeave(e: DragEvent) {
    if (!hasFiles(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }

  function onDrop(e: DragEvent) {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth.current = 0
    setDragging(false)
    addImages(channelId, pickImageFiles(e.dataTransfer.files))
  }

  return (
    <div className="text-channel" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <MessageList channelId={channelId} />
      <div className="composer-area">
        <TypingLine channelId={channelId} />
        <Composer channelId={channelId} channelName={channelName} />
      </div>
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <strong>Drop images to send</strong>
            <span>
              to #{channelName} · up to {MAX_ATTACHMENTS_PER_MESSAGE} per message
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
