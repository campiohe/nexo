// Glue for main.ts: runs every command except the server itself, and prepares a start
// (data folder, config or first-run setup, single-instance lock, logger).
//
// main.ts (agent A) does:  const cmd = parseArgs(argv)
//   cmd.kind === 'start' ? prepareStart(cmd, deps) → start server + LiveKit with the result
//                        : process.exitCode = await runCommand(cmd, deps)

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import { runAutostart, type Exec } from '../autostart.ts'
import { runUpdate } from '../update/command.ts'
import { packagedBinary } from '../update/install.ts'
import { AdminError, backupDatabase, makeOwner, renameUser } from './admin.ts'
import { parseArgs, usage, type Command } from './commands.ts'
import { applyEnvOverrides, ConfigError, loadCliConfig, saveCliConfig, type ServerCliConfig } from './config.ts'
import { acquireInstance, runningInstance, type InstanceLock, type LockInfo } from './instance.ts'
import { renderInvite, inviteFromProbe, supportsUnicode, httpUrl, type InviteInput, type NetworkProbe } from './invite.ts'
import { createLogger, type Logger } from './log.ts'
import { dataLayout, resolveDataDir } from './paths.ts'
import { runSetup, SetupError } from './setup.ts'
import { formatStatus, getStatus } from './status.ts'

/** Exit code of `status` when the server is not running (like systemctl / LSB "program is not running"). */
export const EXIT_NOT_RUNNING = 3

export { parseArgs }

export interface CliDeps {
  /** nexo-server version, e.g. "0.5.0". */
  version: string
  stdin?: Readable
  stdout?: Writable
  stderr?: Writable
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Agent B's probeNetwork(). Without it, the invite only has the local address. */
  probeNetwork?: (cfg: ServerCliConfig) => Promise<NetworkProbe>
  /** Injected in tests. */
  isAlive?: (pid: number) => boolean
  /** The packaged nexo-server binary, or null from source. Default: packagedBinary(). */
  binary?: string | null
  /** Runs reg.exe / systemctl (autostart). Default: execFile without a shell. */
  exec?: Exec
  /** For `update` (GitHub API and downloads). */
  fetch?: typeof fetch
  arch?: string
}

/** execFile without a shell that never throws: exit code + output (autostart's Exec). */
export const execNoShell: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { windowsHide: true, encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => {
      const e = error as (NodeJS.ErrnoException & { code?: string | number }) | null
      if (e && typeof e.code === 'string') {
        resolve({ code: -1, stdout: stdout ?? '', stderr: stderr || e.message, missing: e.code === 'ENOENT' })
        return
      }
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })

interface Io {
  out: (line?: string) => void
  err: (line?: string) => void
  ascii: boolean
  columns: number
}

function io(cmd: Command, deps: CliDeps): Io {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  const env = deps.env ?? process.env
  return {
    out: (l = '') => void stdout.write(l + '\n'),
    err: (l = '') => void stderr.write(l + '\n'),
    ascii: cmd.global.ascii === true || !supportsUnicode(env, deps.platform ?? process.platform),
    columns: (stdout as Writable & { columns?: number }).columns ?? 80,
  }
}

function dataDirFor(cmd: Command, deps: CliDeps): string {
  return resolveDataDir({ flag: cmd.global.dataDir, env: deps.env ?? process.env, platform: deps.platform })
}

/** The invite for a config: probes the network when a probe is available, else only the local address. */
export async function buildInvite(config: ServerCliConfig, deps: CliDeps): Promise<InviteInput> {
  const notes: string[] = []
  if (deps.probeNetwork) {
    try {
      return inviteFromProbe(await deps.probeNetwork(config), config)
    } catch (e) {
      notes.push(`Could not check the network (${(e as Error).message}); only the local address is shown.`)
    }
  }
  return {
    serverName: config.serverName,
    password: config.serverPassword,
    addresses: [],
    localUrl: httpUrl('localhost', config.ports.http),
    notes,
  }
}

const noConfigHelp = (dataDir: string) => `No server is set up in ${dataDir} yet. Run "nexo-server setup" (or just "nexo-server").`

