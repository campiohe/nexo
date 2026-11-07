import path from 'node:path'

export interface Config {
  /** TCP port for http + socket.io. 0 = pick a free port (tests). */
  port: number
  /** Interface to bind. Default: all interfaces. */
  host: string
  serverName: string
  /** Empty = no password required for new identities. */
  serverPassword: string
  /** Directory holding nexo.db. */
  dataDir: string
  livekit: {
    apiKey: string
    apiSecret: string
    /** URL clients use to reach LiveKit. Empty = derive from the host the client used to reach us. */
    publicUrl: string
    /** LiveKit signaling port, used when deriving the public URL. */
    port: number
  }
}

const DEV_SECRET = 'secret'

function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`[nexo] ${name} must be a port number, got "${value}"`)
  return n
}

/** Reads configuration from environment variables (see .env.example). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parsePort(env.PORT, 3001, 'PORT'),
    host: env.HOST || '0.0.0.0',
    serverName: (env.SERVER_NAME || 'Nexo').trim().slice(0, 64) || 'Nexo',
    serverPassword: env.SERVER_PASSWORD || '',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    livekit: {
      apiKey: env.LIVEKIT_API_KEY || 'devkey',
      apiSecret: env.LIVEKIT_API_SECRET || DEV_SECRET,
      publicUrl: (env.LIVEKIT_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
      port: parsePort(env.LIVEKIT_PORT, 7880, 'LIVEKIT_PORT'),
    },
  }
}

/** Human-readable warnings about a config that will probably not work. */
export function configWarnings(config: Config): string[] {
  const warnings: string[] = []
  if (config.livekit.apiSecret === DEV_SECRET) {
    warnings.push('LIVEKIT_API_SECRET is not set; using the LiveKit dev secret. Voice will not work against the Docker LiveKit. See .env.example')
  } else if (config.livekit.apiSecret.length < 32) {
    warnings.push('LIVEKIT_API_SECRET is shorter than 32 chars; LiveKit will reject it. See .env.example')
  }
  if (config.livekit.publicUrl && !/^wss?:\/\//.test(config.livekit.publicUrl)) {
    warnings.push(`LIVEKIT_PUBLIC_URL should start with ws:// or wss:// (got "${config.livekit.publicUrl}")`)
  }
  return warnings
}
