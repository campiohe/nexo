// Swapping in new binaries next to the running nexo-server (docs/SPEC-SERVER-CLI.md §8).
//
// Windows won't overwrite or delete a running .exe, but it does allow renaming it. So: write the new files
// as `<name>.new`, rename the current ones to `<name>.old`, rename the new ones into place. The `.old`
// files are deleted on the next start (cleanupOldFiles), when nothing runs from them anymore. Linux does
// the same dance (overwriting a running binary fails with ETXTBSY there; renaming is fine).
import { existsSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isSea } from 'node:sea'

/** Base names of the binaries in the release download, for this OS. */
export function binaryNames(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['nexo-server.exe', 'livekit-server.exe'] : ['nexo-server', 'livekit-server']
}

/**
 * The packaged nexo-server binary this process runs from, or null when running from source / plain Node
 * (`node src/main.ts`, `node dist/nexo-server.cjs`). `autostart` and `update` only make sense for it.
 */
export function packagedBinary(execPath = process.execPath, sea = isSea()): string | null {
  return sea && /^nexo-server(\.exe)?$/i.test(path.basename(execPath)) ? execPath : null
}

export interface NewFile {
  name: string
  data: Uint8Array
  /** File mode on POSIX (0o755 for binaries). */
  mode?: number
}

/** Moves `file` aside as `<file>.old` (or `<file>.<n>.old` when an older .old can't be removed). */
function moveAside(file: string): string {
  let target = `${file}.old`
  try {
    rmSync(target, { force: true })
  } catch {
    target = `${file}.${Date.now()}.old` // a previous .old is still running (another server): keep it
  }
  renameSync(file, target)
  return target
}

/**
 * Installs `files` into `dir`, replacing files of the same name. All or nothing: on any failure the old
 * files are put back and the new ones removed, then the error is rethrown.
 */
export function installFiles(dir: string, files: readonly NewFile[]): void {
  const staged: string[] = []
  const moved: { file: string; aside: string }[] = []
  const placed: string[] = []
  try {
    for (const f of files) {
      const tmp = path.join(dir, `${f.name}.new`)
      writeFileSync(tmp, f.data, { mode: f.mode ?? 0o755 })
      staged.push(tmp)
    }
    for (const f of files) {
      const file = path.join(dir, f.name)
      if (existsSync(file)) moved.push({ file, aside: moveAside(file) })
      renameSync(path.join(dir, `${f.name}.new`), file)
      placed.push(file)
    }
  } catch (err) {
    for (const file of placed) rmSync(file, { force: true })
    for (const { file, aside } of moved.reverse()) {
      try {
        renameSync(aside, file)
      } catch {
        // best effort: the .old file is still there for a manual fix
      }
    }
    for (const tmp of staged) rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * Deletes `<name>.old` / `<name>.<n>.old` left by a previous update. Files still in
 * use (another server running from them) are left for next time. Never throws.
 */
export function cleanupOldFiles(dir: string, names: readonly string[] = binaryNames()): string[] {
  const removed: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return removed
  }
  for (const entry of entries) {
    const stale = names.some((n) => entry === `${n}.old` || (entry.startsWith(`${n}.`) && /^\.\d+\.old$/.test(entry.slice(n.length))))
    if (!stale) continue
    try {
      rmSync(path.join(dir, entry), { force: true })
      removed.push(entry)
    } catch {
      // still running: next time
    }
  }
  return removed
}
