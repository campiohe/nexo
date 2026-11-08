// Nexo Server CLI entry (docs/SPEC-SERVER-CLI.md §4). This is the esbuild bundle entry that becomes
// nexo-server.exe (Node SEA): it runs the Nexo server in-process and LiveKit as a supervised child.
//
// S0 spike: configuration comes from the environment (same variables as server/.env, see main()).
// `run(options)` is the reusable part; the CLI (setup, config.json) builds RunOptions and calls it.
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { configWarnings, loadConfig, type Config } from '../../server/src/config.ts'
import { start, type NexoInstance } from '../../server/src/server.ts'
import { liveKitYaml, locateLiveKit, portInUse, superviseLiveKit, type LiveKitYamlOptions } from './livekit.ts'

export interface RunOptions {
  /** Nexo server config (server/src/config.ts). `config.livekit` keys and port are also LiveKit's. */
  config: Config
  /** LiveKit network settings (keys and signaling port come from `config.livekit`). */
  liveKit: Omit<LiveKitYamlOptions, 'apiKey' | 'apiSecret' | 'port'> & {
    /** Path of livekit-server(.exe). Default: locateLiveKit(). */
    binary?: string
  }
  /** Console/log sink. Default: console.log. */
  log?: (line: string) => void
  /** LiveKit gave up restarting (see superviseLiveKit). Default: log it and keep the chat server running. */
  onFatal?: (err: Error) => void
}

export interface Running {
  nexo: NexoInstance
  /** Generated LiveKit config path (`<dataDir>/livekit.yaml`). */
  liveKitConfigPath: string
  /** Stops the Nexo server, then LiveKit. Safe to call more than once. */
  stop(): Promise<void>
}

/** Writes `<dataDir>/livekit.yaml`, starts LiveKit and waits until it's ready, then starts the Nexo server. */
export async function run(options: RunOptions): Promise<Running> {
  const { config } = options
  const log = options.log ?? ((line: string) => console.log(line))

  const lkHost = options.liveKit.bindAddresses.find((a) => !['0.0.0.0', '::', ''].includes(a)) ?? '127.0.0.1'
  if (await portInUse(lkHost, config.livekit.port)) {
    throw new Error(`Port ${config.livekit.port} is already in use (is another LiveKit or Nexo server running?)`)
  }

  mkdirSync(config.dataDir, { recursive: true })
  const liveKitConfigPath = path.join(config.dataDir, 'livekit.yaml')
  const { binary, ...net } = options.liveKit
  writeFileSync(
    liveKitConfigPath,
    liveKitYaml({ ...net, apiKey: config.livekit.apiKey, apiSecret: config.livekit.apiSecret, port: config.livekit.port }),
    { mode: 0o600 },
  )

  const liveKit = superviseLiveKit({
    binary: binary ?? locateLiveKit(),
    configPath: liveKitConfigPath,
    port: config.livekit.port,
    host: lkHost,
    log,
    onFatal: options.onFatal ?? ((err) => log(`[nexo] Voice is unavailable: ${err.message}`)),
  })
  try {
    await liveKit.ready
  } catch (err) {
    await liveKit.stop()
    throw err
  }

  let nexo: NexoInstance
  try {
    nexo = await start({ ...config, log })
  } catch (err) {
    await liveKit.stop()
    throw err
  }

  let stopped: Promise<void> | null = null
  return {
    nexo,
    liveKitConfigPath,
    stop: () =>
      (stopped ??= (async () => {
        try {
          await nexo.close()
        } finally {
          await liveKit.stop()
        }
      })()),
  }
}

// ---------- S0: env-driven entry ----------

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim())

