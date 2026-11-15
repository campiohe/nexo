// Join / leave sounds for the voice channel you're connected to (Discord-like):
// - your own connection reaching 'connected' plays `join`; leaving voice (button, keybind, tray, channel
//   deleted, dropped connection) plays `leave`. Switching channels (also being moved) only plays the join.
// - someone else entering (joining, or moved in) plays `join`; leaving (also disconnecting or moved out)
//   plays `leave`. Derived from the server's voice states (`useApp.voice`), membership only: mute / deafen /
//   camera / streaming flips are ignored.
// Nothing plays for the people already there when you join, nor when a (re)bootstrap replaces the list.
// Imported once for its side effects (App.tsx).
import { useApp } from '@renderer/store/app'
import { getRoom, useVoice } from './session'
import { playVoiceSound, type VoiceSound } from './sounds'

/** The same sound isn't repeated within this window (several voice:states in a burst play once). */
const REPEAT_GAP_MS = 250

/** Members (without you) of the channel you're connected to, as last seen. null = not watching. */
let watched: { channelId: string; members: Set<string> } | null = null
/** Your own join sound played and no leave since: a failed join plays nothing on the way out. */
let ownJoined = false
let leaveCheck: number | undefined
const lastPlayed: Partial<Record<VoiceSound, number>> = {}

function play(sound: VoiceSound): void {
  const now = performance.now()
  if (now - (lastPlayed[sound] ?? -Infinity) < REPEAT_GAP_MS) return
  lastPlayed[sound] = now
  playVoiceSound(sound)
}

/** Others in `channelId` per the server. */
function membersOf(channelId: string): Set<string> {
  const { voice, me } = useApp.getState()
  const out = new Set<string>()
  for (const v of voice) if (v.channelId === channelId && v.userId !== me?.id) out.add(v.userId)
  return out
}

/** Connected (or briefly reconnecting) to a live room: the state where membership changes are heard. */
function liveChannel(): string | null {
  const v = useVoice.getState()
  if (!v.channelId || (v.status !== 'connected' && v.status !== 'reconnecting')) return null
  // teardown() drops the room before its awaits, so a leave in progress is already silent here.
  if (!getRoom()) return null
  return v.channelId
}

/** Compare the server's list with the snapshot, play at most one join and one leave, keep the new list. */
function diff(): void {
  const channelId = liveChannel()
  if (!channelId || watched?.channelId !== channelId) return
  const app = useApp.getState()
  // Socket down: nothing is current. A deleted channel empties out right before we leave it ourselves.
  if (app.connection !== 'connected' || !app.channels.some((c) => c.id === channelId)) return
  const next = membersOf(channelId)
  const prev = watched.members
  let joined = false
  let left = false
  for (const id of next) if (!prev.has(id)) joined = true
  for (const id of prev) if (!next.has(id)) left = true
  watched = { channelId, members: next }
  if (joined) play('join')
  if (left && !joined) play('leave')
}

const offVoice = useVoice.subscribe((s, prev) => {
  // Own join: the first 'connected' of a join (not the one after a LiveKit reconnect).
  if (s.status === 'connected' && prev.status === 'connecting' && s.channelId) {
    window.clearTimeout(leaveCheck)
    leaveCheck = undefined
    ownJoined = true
    play('join')
    // Start listening from here: whoever is already in the channel makes no sound.
    watched = { channelId: s.channelId, members: membersOf(s.channelId) }
    return
  }
  if (s.channelId !== prev.channelId) {
    watched = null
    // Own leave. join() switching channels goes channelId → null → new id across an await, so wait a tick
    // and only sound it when we are still out of voice.
    if (!s.channelId && prev.channelId && ownJoined) {
      window.clearTimeout(leaveCheck)
      leaveCheck = window.setTimeout(() => {
        leaveCheck = undefined
        if (useVoice.getState().channelId) return
        ownJoined = false
        play('leave')
      }, 0)
    }
  }
})

const offApp = useApp.subscribe((s, prev) => {
  if (s.voice === prev.voice && s.channels === prev.channels && s.connection === prev.connection) return
  // (Re)bootstrap: the whole list is replaced at once (people may have come and gone while we were offline,
  // and our own state is missing until we re-announce). Take it as the new baseline, silently.
  if (s.connection === 'connected' && prev.connection !== 'connected') {
    const channelId = liveChannel()
    watched = channelId ? { channelId, members: membersOf(channelId) } : null
    return
  }
  if (s.voice !== prev.voice) diff()
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offVoice()
    offApp()
    window.clearTimeout(leaveCheck)
  })
}
