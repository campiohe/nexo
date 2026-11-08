// Builds the Windows x64 server: dist/win-x64/{nexo-server.exe, livekit-server.exe, livekit-LICENSE.txt}.
//
// Steps (Node single executable application, https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html):
//  1. Bundle src/main.ts into one CommonJS file (scripts/bundle.ts).
//  2. Fetch the pinned official Node 24 LTS win-x64 node.exe (scripts/node.lock; cached in .cache/, SHA-256 checked).
//  3. Write sea-config.json and generate the SEA preparation blob with `node --experimental-sea-config`.
//     The blob must come from a Node of the SAME version as the exe it's injected into, so we run the pinned
//     node.exe itself: natively on Windows, or through WSL interop (paths converted with `wslpath -w`).
//     Elsewhere (e.g. Linux CI) a host Node of exactly the pinned version is used: with useCodeCache and
//     useSnapshot off the blob is platform-independent.
//  4. Copy node.exe to dist/win-x64/nexo-server.exe, strip its Authenticode signature (it would be invalid
//     after injection; a cleanly unsigned exe beats a corrupted signature, also for antivirus heuristics, spec
//     R2; Node's docs do the same with `signtool remove /s`), then inject the blob as the NODE_SEA_BLOB resource
//     with postject, flipping the NODE_SEA_FUSE sentinel.
//  5. Fetch the pinned LiveKit Windows zip (scripts/livekit.lock) and extract livekit-server.exe + its LICENSE.
//
// Usage: node scripts/build-win.ts       (or: npm run build:win -w server-cli)
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import path from 'node:path'
import { inject } from 'postject'
import { bundle } from './bundle.ts'
import { DIST_DIR, PKG_DIR, extractZipEntry, fetchPinned, readLock } from './fetch.ts'

const TARGET = 'win-x64'
const OUT_DIR = path.join(DIST_DIR, TARGET)
const WORK_DIR = path.join(DIST_DIR, `${TARGET}-sea`) // intermediate files (sea-config.json, blob)
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

const isWsl = process.platform === 'linux' && /microsoft/i.test(release())
const mb = (file: string) => `${(statSync(file).size / 1e6).toFixed(1)} MB`

/** Path as the Windows node.exe sees it. */
function forWindows(p: string): string {
  if (process.platform === 'win32') return p
  return execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim()
}

/**
 * Removes the Authenticode signature from a PE32+ file: clears the Security data directory entry and drops the
 * certificate table, which the Windows signing format always appends at the end of the file.
 */
function stripSignature(pe: Buffer): Buffer {
  const header = pe.readUInt32LE(0x3c)
  if (pe.readUInt32LE(header) !== 0x00004550) throw new Error('not a PE file')
  const opt = header + 24 // PE signature (4) + COFF file header (20)
  if (pe.readUInt16LE(opt) !== 0x20b) throw new Error('not a PE32+ (64-bit) file')
  const securityDir = opt + 112 + 4 * 8 // data directories start at +112 in PE32+; Security is entry #4
  const offset = pe.readUInt32LE(securityDir)
  const size = pe.readUInt32LE(securityDir + 4)
  if (offset === 0 || size === 0) return pe
  if (offset + size !== pe.length) throw new Error('certificate table is not at the end of the file')
  const out = Buffer.from(pe.subarray(0, offset))
  out.writeUInt32LE(0, securityDir)
  out.writeUInt32LE(0, securityDir + 4)
  out.writeUInt32LE(0, opt + 64) // PE checksum: not checked for user-mode exes; 0 = not set
  return out
}

async function main() {
  // 1. bundle
  const bundlePath = await bundle()

  // 2. pinned Node
  const node = readLock('node', TARGET)
  const nodeExe = await fetchPinned(node.file)
  console.log(`node: v${node.version} win-x64 (${nodeExe})`)

  // 3. SEA blob
  rmSync(WORK_DIR, { recursive: true, force: true })
  mkdirSync(WORK_DIR, { recursive: true })
  const blobPath = path.join(WORK_DIR, 'sea-prep.blob')
  const configPath = path.join(WORK_DIR, 'sea-config.json')
  const canRunWindowsNode = process.platform === 'win32' || isWsl
  const generator = canRunWindowsNode ? nodeExe : process.execPath
  if (!canRunWindowsNode && process.version !== `v${node.version}`) {
    throw new Error(`SEA blob needs Node v${node.version} (this is ${process.version}); run on Windows/WSL or with that Node version`)
  }
  const p = canRunWindowsNode ? forWindows : (x: string) => x
  const seaConfig = {
    main: p(bundlePath),
    output: p(blobPath),
    disableExperimentalSEAWarning: true,
    // Off: keeps the blob platform-independent and reproducible (start-up cost measured in S0 is small).
    useSnapshot: false,
    useCodeCache: false,
  }
  writeFileSync(configPath, `${JSON.stringify(seaConfig, null, 2)}\n`)
  if (generator === nodeExe && process.platform !== 'win32') execFileSync('chmod', ['+x', nodeExe])
  execFileSync(generator, ['--experimental-sea-config', p(configPath)], { stdio: 'inherit' })
  console.log(`sea: blob ${mb(blobPath)}`)

  // 4. inject into a copy of node.exe
  mkdirSync(OUT_DIR, { recursive: true })
  const exe = path.join(OUT_DIR, 'nexo-server.exe')
  rmSync(exe, { force: true })
  writeFileSync(exe, stripSignature(readFileSync(nodeExe)), { mode: 0o755 })
  await inject(exe, 'NODE_SEA_BLOB', readFileSync(blobPath), { sentinelFuse: SEA_FUSE })
  console.log(`sea: ${path.relative(PKG_DIR, exe)} (${mb(exe)})`)

  // 5. LiveKit
  const lk = readLock('livekit', TARGET)
  const zip = await fetchPinned(lk.file)
  const binary = lk.file.binary ?? 'livekit-server.exe'
  const lkExe = extractZipEntry(zip, binary)
  if (!lkExe) throw new Error(`${zip} has no ${binary}`)
  writeFileSync(path.join(OUT_DIR, binary), lkExe, { mode: 0o755 })
  const license = extractZipEntry(zip, 'LICENSE')
  if (license) writeFileSync(path.join(OUT_DIR, 'livekit-LICENSE.txt'), license)
  console.log(`livekit: v${lk.version} ${path.relative(PKG_DIR, path.join(OUT_DIR, binary))} (${(lkExe.length / 1e6).toFixed(1)} MB)`)

  rmSync(WORK_DIR, { recursive: true, force: true })
  console.log(`done: ${path.relative(process.cwd(), OUT_DIR) || '.'}`)
}

await main()
