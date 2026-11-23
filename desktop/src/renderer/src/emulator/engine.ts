// The emulator engines (contract: ./types.ts), one per console, behind `createEmulator`: SNES (engine/snes/,
// snes9x), Mega Drive / Genesis (engine/genesis/), PlayStation (engine/psx/) and Nintendo 64 (engine/n64/). Each
// is bundled with the app and runs only the bytes the host gave it; nothing is fetched from the network.
//
// Also the host's file handling before an engine starts: which files the picker accepts (ROM_EXTENSIONS), and
// `detectSystem`, which tells from the picked / dropped files which console a game is for, which file is the game
// and which are extras (a PlayStation .cue's .bin tracks, a PlayStation BIOS), with readable errors and size caps.
import type { EmuSystem } from '@shared/protocol'
import type { EmulatorEngine, EmulatorOptions } from './types'
import { EmulatorError } from './types'
import { EMU_SYSTEM_INFO } from './systems'
import { createSnesEngine } from './engine/snes'
import { baseName, extractZipEntry, isZipBytes, listZip, listZipBytes, type ZipEntry } from './zip'
import { msg, t } from '../i18n'

const MB = 1024 * 1024

/** File extensions the host's file picker accepts per system (lower case, with the dot). */
export const ROM_EXTENSIONS: Record<EmuSystem, string[]> = {
  snes: ['.sfc', '.smc', '.swc', '.fig', '.zip'],
  genesis: ['.md', '.gen', '.smd', '.bin', '.zip'],
  psx: ['.cue', '.bin', '.chd', '.pbp', '.iso', '.img'],
  n64: ['.z64', '.n64', '.v64', '.zip'],
}

/** Every extension of every system (the file picker's `accept`). */
export const ALL_ROM_EXTENSIONS: string[] = [...new Set(Object.values(ROM_EXTENSIONS).flat())]

/**
 * Largest game per system: cartridges are small (SNES ≤ 6 MB, Mega Drive ≤ 5 MB, N64 ≤ 64 MB; room left for hacks
 * and headers); a PlayStation disc (all its files together) up to a full 80-minute CD.
 */
export const MAX_GAME_BYTES: Record<EmuSystem, number> = {
  snes: 16 * MB,
  genesis: 16 * MB,
  psx: 850 * MB,
  n64: 64 * MB,
}
/** Largest extra file that isn't a disc track (a PlayStation BIOS is 512 KB). */
const MAX_EXTRA_BYTES = 4 * MB
/** A .cue sheet is a few lines of text. */
const MAX_CUE_BYTES = 256 * 1024
/** Size of a PlayStation BIOS image. */
const PSX_BIOS_BYTES = 512 * 1024
/** A lone .bin bigger than this is a disc image, not a Mega Drive cartridge. */
const BIG_BIN_BYTES = 16 * MB

const CARTRIDGE_EXT: Record<string, EmuSystem> = {
  '.sfc': 'snes',
  '.smc': 'snes',
  '.swc': 'snes',
  '.fig': 'snes',
  '.md': 'genesis',
  '.gen': 'genesis',
  '.smd': 'genesis',
  '.z64': 'n64',
  '.n64': 'n64',
  '.v64': 'n64',
}
/** PlayStation disc images that are one file. */
const DISC_EXT = new Set(['.chd', '.pbp', '.iso', '.img'])

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

// ---------------------------------------------------------------------------------------------------------------
// createEmulator

/** Starts the engine of `opts.system` on the game. Rejects with an EmulatorError (readable message) on failure. */
export async function createEmulator(opts: EmulatorOptions): Promise<EmulatorEngine> {
  switch (opts.system) {
    case 'snes':
      return createSnesEngine(opts) // reads .zip itself (engine/rom.ts)
    case 'genesis': {
      const { createGenesisEngine } = await loadEngine('genesis', () => import('./engine/genesis'))
      return createGenesisEngine(await unzipCartridge(opts))
    }
    case 'n64': {
      const { createN64Engine } = await loadEngine('n64', () => import('./engine/n64'))
      return createN64Engine(await unzipCartridge(opts))
    }
    case 'psx': {
      const { createPsxEngine } = await loadEngine('psx', () => import('./engine/psx'))
      return createPsxEngine(opts)
    }
    default:
      throw new EmulatorError(t("This console isn't supported"))
  }
}

async function loadEngine<T>(system: EmuSystem, load: () => Promise<T>): Promise<T> {
  try {
    return await load()
  } catch (e) {
    console.error(`[emulator] the ${system} engine failed to load`, e)
    throw new EmulatorError(t("The {console} emulator couldn't start (it failed to load)", { console: EMU_SYSTEM_INFO[system].name }))
  }
}

