// App preferences (AppPrefs) plus a little internal state, persisted in <userData>/prefs.json.
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, type AppPrefs } from '../preload/api'
import { isAppUrl } from './security'

interface PrefsFile extends AppPrefs {
  /** The one-time "Nexo is still running in the tray" hint was shown (internal, not part of AppPrefs). */
  trayHintShown: boolean
}

const DEFAULTS: PrefsFile = { closeToTray: true, trayHintShown: false }

let cache: PrefsFile | null = null

const filePath = (): string => join(app.getPath('userData'), 'prefs.json')

function load(): PrefsFile {
  if (cache) return cache
  const data: PrefsFile = { ...DEFAULTS }
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8')) as Record<string, unknown>
    if (typeof raw.closeToTray === 'boolean') data.closeToTray = raw.closeToTray
    if (typeof raw.trayHintShown === 'boolean') data.trayHintShown = raw.trayHintShown
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[nexo] could not read prefs, using defaults:', err)
  }
  cache = data
  return data
}

function save(data: PrefsFile): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const target = filePath()
    writeFileSync(`${target}.tmp`, JSON.stringify(data, null, 2), 'utf8')
    renameSync(`${target}.tmp`, target)
  } catch (err) {
    console.warn('[nexo] could not save prefs:', err)
  }
}

export function getPrefs(): AppPrefs {
  return { closeToTray: load().closeToTray }
}

/** True the first time it's called per install (then remembered in prefs.json). */
export function takeTrayHint(): boolean {
  const data = load()
  if (data.trayHintShown) return false
  data.trayHintShown = true
  save(data)
  return true
}

function parsePatch(patch: unknown): Partial<AppPrefs> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new TypeError('prefs patch must be an object')
  const out: Partial<AppPrefs> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'closeToTray') {
      if (typeof value !== 'boolean') throw new TypeError('closeToTray must be a boolean')
      out.closeToTray = value
    } else {
      throw new TypeError(`unknown pref: ${key.slice(0, 64)}`)
    }
  }
  return out
}

function fromApp(event: IpcMainInvokeEvent): boolean {
  return isAppUrl(event.senderFrame?.url)
}

export function installPrefs(): void {
  ipcMain.handle(IPC.prefsGet, (event) => {
    if (!fromApp(event)) throw new Error('forbidden')
    return getPrefs()
  })
  ipcMain.handle(IPC.prefsSet, (event, patch: unknown) => {
    if (!fromApp(event)) throw new Error('forbidden')
    const changes = parsePatch(patch)
    const data = load()
    Object.assign(data, changes)
    save(data)
    return getPrefs()
  })
}
