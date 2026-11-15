// Presence helpers that need the main process:
// - Auto-idle: powerMonitor's system idle state, polled every 30 s (every 2 s while idle, so coming back
//   is noticed quickly), plus screen lock / suspend. The renderer decides what to do with it (never over
//   Do Not Disturb, not while talking in voice): see renderer lib/presenceSync.ts.
// - "Playing X" (opt-in, off by default): every 15 s one `tasklist` (Windows) / `ps` (elsewhere) run,
//   matched against main/games.ts plus the user's own games. Only the display name of the detected game
//   goes to the renderer (and from there to the server); process lists stay in main, except the plain exe
//   names shown locally in Settings → Activity → "Add a game".
// Settings live in <userData>/activity.json (per device, like prefs.json).
import { app, ipcMain, powerMonitor, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { IPC, type ActivitySettings, type CustomGame, type DetectedActivity, type PresenceBridgeState } from '../preload/api'
import { createMatcher, nextActivity, parsePsOutput, parseTasklistCsv, userProcessNames, type GameMatcher, type ProcessInfo } from './games'
import { logLine } from './log'
import { platform } from './platform'
import { isAppUrl } from './security'

interface PresenceDeps {
  getWindow(): BrowserWindow | null
}

/** Seconds without keyboard / mouse input before reporting idle. */
const IDLE_AFTER_S = 10 * 60
const IDLE_POLL_MS = 30_000
const IDLE_POLL_FAST_MS = 2_000
const DETECT_MS = 15_000
const LIST_TIMEOUT_MS = 10_000
const LIST_MAX_BUFFER = 8 * 1024 * 1024
/** Same as ACTIVITY_NAME_MAX in shared/protocol.ts (the server trims longer names). */
const NAME_MAX = 64
const EXE_MAX = 260
const MAX_CUSTOM_GAMES = 200

const DEFAULTS: ActivitySettings = { shareActivity: false, customGames: [] }

let deps: PresenceDeps | null = null
let settingsCache: ActivitySettings | null = null

let idle = false
let idleTimer: NodeJS.Timeout | null = null

let detectTimer: NodeJS.Timeout | null = null
let scanning = false
let matcher: GameMatcher = createMatcher()
let firstSeen = new Map<string, number>()
let activity: DetectedActivity | null = null
let listFailureLogged = false

// ── Settings ────────────────────────────────────────────────────────────────────────────────────────────

const filePath = (): string => join(app.getPath('userData'), 'activity.json')

function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text && text.length <= max ? text : null
}

/** An exe name (no path, no separators). */
function cleanExe(raw: unknown): string | null {
  const exe = cleanText(raw, EXE_MAX)
  return exe && !/[\\/:*?"<>|]/.test(exe) ? exe : null
}

function parseGames(raw: unknown): CustomGame[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_CUSTOM_GAMES) return null
  const out: CustomGame[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const g = item as Record<string, unknown>
    const exe = cleanExe(g.exe)
    const name = cleanText(g.name, NAME_MAX)
    if (!exe || !name) return null
    const key = exe.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ exe, name })
  }
  return out
}

function loadSettings(): ActivitySettings {
  if (settingsCache) return settingsCache
  const data: ActivitySettings = { ...DEFAULTS, customGames: [] }
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8')) as Record<string, unknown>
    if (typeof raw.shareActivity === 'boolean') data.shareActivity = raw.shareActivity
    data.customGames = parseGames(raw.customGames) ?? []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[nexo] could not read activity settings:', err)
  }
  settingsCache = data
  return data
}

function saveSettings(data: ActivitySettings): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const target = filePath()
    writeFileSync(`${target}.tmp`, JSON.stringify(data, null, 2), 'utf8')
    renameSync(`${target}.tmp`, target)
  } catch (err) {
    console.warn('[nexo] could not save activity settings:', err)
  }
}

function parsePatch(patch: unknown): Partial<ActivitySettings> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new TypeError('settings patch must be an object')
  const out: Partial<ActivitySettings> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'shareActivity') {
      if (typeof value !== 'boolean') throw new TypeError('shareActivity must be a boolean')
      out.shareActivity = value
    } else if (key === 'customGames') {
      const games = parseGames(value)
      if (!games) throw new TypeError(`customGames must be up to ${MAX_CUSTOM_GAMES} { exe, name } entries`)
      out.customGames = games
    } else {
      throw new TypeError(`unknown setting: ${key.slice(0, 64)}`)
    }
  }
  return out
}

function copySettings(s: ActivitySettings): ActivitySettings {
  return { shareActivity: s.shareActivity, customGames: s.customGames.map((g) => ({ ...g })) }
}

