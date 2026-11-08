// Build helpers: read a pinned lock file, download + cache + verify an archive, extract one zip entry.
// Only used at build time (never bundled). Downloads land in server-cli/.cache/ (gitignored) and are
// re-verified against the lock's SHA-256 on every build, so a corrupted or tampered cache fails loudly.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CACHE_DIR = path.join(PKG_DIR, '.cache')
export const DIST_DIR = path.join(PKG_DIR, 'dist')

export interface LockedFile {
  url: string
  sha256: string
  /** For archives: the entry to extract. */
  binary?: string
}

export interface Lock {
  version: string
  files: Record<string, LockedFile>
}

/** Reads scripts/<name>.lock and returns the entry for `target` (e.g. "win-x64"). */
export function readLock(name: 'node' | 'livekit', target: string): { version: string; file: LockedFile } {
  const lock = JSON.parse(readFileSync(path.join(PKG_DIR, 'scripts', `${name}.lock`), 'utf8')) as Lock
  const file = lock.files[target]
  if (!file) throw new Error(`scripts/${name}.lock has no entry for ${target}`)
  if (!/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error(`scripts/${name}.lock: bad sha256 for ${target}`)
  return { version: lock.version, file }
}

const sha256 = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex')

/**
 * Returns the path of the cached download for `file`, downloading it first if needed.
 * The cache key is the SHA-256, so bumping a lock never reuses a stale file.
 */
export async function fetchPinned(file: LockedFile, log: (msg: string) => void = console.log): Promise<string> {
  const name = path.basename(new URL(file.url).pathname)
  const dir = path.join(CACHE_DIR, file.sha256.slice(0, 16))
  const dest = path.join(dir, name)
  if (existsSync(dest)) {
    if (sha256(readFileSync(dest)) === file.sha256) return dest
    log(`cache: ${dest} does not match its pinned SHA-256, downloading again`)
    rmSync(dest)
  }
  mkdirSync(dir, { recursive: true })
  log(`download: ${file.url}`)
  const res = await fetch(file.url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} (${file.url})`)
  const body = new Uint8Array(await res.arrayBuffer())
  const actual = sha256(body)
  if (actual !== file.sha256) {
    throw new Error(`SHA-256 mismatch for ${file.url}\n  expected ${file.sha256}\n  got      ${actual}`)
  }
  const tmp = `${dest}.partial`
  writeFileSync(tmp, body)
  renameSync(tmp, dest)
  log(`download: ok (${(body.length / 1e6).toFixed(1)} MB, sha256 verified)`)
  return dest
}

/**
 * Extracts one entry (matched by its base name) from a zip file. Minimal reader for the archives we pin:
 * central directory → local header → stored (0) or deflated (8) data. No zip64, no encryption.
 * Returns null when no entry has that name.
 */
export function extractZipEntry(zipPath: string, entryName: string): Buffer | null {
  const zip = readFileSync(zipPath)
  // End of central directory record: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error(`${zipPath}: not a zip file`)
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error(`${zipPath}: corrupt central directory`)
    const method = zip.readUInt16LE(p + 10)
    const compressedSize = zip.readUInt32LE(p + 20)
    const size = zip.readUInt32LE(p + 24)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const localOffset = zip.readUInt32LE(p + 42)
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (path.posix.basename(name) !== entryName) continue
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${zipPath}: corrupt local header`)
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28)
    const raw = zip.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null
    if (!data) throw new Error(`${zipPath}: ${name} uses unsupported compression method ${method}`)
    if (data.length !== size) throw new Error(`${zipPath}: ${name} size mismatch`)
    return data
  }
  return null
}