/** Spike config from env: the server's variables (PORT, HOST, DATA_DIR, SERVER_PASSWORD, LIVEKIT_*) plus LiveKit networking. */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): Omit<RunOptions, 'log' | 'onFatal'> & { notes: string[] } {
  const config = loadConfig(env)
  const notes: string[] = []
  if (!env.LIVEKIT_API_SECRET) {
    // Our own LiveKit: random keys per run are fine until config.json stores them (S1).
    config.livekit.apiKey = `nexo-${randomBytes(6).toString('hex')}`
    config.livekit.apiSecret = randomBytes(32).toString('base64url')
    notes.push('LIVEKIT_API_SECRET not set: generated random LiveKit keys for this run')
  }
  const bindAddresses = (env.LIVEKIT_BIND_ADDRESSES || (config.host === '0.0.0.0' ? '0.0.0.0' : config.host))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const loopbackOnly = bindAddresses.every((a) => a === '::1' || a.startsWith('127.'))
  let tcpPort = Number(env.LIVEKIT_TCP_PORT || 7881)
  if (loopbackOnly && tcpPort !== 0) {
    // LiveKit's ICE/TCP listener ignores bind_addresses (always all interfaces): keep loopback really loopback.
    tcpPort = 0
    notes.push('loopback-only: LiveKit ICE/TCP fallback disabled')
  }
  return {
    config,
    liveKit: {
      bindAddresses,
      tcpPort,
      udpPort: Number(env.LIVEKIT_UDP_PORT || 7882),
      nodeIp: env.LIVEKIT_NODE_IP || undefined,
      useExternalIp: truthy(env.LIVEKIT_USE_EXTERNAL_IP),
    },
    notes,
  }
}

export async function main(): Promise<void> {
  const t0 = performance.now()
  const log = (line: string) => console.log(line)
  let opts: ReturnType<typeof optionsFromEnv>
  try {
    opts = optionsFromEnv()
  } catch (err) {
    console.error(`[nexo] ${(err as Error).message}`)
    process.exit(1)
  }
  for (const note of opts.notes) log(`[nexo] ${note}`)
  for (const warning of configWarnings(opts.config)) console.warn(`[nexo] ${warning}`)

  let running: Running | null = null
  let shuttingDown = false
  async function shutdown(reason: string, code = 0) {
    if (shuttingDown) {
      log('[nexo] Forcing exit')
      process.exit(1)
    }
    shuttingDown = true
    const since = performance.now()
    log(`[nexo] ${reason}, shutting down…`)
    const force = setTimeout(() => {
      console.error('[nexo] Shutdown timed out, forcing exit')
      process.exit(1)
    }, 8000)
    force.unref()
    try {
      await running?.stop()
      log(`[nexo] Stopped in ${Math.round(performance.now() - since)} ms`)
      process.exit(code)
    } catch (err) {
      console.error('[nexo] Error during shutdown:', err)
      process.exit(1)
    }
  }
  // SIGINT = Ctrl+C; SIGBREAK = Ctrl+Break (Windows); SIGHUP = console window closed (Windows gives ~10 s).
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) process.on(sig, () => void shutdown(sig))

  try {
    running = await run({ ...opts, log })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'EADDRINUSE') console.error(`[nexo] Port ${opts.config.port} is already in use. Is another Nexo server running? (set PORT)`)
    else console.error(`[nexo] Failed to start: ${e.message}`)
    process.exit(1)
  }
  if (shuttingDown) return

  const { config, liveKit } = opts
  const ms = Math.round(performance.now() - t0)
  log('')
  log(`  Nexo server   listening on ${running.nexo.url}  (${config.serverName})`)
  log(`  Voice         LiveKit on ${liveKit.bindAddresses.join(', ')} port ${config.livekit.port} (tcp ${liveKit.tcpPort || 'off'}, udp ${liveKit.udpPort})`)
  log(`  Data folder   ${config.dataDir}`)
  log(`  Started in ${ms} ms. Press Ctrl+C to stop.`)
  log('')
}

// Bundle (nexo-server.exe / nexo-server.cjs): esbuild defines import.meta.main as true. Dev: `node src/main.ts`.
if (import.meta.main) void main()
