// Small key/value secret store: safeStorage-encrypted values in <userData>/secrets.json.
// Falls back to plain text (with a warning) when OS encryption is unavailable, e.g. Linux without a keyring.
import { app, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../preload/api'
import { isAppUrl } from './security'

type Entry = { enc: string } | { plain: string }
interface SecretsFile {
  v: 1
  entries: Record<string, Entry>
}

// Keys are JSON property names only (never paths), e.g. "token:http://100.64.0.1:3001".
const KEY_RE = /^[A-Za-z0-9_.:/[\]-]{1,256}$/
const MAX_VALUE = 64 * 1024

let cache: SecretsFile | null = null
let queue: Promise<unknown> = Promise.resolve()
let encryption: Promise<boolean> | null = null

const filePath = (): string => join(app.getPath('userData'), 'secrets.json')

function encryptionAvailable(): Promise<boolean> {
  encryption ??= safeStorage.isAsyncEncryptionAvailable().then(
    (ok) => {
      if (!ok) console.warn('[nexo] safeStorage encryption unavailable — secrets are stored in plain text')
      return ok
    },
    (err: unknown) => {
      console.warn('[nexo] safeStorage check failed — secrets are stored in plain text:', err)
      return false
    },
  )
  return encryption
}

async function load(): Promise<SecretsFile> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await readFile(filePath(), 'utf8')) as Partial<SecretsFile>
    cache = { v: 1, entries: parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed.entries : {} }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[nexo] could not read secrets file:', err)
    cache = { v: 1, entries: {} }
  }
  return cache
}

async function persist(data: SecretsFile): Promise<void> {
  const target = filePath()
  await mkdir(app.getPath('userData'), { recursive: true })
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, target)
}

async function encode(value: string): Promise<Entry> {
  if (await encryptionAvailable()) {
    try {
      return { enc: (await safeStorage.encryptStringAsync(value)).toString('base64') }
    } catch (err) {
      console.warn('[nexo] safeStorage encryption failed — storing in plain text:', err)
    }
  }
  return { plain: value }
}

async function getSecret(key: string): Promise<string | null> {
  const data = await load()
  const entry = data.entries[key]
  if (!entry) return null
  if ('plain' in entry && typeof entry.plain === 'string') return entry.plain
  if ('enc' in entry && typeof entry.enc === 'string') {
    try {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(entry.enc, 'base64'))
      if (shouldReEncrypt) await setSecret(key, result)
      return result
    } catch (err) {
      console.warn(`[nexo] could not decrypt secret "${key}":`, err)
      return null
    }
  }
  return null
}

async function setSecret(key: string, value: string | null): Promise<void> {
  const data = await load()
  if (value === null) delete data.entries[key]
  else data.entries[key] = await encode(value)
  await persist(data)
}

/** Serialize all store operations so concurrent set/get calls can't interleave file writes. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

function fromApp(event: IpcMainInvokeEvent): boolean {
  return isAppUrl(event.senderFrame?.url)
}

export function installSecrets(): void {
  ipcMain.handle(IPC.secretGet, (event, key: unknown) => {
    if (!fromApp(event)) throw new Error('forbidden')
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new TypeError('invalid secret key')
    return serial(() => getSecret(key))
  })
  ipcMain.handle(IPC.secretSet, (event, key: unknown, value: unknown) => {
    if (!fromApp(event)) throw new Error('forbidden')
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new TypeError('invalid secret key')
    if (value !== null && (typeof value !== 'string' || value.length > MAX_VALUE)) {
      throw new TypeError('secret value must be a string (max 64 KiB) or null')
    }
    return serial(() => setSecret(key, value))
  })
}