/** A zipped Mega Drive / N64 game → the game file inside (its bytes and name); other files pass through. */
async function unzipCartridge(opts: EmulatorOptions): Promise<EmulatorOptions> {
  if (extensionOf(opts.fileName) !== '.zip' && !isZipBytes(opts.rom)) return opts
  const system = opts.system
  const entry = pickZipEntry(listZipBytes(opts.rom), system)
  if (!entry) throw new EmulatorError(t("This .zip file doesn't contain a {console} game", { console: EMU_SYSTEM_INFO[system].name }))
  const rom = await extractZipEntry(opts.rom, entry, MAX_GAME_BYTES[system], tooBig(system))
  return { ...opts, rom, fileName: baseName(entry.name) }
}

/** The biggest entry that is a game of `system` (a zipped Mega Drive .bin counts). */
function pickZipEntry(entries: ZipEntry[], system: EmuSystem): ZipEntry | null {
  const fits = entries.filter((e) => {
    const ext = extensionOf(e.name)
    return CARTRIDGE_EXT[ext] === system || (system === 'genesis' && ext === '.bin')
  })
  if (fits.length === 0) return null
  return fits.reduce((a, b) => (b.size > a.size ? b : a))
}

const tooBig = (system: EmuSystem) =>
  system === 'psx'
    ? t('This disc image is too big for a PlayStation game')
    : t('This file is too big to be a {console} game', { console: EMU_SYSTEM_INFO[system].name })

// ---------------------------------------------------------------------------------------------------------------
// detectSystem

/** What the picked files are. */
export type GameDetection =
  /** A game of `system`: `main` is the game file, `extras` go to the engine as EmulatorOptions.extraFiles. */
  | { kind: 'game'; system: EmuSystem; main: File; extras: File[] }
  /** It could be a game of any of `systems` (a .bin without a .cue): ask the host. */
  | { kind: 'ask'; systems: EmuSystem[]; main: File; extras: File[] }
  | { kind: 'error'; message: string }

/** `message` is translated already. */
const err = (message: string): GameDetection => ({ kind: 'error', message })
const ONE_GAME = msg('Pick one game at a time')
const CUE_WITH_BINS = msg('Pick the .cue together with its .bin files')
const UNZIP_PSX = msg('Unzip PlayStation games first, then pick the .cue together with its .bin files')

/**
 * Which console the picked / dropped files are for, by their extensions (and a peek at the headers of .bin files
 * and at the directory of a .zip; big files are never read whole here):
 * - .sfc .smc .swc .fig → SNES; .md .gen .smd → Mega Drive; .z64 .n64 .v64 → N64; one file only.
 * - .cue (+ the .bin / .img files it lists, which must be picked with it) → PlayStation; .chd .pbp .iso .img →
 *   PlayStation. Other small .bin files picked with a disc are extras (a BIOS).
 * - .bin alone: a raw CD sector, or bigger than 16 MB → PlayStation; "SEGA" at 0x100 → Mega Drive; a 512 KB file
 *   without it is a PlayStation BIOS (an error: pick it with a game); anything else → ask.
 * - .zip alone: by the game files inside (a .bin inside → Mega Drive); PlayStation games must be unzipped.
 */
export async function detectSystem(files: File[]): Promise<GameDetection> {
  if (files.length === 0) return err(t('Pick a game file'))
  for (const f of files) {
    const ext = extensionOf(f.name)
    if (!ALL_ROM_EXTENSIONS.includes(ext)) {
      return err(
        t(`"{name}" isn't a game file the emulator reads ({extensions})`, { name: f.name, extensions: ALL_ROM_EXTENSIONS.join(', ') }),
      )
    }
    if (f.size === 0) return err(t('"{name}" is empty', { name: f.name }))
  }
  const byExt = (pred: (ext: string) => boolean) => files.filter((f) => pred(extensionOf(f.name)))
  const cues = byExt((e) => e === '.cue')
  const discs = byExt((e) => DISC_EXT.has(e))
  const zips = byExt((e) => e === '.zip')
  const carts = byExt((e) => e in CARTRIDGE_EXT)
  const bins = byExt((e) => e === '.bin')

  if (cues.length > 0) {
    if (cues.length > 1 || discs.some((d) => extensionOf(d.name) !== '.img') || zips.length || carts.length) return err(t(ONE_GAME))
    return detectCue(cues[0], files.filter((f) => f !== cues[0]))
  }
  if (discs.length > 0) {
    if (discs.length > 1 || zips.length || carts.length) return err(t(ONE_GAME))
    const main = discs[0]
    const extras = files.filter((f) => f !== main)
    if (extras.some((f) => f.size > MAX_EXTRA_BYTES)) return err(t(ONE_GAME))
    if (main.size > MAX_GAME_BYTES.psx) return err(tooBig('psx'))
    return { kind: 'game', system: 'psx', main, extras }
  }
  if (zips.length > 0) {
    if (files.length > 1) return err(t('Pick the .zip file alone'))
    return detectZip(zips[0])
  }
  if (carts.length > 0) {
    if (files.length > 1) return err(t(ONE_GAME))
    const main = carts[0]
    const system = CARTRIDGE_EXT[extensionOf(main.name)]
    if (main.size > MAX_GAME_BYTES[system]) return err(tooBig(system))
    return { kind: 'game', system, main, extras: [] }
  }
  return detectBins(bins)
}

