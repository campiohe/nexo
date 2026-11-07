/** Normalize a server URL typed by a user: trims, adds http:// when missing, strips trailing slashes. */
export function normalizeServerUrl(input: string): string {
  let url = input.trim()
  if (!url) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`
  url = url.replace(/^ws(s?):\/\//i, 'http$1://')
  return url.replace(/\/+$/, '')
}

export function isValidServerUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    return false
  }
}

export const DEFAULT_SERVER_URL = 'http://localhost:3001'
