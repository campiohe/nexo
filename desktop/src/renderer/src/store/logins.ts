// Saved logins (docs/SPEC-ACCOUNTS.md §1). A login is the device token for one server account.
// - Saved under `token:id:<serverId>`, so it is found whatever address the server is reached through.
// - localStorage keeps a `serverUrl → serverId` map, so lookups don't need a network round trip.
// - Legacy `token:<serverUrl>` entries are still read, and move to the id key on the first bootstrap that
//   carries `serverId` (migrateLogin).
// - When the secrets store fails to save, the token also goes to localStorage (last resort; the secrets
//   file keeps a plain copy anyway), so a freshly created account is never lost silently.
import type { SecretRead } from '../../../preload/api'
import { isValidServerId } from '../net/accounts'

const KEY_SERVER_IDS = 'nexo:serverIds'
/** Fallback secret storage: the only store outside Electron (dev), a last resort inside it. */
const KEY_SECRET_FALLBACK = 'nexo:secret:' // + secret key

export const idTokenKey = (serverId: string) => `token:id:${serverId}`
export const legacyTokenKey = (serverUrl: string) => `token:${serverUrl}`

export interface LoginRead {
  token: string | null
  /** A saved login exists but couldn't be read (decryption failed, corrupt file, IPC error). */
  unreadable: boolean
}

// ---- url → serverId map ----

function readIdMap(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY_SERVER_IDS) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function knownServerId(serverUrl: string): string | null {
  const id = readIdMap()[serverUrl]
  return isValidServerId(id) ? id : null
}

export function rememberServerId(serverUrl: string, serverId: string): void {
  if (!isValidServerId(serverId)) return
  const map = readIdMap()
  if (map[serverUrl] === serverId) return
  map[serverUrl] = serverId
  try {
    localStorage.setItem(KEY_SERVER_IDS, JSON.stringify(map))
  } catch (err) {
    console.warn('[nexo] could not save the server id map', err)
  }
}

// ---- raw secret access (window.nexo.secrets + localStorage fallback) ----

function fallbackGet(key: string): string | null {
  try {
    return localStorage.getItem(KEY_SECRET_FALLBACK + key)
  } catch {
    return null
  }
}

function fallbackSet(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(KEY_SECRET_FALLBACK + key)
    else localStorage.setItem(KEY_SECRET_FALLBACK + key, value)
    return true
  } catch {
    return false
  }
}

async function readSecret(key: string): Promise<SecretRead> {
  const secrets = window.nexo?.secrets
  let r: SecretRead = { status: 'missing' }
  if (secrets) {
    try {
      // Older preloads (shouldn't happen: main and preload ship together) only have get().
      if (secrets.read) r = await secrets.read(key)
      else {
        const v = await secrets.get(key)
        r = v === null ? { status: 'missing' } : { status: 'ok', value: v }
      }
    } catch (err) {
      console.error(`[nexo] reading saved login "${key}" failed`, err)
      r = { status: 'unreadable' }
    }
  }
  if (r.status === 'ok') return r
  const fb = fallbackGet(key)
  return fb ? { status: 'ok', value: fb } : r
}

/** Throws when the value couldn't be saved anywhere. Returns false when only the localStorage fallback has it. */
async function writeSecret(key: string, value: string | null): Promise<boolean> {
  const secrets = window.nexo?.secrets
  if (!secrets) {
    if (!fallbackSet(key, value)) throw new Error('Local storage is unavailable')
    return true
  }
  try {
    await secrets.set(key, value)
  } catch (err) {
    console.error(`[nexo] saving login "${key}" failed`, err)
    if (value === null) {
      fallbackSet(key, null)
      throw err
    }
    if (fallbackSet(key, value)) {
      console.error(`[nexo] login "${key}" was saved to the fallback store instead`)
      return false
    }
    throw err
  }
  fallbackSet(key, null) // the secrets store has it now; drop any fallback copy
  return true
}

// ---- logins ----

/** The saved login for a server: the id key first (if the id is known), then the legacy URL key. */
export async function readLogin(serverUrl: string, serverId = knownServerId(serverUrl)): Promise<LoginRead> {
  let unreadable = false
  if (serverId) {
    const r = await readSecret(idTokenKey(serverId))
    if (r.status === 'ok') return { token: r.value, unreadable: false }
    unreadable ||= r.status === 'unreadable'
  }
  const legacy = await readSecret(legacyTokenKey(serverUrl))
  if (legacy.status === 'ok') return { token: legacy.value, unreadable: false }
  unreadable ||= legacy.status === 'unreadable'
  return { token: null, unreadable }
}

/**
 * Save a login, under the id key when the server id is known (else the legacy URL key, migrated later).
 * Tries twice. Throws when it couldn't be saved at all; resolves false when only the fallback store has it.
 */
export async function saveLogin(serverUrl: string, serverId: string | null | undefined, token: string): Promise<boolean> {
  const id = isValidServerId(serverId) ? serverId : knownServerId(serverUrl)
  if (id) rememberServerId(serverUrl, id)
  const key = id ? idTokenKey(id) : legacyTokenKey(serverUrl)
  try {
    return await writeSecret(key, token)
  } catch {
    return await writeSecret(key, token)
  }
}

/** Forget the saved login(s) for a server URL (both keys). Failures are logged, not thrown. */
export async function forgetLogin(serverUrl: string): Promise<void> {
  const id = knownServerId(serverUrl)
  const keys = [legacyTokenKey(serverUrl), ...(id ? [idTokenKey(id)] : [])]
  for (const key of keys) {
    try {
      await writeSecret(key, null)
    } catch {
      /* logged by writeSecret */
    }
  }
}

/**
 * After a bootstrap with `serverId`: make sure the token in use is saved under the id key, then drop the
 * legacy URL entry. Never throws.
 */
export async function migrateLogin(serverUrl: string, serverId: string, token: string): Promise<void> {
  if (!isValidServerId(serverId)) return
  rememberServerId(serverUrl, serverId)
  try {
    const cur = await readSecret(idTokenKey(serverId))
    const saved = (cur.status === 'ok' && cur.value === token) || (await writeSecret(idTokenKey(serverId), token))
    if (!saved) return // only the fallback store has it: keep the legacy entry too
    const legacy = await readSecret(legacyTokenKey(serverUrl))
    if (legacy.status !== 'missing') await writeSecret(legacyTokenKey(serverUrl), null)
  } catch (err) {
    console.warn('[nexo] migrating the saved login failed', err)
  }
}
