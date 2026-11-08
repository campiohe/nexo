// `nexo-server update` and the start-up "a newer version exists" line (docs/SPEC-SERVER-CLI.md §8).
// Never updates silently: the start-up check only prints; installing needs the `update` command.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { extractTarGz, extractZip, parseSha256File, sha256 } from './archive.ts'
import { binaryNames, installFiles } from './install.ts'
import { download, fetchReleases, osName, planUpdate, UpdateError, type Target, type UpdatePlan } from './releases.ts'
import { parseVersion } from './semver.ts'

export interface UpdateDeps extends Target {
  /** This nexo-server's version. */
  version: string
  /** The packaged binary (packagedBinary()), or null when running from source. */
  binary: string | null
  /** PID of a server running for the data folder (runningInstance), or null. */
  runningPid: number | null
  out: (line?: string) => void
  err: (line?: string) => void
  fetch?: typeof fetch
  /** Show download progress (a TTY). */
  progress?: boolean
}

const userAgent = (version: string) => `nexo-server/${version}`
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`

/** Runs `nexo-server update`. Returns the exit code. */
export async function runUpdate(deps: UpdateDeps): Promise<number> {
  const { out, err } = deps
  if (!deps.binary || !parseVersion(deps.version)) {
    err('"update" only works in the downloaded nexo-server program, not when running from source.')
    err('From source, update with git (git pull) instead.')
    return 1
  }
  if (deps.runningPid) {
    err(`Nexo Server is running (PID ${deps.runningPid}). Stop it first (Ctrl+C in its window), then run "nexo-server update" again.`)
    return 1
  }

  try {
    out('Checking for a newer Nexo Server...')
    const releases = await fetchReleases({ fetch: deps.fetch, userAgent: userAgent(deps.version) })
    const plan = planUpdate(releases, deps.version, deps)
    if (plan.kind === 'up-to-date') {
      out(`You have the newest version (${deps.version}).`)
      return 0
    }
    if (plan.kind === 'no-build') {
      out(`Nexo ${plan.version} is out, but that release has no Nexo Server download for ${osName(deps.platform)} yet` +
        (plan.assetName ? ` (no ${plan.assetName}).` : '.'))
      out(`You keep ${deps.version}. Release page: ${plan.release.html_url}`)
      return 1
    }
    if (plan.skipped) out(`(${plan.skipped} has no ${osName(deps.platform)} server download yet; getting ${plan.version} instead.)`)
    if (!plan.checksum) {
      err(`The ${plan.version} release has no checksum file (${plan.asset.name}.sha256), so it can't be verified. Not installing.`)
      return 1
    }

    const files = await fetchAndVerify(plan, deps)
    installFiles(path.dirname(deps.binary), files)
    out('')
    out(`Updated Nexo Server ${deps.version} -> ${plan.version}.`)
    out(`What's new: ${plan.release.html_url}`)
    out('Start it again with "nexo-server" (or double-click nexo-server). Your data and settings are kept.')
    return 0
  } catch (e) {
    if (e instanceof UpdateError) {
      err(e.message)
      return 1
    }
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
      err(`Couldn't replace the files next to nexo-server (${code}). Is the folder read-only, or is a file open in another program?`)
      return 1
    }
    throw e
  }
}

/** Downloads the archive and its .sha256, verifies, extracts the binaries. Throws UpdateError. */
async function fetchAndVerify(plan: Extract<UpdatePlan, { kind: 'available' }>, deps: UpdateDeps) {
  const { out } = deps
  const ua = userAgent(deps.version)
  const sumText = (await download(plan.checksum!.browser_download_url, { fetch: deps.fetch, userAgent: ua })).toString('utf8')
  let expected: string
  try {
    expected = parseSha256File(sumText, plan.asset.name)
  } catch (e) {
    throw new UpdateError(`Bad checksum file in the ${plan.version} release: ${(e as Error).message}. Not installing.`)
  }

  out(`Downloading ${plan.asset.name} (${mb(plan.asset.size)})...`)
  let lastPct = -1
  const archive = await download(plan.asset.browser_download_url, {
    fetch: deps.fetch,
    userAgent: ua,
    onProgress: deps.progress
      ? (got, total) => {
          const pct = total ? Math.floor((got / total) * 10) * 10 : -1
          if (pct > lastPct) {
            lastPct = pct
            out(`  ${pct}%`)
          }
        }
      : undefined,
  })
  const actual = sha256(archive)
  if (actual !== expected) {
    throw new UpdateError(`The download doesn't match its checksum (expected ${expected}, got ${actual}). Not installing; try again.`)
  }
  out('Checksum OK.')

  const names = binaryNames(deps.platform)
  let entries
  try {
    entries = plan.asset.name.endsWith('.zip') ? extractZip(archive, names) : extractTarGz(archive, names)
  } catch (e) {
    throw new UpdateError(`Couldn't unpack ${plan.asset.name}: ${(e as Error).message}`)
  }
  const missing = names.filter((n) => !entries.some((e) => path.posix.basename(e.name) === n))
  if (missing.length) throw new UpdateError(`${plan.asset.name} doesn't contain ${missing.join(' and ')}. Not installing.`)
  return names.map((n) => ({ name: n, data: entries.find((e) => path.posix.basename(e.name) === n)!.data, mode: 0o755 }))
}

// ---------- start-up check ----------

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const CHECK_FILE = 'update-check.json'

/** `<data>/update-check.json`: the last check's result, so a start checks GitHub at most once a day. */
export interface CheckCache {
  checkedAt: string
  /** The version that did the check: a different (updated) binary checks again. */
  current: string
  /** Newer version with a download for this OS, if any. */
  available?: { version: string; url: string }
}

export interface StartupCheckOptions extends Target {
  dataDir: string
  version: string
  fetch?: typeof fetch
  now?: () => Date
  /** Default 5 s: it runs in the background, never delays the start. */
  timeoutMs?: number
}

const readCache = (file: string): CheckCache | null => {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as CheckCache
    return typeof c.checkedAt === 'string' && typeof c.current === 'string' ? c : null
  } catch {
    return null
  }
}

/**
 * The one line to print on start when a newer server exists, else null. Uses the cached result when the
 * last check is less than a day old (and was done by this version). Never throws: offline or rate-limited
 * just means no line (the attempt is still recorded, so a broken network doesn't mean a check per start).
 */
export async function startupUpdateLine(opts: StartupCheckOptions): Promise<string | null> {
  if (!parseVersion(opts.version)) return null // running from source
  const file = path.join(opts.dataDir, CHECK_FILE)
  const now = opts.now?.() ?? new Date()
  let cache = readCache(file)
  const fresh = cache && cache.current === opts.version && now.getTime() - Date.parse(cache.checkedAt) < CHECK_INTERVAL_MS && Date.parse(cache.checkedAt) <= now.getTime()
  if (!fresh) {
    cache = { checkedAt: now.toISOString(), current: opts.version }
    try {
      const releases = await fetchReleases({ fetch: opts.fetch, userAgent: userAgent(opts.version), timeoutMs: opts.timeoutMs ?? 5000 })
      const plan = planUpdate(releases, opts.version, opts)
      if (plan.kind === 'available' && plan.checksum) cache.available = { version: plan.version, url: plan.release.html_url }
    } catch {
      // offline, rate-limited: try again tomorrow
    }
    try {
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n')
      renameSync(tmp, file)
    } catch {
      // read-only data folder: we'll check again next start
    }
  }
  const a = cache!.available
  return a ? `Nexo Server ${a.version} is available (you have ${opts.version}). Stop the server and run "nexo-server update" to install it.` : null
}
