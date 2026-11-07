#!/usr/bin/env node
// Verifies the LiveKit container accepts the API key/secret from .env.
// Usage (repo root): node --env-file=.env scripts/check-livekit.mjs
import { RoomServiceClient } from 'livekit-server-sdk'

const host = process.env.LIVEKIT_CHECK_URL || `http://127.0.0.1:${process.env.LIVEKIT_PORT || 7880}`
const key = process.env.LIVEKIT_API_KEY
const secret = process.env.LIVEKIT_API_SECRET

if (!key || !secret) {
  console.error('✗ LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set (run with --env-file=.env)')
  process.exit(1)
}
if (process.env.LIVEKIT_KEYS && process.env.LIVEKIT_KEYS !== `${key}: ${secret}`) {
  console.error('✗ LIVEKIT_KEYS does not equal "LIVEKIT_API_KEY: LIVEKIT_API_SECRET" in .env')
  process.exit(1)
}

try {
  const res = await fetch(host)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
} catch (err) {
  console.error(`✗ LiveKit is not reachable at ${host} (${err.message}). Start it with: npm run media`)
  process.exit(1)
}

try {
  const rooms = await new RoomServiceClient(host, key, secret).listRooms()
  console.log(`✓ LiveKit at ${host} accepted the API key "${key}" (${rooms.length} active room${rooms.length === 1 ? '' : 's'})`)
} catch (err) {
  console.error(`✗ LiveKit rejected the credentials: ${err.message}`)
  process.exit(1)
}

try {
  await new RoomServiceClient(host, key, 'definitely-the-wrong-secret-0123456789abcdef').listRooms()
  console.error('✗ LiveKit accepted a WRONG secret — auth is not being enforced')
  process.exit(1)
} catch {
  console.log('✓ A wrong secret is rejected')
}
