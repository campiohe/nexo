// Where the Nexo Server CLI keeps its files (docs/SPEC-SERVER-CLI.md §4 "Data folder").
//
// One folder holds everything. It is also the server's DATA_DIR, so nexo.db, attachments/ and avatars/
// sit exactly where today's server puts them, and `--data server/data` adopts an existing install.
//
//   <data>/config.json        CLI config (config.ts)
//   <data>/nexo.db            the server's database (+ -wal/-shm), attachments/, avatars/
//   <data>/livekit.yaml       generated on every start (agent A, livekit.ts)
//   <data>/logs/              rotating nexo-server.log (log.ts)
//   <data>/backups/           default target of `nexo-server backup` (admin.ts)
//   <data>/nexo-server.lock   single-instance lock (instance.ts)

import os from 'node:os'
import path from 'node:path'

export interface DataDirOptions {
  /** `--data <dir>` from the command line (wins over everything). */
  flag?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homedir?: string
  cwd?: string
}

/**
 * The OS default data folder:
 * - Windows: `%LOCALAPPDATA%\Nexo Server` (falls back to `<home>\AppData\Local\Nexo Server`)
 * - Linux and others: `$XDG_DATA_HOME/nexo-server`, else `~/.local/share/nexo-server`
 */
export function defaultDataDir(opts: Omit<DataDirOptions, 'flag' | 'cwd'> = {}): string {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const home = opts.homedir ?? os.homedir()
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local')
    return path.win32.join(local, 'Nexo Server')
  }
  // XDG says relative values must be ignored.
  const xdg = env.XDG_DATA_HOME && path.posix.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : ''
  return path.posix.join(xdg || path.posix.join(home, '.local', 'share'), 'nexo-server')
}

/**
 * The data folder to use: `--data <dir>` > `DATA_DIR` env (today's `.env` name, spec C5) > OS default.
 * Relative paths resolve against the current directory. Returns an absolute path.
 */
export function resolveDataDir(opts: DataDirOptions = {}): string {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const chosen = opts.flag?.trim() || env.DATA_DIR?.trim()
  const platform = opts.platform ?? process.platform
  const p = platform === 'win32' ? path.win32 : path.posix
  if (chosen) return p.resolve(cwd, chosen)
  return defaultDataDir(opts)
}

export interface DataLayout {
  root: string
  config: string
  db: string
  livekitYaml: string
  logsDir: string
  logFile: string
  backupsDir: string
  lock: string
}

/** File locations inside a data folder. */
export function dataLayout(dataDir: string): DataLayout {
  return {
    root: dataDir,
    config: path.join(dataDir, 'config.json'),
    db: path.join(dataDir, 'nexo.db'),
    livekitYaml: path.join(dataDir, 'livekit.yaml'),
    logsDir: path.join(dataDir, 'logs'),
    logFile: path.join(dataDir, 'logs', 'nexo-server.log'),
    backupsDir: path.join(dataDir, 'backups'),
    lock: path.join(dataDir, 'nexo-server.lock'),
  }
}
