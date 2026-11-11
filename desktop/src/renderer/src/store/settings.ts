// Persisted client settings. Server URL + last channel live in localStorage; saved logins (device tokens)
// are handled by store/logins.ts (window.nexo.secrets, keyed by server id).
import { forgetLogin, readLogin, saveLogin } from './logins'

const KEY_SERVER_URL = 'nexo:serverUrl'
const KEY_LAST_CHANNEL = 'nexo:lastChannel:' // + serverUrl

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

export const settings = {
  getServerUrl(): string | null {
    return lsGet(KEY_SERVER_URL)
  },
  setServerUrl(url: string | null): void {
    lsSet(KEY_SERVER_URL, url)
  },

  getLastChannel(serverUrl: string): string | null {
    return lsGet(KEY_LAST_CHANNEL + serverUrl)
  },
  setLastChannel(serverUrl: string, channelId: string | null): void {
    lsSet(KEY_LAST_CHANNEL + serverUrl, channelId)
  },

  /** The saved login (device token) for a server; see store/logins.ts for how it is found. */
  async getToken(serverUrl: string): Promise<string | null> {
    return (await readLogin(serverUrl)).token
  },
  /**
   * Save (or with null, forget) the login for a server. Saving throws when the token couldn't be stored
   * anywhere, so callers can tell the user instead of losing the account silently.
   */
  async setToken(serverUrl: string, token: string | null, serverId?: string): Promise<void> {
    if (token === null) return forgetLogin(serverUrl)
    await saveLogin(serverUrl, serverId, token)
  },
}
