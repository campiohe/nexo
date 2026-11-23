// Turns the host's file into N64 ROM bytes, or a readable EmulatorError: size caps, .zip extraction (stored /
// deflate, via the browser's DecompressionStream) and a check of the cartridge's first word, which also tells the
// three byte orders apart (.z64 big-endian, .v64 byte-swapped, .n64 little-endian: the core handles all three).
// The zip reader is a copy of ../rom.ts's (that one is specific to SNES files).
import { EmulatorError } from '../../types'

/** The biggest N64 cartridges are 64 MB. */
export const MAX_N64_ROM_BYTES = 64 * 1024 * 1024
/** Largest file the host may load (a zipped 64 MB ROM is smaller; leaves room for an odd archive). */
const MAX_FILE_BYTES = MAX_N64_ROM_BYTES + 16 * 1024 * 1024
/** Smallest plausible ROM: the header + boot code (4 KB) and some program (homebrew can be tiny). */
const MIN_ROM_BYTES = 0x2000
const ROM_NAME = /\.(z64|n64|v64)$/i

const TOO_BIG = 'This file is too big to be a Nintendo 64 game'
const NOT_N64 = "This file isn't a Nintendo 64 game"
const CORRUPT_ZIP = 'This .zip file is damaged or uses an unsupported format'

/** The first word of a cartridge (PI timing settings) in each byte order. */
const MAGICS = [
  [0x80, 0x37, 0x12, 0x40], // .z64
  [0x37, 0x80, 0x40, 0x12], // .v64
  [0x40, 0x12, 0x37, 0x80], // .n64
]

export function looksLikeN64(rom: Uint8Array): boolean {
  if (rom.length < MIN_ROM_BYTES) return false
  return MAGICS.some((m) => m.every((b, i) => rom[i] === b))
}

export async function prepareN64Rom(file: Uint8Array): Promise<Uint8Array> {
  if (file.length === 0) throw new EmulatorError('This file is empty')
  if (file.length > MAX_FILE_BYTES) throw new EmulatorError(TOO_BIG)
  const rom = isZip(file) ? await unzipRom(file) : file
  if (rom.length > MAX_N64_ROM_BYTES) throw new EmulatorError(TOO_BIG)
  if (!looksLikeN64(rom)) throw new EmulatorError(NOT_N64)
  return rom
}

function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
}

async function unzipRom(zip: Uint8Array): Promise<Uint8Array> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  // End of central directory: last 22 bytes + up to 64 KB of comment.
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new EmulatorError(CORRUPT_ZIP)
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)

  interface Entry {
    name: string
    method: number
    flags: number
    compressed: number
    size: number
    local: number
  }
  const entries: Entry[] = []
  const decoder = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || dv.getUint32(p, true) !== 0x02014b50) throw new EmulatorError(CORRUPT_ZIP)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen))
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

  const roms = entries.filter((e) => ROM_NAME.test(e.name))
  const entry = roms.length > 0 ? roms.reduce((a, b) => (b.size > a.size ? b : a)) : entries.length === 1 ? entries[0] : null
  if (!entry) throw new EmulatorError("This .zip file doesn't contain a Nintendo 64 game")
  if (entry.size > MAX_N64_ROM_BYTES) throw new EmulatorError(TOO_BIG)
  if (entry.flags & 1) throw new EmulatorError('This .zip file is password-protected')
  if (entry.method !== 0 && entry.method !== 8) throw new EmulatorError(CORRUPT_ZIP)

  const l = entry.local
  if (l + 30 > zip.length || dv.getUint32(l, true) !== 0x04034b50) throw new EmulatorError(CORRUPT_ZIP)
  const start = l + 30 + dv.getUint16(l + 26, true) + dv.getUint16(l + 28, true)
  const end = start + entry.compressed
  if (end > zip.length) throw new EmulatorError(CORRUPT_ZIP)
  const data = zip.subarray(start, end)
  if (entry.method === 0) return data.slice()

  // Inflate into the size the directory announced, never past it (a lying entry can't balloon memory).
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
    throw new EmulatorError(CORRUPT_ZIP)
  }
  if (filled !== out.length) throw new EmulatorError(CORRUPT_ZIP)
  return out
}
