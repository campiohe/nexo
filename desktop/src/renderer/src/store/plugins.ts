// Built-in plugins the server's admins turned on (docs/SPEC.md "Plugins"): from bootstrap, kept current by
// `plugins:changed` (net/socket.ts). Session state: reset on server change / sign out (resetPlugins).
// No imports from store/app or net/socket (net/socket imports this module; see store/sounds.ts).
import { create } from 'zustand'
import { DEFAULT_PLUGINS, type ServerPlugins } from '@shared/protocol'

interface PluginsState {
  /** False until a bootstrap with `plugins` (older servers have none: everything stays off). */
  supported: boolean
  plugins: ServerPlugins
}

export const usePlugins = create<PluginsState>()(() => ({ supported: false, plugins: DEFAULT_PLUGINS }))

/** Unknown keys dropped, missing / non-boolean ones = DEFAULT_PLUGINS. */
function normalize(p: unknown): ServerPlugins {
  const raw = p && typeof p === 'object' ? (p as Record<string, unknown>) : {}
  const out = { ...DEFAULT_PLUGINS }
  for (const key of Object.keys(DEFAULT_PLUGINS) as (keyof ServerPlugins)[]) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key] as boolean
  }
  return out
}

export function setBootstrapPlugins(p: ServerPlugins | undefined): void {
  usePlugins.setState({ supported: !!p && typeof p === 'object', plugins: normalize(p) })
}

/** `plugins:changed`, or the ack of `plugins:set`. */
export function applyPlugins(p: ServerPlugins): void {
  if (!p || typeof p !== 'object') return
  usePlugins.setState({ supported: true, plugins: normalize(p) })
}

/** Another server, or signed out (store/app.ts, net/socket.ts, store/signin.ts). */
export function resetPlugins(): void {
  usePlugins.setState({ supported: false, plugins: DEFAULT_PLUGINS })
}
