// The CLI's config file, <data>/config.json (docs/SPEC-SERVER-CLI.md §4, decision C5).
//
// Written by setup, read on every start. Real environment variables with today's names (.env.example)
// override it, so a `.env`-based host can switch to the CLI without changes. The LiveKit secret is
// generated once and never printed.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, type Config } from '../../../server/src/config.ts'
import { dataLayout } from './paths.ts'

export const CONFIG_VERSION = 1

export const NETWORK_MODES = ['auto', 'tailscale', 'public', 'lan'] as const
export type NetworkMode = (typeof NETWORK_MODES)[number]

export interface ServerCliConfig {
  /** Schema version, for migrations. */
  version: number
  serverName: string
  /** Empty = no password for new identities. */
  serverPassword: string
  ports: {
    /** Nexo server, http + socket.io (TCP). */
    http: number
    /** LiveKit signaling (TCP). */
    livekit: number
    /** LiveKit ICE/TCP fallback (TCP). */
    livekitTcp: number
    /** LiveKit media, single port (UDP). */
    livekitUdp: number
  }
  livekit: {
    apiKey: string
    /** Secret: never print it. */
    apiSecret: string
  }
  network: {
    mode: NetworkMode
  }
}

export const DEFAULT_PORTS: ServerCliConfig['ports'] = { http: 3001, livekit: 7880, livekitTcp: 7881, livekitUdp: 7882 }
export const DEFAULT_SERVER_NAME = 'Nexo'
export const SERVER_NAME_MAX = 64 // server/src/config.ts slices SERVER_NAME to 64
export const SERVER_PASSWORD_MAX = 128
export const LIVEKIT_SECRET_MIN = 32 // LiveKit rejects shorter secrets

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** LiveKit API key: an identifier, not a secret. */
export function generateApiKey(): string {
  return 'nexo'
}

/** LiveKit API secret: 32 random bytes as 64 hex chars. */
export function generateApiSecret(): string {
  return randomBytes(32).toString('hex')
}

/** A fresh config with defaults and newly generated LiveKit keys. */
export function createDefaultConfig(overrides: Partial<Pick<ServerCliConfig, 'serverName' | 'serverPassword'>> = {}): ServerCliConfig {
  return {
    version: CONFIG_VERSION,
    serverName: overrides.serverName ?? DEFAULT_SERVER_NAME,
    serverPassword: overrides.serverPassword ?? '',
    ports: { ...DEFAULT_PORTS },
    livekit: { apiKey: generateApiKey(), apiSecret: generateApiSecret() },
    network: { mode: 'auto' },
  }
}

// ---------- validation ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535

/** Problems with a config as plain sentences; empty when valid. */
export function validateConfig(value: unknown): string[] {
  if (!isObj(value)) return ['the file must contain a JSON object']
  const errors: string[] = []
  const c = value
  if (c.version !== CONFIG_VERSION) errors.push(`"version" must be ${CONFIG_VERSION}`)
  if (typeof c.serverName !== 'string' || !c.serverName.trim()) errors.push('"serverName" must be a non-empty text')
  else if (c.serverName.trim().length > SERVER_NAME_MAX) errors.push(`"serverName" must be at most ${SERVER_NAME_MAX} characters`)
  if (typeof c.serverPassword !== 'string') errors.push('"serverPassword" must be a text ("" for no password)')
  else if (c.serverPassword.length > SERVER_PASSWORD_MAX) errors.push(`"serverPassword" must be at most ${SERVER_PASSWORD_MAX} characters`)

  if (!isObj(c.ports)) errors.push('"ports" must be an object')
  else {
    const ports = c.ports
    const keys = Object.keys(DEFAULT_PORTS) as (keyof ServerCliConfig['ports'])[]
    for (const k of keys) if (!isPort(ports[k])) errors.push(`"ports.${k}" must be a port number (1-65535)`)
    // 7882 is UDP, so it could share a number with a TCP port, but keeping all four distinct is simpler to explain.
    const nums = keys.map((k) => ports[k]).filter(isPort)
    if (nums.length === keys.length && new Set(nums).size !== nums.length) errors.push('"ports" must all be different')
  }

  if (!isObj(c.livekit)) errors.push('"livekit" must be an object')
  else {
    const { apiKey, apiSecret } = c.livekit
    if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(apiKey)) {
      errors.push('"livekit.apiKey" must be 1-64 letters, digits, _ or -')
    }
    if (typeof apiSecret !== 'string' || apiSecret.length < LIVEKIT_SECRET_MIN || /\s/.test(apiSecret)) {
      errors.push(`"livekit.apiSecret" must be at least ${LIVEKIT_SECRET_MIN} characters without spaces`)
    }
  }

  if (!isObj(c.network) || !NETWORK_MODES.includes(c.network.mode as NetworkMode)) {
    errors.push(`"network.mode" must be one of ${NETWORK_MODES.join(', ')}`)
  }
  return errors
}

/**
 * Brings an older config up to CONFIG_VERSION. Version 1 is the first, so there's nothing to do yet;
 * a newer version (written by a newer nexo-server) is refused instead of being silently downgraded.
 */
function migrate(raw: Record<string, unknown>, file: string): Record<string, unknown> {
  if (typeof raw.version === 'number' && raw.version > CONFIG_VERSION) {
    throw new ConfigError(`${file} was written by a newer version of Nexo Server (config version ${raw.version}). Update nexo-server.`)
  }
  return raw
}

// ---------- load / save ----------

