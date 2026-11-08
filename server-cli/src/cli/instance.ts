// Single instance per data folder (docs/SPEC-SERVER-CLI.md §4): a lock file with the owner's PID,
// ports and start time. A second double-click finds it and prints the invite instead of failing on ports.
//
// The lock is created with O_EXCL ('wx'), so two starts can't both create it. A lock whose PID is no
// longer running (crash, power loss) is stale and taken over.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dataLayout } from './paths.ts'

export interface LockInfo {
  pid: number
  /** ISO time the instance started. */
  startedAt: string
  /** nexo-server version that holds the lock. */
  version: string
  ports: { http: number; livekit: number; livekitTcp: number; livekitUdp: number }
  /** Live counts, refreshed by the running instance (read by `nexo-server status`). */
  stats?: { online: number; inVoice: number; streaming: number; uploadMbps?: number; updatedAt: string }
}

export type AcquireResult =
  | { ok: true; lock: InstanceLock; tookOver?: LockInfo }
  | { ok: false; alreadyRunning: LockInfo }

export interface InstanceLock {
  readonly file: string
  readonly info: LockInfo
  /**
   * Rewrites the lock with new fields (e.g. stats, or ports actually bound). Returns false if the write
   * failed (e.g. Windows briefly refusing the replace while `status` reads it): just try again next time.
   */
  update(patch: Partial<Omit<LockInfo, 'pid'>>): boolean
  /** Removes the lock if it is still ours. Safe to call twice. */
  release(): void
}

/** True when a process with this PID exists (EPERM = exists but belongs to someone else). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function parseLock(text: string): LockInfo | null {
  try {
    const v = JSON.parse(text) as LockInfo
    return v && Number.isInteger(v.pid) && typeof v.ports === 'object' && v.ports !== null ? v : null
  } catch {
    return null
  }
}

/** The lock's contents, or null when there is no (readable) lock. Doesn't check the PID. */
export function readLock(dataDir: string): LockInfo | null {
  try {
    return parseLock(readFileSync(dataLayout(dataDir).lock, 'utf8'))
  } catch {
    return null
  }
}

/** The running instance for this data folder, or null (no lock, or a stale one). */
export function runningInstance(dataDir: string, isAlive: (pid: number) => boolean = isProcessAlive): LockInfo | null {
  const info = readLock(dataDir)
  return info && info.pid !== process.pid && isAlive(info.pid) ? info : null
}

export interface AcquireOptions {
  version: string
  ports: LockInfo['ports']
  pid?: number
  /** Injected in tests. */
  isAlive?: (pid: number) => boolean
  now?: () => Date
}

/**
 * Takes the lock for `dataDir`. Returns `{ alreadyRunning }` when another live process holds it,
 * so the caller can print that instance's invite. A stale lock (dead PID or unreadable file) is taken over.
 */
export function acquireInstance(dataDir: string, opts: AcquireOptions): AcquireResult {
  const file = dataLayout(dataDir).lock
  const pid = opts.pid ?? process.pid
  const isAlive = opts.isAlive ?? isProcessAlive
  const info: LockInfo = {
    pid,
    startedAt: (opts.now?.() ?? new Date()).toISOString(),
    version: opts.version,
    ports: { ...opts.ports },
  }
  mkdirSync(dataDir, { recursive: true })

  let tookOver: LockInfo | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(info, null, 2) + '\n', { flag: 'wx' })
      return { ok: true, lock: makeHandle(file, info), ...(tookOver ? { tookOver } : {}) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue // vanished in between: try again
    }
    const current = parseLock(text)
    if (current && current.pid !== pid && isAlive(current.pid)) return { ok: false, alreadyRunning: current }
    // Stale (or ours from a previous life with a recycled PID). Move it aside rather than unlinking,
    // and only if it still has the content we judged stale, to narrow the race with another taker.
    const aside = `${file}.stale-${pid}`
    try {
      if (readFileSync(file, 'utf8') !== text) continue
      renameSync(file, aside)
      rmSync(aside, { force: true })
    } catch {
      // someone else took it over first: loop and look again
    }
    if (current) tookOver = current
  }
  const holder = readLock(dataDir)
  if (holder) return { ok: false, alreadyRunning: holder }
  throw new Error(`Could not create the lock file ${file}`)
}

function makeHandle(file: string, initial: LockInfo): InstanceLock {
  let info = initial
  let released = false
  return {
    file,
    get info() {
      return info
    },
    update(patch) {
      if (released) return false
      info = { ...info, ...patch, pid: info.pid }
      // Atomic replace, so `status` never reads half a file.
      const tmp = `${file}.${info.pid}.tmp`
      try {
        writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n')
        renameSync(tmp, file)
        return true
      } catch {
        rmSync(tmp, { force: true })
        return false
      }
    },
    release() {
      if (released) return
      released = true
      try {
        const current = parseLock(readFileSync(file, 'utf8'))
        if (current?.pid === info.pid) rmSync(file, { force: true })
      } catch {
        // already gone
      }
    },
  }
}
