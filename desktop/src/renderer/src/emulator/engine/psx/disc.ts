// Turns the host's PlayStation files into what the core opens from its in-memory file system, or a readable
// EmulatorError: which file is the disc (a .cue and its tracks, a single .bin / .img / .iso, a .chd, a .pbp, or a
// homebrew PS-X EXE), which picked file is the BIOS (optional), and the companion .sbi (LibCrypt) file.
//
// Nothing is copied: the plan holds the host's own Uint8Arrays and the engine hands them to MEMFS by reference
// (writeFile canOwn), so a 700 MB disc costs 700 MB once, not twice.
import { EmulatorError } from '../../types'

export interface PsxFile {
  name: string
  data: Uint8Array
}

export interface DiscPlan {
  /** Files to create under /disc (flat names), the one the core opens first. */
  files: { path: string; data: Uint8Array | string }[]
  /** The path given to the core (one of `files`). */
  main: string
  /** /system/<name> of the BIOS, if the host picked one. */
  bios: PsxFile | null
}

/** A PS1 BIOS image is exactly 512 KB. */
export const BIOS_SIZE = 512 * 1024
const CUE_MAX = 256 * 1024
/** Smallest plausible disc image: the core needs the volume descriptor at sector 16. */
const MIN_DISC_BYTES = 2048 * 17

const NOT_PSX = "This file isn't a PlayStation game"

function ext(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1]
}

function startsWith(data: Uint8Array, magic: string, at = 0): boolean {
  if (data.length < at + magic.length) return false
  for (let i = 0; i < magic.length; i++) if (data[at + i] !== magic.charCodeAt(i)) return false
  return true
}

/** The core's own BIOS check (frontend/libretro.c try_use_bios): MIPS reset code, or the "PS compatible" tag. */
export function looksLikeBios(data: Uint8Array): boolean {
  if (data.length !== BIOS_SIZE) return false
  const reset = data[1] === 0x00 && data[2] === 0x08 && data[3] === 0x3c && data[4] === 0x3f
  return reset || startsWith(data, 'PS compatible', 0x12c)
}

function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return new TextDecoder('windows-1252').decode(data) // older rippers wrote ANSI names
  }
}

interface CueFile {
  /** The FILE line's index in `lines`. */
  line: number
  name: string
  type: string
}

function parseCue(text: string): { lines: string[]; files: CueFile[] } {
  const lines = text.split(/\r?\n/)
  const files: CueFile[] = []
  lines.forEach((raw, line) => {
    const m = /^\s*FILE\s+(?:"([^"]*)"|(\S+))\s*(\S*)\s*$/i.exec(raw)
    if (m) files.push({ line, name: m[1] ?? m[2], type: m[3] || 'BINARY' })
  })
  return { lines, files }
}

function findFile(name: string, pool: PsxFile[]): PsxFile | undefined {
  const want = baseName(name)
  return pool.find((f) => f.name === want) ?? pool.find((f) => f.name.toLowerCase() === want.toLowerCase())
}

const isCueText = (f: PsxFile): boolean => ext(f.name) === 'cue' && f.data.length > 0 && f.data.length <= CUE_MAX

/**
 * Plans the disc. `rom`/`fileName` is what the host picked as the game; `extra` the other picked files (tracks,
 * BIOS, .sbi). If the host picked a track .bin as the game but its .cue came along in `extra`, the .cue wins.
 */
