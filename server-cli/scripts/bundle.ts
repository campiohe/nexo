// Bundles src/main.ts (+ the server sources it imports from ../../server/src and ../../shared) and all npm
// dependencies into ONE CommonJS file: dist/nexo-server.cjs.
//
// Why CommonJS: on Node 24 a single executable application's main script must be CommonJS (ESM entry
// points are only supported from Node 25.x). Inside a SEA, `require()` can only load builtins, so every
// dependency must be inside the bundle; `node:*` builtins (node:sqlite, node:sea…) stay external.
//
// Usage: node scripts/bundle.ts        (or: npm run build -w server-cli)
import { build } from 'esbuild'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { DIST_DIR, PKG_DIR } from './fetch.ts'

const PKG_VERSION: string = JSON.parse(readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version

export const BUNDLE = path.join(DIST_DIR, 'nexo-server.cjs')

export async function bundle(): Promise<string> {
  mkdirSync(DIST_DIR, { recursive: true })
  const result = await build({
    entryPoints: [path.join(PKG_DIR, 'src', 'main.ts')],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node', // builtins (fs, node:sqlite, …) are external automatically
    format: 'cjs',
    target: 'node24',
    // ws (used by engine.io) optionally requires these native addons inside try/catch and falls back to
    // pure JS when they're missing. No native modules in a SEA: leave them unresolved (the require throws,
    // ws catches it).
    external: ['bufferutil', 'utf-8-validate'],
    // main.ts runs main() only when it's the entry module (`import.meta.main`); in the bundle it always is.
    // The version printed by `nexo-server --version` and stored in the lock file: this package's version
    // (kept equal to the app's by the release process).
    define: { 'import.meta.main': 'true', __NEXO_SERVER_VERSION__: JSON.stringify(PKG_VERSION) },
    logLevel: 'warning',
    legalComments: 'eof',
    metafile: true,
  })
  const inputs = Object.keys(result.metafile.inputs).length
  console.log(`bundle: ${path.relative(PKG_DIR, BUNDLE)} (${(statSync(BUNDLE).size / 1e6).toFixed(2)} MB, ${inputs} modules)`)
  return BUNDLE
}

if (import.meta.main) await bundle()
