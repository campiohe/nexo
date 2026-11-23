// Turns the host's file into Mega Drive ROM bytes, or a readable EmulatorError: size caps, .zip extraction (stored /
// deflate, via the browser's DecompressionStream; same reader as ../rom.ts, which only looks for SNES games) and a
// sanity check of the cartridge, so a random file gets "isn't a Mega Drive game" instead of a black screen. The
// core itself handles the formats: raw (.md / .gen / .bin), byte-swapped, and .smd (512-byte header, interleaved).
import { EmulatorError } from '../../types'

/** Largest file the host may load (the biggest Mega Drive games are 5 MB; leaves room for hacks and headers). */
export const MAX_ROM_BYTES = 16 * 1024 * 1024
/** Largest ROM the core accepts (its MAXROMSIZE, 10 MB, see genesis_plus_gx/build.sh) plus a copier header. */
const MAX_CORE_ROM_BYTES = 10 * 1024 * 1024 + 512
/** Smallest plausible cartridge: the 68000 vectors + the 0x100-byte header. */
const MIN_ROM_BYTES = 0x200
const ROM_NAME = /\.(md|gen|smd|bin)$/i

const TOO_BIG = 'This file is too big to be a Mega Drive game'
const NOT_MD = "This file isn't a Mega Drive / Genesis game"
const CORRUPT_ZIP = 'This .zip file is damaged or uses an unsupported format'

export async function prepareGenesisRom(file: Uint8Array): Promise<Uint8Array> {
  if (file.length === 0) throw new EmulatorError('This file is empty')
  if (file.length > MAX_ROM_BYTES) throw new EmulatorError(TOO_BIG)
  const rom = isZip(file) ? await unzipRom(file) : file
  if (rom.length > MAX_CORE_ROM_BYTES) throw new EmulatorError(TOO_BIG)
  if (rom.length < MIN_ROM_BYTES || !looksLikeMegaDrive(rom)) throw new EmulatorError(NOT_MD)
  return rom
}

function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
}

// ---------------------------------------------------------------------------------------------------------------
// Cartridge check. A Mega Drive ROM has "SEGA" in its header at 0x100 (the console's TMSS checks it), "ESAG" when
// the dump is byte-swapped; a .smd file has a 512-byte copier header (bytes 8–9 = AA BB) and 16 KB interleaved
// blocks. Homebrew without the text still has the 68000 vectors: an even entry point inside the ROM.

function hasText(rom: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) if (rom[at + i] !== text.charCodeAt(i)) return false
  return true
}

function looksLikeMegaDrive(rom: Uint8Array): boolean {
  for (let at = 0x100; at <= 0x104; at++) if (hasText(rom, at, 'SEGA') || hasText(rom, at, 'ESAG')) return true
  if (rom.length % 0x4000 === 512 && rom[8] === 0xaa && rom[9] === 0xbb) return true
  const pc = ((rom[4] << 24) | (rom[5] << 16) | (rom[6] << 8) | rom[7]) >>> 0
  const sspTop = rom[0]
  return pc % 2 === 0 && pc >= 0x200 && pc < rom.length && (sspTop === 0x00 || sspTop === 0xff)
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
  if (!entry) throw new EmulatorError("This .zip file doesn't contain a Mega Drive game")
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