/** Reads and validates `<data>/config.json`. Returns null when it doesn't exist (first run). */
export function loadCliConfig(dataDir: string): ServerCliConfig | null {
  const file = dataLayout(dataDir).config
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ConfigError(`Can't read ${file}: ${(err as Error).message}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^﻿/, '')) // tolerate a BOM from Notepad
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON (${(err as Error).message}). Fix it, or delete it and run "nexo-server setup".`)
  }
  if (!isObj(raw)) throw new ConfigError(`${file} must contain a JSON object. Delete it and run "nexo-server setup".`)
  const migrated = migrate(raw, file)
  const errors = validateConfig(migrated)
  if (errors.length) {
    throw new ConfigError(`${file} has problems:\n${errors.map((e) => `  - ${e}`).join('\n')}\nFix them, or run "nexo-server setup".`)
  }
  const c = migrated as unknown as ServerCliConfig
  return { ...c, serverName: c.serverName.trim() }
}

/**
 * Validates and writes `<data>/config.json` atomically (temp file + rename), readable only by the
 * current user where the OS supports file modes (POSIX 0600; on Windows the per-user AppData folder
 * already restricts access).
 */
export function saveCliConfig(dataDir: string, config: ServerCliConfig): void {
  const errors = validateConfig(config)
  if (errors.length) throw new ConfigError(`Invalid config:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
  const file = dataLayout(dataDir).config
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dataDir, `.config.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const ordered: ServerCliConfig = {
    version: config.version,
    serverName: config.serverName,
    serverPassword: config.serverPassword,
    ports: { ...config.ports },
    livekit: { ...config.livekit },
    network: { ...config.network },
  }
  try {
    writeFileSync(tmp, JSON.stringify(ordered, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

// ---------- environment overrides ----------

/**
 * Environment variables (today's names, .env.example) that override config.json. A variable counts only
 * when it is set to a non-empty value, the same rule the server's loadConfig uses (empty = unset).
 */
export const ENV_OVERRIDES = [
  'PORT',
  'SERVER_NAME',
  'SERVER_PASSWORD',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_PORT',
] as const

/** Passed straight to the server when set; config.json has no equivalent. */
const ENV_PASSTHROUGH = ['HOST', 'LIVEKIT_PUBLIC_URL'] as const

const envSet = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const v = env[name]
  return v !== undefined && v.trim() !== '' ? v : undefined
}

function envPort(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = envSet(env, name)
  if (v === undefined) return fallback
  const n = Number(v)
  if (!isPort(n)) throw new ConfigError(`Environment variable ${name} must be a port number (1-65535), got "${v}"`)
  return n
}

export interface EffectiveConfig {
  config: ServerCliConfig
  /** Names of the environment variables that replaced a config.json value (for a startup note). */
  overriddenBy: string[]
}

/**
 * config.json with the environment applied. Use this everywhere a value is needed at run time
 * (server env, livekit.yaml, invite), so the server and LiveKit always agree on keys and ports.
 */
export function applyEnvOverrides(config: ServerCliConfig, env: NodeJS.ProcessEnv = process.env): EffectiveConfig {
  const overriddenBy = ENV_OVERRIDES.filter((n) => envSet(env, n) !== undefined)
  const name = envSet(env, 'SERVER_NAME')
  const effective: ServerCliConfig = {
    ...config,
    serverName: name !== undefined ? name.trim().slice(0, SERVER_NAME_MAX) || DEFAULT_SERVER_NAME : config.serverName,
    serverPassword: envSet(env, 'SERVER_PASSWORD') ?? config.serverPassword,
    ports: {
      ...config.ports,
      http: envPort(env, 'PORT', config.ports.http),
      livekit: envPort(env, 'LIVEKIT_PORT', config.ports.livekit),
    },
    livekit: {
      apiKey: envSet(env, 'LIVEKIT_API_KEY') ?? config.livekit.apiKey,
      apiSecret: envSet(env, 'LIVEKIT_API_SECRET') ?? config.livekit.apiSecret,
    },
    network: { ...config.network },
  }
  return { config: effective, overriddenBy }
}

/**
 * The environment the server's `loadConfig(env)` expects (server/src/config.ts), built from config.json
 * with real environment variables taking precedence. DATA_DIR is always the data folder (resolveDataDir
 * already honoured a DATA_DIR env var).
 */
export function toServerEnv(config: ServerCliConfig, dataDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const { config: c } = applyEnvOverrides(config, env)
  const out: Record<string, string> = {
    PORT: String(c.ports.http),
    SERVER_NAME: c.serverName,
    SERVER_PASSWORD: c.serverPassword,
    DATA_DIR: dataDir,
    LIVEKIT_API_KEY: c.livekit.apiKey,
    LIVEKIT_API_SECRET: c.livekit.apiSecret,
    LIVEKIT_PORT: String(c.ports.livekit),
  }
  for (const n of ENV_PASSTHROUGH) {
    const v = envSet(env, n)
    if (v !== undefined) out[n] = v
  }
  return out
}

/** The server's own Config (pass it to `start(config)` from server/src/server.ts). */
export function toServerConfig(config: ServerCliConfig, dataDir: string, env: NodeJS.ProcessEnv = process.env): Config {
  return loadConfig(toServerEnv(config, dataDir, env))
}

/** The config as safe-to-print JSON: the LiveKit secret is replaced, the password kept (spec §9). */
export function describeConfig(config: ServerCliConfig): string {
  return JSON.stringify({ ...config, livekit: { ...config.livekit, apiSecret: '(hidden)' } }, null, 2)
}
