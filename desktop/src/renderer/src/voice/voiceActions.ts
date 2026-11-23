// Acting on other people in voice: moving them to another voice channel (admins/owner) and "wake up"
// nudges (anyone), plus the handling of `voice:moved` / `voice:nudged` aimed at us. socket.ts imports this
// lazily (like voice/session) to avoid an import cycle.
import { request } from '@renderer/net/socket'
import { useApp } from '@renderer/store/app'
import { toast } from '@renderer/lib/toast'
import { t } from '@renderer/i18n'
import { getBridge, useVoice } from './session'
import { playVoiceSound } from './sounds'

/** How long the "trying to get your attention" toast stays up. */
const NUDGE_TOAST_MS = 8000

function nameOf(userId: string): string {
  return useApp.getState().users[userId]?.name ?? t('Someone')
}

function voiceChannel(channelId: string) {
  return useApp.getState().channels.find((c) => c.id === channelId && c.type === 'voice')
}

/**
 * Switch this device's voice session to `channelId`. join() tears the old room down first (camera and
 * shares stop, without announcing a leave) and keeps mute / deafen. The center pane follows when it was
 * showing the old voice channel.
 */
function rejoinIn(channelId: string): void {
  const v = useVoice.getState()
  const app = useApp.getState()
  const wasViewingOld = !!v.channelId && app.selectedChannelId === v.channelId
  v.join(channelId).catch((err) => toast(err, 'error'))
  if (wasViewingOld) app.selectChannel(channelId)
}

/**
 * Move `userId` (who is in voice) to the voice channel `channelId`. Moving yourself while this device is
 * the one in voice just switches channels locally (works on servers without `voice:move` too).
 * Rejects with the server's error.
 */
export async function moveToChannel(userId: string, channelId: string): Promise<void> {
  const current = useApp.getState().voice.find((s) => s.userId === userId)
  if (current?.channelId === channelId) return
  const own = useVoice.getState()
  if (userId === useApp.getState().me?.id && own.channelId) {
    if (own.channelId !== channelId) rejoinIn(channelId)
    return
  }
  await request('voice:move', { userId, channelId })
}

/** "Wake up" someone who is muted or deafened. Toasts the outcome (the server's error, e.g. the cooldown). */
export async function nudge(userId: string): Promise<boolean> {
  try {
    await request('voice:nudge', { userId })
    toast(t('Nudged {name}', { name: nameOf(userId) }), 'success')
    return true
  } catch (err) {
    toast(err, 'error')
    return false
  }
}

/** `voice:moved`: an admin moved us (our server voice state is already in `channelId`). */
export function handleMoved(channelId: string, by: string): void {
  const v = useVoice.getState()
  // This device isn't in voice (left meanwhile): nothing to follow.
  if (!v.channelId) return
  if (v.channelId === channelId) return
  const channel = voiceChannel(channelId)
  if (!channel) {
    console.warn('[nexo] moved to an unknown voice channel', channelId)
    return
  }
  rejoinIn(channelId)
  if (by !== useApp.getState().me?.id) toast(t('{name} moved you to {channel}', { name: nameOf(by), channel: channel.name }), 'info', 5000)
}

/** `voice:nudged`: someone wants our attention while we're muted / deafened. */
export function handleNudged(by: string): void {
  // Only meaningful while in voice on this device.
  if (!useVoice.getState().channelId) return
  // The UI sound context is separate from the call's audio, so this is heard even while deafened.
  playVoiceSound('nudge')
  toast(t('{name} is trying to get your attention', { name: nameOf(by) }), 'info', NUDGE_TOAST_MS)
  // Flash the taskbar button when Nexo isn't the focused window (main checks focus itself too).
  if (!document.hasFocus()) getBridge()?.requestAttention()
}