async function detectCue(cue: File, others: File[]): Promise<GameDetection> {
  if (cue.size > MAX_CUE_BYTES) return err(t("This .cue file isn't a disc's track list"))
  let listed: string[]
  try {
    listed = cueFiles(await cue.text())
  } catch {
    return err(t("This .cue file couldn't be read"))
  }
  if (listed.length === 0) return err(t("This .cue file doesn't list any track files"))
  const picked = new Map(others.map((f) => [f.name.toLowerCase(), f]))
  const missing = listed.filter((name) => !picked.has(baseName(name).toLowerCase()))
  if (missing.length === listed.length) return err(t(CUE_WITH_BINS))
  if (missing.length > 0) {
    const names = missing.slice(0, 3).map((n) => `"${baseName(n)}"`).join(', ')
    return err(t('Pick the .cue together with its .bin files (missing: {files})', { files: `${names}${missing.length > 3 ? '…' : ''}` }))
  }
  const tracks = new Set(listed.map((n) => picked.get(baseName(n).toLowerCase())!))
  // Anything else picked must be small (a BIOS), not another game.
  if (others.some((f) => !tracks.has(f) && f.size > MAX_EXTRA_BYTES)) return err(t(ONE_GAME))
  let total = cue.size
  for (const t of tracks) total += t.size
  if (total > MAX_GAME_BYTES.psx) return err(tooBig('psx'))
  // Tracks go to the engine under the exact names the .cue uses (the picked name may differ in case).
  const cueName = new Map(listed.map((n) => [baseName(n).toLowerCase(), baseName(n)]))
  const extras = others.map((f) => {
    const name = cueName.get(f.name.toLowerCase())
    return name && name !== f.name ? new File([f], name, { type: f.type, lastModified: f.lastModified }) : f
  })
  return { kind: 'game', system: 'psx', main: cue, extras }
}

/** The file names a .cue sheet lists (`FILE "Game (Track 1).bin" BINARY`, quotes optional). */
export function cueFiles(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*FILE\s+(?:"([^"]+)"|(\S+))/i.exec(line)
    const name = m?.[1] ?? m?.[2]
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

async function detectZip(zip: File): Promise<GameDetection> {
  let entries: ZipEntry[]
  try {
    entries = await listZip(zip)
  } catch (e) {
    return err(e instanceof EmulatorError ? e.message : t('This .zip file is damaged or uses an unsupported format'))
  }
  const carts = entries.filter((e) => extensionOf(e.name) in CARTRIDGE_EXT)
  if (carts.length > 0) {
    const biggest = carts.reduce((a, b) => (b.size > a.size ? b : a))
    const system = CARTRIDGE_EXT[extensionOf(biggest.name)]
    // The SNES engine reads the zip itself and caps it; others are unzipped by createEmulator.
    if (zip.size > MAX_GAME_BYTES[system] || biggest.size > MAX_GAME_BYTES[system]) return err(tooBig(system))
    return { kind: 'game', system, main: zip, extras: [] }
  }
  const discs = entries.filter((e) => {
    const ext = extensionOf(e.name)
    return ext === '.cue' || DISC_EXT.has(ext)
  })
  if (discs.length > 0) return err(t(UNZIP_PSX))
  const bins = entries.filter((e) => extensionOf(e.name) === '.bin')
  if (bins.length > 0) {
    const biggest = bins.reduce((a, b) => (b.size > a.size ? b : a))
    // A zipped .bin is a Mega Drive cartridge; a disc image that size would be a PlayStation game.
    if (biggest.size > BIG_BIN_BYTES) return err(t(UNZIP_PSX))
    return { kind: 'game', system: 'genesis', main: zip, extras: [] }
  }
  return err(t("This .zip file doesn't contain a game the emulator reads"))
}

type BinKind = 'disc' | 'sega' | 'bios' | 'unknown'

