// Identity of the native stream participant (docs/SPEC-BETA.md D6, §7).
// The server signs it, so any client can trust `<userId>#stream` to be <userId>'s stream.

export const STREAM_IDENTITY_SUFFIX = '#stream'

/** LiveKit identity the native helper publishes a user's stream under. */
export function streamIdentity(userId: string): string {
  return `${userId}${STREAM_IDENTITY_SUFFIX}`
}

/** The owner's userId when `identity` is a stream participant, otherwise null. */
export function streamOwner(identity: string): string | null {
  if (!identity.endsWith(STREAM_IDENTITY_SUFFIX)) return null
  const owner = identity.slice(0, -STREAM_IDENTITY_SUFFIX.length)
  return owner ? owner : null
}

export function isStreamIdentity(identity: string): boolean {
  return streamOwner(identity) !== null
}
