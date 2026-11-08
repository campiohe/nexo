// Nexo Server CLI entry (docs/SPEC-SERVER-CLI.md §4). This is the esbuild bundle entry that becomes
// nexo-server.exe (Node SEA): it runs the Nexo server in-process and LiveKit as a supervised child.
//
// main() is the CLI (src/cli: commands, setup, config.json, lock, logs); `run(options)` starts LiveKit and
// the Nexo server; the network probe (src/network) decides addresses, LiveKit's advertised IPs and UPnP.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { configWarnings, type Config } from '../../server/src/config.ts'
import { start, type NexoInstance } from '../../server/src/server.ts'
import { parseArgs, prepareStart, runCommand, type CliDeps } from './cli/run.ts'
import { toServerConfig, type ServerCliConfig } from './cli/config.ts'
import { inviteFromProbe, renderInvite, supportsUnicode, symbols } from './cli/invite.ts'
import { statusLine } from './cli/status.ts'
import { defaultPorts, isLoopback, isPrivateIp, mapPorts, probeNetwork, type NetworkProbe, type PortMappingSession } from './network/index.ts'
import { liveKitYaml, locateLiveKit, portInUse, superviseLiveKit, type LiveKitYamlOptions } from './livekit.ts'

declare const __NEXO_SERVER_VERSION__: string
/** Injected by the bundle (build/bundle.ts); "dev" when run from source. */
export const VERSION = typeof __NEXO_SERVER_VERSION__ === 'string' ? __NEXO_SERVER_VERSION__ : 'dev'

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

// ---------- CLI entry ----------

/** How the server is reached (docs/SPEC-SERVER-CLI.md §6), from the config's mode and the probe. */
export interface NetworkPlan {
  /** LiveKit's advertised IP for media; undefined = its interface addresses (advertise_internal_ip). */
  nodeIp?: string
  /** Advertise the STUN-discovered public IP too (port-forwarded hosts). */
  useExternalIp: boolean
  /** Ask the router to forward the ports (UPnP). */
  mapPorts: boolean
}

/**
 * - tailscale: advertise the Tailscale IP; no router changes.
 * - public: UPnP mapping + external IP.
 * - lan: local addresses only.
 * - auto: Tailscale when it's running (no ports opened to the internet), else try UPnP, else LAN.
 */
export function planNetwork(mode: ServerCliConfig['network']['mode'], probe: Pick<NetworkProbe, 'tailscale'>): NetworkPlan {
  if (mode === 'tailscale') return { nodeIp: probe.tailscale?.ip, useExternalIp: false, mapPorts: false }
  if (mode === 'public') return { useExternalIp: true, mapPorts: true }
  if (mode === 'lan') return { useExternalIp: false, mapPorts: false }
  return probe.tailscale ? { useExternalIp: false, mapPorts: false } : { useExternalIp: true, mapPorts: true }
}

/** A connected client that is neither this PC nor the local network: a friend from outside. */
export const isOutsideAddress = (a: string) => !!a && !isLoopback(a) && !isPrivateIp(a) && a !== '::1'

