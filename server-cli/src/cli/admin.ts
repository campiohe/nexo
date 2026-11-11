// Admin commands that work on the database directly: `backup`, `rename-user` (spec §3.3) and `owner`
// (docs/SPEC-ACCOUNTS.md §2).
//
// rename-user replaces the manual SQLite command in docs/SERVER.md ("Lost identity") and applies the
// server's own name rules (server/src/server.ts: normalizeUserName, LIMITS, NAME_RE; users.name is
// UNIQUE COLLATE NOCASE in server/src/db.ts).

import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../../server/src/db.ts'
import { isValidUserName, LIMITS, normalizeUserName } from '../../../server/src/server.ts'
import { runningInstance } from './instance.ts'
import { dataLayout } from './paths.ts'

export class AdminError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdminError'
  }
}


/** Normalizes a user name like the server does; returns it, or an error message when the server would reject it. */
export function checkUserName(name: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = normalizeUserName(name)
  if (!isValidUserName(value)) {
    return { ok: false, error: `Names must be ${LIMITS.nameMin}-${LIMITS.nameMax} letters, numbers, spaces, . _ or - (got "${value}")` }
  }
  return { ok: true, value }
}

function openExisting(dataDir: string): DatabaseSync {
  const file = dataLayout(dataDir).db
  if (!existsSync(file)) {
    throw new AdminError(`No database at ${file}. Is this the right data folder? (use --data <dir>)`)
  }
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

/** `nexo-backup-2026-11-08_14-30-05.db` for the given time (local time, so the host recognizes it). */
export function defaultBackupName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
  const time = `${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`
  return `nexo-backup-${date}_${time}.db`
}

export interface BackupResult {
  file: string
  bytes: number
}

/**
 * Writes a consistent copy of nexo.db with `VACUUM INTO` (safe while the server runs: it reads a snapshot).
 * `file` defaults to `<data>/backups/<defaultBackupName()>`; relative paths resolve against the current
 * directory. Refuses to overwrite. Note: pictures (attachments/, avatars/) are files next to the DB, not in it.
 */
export function backupDatabase(dataDir: string, file?: string, now = new Date()): BackupResult {
  const target = file ? path.resolve(file) : path.join(dataLayout(dataDir).backupsDir, defaultBackupName(now))
  if (existsSync(target)) throw new AdminError(`${target} already exists. Choose another file name.`)
  const db = openExisting(dataDir)
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    db.prepare('VACUUM INTO ?').run(target)
  } catch (err) {
    if (err instanceof AdminError) throw err
    throw new AdminError(`Backup failed: ${(err as Error).message}`)
  } finally {
    db.close()
  }
  return { file: target, bytes: statSync(target).size }
}

export interface RenameOptions {
  /** Rename even while the server is running (see renameUser). */
  force?: boolean
  /** Injected in tests. */
  isAlive?: (pid: number) => boolean
}

export interface RenameResult {
  id: string
  oldName: string
  newName: string
}

/**
 * Renames a user (keeping their messages), e.g. to free a name after a friend lost their device token.
 * Matches the old name case-insensitively, like the server. The new name must pass the server's rules
 * and not be taken by someone else (a case-only change of the same user is fine).
 *
 * Refused while the server for this data folder is running, unless `force`: the write itself is safe
 * (SQLite + WAL), but the running server keeps connected users' names in memory, so friends would see
 * the old name until everyone reconnects, and a restart is the clean way to make it take effect.
 */
export function renameUser(dataDir: string, oldName: string, newName: string, opts: RenameOptions = {}): RenameResult {
  const running = runningInstance(dataDir, opts.isAlive)
  if (running && !opts.force) {
    throw new AdminError(
      `The server is running (PID ${running.pid}). Stop it first (Ctrl+C in its window), then run this again.\n` +
        'Renaming while it runs works, but connected friends keep seeing the old name until they reconnect.\n' +
        'To do it anyway, add --force.',
    )
  }
  const from = normalizeUserName(oldName)
  if (!from) throw new AdminError('Give the current name of the user to rename.')
  const to = checkUserName(newName)
  if (!to.ok) throw new AdminError(to.error)

  const db = openExisting(dataDir)
  try {
    // users.name is COLLATE NOCASE, so `=` is case-insensitive (same as the server's lookups).
    const user = db.prepare('SELECT id, name FROM users WHERE name = ?').get(from) as { id: string; name: string } | undefined
    if (!user) throw new AdminError(`No user named "${from}".`)
    const clash = db.prepare('SELECT id, name FROM users WHERE name = ? AND id <> ?').get(to.value, user.id) as
      | { id: string; name: string }
      | undefined
    if (clash) throw new AdminError(`The name "${clash.name}" is already taken by another user.`)
    if (user.name === to.value) throw new AdminError(`The user is already called "${to.value}".`)
    try {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(to.value, user.id)
    } catch (err) {
      if (/UNIQUE constraint failed/i.test((err as Error).message)) throw new AdminError(`The name "${to.value}" is already taken.`)
      throw err
    }
    return { id: user.id, oldName: user.name, newName: to.value }
  } finally {
    db.close()
  }
}

export interface OwnerResult {
  id: string
  name: string
  /** The previous owner, now an admin (undefined when there was none). */
  previous?: string
}

/**
 * Makes a user the server's owner; the previous owner becomes an admin (docs/SPEC-ACCOUNTS.md §2: the app
 * can't move ownership). Matches the name case-insensitively, like the server. Opens the database with the
 * server's own openDb, so an older database is migrated (roles, logins) first.
 *
 * Refused while the server for this data folder is running, unless `force`: permissions take effect at once
 * (the server reads roles from the database), but connected friends see the old roles until they reconnect.
 */
export function makeOwner(dataDir: string, name: string, opts: RenameOptions = {}): OwnerResult {
  const running = runningInstance(dataDir, opts.isAlive)
  if (running && !opts.force) {
    throw new AdminError(
      `The server is running (PID ${running.pid}). Stop it first (Ctrl+C in its window), then run this again.\n` +
        'Changing the owner while it runs works, but connected friends see the old roles until they reconnect.\n' +
        'To do it anyway, add --force.',
    )
  }
  const wanted = normalizeUserName(name)
  if (!wanted) throw new AdminError('Give the name of the user who should own the server.')
  openExisting(dataDir).close() // a clear error when there is no database (openDb would create one)

  const db = openDb(dataDir)
  try {
    const user = db.users.byName(wanted)
    if (!user) throw new AdminError(`No user named "${wanted}".`)
    if (user.role === 'owner') throw new AdminError(`"${user.name}" is already the owner.`)
    const moved = db.users.transferOwnership(user.id)
    if (!moved) throw new AdminError(`No user named "${wanted}".`)
    return { id: user.id, name: user.name, ...(moved.previous ? { previous: moved.previous.name } : {}) }
  } finally {
    db.close()
  }
}