/** Peek at a .bin's first bytes: a raw CD sector (sync pattern) is a disc; "SEGA" at 0x100 a Mega Drive ROM. */
async function binKind(f: File): Promise<BinKind> {
  if (f.size > BIG_BIN_BYTES) return 'disc'
  const head = new Uint8Array(await f.slice(0, 0x110).arrayBuffer())
  const sync = head.length >= 12 && head[0] === 0 && head[11] === 0 && head.subarray(1, 11).every((b) => b === 0xff)
  if (sync) return 'disc'
  if (head.length >= 0x104 && String.fromCharCode(...head.subarray(0x100, 0x104)) === 'SEGA') return 'sega'
  if (f.size === PSX_BIOS_BYTES) return 'bios'
  return 'unknown'
}

async function detectBins(bins: File[]): Promise<GameDetection> {
  let kinds: BinKind[]
  try {
    kinds = await Promise.all(bins.map(binKind))
  } catch {
    return err(t("The file couldn't be read"))
  }
  if (bins.length === 1) {
    const [main] = bins
    switch (kinds[0]) {
      case 'disc':
        if (main.size > MAX_GAME_BYTES.psx) return err(tooBig('psx'))
        return { kind: 'game', system: 'psx', main, extras: [] }
      case 'sega':
        return { kind: 'game', system: 'genesis', main, extras: [] }
      case 'bios':
        return err(t('This looks like a PlayStation BIOS file: pick it together with the game files'))
      default:
        return { kind: 'ask', systems: ['genesis', 'psx'], main, extras: [] }
    }
  }
  // Several .bin files without a .cue: one disc image + BIOS files is fine; several tracks need their .cue.
  const discIdx = kinds.flatMap((k, i) => (k === 'disc' ? [i] : []))
  if (discIdx.length > 1) return err(t(CUE_WITH_BINS))
  if (kinds.includes('sega')) return err(t(ONE_GAME))
  if (discIdx.length === 1) {
    const main = bins[discIdx[0]]
    const extras = bins.filter((f) => f !== main)
    if (extras.some((f) => f.size > MAX_EXTRA_BYTES)) return err(t(CUE_WITH_BINS))
    if (main.size > MAX_GAME_BYTES.psx) return err(tooBig('psx'))
    return { kind: 'game', system: 'psx', main, extras }
  }
  return err(t(CUE_WITH_BINS))
}

/**
 * What the engines (./engine/, which stay in English) reject with, as is: marked here so pt-BR/emulator.ts can
 * translate them. They reach the user through toast(), whose tKnown() looks the exact text up.
 */
export const ENGINE_MESSAGES = [
  msg('This .zip file is damaged or uses an unsupported format'),
  msg('This .zip file is password-protected'),
  msg("This .zip file doesn't contain a SNES game"),
  msg("This .zip file doesn't contain a Mega Drive game"),
  msg("This .zip file doesn't contain a Nintendo 64 game"),
  msg('This file is empty'),
  msg("This file isn't a SNES game"),
  msg("This file isn't a Mega Drive / Genesis game"),
  msg("This file isn't a PlayStation game"),
  msg("This file isn't a Nintendo 64 game"),
  msg('This file is too big to be a SNES game'),
  msg('This file is too big to be a Mega Drive game'),
  msg('This file is too big to be a Nintendo 64 game'),
  msg("This .cue file doesn't list any track"),
  msg('This is a PlayStation BIOS, not a game: pick it together with the game'),
  msg('.mdf images need their .mds: convert the disc to .cue/.bin or .chd'),
  msg("This SNES game couldn't be loaded (the file may be corrupt)"),
  msg("This Mega Drive game couldn't be loaded (the file may be corrupt)"),
  msg("This Nintendo 64 game couldn't be loaded (the file may be corrupt)"),
  msg("This PlayStation game couldn't be loaded (the disc image may be incomplete or corrupt)"),
  msg("The SNES emulator couldn't start (its core failed to load)"),
  msg("The Mega Drive emulator couldn't start (its core failed to load)"),
  msg("The PlayStation emulator couldn't start (its core failed to load)"),
  msg("The Nintendo 64 emulator couldn't start (its core failed to load)"),
  msg("The emulator couldn't create its screen"),
  msg("The Nintendo 64 emulator couldn't create its screen"),
  msg("The emulator couldn't start its sound output"),
  msg("The Nintendo 64 emulator needs WebGL 2, which isn't available (check the graphics driver)"),
  msg('The game stopped working'),
  msg('The game has been closed'),
  msg("The game couldn't be saved"),
  msg("This save doesn't belong to this game"),
]
