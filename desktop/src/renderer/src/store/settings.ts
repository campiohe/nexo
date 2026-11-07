// Persisted client settings. Server URL + last channel live in localStorage; the device token goes
// through window.nexo.secrets (Electron safeStorage). Outside Electron we fall back to localStorage.

const KEY_SERVER_URL = 'nexo:serverUrl'
const KEY_LAST_CHANNEL = 'nexo:lastChannel:' // + serverUrl
const KEY_SECRET_FALLBACK = 'nexo:secret:' // + secret key (dev only, outside Electron)

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

const tokenKey = (serverUrl: string) => `token:${serverUrl}`

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

  async getToken(serverUrl: string): Promise<string | null> {
    const key = tokenKey(serverUrl)
    if (window.nexo?.secrets) {
      try {
        return await window.nexo.secrets.get(key)
      } catch (err) {
        console.error('[nexo] secrets.get failed', err)
        return null
      }
    }
    return lsGet(KEY_SECRET_FALLBACK + key)
  },
  async setToken(serverUrl: string, token: string | null): Promise<void> {
    const key = tokenKey(serverUrl)
    if (window.nexo?.secrets) {
      try {
        await window.nexo.secrets.set(key, token)
      } catch (err) {
        console.error('[nexo] secrets.set failed', err)
      }
      return
    }
    lsSet(KEY_SECRET_FALLBACK + key, token)
  },
}
