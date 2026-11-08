// GitHub releases for `nexo-server update` (docs/SPEC-SERVER-CLI.md §8): list them, pick the newest one in
// this build's lane that has a server download for this OS, and download its files.
//
// Lanes (same as the app's updater, desktop/src/main/updater.ts): a test build (`X.Y.Z-test.N`) only follows
// newer test builds; every other version (alpha, beta, rc, stable) takes the newest non-test release.
// Never a downgrade.
import { compareVersions, isTestVersion, parseVersion } from './semver.ts'

export const REPO = 'campiohe/nexo'
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=50`
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`

export interface GitHubAsset {
  name: string
  browser_download_url: string
  size: number
}

/** The fields of GitHub's release object we use (GET /repos/{owner}/{repo}/releases). */
export interface GitHubRelease {
  tag_name: string
  html_url: string
  draft: boolean
  prerelease: boolean
  assets: GitHubAsset[]
}

export interface Target {
  platform: NodeJS.Platform
  arch: string
}

/** The release download for this OS: `Nexo-Server-<version>-win-x64.zip` / `-linux-x64.tar.gz`. */
export function serverAssetName(version: string, target: Target): string | null {
  if (target.arch !== 'x64') return null
  if (target.platform === 'win32') return `Nexo-Server-${version}-win-x64.zip`
  if (target.platform === 'linux') return `Nexo-Server-${version}-linux-x64.tar.gz`
  return null
}

/** "Windows" / "Linux": for messages. */
export const osName = (platform: NodeJS.Platform) => (platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform)

export type UpdatePlan =
  /** Nothing newer in this lane. `latest` is the newest release in the lane, when there is one. */
  | { kind: 'up-to-date'; current: string; latest?: string }
  /** A newer release with a build for this OS. `skipped`: an even newer release without one. */
  | {
      kind: 'available'
      current: string
      version: string
      release: GitHubRelease
      asset: GitHubAsset
      /** `<asset>.sha256` next to it; undefined when the release lacks it (the update is refused then). */
      checksum?: GitHubAsset
      skipped?: string
    }
  /** Newer releases exist, but none has a server build for this OS. `version` is the newest. */
  | { kind: 'no-build'; current: string; version: string; release: GitHubRelease; assetName: string | null }

const versionOf = (r: GitHubRelease) => r.tag_name.replace(/^v/, '')

/** Picks what `update` should install (pure: the releases come from fetchReleases). */
export function planUpdate(releases: readonly GitHubRelease[], current: string, target: Target): UpdatePlan {
  if (!parseVersion(current)) throw new Error(`This nexo-server has no release version ("${current}")`)
  const testLane = isTestVersion(current)
  const lane = releases
    .filter((r) => !r.draft && parseVersion(versionOf(r)) && isTestVersion(versionOf(r)) === testLane)
    .sort((a, b) => compareVersions(versionOf(b), versionOf(a)))
  const newer = lane.filter((r) => compareVersions(versionOf(r), current) > 0)
  if (!newer.length) return { kind: 'up-to-date', current, ...(lane[0] ? { latest: versionOf(lane[0]) } : {}) }

  for (const release of newer) {
    const version = versionOf(release)
    const name = serverAssetName(version, target)
    const asset = name ? release.assets.find((a) => a.name === name) : undefined
    if (!asset) continue
    const checksum = release.assets.find((a) => a.name === `${name}.sha256`)
    const skipped = release === newer[0] ? undefined : versionOf(newer[0]!)
    return { kind: 'available', current, version, release, asset, ...(checksum ? { checksum } : {}), ...(skipped ? { skipped } : {}) }
  }
  const newest = newer[0]!
  return { kind: 'no-build', current, version: versionOf(newest), release: newest, assetName: serverAssetName(versionOf(newest), target) }
}

/** A failure explained in plain words (offline, rate-limited, bad download…). */
export class UpdateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpdateError'
  }
}

