import { MessageList } from './MessageList'
import { TypingLine } from './TypingLine'
import { Composer } from './Composer'

export function TextChannel({ channelId, channelName }: { channelId: string; channelName: string }) {
  return (
    <div className="text-channel">
      <MessageList channelId={channelId} />
      <div className="composer-area">
        <TypingLine channelId={channelId} />
        <Composer channelId={channelId} channelName={channelName} />
      </div>
    </div>
  )
}