export function planDisc(rom: Uint8Array, fileName: string, extra: PsxFile[]): DiscPlan {
  let main: PsxFile = { name: baseName(fileName), data: rom }
  let others = extra.filter((f) => f.data !== rom)
  if (main.data.length === 0) throw new EmulatorError('This file is empty')

  if (ext(main.name) !== 'cue') {
    const cue = others.find(
      (f) => isCueText(f) && parseCue(decodeText(f.data)).files.some((c) => findFile(c.name, [main])),
    )
    if (cue) {
      others = [main, ...others.filter((f) => f !== cue)]
      main = cue
    }
  }

  // The BIOS: a 512 KB file the core would accept. Never a track of the .cue (checked below).
  const biosCandidates = others.filter((f) => looksLikeBios(f.data))

  const files: DiscPlan['files'] = []
  let mainPath: string
  const usedTracks: PsxFile[] = []
  const kind = ext(main.name)

  if (kind === 'cue') {
    if (main.data.length > CUE_MAX) throw new EmulatorError(NOT_PSX)
    const { lines, files: entries } = parseCue(decodeText(main.data))
    if (entries.length === 0) throw new EmulatorError("This .cue file doesn't list any track")
    const pool = others.filter((f) => !biosCandidates.includes(f) || entries.some((e) => findFile(e.name, [f])))
    const missing: string[] = []
    entries.forEach((entry, i) => {
      let file = findFile(entry.name, pool)
      // A single-track disc whose .bin was renamed: the only disc-sized file picked with it.
      if (!file && entries.length === 1) {
        const bins = pool.filter((f) => ['bin', 'img', 'iso'].includes(ext(f.name)) && f.data.length >= MIN_DISC_BYTES)
        if (bins.length === 1) file = bins[0]
      }
      if (!file) {
        missing.push(baseName(entry.name))
        return
      }
      usedTracks.push(file)
      const path = `/disc/track${String(i + 1).padStart(2, '0')}.${ext(file.name) || 'bin'}`
      files.push({ path, data: file.data })
      lines[entry.line] = `FILE "${path.slice('/disc/'.length)}" ${entry.type}`
    })
    if (missing.length === 1) {
      throw new EmulatorError(`The track "${missing[0]}" is missing: pick it together with the .cue file`)
    }
    if (missing.length > 1) {
      const list = missing.map((m) => `"${m}"`).join(', ')
      throw new EmulatorError(`${missing.length} tracks are missing (${list}): pick them together with the .cue file`)
    }
    mainPath = '/disc/game.cue'
    files.push({ path: mainPath, data: lines.join('\n') })
  } else if (kind === 'exe' || startsWith(main.data, 'PS-X EXE')) {
    if (!startsWith(main.data, 'PS-X EXE')) throw new EmulatorError(NOT_PSX)
    mainPath = '/disc/game.exe'
    files.push({ path: mainPath, data: main.data })
  } else if (kind === 'chd' || startsWith(main.data, 'MComprHD')) {
    if (!startsWith(main.data, 'MComprHD')) throw new EmulatorError(NOT_PSX)
    mainPath = '/disc/game.chd'
    files.push({ path: mainPath, data: main.data })
  } else if (kind === 'pbp' || startsWith(main.data, '\0PBP')) {
    if (!startsWith(main.data, '\0PBP')) throw new EmulatorError(NOT_PSX)
    mainPath = '/disc/game.pbp'
    files.push({ path: mainPath, data: main.data })
  } else if (['bin', 'img', 'iso', 'mdf'].includes(kind) || kind === '') {
    if (looksLikeBios(main.data)) {
      throw new EmulatorError('This is a PlayStation BIOS, not a game: pick it together with the game')
    }
    if (main.data.length < MIN_DISC_BYTES) throw new EmulatorError(NOT_PSX)
    if (kind === 'mdf') throw new EmulatorError('.mdf images need their .mds: convert the disc to .cue/.bin or .chd')
    mainPath = `/disc/game.${kind || 'bin'}`
    files.push({ path: mainPath, data: main.data })
  } else {
    throw new EmulatorError(NOT_PSX)
  }

  // LibCrypt-protected PAL games need their .sbi next to the image, under the same base name.
  const sbi = others.find((f) => ext(f.name) === 'sbi')
  if (sbi) files.push({ path: mainPath.replace(/\.[^./]+$/, '.sbi'), data: sbi.data })

  const bios = biosCandidates.find((f) => !usedTracks.includes(f)) ?? null
  return { files, main: mainPath, bios: bios && { name: safeBiosName(bios.name), data: bios.data } }
}

function safeBiosName(name: string): string {
  const clean = baseName(name).replace(/[^\w.-]/g, '_')
  return /\.bin$/i.test(clean) ? clean : `${clean || 'bios'}.bin`
}