/** Runs any command except `start`. Returns the process exit code (0 ok, 1 failed, 2 bad usage). */
export async function runCommand(cmd: Command, deps: CliDeps): Promise<number> {
  const { out, err, ascii, columns } = io(cmd, deps)
  const env = deps.env ?? process.env
  try {
    switch (cmd.kind) {
      case 'start':
        throw new Error('runCommand does not start the server; use prepareStart')
      case 'help':
        out(usage())
        return 0
      case 'version':
        out(`nexo-server ${deps.version}`)
        return 0
      case 'error':
        err(cmd.message)
        err()
        err(usage())
        return 2
      case 'autostart': {
        const dataDir = dataDirFor(cmd, deps)
        return await runAutostart(cmd.action, {
          platform: deps.platform ?? process.platform,
          binary: deps.binary !== undefined ? deps.binary : packagedBinary(),
          dataDir,
          configured: existsSync(dataLayout(dataDir).config),
          running: runningInstance(dataDir, deps.isAlive) !== null,
          exec: deps.exec ?? execNoShell,
          out,
          err,
          env,
        })
      }
      case 'update': {
        const dataDir = dataDirFor(cmd, deps)
        const stdout = deps.stdout ?? process.stdout
        return await runUpdate({
          version: deps.version,
          platform: deps.platform ?? process.platform,
          arch: deps.arch ?? process.arch,
          binary: deps.binary !== undefined ? deps.binary : packagedBinary(),
          runningPid: runningInstance(dataDir, deps.isAlive)?.pid ?? null,
          out,
          err,
          fetch: deps.fetch,
          progress: (stdout as Writable & { isTTY?: boolean }).isTTY === true,
        })
      }
      case 'setup': {
        const dataDir = dataDirFor(cmd, deps)
        const existing = loadCliConfig(dataDir)
        const { config } = await runSetup({
          dataDir,
          existing,
          flags: cmd.setup,
          input: deps.stdin,
          output: deps.stdout,
          version: deps.version,
          platform: deps.platform,
        })
        saveCliConfig(dataDir, config)
        out('  Saved.')
        if (runningInstance(dataDir, deps.isAlive)) out('  The server is running: restart it to use the new settings.')
        return 0
      }
      case 'invite': {
        const dataDir = dataDirFor(cmd, deps)
        const config = loadCliConfig(dataDir)
        if (!config) {
          err(noConfigHelp(dataDir))
          return 1
        }
        const invite = await buildInvite(applyEnvOverrides(config, env).config, deps)
        for (const l of renderInvite(invite, { ascii, width: columns })) out(l)
        if (!runningInstance(dataDir, deps.isAlive)) out('  (The server is not running right now: start it with "nexo-server".)')
        return 0
      }
      case 'status': {
        const dataDir = dataDirFor(cmd, deps)
        const report = await getStatus(dataDir, { isAlive: deps.isAlive })
        for (const l of formatStatus(report, { dataDir, version: deps.version, ascii })) out(l)
        return report.running ? 0 : EXIT_NOT_RUNNING
      }
      case 'backup': {
        const dataDir = dataDirFor(cmd, deps)
        const r = backupDatabase(dataDir, cmd.file)
        out(`Database saved to ${r.file} (${(r.bytes / 1024 / 1024).toFixed(1)} MB).`)
        out(`Pictures are files, not in the database: copy the "attachments" and "avatars" folders in ${dataDir} too.`)
        return 0
      }
      case 'rename-user': {
        const dataDir = dataDirFor(cmd, deps)
        const r = renameUser(dataDir, cmd.oldName, cmd.newName, { force: cmd.force, isAlive: deps.isAlive })
        out(`Renamed "${r.oldName}" to "${r.newName}". Their messages are kept; "${r.oldName}" is free again.`)
        return 0
      }
      case 'owner': {
        const dataDir = dataDirFor(cmd, deps)
        const r = makeOwner(dataDir, cmd.name, { force: cmd.force, isAlive: deps.isAlive })
        out(`"${r.name}" is now the owner.${r.previous ? ` "${r.previous}" is now an admin.` : ''}`)
        return 0
      }
    }
  } catch (e) {
    if (e instanceof AdminError || e instanceof ConfigError || e instanceof SetupError) {
      err(e.message)
      return 1
    }
    throw e
  }
}

