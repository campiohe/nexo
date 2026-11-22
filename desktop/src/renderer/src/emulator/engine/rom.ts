// Turns the host's file into SNES ROM bytes, or a readable EmulatorError: size caps, .zip extraction (stored /
// deflate, via the browser's DecompressionStream) and a sanity check of the cartridge header, so a random file
// gets "isn't a SNES game" instead of a black screen.
import { EmulatorError } from '../types'

/** Largest file the host may load (the biggest SNES games are 6 MB; leaves room for hacks and headers). */
export const MAX_ROM_BYTES = 16 * 1024 * 1024
/** Largest ROM the core accepts (snes9x's MAX_ROM_SIZE, 12 MB) plus a copier header. */
const MAX_CORE_ROM_BYTES = 0xc00000 + 512
/** Smallest plausible SNES ROM (one 32 KB LoROM bank). */
const MIN_ROM_BYTES = 0x8000
const ROM_NAME = /\.(sfc|smc|swc|fig)$/i

const TOO_BIG = 'This file is too big to be a SNES game'
const NOT_SNES = "This file isn't a SNES game"
const CORRUPT_ZIP = 'This .zip file is damaged or uses an unsupported format'

export async function prepareRom(file: Uint8Array): Promise<Uint8Array> {
  if (file.length === 0) throw new EmulatorError('This file is empty')
  if (file.length > MAX_ROM_BYTES) throw new EmulatorError(TOO_BIG)
  const rom = isZip(file) ? await unzipRom(file) : file
  if (rom.length > MAX_CORE_ROM_BYTES) throw new EmulatorError(TOO_BIG)
  if (rom.length < MIN_ROM_BYTES || !looksLikeSnes(rom)) throw new EmulatorError(NOT_SNES)
  return rom
}

function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
}

// ---------------------------------------------------------------------------------------------------------------
// Header check. The internal header sits at 0x7FC0 (LoROM), 0xFFC0 (HiROM) or 0x40FFC0 (ExHiROM), after an
// optional 512-byte copier header. A candidate is plausible when its reset vector points into ROM (≥ 0x8000) and
// either the map mode byte is a known one or the checksum and its complement add up to 0xFFFF. Homebrew often has
// a wrong checksum but a proper map mode; real dumps have both.

const MAP_MODES = new Set([0x20, 0x21, 0x22, 0x23, 0x25, 0x30, 0x31, 0x32, 0x35, 0x3a])

function looksLikeSnes(rom: Uint8Array): boolean {
  const copier = rom.length % 1024 === 512 ? 512 : 0
  for (const base of [0x7fc0, 0xffc0, 0x40ffc0]) {
    const h = copier + base
    if (h + 0x40 > rom.length) continue
    const reset = rom[h + 0x3c] | (rom[h + 0x3d] << 8)
    if (reset < 0x8000) continue
    const mapMode = rom[h + 0x15]
    const complement = rom[h + 0x1c] | (rom[h + 0x1d] << 8)
    const checksum = rom[h + 0x1e] | (rom[h + 0x1f] << 8)
    if (MAP_MODES.has(mapMode) || (complement ^ checksum) === 0xffff) return true
  }
  return false
}

// ---------------------------------------------------------------------------------------------------------------
// Minimal .zip reader: central directory → the ROM entry (by extension; else the only file) → its bytes.

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
  if (!entry) throw new EmulatorError("This .zip file doesn't contain a SNES game")
  if (entry.size > MAX_ROM_BYTES) throw new EmulatorError(TOO_BIG)
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