function bindAddressesFor(host: string): string[] {
  return host === '0.0.0.0' || host === '' ? ['0.0.0.0'] : [host]
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const env = process.env
  const deps: CliDeps = {
    version: VERSION,
    probeNetwork: () => probeNetwork(),
  }
  const cmd = parseArgs(argv)
  if (cmd.kind !== 'start') {
    process.exitCode = await runCommand(cmd, deps)
    return
  }

  const prep = await prepareStart(cmd, deps)
  if (prep.kind === 'exit') {
    process.exitCode = prep.code
    return
  }
  if (prep.kind === 'already-running') return

  const { logger, lock, dataDir } = prep
  const cfg = prep.config
  const ascii = cmd.global.ascii === true || !supportsUnicode(env)
  const sym = symbols(ascii)
  const columns = process.stdout.columns ?? 80
  if (prep.tookOver) logger.warn(`The previous run (PID ${prep.tookOver.pid}) didn't shut down cleanly; taking over.`)

  const config = toServerConfig(cfg, dataDir, env)
  for (const warning of configWarnings(config)) logger.warn(warning)

  // Network first: it decides what LiveKit advertises and whether to ask the router for ports.
  const probe = await probeNetwork()
  const plan = planNetwork(cfg.network.mode, probe)
  let mapping: PortMappingSession | null = null

  let running: Running | null = null
  let shuttingDown = false
  let statusTimer: NodeJS.Timeout | undefined
  async function shutdown(reason: string, code = 0) {
    if (shuttingDown) {
      logger.print('Forcing exit')
      process.exit(1)
    }
    shuttingDown = true
    clearInterval(statusTimer)
    logger.print('')
    logger.info(`${reason}: shutting down${sym.ellipsis}`)
    const force = setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit')
      process.exit(1)
    }, 8000)
    force.unref()
    try {
      await running?.stop()
      await mapping?.release()
      lock.release()
      logger.info('Stopped.')
      process.exit(code)
    } catch (err) {
      logger.error('Error during shutdown', err as Error)
      lock.release()
      process.exit(1)
    }
  }
  // SIGINT = Ctrl+C; SIGBREAK = Ctrl+Break (Windows); SIGHUP = console window closed (Windows gives ~10 s).
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) process.on(sig, () => void shutdown(sig))

  const bindAddresses = bindAddressesFor(config.host)
  const loopbackOnly = bindAddresses.every((a) => a === '::1' || a.startsWith('127.'))
  try {
    running = await run({
      config,
      liveKit: {
        bindAddresses,
        // LiveKit's ICE/TCP listener ignores bind_addresses (always all interfaces): off when loopback-only.
        tcpPort: loopbackOnly ? 0 : cfg.ports.livekitTcp,
        udpPort: cfg.ports.livekitUdp,
        nodeIp: plan.nodeIp,
        useExternalIp: plan.useExternalIp && !loopbackOnly,
      },
      log: (line) => logger.info(line),
    })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'EADDRINUSE') logger.error(`Port ${config.port} is already in use. Is another Nexo server running? ("nexo-server setup" can change ports)`)
    else logger.error(`Failed to start: ${e.message}`)
    lock.release()
    process.exitCode = 1
    return
  }
  if (shuttingDown) return

  logger.print('')
  logger.print(`  ${sym.ok} Nexo server   listening on port ${running.nexo.port}`)
  logger.print(`  ${sym.ok} Voice         LiveKit ready on ports ${cfg.ports.livekit}${sym.range}${cfg.ports.livekitUdp}`)

  if (plan.mapPorts && !loopbackOnly) {
    if (probe.gateway.device) {
      const ports = defaultPorts({
        http: cfg.ports.http,
        livekitSignal: cfg.ports.livekit,
        livekitTcp: cfg.ports.livekitTcp,
        livekitUdp: cfg.ports.livekitUdp,
      })
      mapping = await mapPorts(probe.gateway.device, ports, { description: 'Nexo Server' })
      mapping.startAutoRenew()
      if (mapping.allMapped) logger.print(`  ${sym.ok} Router        opened the ports automatically (UPnP)`)
      else {
        const bad = mapping.results.filter((r) => r.status !== 'mapped')
        logger.print(`  ${sym.warn} Router        could not open ${bad.map((r) => `${r.externalPort}/${r.protocol}`).join(', ')}`)
      }
    } else {
      logger.print(`  ${sym.warn} Router        automatic port forwarding (UPnP) is not available`)
    }
  }
  if (probe.reachability === 'public' && probe.stunIp) logger.print(`  ${sym.ok} Public address ${probe.stunIp}`)
  if (probe.reachability === 'cgnat') {
    logger.print(`  ${sym.warn} Your internet provider doesn't let friends connect to you directly (CGNAT).`)
    logger.print(`    Use Tailscale instead: see "Tailscale" in the server guide (docs/SERVER.md).`)
  }

  logger.print('')
  for (const line of renderInvite(inviteFromProbe(probe, cfg), { ascii, width: columns })) logger.print(line)
  logger.print('')
  logger.print('  Keep this window open while you play. Press Ctrl+C to stop.')
  logger.print('')

  // Live status: printed when it changes; also written to the lock file for `nexo-server status`.
  let last = ''
  let friendFromOutside = false
  const tick = () => {
    if (!running || shuttingDown) return
    const s = running.nexo.stats()
    const live = { online: s.online, inVoice: s.inVoice, streaming: s.streaming }
    lock.update({ stats: { ...live, updatedAt: new Date().toISOString() } })
    const line = statusLine(live, { ascii })
    if (line !== last) {
      last = line
      logger.print(`  ${line}`)
    }
    if (!friendFromOutside && s.clientAddresses.some(isOutsideAddress)) {
      friendFromOutside = true
      logger.print(`  ${sym.ok} A friend connected from outside your network.`)
    }
  }
  statusTimer = setInterval(tick, 3000)
  statusTimer.unref()
  tick()
}

// Bundle (nexo-server.exe / nexo-server.cjs): esbuild defines import.meta.main as true. Dev: `node src/main.ts`.
if (import.meta.main) void main()