export type PrepareResult =
  | {
      kind: 'ready'
      dataDir: string
      /** config.json as saved. */
      saved: ServerCliConfig
      /** With environment overrides applied: use this for the server (toServerConfig) and livekit.yaml. */
      config: ServerCliConfig
      overriddenBy: string[]
      lock: InstanceLock
      /** Logger to the console and <data>/logs/nexo-server.log; the password and LiveKit secret are masked. */
      logger: Logger
      /** The previous run's lock if it crashed (for a log line). */
      tookOver?: LockInfo
    }
  /** Another instance is running for this data folder; its invite was printed. Exit 0. */
  | { kind: 'already-running'; dataDir: string; info: LockInfo }
  /** Nothing to start (setup failed or was cancelled, bad config); a message was printed. */
  | { kind: 'exit'; code: number }

/**
 * Everything before the server starts: data folder, config (first-run setup when missing), env overrides,
 * single-instance lock, logger. On `ready`, the caller starts the server and LiveKit, prints the invite
 * (`buildInvite` + `renderInvite` via `logger.print`), and calls `lock.release()` on exit.
 */
export async function prepareStart(cmd: Extract<Command, { kind: 'start' }>, deps: CliDeps): Promise<PrepareResult> {
  const { out, err, ascii, columns } = io(cmd, deps)
  const env = deps.env ?? process.env
  const dataDir = dataDirFor(cmd, deps)
  try {
    // A second double-click: say so and show the invite before anything else (no setup, no port errors).
    const other = runningInstance(dataDir, deps.isAlive)
    if (other) {
      await printAlreadyRunning(other, dataDir, deps, { out, ascii, columns })
      return { kind: 'already-running', dataDir, info: other }
    }

    let saved = loadCliConfig(dataDir)
    if (!saved) {
      const { config } = await runSetup({
        dataDir,
        flags: cmd.setup,
        input: deps.stdin,
        output: deps.stdout,
        version: deps.version,
        platform: deps.platform,
      })
      saveCliConfig(dataDir, config)
      out(`  Saved. Starting${ascii ? '...' : '…'}`)
      out()
      saved = config
    }
    const { config, overriddenBy } = applyEnvOverrides(saved, env)

    const acquired = acquireInstance(dataDir, { version: deps.version, ports: config.ports, isAlive: deps.isAlive })
    if (!acquired.ok) {
      await printAlreadyRunning(acquired.alreadyRunning, dataDir, deps, { out, ascii, columns })
      return { kind: 'already-running', dataDir, info: acquired.alreadyRunning }
    }

    const logger = createLogger({
      file: dataLayout(dataDir).logFile,
      stdout: deps.stdout,
      stderr: deps.stderr,
      secrets: [config.livekit.apiSecret, config.serverPassword],
    })
    if (overriddenBy.length) logger.info(`Using environment variables over config.json: ${overriddenBy.join(', ')}`)
    return {
      kind: 'ready',
      dataDir,
      saved,
      config,
      overriddenBy,
      lock: acquired.lock,
      logger,
      ...(acquired.tookOver ? { tookOver: acquired.tookOver } : {}),
    }
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SetupError) {
      err(e.message)
      return { kind: 'exit', code: 1 }
    }
    throw e
  }
}

async function printAlreadyRunning(info: LockInfo, dataDir: string, deps: CliDeps, o: Pick<Io, 'out' | 'ascii' | 'columns'>) {
  o.out(`Nexo Server is already running for ${dataDir} (PID ${info.pid}, since ${new Date(info.startedAt).toLocaleString()}).`)
  const config = loadCliConfig(dataDir)
  if (config) {
    const effective = applyEnvOverrides(config, deps.env ?? process.env).config
    effective.ports = { ...effective.ports, ...info.ports }
    o.out()
    for (const l of renderInvite(await buildInvite(effective, deps), { ascii: o.ascii, width: o.columns })) o.out(l)
  }
}