// ── Process list ────────────────────────────────────────────────────────────────────────────────────────

/** The running processes, or null when the list couldn't be read (the caller keeps its state). */
function listProcesses(): Promise<ProcessInfo[] | null> {
  return new Promise((resolve) => {
    const win = platform === 'win32'
    // Full path on Windows: never whatever `tasklist` happens to be first on PATH. No shell either way.
    const cmd = win ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe') : 'ps'
    const args = win ? ['/fo', 'csv', '/nh'] : ['-A', '-o', 'comm=']
    execFile(cmd, args, { windowsHide: true, timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER }, (err, stdout) => {
      if (err) {
        if (!listFailureLogged) {
          listFailureLogged = true
          logLine('WARN', `[presence] process list failed: ${err.message}`)
        }
        resolve(null)
        return
      }
      resolve(win ? parseTasklistCsv(stdout) : parsePsOutput(stdout))
    })
  })
}

// ── Game detection ──────────────────────────────────────────────────────────────────────────────────────

function send(channel: string, value: unknown): void {
  const win = deps?.getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, value)
}

function setActivity(next: DetectedActivity | null): void {
  if (next?.name === activity?.name && next?.startedAt === activity?.startedAt) return
  activity = next
  send(IPC.presenceActivity, activity)
}

async function scan(): Promise<void> {
  if (scanning || !loadSettings().shareActivity) return
  scanning = true
  try {
    const processes = await listProcesses()
    // Turned off while the list was running: stopDetection() already cleared everything.
    if (!processes || !loadSettings().shareActivity) return
    const running = new Set<string>()
    for (const p of processes) {
      const name = matcher.match(p.exe)
      if (name) running.add(name)
    }
    const step = nextActivity(running, firstSeen, activity, Date.now())
    firstSeen = step.firstSeen
    setActivity(step.activity)
  } finally {
    scanning = false
  }
}

function startDetection(): void {
  if (detectTimer) return
  detectTimer = setInterval(() => void scan(), DETECT_MS)
  void scan()
}

function stopDetection(): void {
  if (detectTimer) clearInterval(detectTimer)
  detectTimer = null
  firstSeen = new Map()
  setActivity(null)
}

function applySettings(s: ActivitySettings): void {
  matcher = createMatcher(s.customGames)
  if (!s.shareActivity) return stopDetection()
  if (detectTimer) void scan() // new games list: re-check right away
  else startDetection()
}

// ── Idle ────────────────────────────────────────────────────────────────────────────────────────────────

function setIdle(next: boolean): void {
  if (next !== idle) {
    idle = next
    send(IPC.presenceIdle, idle)
  }
  scheduleIdleCheck()
}

function checkIdle(): void {
  // 'locked' counts as idle; 'unknown' (e.g. some Wayland sessions) never does.
  const state = powerMonitor.getSystemIdleState(IDLE_AFTER_S)
  setIdle(state === 'idle' || state === 'locked')
}

function scheduleIdleCheck(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(checkIdle, idle ? IDLE_POLL_FAST_MS : IDLE_POLL_MS)
}

// ── IPC ─────────────────────────────────────────────────────────────────────────────────────────────────

function fromApp(event: IpcMainInvokeEvent): boolean {
  return isAppUrl(event.senderFrame?.url)
}

export function installPresence(d: PresenceDeps): void {
  deps = d

  powerMonitor.on('lock-screen', () => setIdle(true))
  powerMonitor.on('suspend', () => setIdle(true))
  powerMonitor.on('unlock-screen', checkIdle)
  powerMonitor.on('resume', checkIdle)
  checkIdle()

  applySettings(loadSettings())

  ipcMain.handle(IPC.presenceGetState, (event): PresenceBridgeState => {
    if (!fromApp(event)) throw new Error('forbidden')
    return { idle, activity, settings: copySettings(loadSettings()) }
  })
  ipcMain.handle(IPC.presenceSetSettings, (event, patch: unknown): ActivitySettings => {
    if (!fromApp(event)) throw new Error('forbidden')
    const changes = parsePatch(patch)
    const data = loadSettings()
    Object.assign(data, changes)
    saveSettings(data)
    applySettings(data)
    return copySettings(data)
  })
  ipcMain.handle(IPC.presenceListProcesses, async (event): Promise<string[]> => {
    if (!fromApp(event)) throw new Error('forbidden')
    const processes = await listProcesses()
    if (!processes) throw new Error("Couldn't list the running programs")
    return userProcessNames(processes, basename(process.execPath))
  })
}
