// Main-process log file: <userData>/logs/main.log, rotated to main.old.log at ~1 MB (one old file kept).
// installMainLog() tees console.warn / console.error (the `[nexo] …` warnings and errors) into it; logLine()
// writes explicit lines. Synchronous appends: lines are rare, and they must survive a crash right after.
import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { formatWithOptions } from 'node:util'

const MAX_BYTES = 1024 * 1024

let file: string | null = null
let size = 0
let failed = false

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

/** Append one line to main.log (no-op before installMainLog, or after the file became unwritable). */
export function logLine(level: LogLevel, ...args: unknown[]): void {
  if (!file || failed) return
  const text = formatWithOptions({ depth: 4, breakLength: Infinity }, ...args).replace(/\r?\n/g, '\n    ')
  const line = `${new Date().toISOString()} ${level} ${text}\n`
  try {
    if (size + line.length > MAX_BYTES) rotate(file)
    appendFileSync(file, line, 'utf8')
    size += Buffer.byteLength(line)
  } catch (err) {
    failed = true
    origError('[nexo] main log write failed, file logging disabled:', err)
  }
}

function rotate(path: string): void {
  try {
    renameSync(path, path.replace(/\.log$/, '.old.log'))
  } catch {
    /* nothing to rotate */
  }
  size = 0
}

const origWarn = console.warn.bind(console)
const origError = console.error.bind(console)

/** Call once, early (after userData is final, before anything logs). */
export function installMainLog(): void {
  if (file) return
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'main.log')
    try {
      size = statSync(file).size
    } catch {
      size = 0
    }
  } catch (err) {
    origError('[nexo] could not open the main log file:', err)
    return
  }
  console.warn = (...args: unknown[]) => {
    origWarn(...args)
    logLine('WARN', ...args)
  }
  console.error = (...args: unknown[]) => {
    origError(...args)
    logLine('ERROR', ...args)
  }
  logLine('INFO', `[nexo] start v${app.getVersion()} ${process.platform} ${process.arch} electron ${process.versions.electron}`)
}