/** Turns a fetch() rejection into a sentence. */
export function describeNetworkError(err: unknown, what = 'GitHub'): string {
  const e = err as Error & { cause?: { code?: string } }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `${what} did not answer in time. Check your internet connection and try again.`
  const code = e?.cause?.code ?? ''
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(code)) {
    return `Couldn't reach ${what} (${code}). Check your internet connection.`
  }
  return `Couldn't reach ${what}: ${code || e?.message || String(err)}`
}

export interface FetchOptions {
  fetch?: typeof fetch
  /** Sent as User-Agent (GitHub's API requires one). */
  userAgent: string
  timeoutMs?: number
  now?: () => Date
}

/** GET the release list. Throws UpdateError with a readable message (offline, rate limit, HTTP error). */
export async function fetchReleases(opts: FetchOptions): Promise<GitHubRelease[]> {
  const fetchFn = opts.fetch ?? fetch
  let res: Response
  try {
    res = await fetchFn(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': opts.userAgent, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
  } catch (err) {
    throw new UpdateError(describeNetworkError(err))
  }
  if (res.status === 403 || res.status === 429) {
    // Unauthenticated API calls: 60 per hour per public IP address.
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    const remaining = res.headers.get('x-ratelimit-remaining')
    if (remaining === '0' || res.status === 429) {
      const when = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null
      const minutes = when ? Math.max(1, Math.ceil((when.getTime() - (opts.now?.() ?? new Date()).getTime()) / 60000)) : null
      throw new UpdateError(
        `GitHub is limiting update checks from your internet address right now. Try again ${minutes ? `in ${minutes} min` : 'later'}.`,
      )
    }
  }
  if (!res.ok) throw new UpdateError(`GitHub answered the update check with HTTP ${res.status}. Try again later.`)
  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    throw new UpdateError(`GitHub sent an unreadable release list (${(err as Error).message}).`)
  }
  if (!Array.isArray(body)) throw new UpdateError('GitHub sent an unexpected release list.')
  return body.filter(
    (r): r is GitHubRelease => !!r && typeof r.tag_name === 'string' && Array.isArray(r.assets) && typeof r.html_url === 'string',
  )
}

export interface DownloadOptions {
  fetch?: typeof fetch
  userAgent: string
  /** Abort when no data arrives for this long. Default 60 s. */
  idleTimeoutMs?: number
  /** Called as bytes arrive (total is 0 when unknown). */
  onProgress?: (received: number, total: number) => void
}

/** Downloads a release asset (follows GitHub's redirect to its CDN) into memory. Throws UpdateError. */
export async function download(url: string, opts: DownloadOptions): Promise<Buffer> {
  const fetchFn = opts.fetch ?? fetch
  const idle = opts.idleTimeoutMs ?? 60_000
  const ctrl = new AbortController()
  let timer = setTimeout(() => ctrl.abort(), idle)
  const kick = () => {
    clearTimeout(timer)
    timer = setTimeout(() => ctrl.abort(), idle)
  }
  try {
    const res = await fetchFn(url, { redirect: 'follow', headers: { 'User-Agent': opts.userAgent }, signal: ctrl.signal })
    if (!res.ok) throw new UpdateError(`Download failed: HTTP ${res.status} (${url})`)
    const total = Number(res.headers.get('content-length')) || 0
    const chunks: Uint8Array[] = []
    let received = 0
    if (res.body) {
      for await (const chunk of res.body) {
        kick()
        chunks.push(chunk)
        received += chunk.length
        opts.onProgress?.(received, total)
      }
    }
    if (total && received !== total) throw new UpdateError(`Download incomplete (${received} of ${total} bytes). Try again.`)
    return Buffer.concat(chunks)
  } catch (err) {
    if (err instanceof UpdateError) throw err
    throw new UpdateError(describeNetworkError(ctrl.signal.aborted ? Object.assign(new Error('timeout'), { name: 'TimeoutError' }) : err, 'the download server'))
  } finally {
    clearTimeout(timer)
  }
}
