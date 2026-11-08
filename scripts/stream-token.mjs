#!/usr/bin/env node
// Prints a LiveKit token for the native helper's stream participant `<userId>#stream`, with the same grants the
// server's `voice:streamToken` signs (docs/SPEC-BETA.md §7). For M0 / manual helper testing without the app.
//
// Usage (repo root): node --env-file=.env scripts/stream-token.mjs <room> <userId> [--name <display name>] [--ttl 12h]
//   <room>   LiveKit room, e.g. voice-<channelId> (what the app joins for a voice channel)
//
// Only the token goes to stdout, so it can be piped straight into the helper:
//   node --env-file=.env scripts/stream-token.mjs voice-abc u1 | nexo-media.exe --test-pattern --url ws://… --token-stdin
import { AccessToken, TrackSource } from 'livekit-server-sdk'
import { streamIdentity } from '../shared/stream.ts'

const args = process.argv.slice(2)
const positional = []
const opts = { name: undefined, ttl: '12h' }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--name') opts.name = args[++i]
  else if (a === '--ttl') opts.ttl = args[++i]
  else if (a === '-h' || a === '--help') {
    console.error('usage: node --env-file=.env scripts/stream-token.mjs <room> <userId> [--name <name>] [--ttl 12h]')
    process.exit(0)
  } else positional.push(a)
}
const [room, userId] = positional
if (!room || !userId) {
  console.error('usage: node --env-file=.env scripts/stream-token.mjs <room> <userId> [--name <name>] [--ttl 12h]')
  process.exit(2)
}

const key = process.env.LIVEKIT_API_KEY
const secret = process.env.LIVEKIT_API_SECRET
if (!key || !secret) {
  console.error('✗ LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set (run with --env-file=.env)')
  process.exit(1)
}

const identity = streamIdentity(userId)
const at = new AccessToken(key, secret, { identity, name: opts.name ?? userId, ttl: opts.ttl })
at.addGrant({
  room,
  roomJoin: true,
  canPublish: true,
  canSubscribe: false,
  canPublishData: false,
  canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
})
console.error(`token for ${identity} in room ${room} (ttl ${opts.ttl})`)
console.log(await at.toJwt())
