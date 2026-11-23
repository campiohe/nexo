// Minimal .zip reading for the emulator's file handling (engine.ts): list a zip's files by reading only its
// central directory (the end of the file: a big zip is never read whole just to see what's inside), and extract
// one entry (stored / deflate, via the browser's DecompressionStream). Zip64 and encrypted entries aren't
// supported (game zips never need them). The SNES engine reads its zips itself (engine/rom.ts).
import { EmulatorError } from './types'
import { msg, t } from '../i18n'

export interface ZipEntry {
  name: string
  /** Uncompressed size (from the directory). */
  size: number
  compressed: number
  method: number
  flags: number
  /** Offset of the entry's local header. */
  local: number
}

const CORRUPT_ZIP = msg('This .zip file is damaged or uses an unsupported format')
const EOCD_SIG = 0x06054b50
const CDIR_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
/** End of central directory record (22 bytes) + the longest possible comment. */
const TAIL_BYTES = 22 + 0xffff

export function isZipName(name: string): boolean {
  return /\.zip$/i.test(name)
}

export function isZipBytes(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
}

/** The files in a .zip (directories left out), reading only the end of the file and its central directory. */
export async function listZip(file: Blob): Promise<ZipEntry[]> {
  const size = file.size
  const tailStart = Math.max(0, size - TAIL_BYTES)
  const tail = new Uint8Array(await file.slice(tailStart, size).arrayBuffer())
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new EmulatorError(t(CORRUPT_ZIP))
  const count = dv.getUint16(eocd + 10, true)
  const dirSize = dv.getUint32(eocd + 12, true)
  const dirOffset = dv.getUint32(eocd + 16, true)
  if (dirOffset + dirSize > size) throw new EmulatorError(t(CORRUPT_ZIP))
  const dir = new Uint8Array(await file.slice(dirOffset, dirOffset + dirSize).arrayBuffer())
  return parseDirectory(dir, count)
}

function parseDirectory(dir: Uint8Array, count: number): ZipEntry[] {
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  let p = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.length || dv.getUint32(p, true) !== CDIR_SIG) throw new EmulatorError(t(CORRUPT_ZIP))
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const name = decoder.decode(dir.subarray(p + 46, p + 46 + nameLen))
    if (!name.endsWith('/')) {
      entries.push({
        name,
        flags: dv.getUint16(p + 8, true),
        method: dv.getUint16(p + 10, true),
        compressed: dv.getUint32(p + 20, true),
        size: dv.getUint32(p + 24, true),
        local: dv.getUint32(p + 42, true),
      })
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** The entries of a zip already in memory. */
export function listZipBytes(zip: Uint8Array): ZipEntry[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - TAIL_BYTES); i--) {
    if (dv.getUint32(i, true) !== EOCD_SIG) continue
    const count = dv.getUint16(i + 10, true)
    const dirSize = dv.getUint32(i + 12, true)
    const dirOffset = dv.getUint32(i + 16, true)
    if (dirOffset + dirSize > zip.length) break
    return parseDirectory(zip.subarray(dirOffset, dirOffset + dirSize), count)
  }
  throw new EmulatorError(t(CORRUPT_ZIP))
}

/** Base name of an entry ("roms/Game.z64" → "Game.z64"). */
export function baseName(name: string): string {
  const i = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return i >= 0 ? name.slice(i + 1) : name
}

/** One entry's bytes, never more than `maxBytes` (a lying directory can't balloon memory). */
export async function extractZipEntry(zip: Uint8Array, entry: ZipEntry, maxBytes: number, tooBig: string): Promise<Uint8Array> {
  if (entry.size > maxBytes) throw new EmulatorError(tooBig)
  if (entry.flags & 1) throw new EmulatorError(t('This .zip file is password-protected'))
  if (entry.method !== 0 && entry.method !== 8) throw new EmulatorError(t(CORRUPT_ZIP))
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const l = entry.local
  if (l + 30 > zip.length || dv.getUint32(l, true) !== LOCAL_SIG) throw new EmulatorError(t(CORRUPT_ZIP))
  const start = l + 30 + dv.getUint16(l + 26, true) + dv.getUint16(l + 28, true)
  const end = start + entry.compressed
  if (end > zip.length) throw new EmulatorError(t(CORRUPT_ZIP))
  const data = zip.subarray(start, end)
  if (entry.method === 0) {
    if (data.length !== entry.size) throw new EmulatorError(t(CORRUPT_ZIP))
    return data.slice()
  }
  const out = new Uint8Array(entry.size)
  let filled = 0
  const reader = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (filled + value.length > out.length) throw new Error('larger than announced')
      out.set(value, filled)
      filled += value.length
    }
  } catch {
    void reader.cancel().catch(() => {})
    throw new EmulatorError(t(CORRUPT_ZIP))
  }
  if (filled !== out.length) throw new EmulatorError(t(CORRUPT_ZIP))
  return out
}
