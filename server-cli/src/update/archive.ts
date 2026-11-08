// Reading the update download with Node builtins only: the `.sha256` file, the Windows zip and the
// Linux tar.gz. Minimal readers for archives our own release workflow builds (no zip64, no encryption).
import { createHash } from 'node:crypto'
import path from 'node:path'
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib'

export const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/**
 * The hash from a checksum file in `sha256sum` format: `<64 hex>  <file name>` (or `<hex> *<name>`, or just
 * the hex). When the line names a file, it must be `fileName`. Throws on anything else.
 */
export function parseSha256File(text: string, fileName?: string): string {
  const line = text.replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim() !== '')
  const m = line ? /^\s*([0-9a-fA-F]{64})(?:\s+\*?(.+?))?\s*$/.exec(line) : null
  if (!m) throw new Error('the checksum file is not in the "<sha256>  <file name>" format')
  const named = m[2]
  if (fileName && named && path.posix.basename(named.replace(/\\/g, '/')) !== fileName) {
    throw new Error(`the checksum file is for "${named}", not "${fileName}"`)
  }
  return m[1]!.toLowerCase()
}

export interface ArchiveEntry {
  /** Path inside the archive (forward slashes). */
  name: string
  data: Buffer
  /** Unix permission bits when the archive has them (tar). */
  mode?: number
}

/**
 * Extracts the entries whose base name is in `wanted` from a zip (central directory → local header →
 * stored or deflated data, CRC-32 checked). Entries not asked for are skipped without inflating.
 */
export function extractZip(zip: Buffer, wanted: readonly string[]): ArchiveEntry[] {
  const want = new Set(wanted)
  if (zip.length < 22) throw new Error('not a zip file')
  // End of central directory record: within the last 64 KiB (+ its 22 bytes).
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file')
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 archives are not supported')
  const out: ArchiveEntry[] = []
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip (central directory)')
    const flags = zip.readUInt16LE(p + 8)
    const method = zip.readUInt16LE(p + 10)
    const crc = zip.readUInt32LE(p + 16)
    const compressedSize = zip.readUInt32LE(p + 20)
    const size = zip.readUInt32LE(p + 24)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const localOffset = zip.readUInt32LE(p + 42)
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/')
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/') || !want.has(path.posix.basename(name))) continue
    if (flags & 1) throw new Error(`${name} is encrypted`)
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`corrupt zip (${name})`)
    const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28)
    if (start + compressedSize > zip.length) throw new Error(`corrupt zip (${name} is cut short)`)
    const raw = zip.subarray(start, start + compressedSize)
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null
    if (!data) throw new Error(`${name} uses an unsupported compression method (${method})`)
    if (data.length !== size || crc32(data) !== crc) throw new Error(`${name} is corrupt (size or CRC mismatch)`)
    out.push({ name, data })
  }
  return out
}

const tarString = (b: Buffer, start: number, len: number) => {
  const end = b.indexOf(0, start)
  return b.toString('utf8', start, end < 0 || end > start + len ? start + len : end)
}
const tarOctal = (b: Buffer, start: number, len: number) => parseInt(tarString(b, start, len).trim() || '0', 8)

/** Extracts regular files whose base name is in `wanted` from a .tar.gz (ustar + GNU long names). */
export function extractTarGz(tgz: Buffer, wanted: readonly string[]): ArchiveEntry[] {
  const want = new Set(wanted)
  const tar = gunzipSync(tgz)
  const out: ArchiveEntry[] = []
  let longName: string | null = null
  for (let p = 0; p + 512 <= tar.length; ) {
    const header = tar.subarray(p, p + 512)
    if (header.every((b) => b === 0)) break // end of archive
    const size = tarOctal(header, 124, 12)
    const type = String.fromCharCode(header[156] || 48) // '\0' = regular file
    const prefix = header.toString('utf8', 257, 263).startsWith('ustar') ? tarString(header, 345, 155) : ''
    const name = longName ?? (prefix ? `${prefix}/` : '') + tarString(header, 0, 100)
    longName = null
    const dataStart = p + 512
    if (!Number.isFinite(size) || dataStart + size > tar.length) throw new Error('corrupt tar archive')
    const data = tar.subarray(dataStart, dataStart + size)
    if (type === 'L') longName = data.toString('utf8').replace(/\0+$/, '')
    else if ((type === '0' || type === '\0') && want.has(path.posix.basename(name))) {
      out.push({ name, data: Buffer.from(data), mode: tarOctal(header, 100, 8) & 0o777 })
    }
    p = dataStart + Math.ceil(size / 512) * 512
  }
  return out
}
