// Logging (docs/SPEC-SERVER-CLI.md §4 "Logs"): plain lines on the console, timestamped lines in
// <data>/logs/nexo-server.log, rotated by size (nexo-server.log → .1 → .2 → .3) for bug reports.
//
// Secrets registered with addSecret() are masked everywhere the logger writes. The password is shown
// only by setup and the invite, which print through `print()` (console only, never the file).

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Writable } from 'node:stream'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LoggerOptions {
  /** Log file; omit for console only. */
  file?: string
  /** Rotate when the file would grow past this. Default 5 MB. */
  maxBytes?: number
  /** Rotated files to keep (`.1` … `.N`). Default 3. */
  maxFiles?: number
  stdout?: Writable
  stderr?: Writable
  /** Values to mask from the start (e.g. the LiveKit secret). */
  secrets?: string[]
  now?: () => Date
}

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string, err?: unknown): void
  /** Console only, unredacted, not in the file: for the invite and setup (the password is meant to be seen). */
  print(line?: string): void
  /** Masks `value` in everything logged from now on. Ignores values shorter than 4 characters. */
  addSecret(value: string): void
  /** Masks the registered secrets in `text`. */
  redact(text: string): string
}

export const REDACTED = '***'

/** Replaces each secret (≥ 4 chars, longest first so overlaps mask fully) in `text` with ***. */
export function redact(text: string, secrets: Iterable<string>): string {
  const list = [...new Set(secrets)].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)
  let out = text
  for (const s of list) out = out.split(s).join(REDACTED)
  return out
}

/** Moves `file` to `file.1`, shifting older ones up and dropping the one past `maxFiles`. */
export function rotateFiles(file: string, maxFiles: number): void {
  rmSync(`${file}.${maxFiles}`, { force: true })
  for (let i = maxFiles - 1; i >= 1; i--) {
    try {
      renameSync(`${file}.${i}`, `${file}.${i + 1}`)
    } catch {
      // that generation doesn't exist yet
    }
  }
  if (maxFiles >= 1) {
    try {
      renameSync(file, `${file}.1`)
    } catch {
      // nothing to rotate
    }
  } else rmSync(file, { force: true })
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
  return String(err)
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const stdout = opts.stdout ?? process.stdout
  const stderr = opts.stderr ?? process.stderr
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024
  const maxFiles = opts.maxFiles ?? 3
  const now = opts.now ?? (() => new Date())
  const secrets = new Set<string>()
  for (const s of opts.secrets ?? []) if (s.length >= 4) secrets.add(s)

  let size = 0
  let fileOk = false
  if (opts.file) {
    try {
      mkdirSync(path.dirname(opts.file), { recursive: true })
      try {
        size = statSync(opts.file).size
      } catch {
        size = 0
      }
      fileOk = true
    } catch (err) {
      stderr.write(`Can't write the log file ${opts.file}: ${(err as Error).message}\n`)
    }
  }

  function toFile(level: LogLevel, msg: string) {
    if (!fileOk || !opts.file) return
    const text = msg
      .split('\n')
      .map((l) => `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${l}`)
      .join('\n') + '\n'
    const bytes = Buffer.byteLength(text)
    try {
      if (size > 0 && size + bytes > maxBytes) {
        rotateFiles(opts.file, maxFiles)
        size = 0
      }
      appendFileSync(opts.file, text)
      size += bytes
    } catch (err) {
      // Never let logging take the server down; say it once and continue on the console.
      fileOk = false
      stderr.write(`Can't write the log file ${opts.file}: ${(err as Error).message}\n`)
    }
  }

  function write(level: LogLevel, raw: string) {
    const msg = redact(raw, secrets)
    ;(level === 'info' ? stdout : stderr).write(msg + '\n')
    toFile(level, msg)
  }

  return {
    info: (msg) => write('info', msg),
    warn: (msg) => write('warn', msg),
    error: (msg, err) => write('error', err === undefined ? msg : `${msg}\n${errorText(err)}`),
    print: (line = '') => {
      stdout.write(line + '\n')
    },
    addSecret(value) {
      if (value.length >= 4) secrets.add(value)
    },
    redact: (text) => redact(text, secrets),
  }
}
