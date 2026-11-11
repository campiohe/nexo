// Small key/value secret store in <userData>/secrets.json (docs/SPEC-ACCOUNTS.md §1).
// Each entry keeps a safeStorage-encrypted copy (`enc`) and a plain copy (`plain`). The plain copy is what
// survives a failed decryption (seen after updates on Windows Insider builds) or a machine without OS
// encryption (Linux without a keyring); losing the value means losing the user's account. Older files whose
// entries only have `enc` keep working and gain a plain copy on their first successful read.
// Nothing fails silently: problems are logged (main.log) and an entry that exists but can't be read is
// reported to the renderer as 'unreadable', distinct from 'missing'.
import { app, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC, type SecretRead } from '../preload/api'
import { isAppUrl } from './security'

interface Entry {
  enc?: string
  plain?: string
}
interface SecretsFile {
  v: 1
  entries: Record<string, Entry>
}

// Keys are JSON property names only (never paths), e.g. "token:id:3f9c…" or "token:http://100.64.0.1:3001".
const KEY_RE = /^[A-Za-z0-9_.:/[\]-]{1,256}$/
const MAX_VALUE = 64 * 1024

let cache: SecretsFile | null = null
/** secrets.json existed but couldn't be parsed: every missing key may have been in it. */
let fileUnreadable = false
let queue: Promise<unknown> = Promise.resolve()
let encryption: Promise<boolean> | null = null

const filePath = (): string => join(app.getPath('userData'), 'secrets.json')
const isStr = (v: unknown): v is string => typeof v === 'string'

function encryptionAvailable(): Promise<boolean> {
  encryption ??= safeStorage.isAsyncEncryptionAvailable().then(
    (ok) => {
      if (!ok) console.warn('[nexo] safeStorage encryption unavailable — secrets are kept in plain text only')
      return ok
    },
    (err: unknown) => {
      console.warn('[nexo] safeStorage check failed — secrets are kept in plain text only:', err)
      return false
    },
  )
  return encryption
}

async function load(): Promise<SecretsFile> {
  if (cache) return cache
  const target = filePath()
  let raw: string
  try {
    raw = await readFile(target, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[nexo] could not read the secrets file:', err)
      fileUnreadable = true
    }
    cache = { v: 1, entries: {} }
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SecretsFile> | null
    const entries = parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed.entries : {}
    cache = { v: 1, entries }
  } catch (err) {
    // Keep the damaged file for inspection before a later write replaces it.
    const backup = `${target}.corrupt-${Date.now()}`
    console.error(`[nexo] the secrets file is corrupt (kept as ${backup}):`, err)
    await copyFile(target, backup).catch((e: unknown) => console.error('[nexo] could not back up the secrets file:', e))
    fileUnreadable = true
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

/** Both copies when OS encryption works, else the plain copy only. */
async function encode(value: string): Promise<Entry> {
  if (await encryptionAvailable()) {
    try {
      return { enc: (await safeStorage.encryptStringAsync(value)).toString('base64'), plain: value }
    } catch (err) {
      console.warn('[nexo] safeStorage encryption failed — keeping the plain copy only:', err)
    }
  }
  return { plain: value }
}

async function decrypt(key: string, enc: string): Promise<{ value: string; stale: boolean } | null> {
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'))
    return { value: result, stale: shouldReEncrypt }
  } catch (err) {
    console.warn(`[nexo] could not decrypt secret "${key}":`, err)
    return null
  }
}

/** Rewrite an entry from its value (fresh encrypted copy + plain copy). A failure here is logged, not fatal. */
async function refresh(data: SecretsFile, key: string, value: string, why: string): Promise<void> {
  try {
    data.entries[key] = await encode(value)
    await persist(data)
  } catch (err) {
    console.warn(`[nexo] could not rewrite secret "${key}" (${why}):`, err)
  }
}

async function readSecret(key: string): Promise<SecretRead> {
  const data = await load()
  const entry = data.entries[key]
  if (!entry || typeof entry !== 'object') {
    return fileUnreadable ? { status: 'unreadable' } : { status: 'missing' }
  }
  const plain = isStr(entry.plain) ? entry.plain : null
  const decrypted = isStr(entry.enc) ? await decrypt(key, entry.enc) : null

  if (decrypted) {
    if (plain !== null && plain !== decrypted.value) {
      console.warn(`[nexo] secret "${key}": the plain and encrypted copies differ; using the encrypted one`)
    }
    if (decrypted.stale || plain !== decrypted.value) await refresh(data, key, decrypted.value, 're-encrypt')
    return { status: 'ok', value: decrypted.value }
  }
  if (plain !== null) {
    // No usable encrypted copy (decryption failed, or it was stored without one): rebuild it if we can.
    if (isStr(entry.enc)) console.warn(`[nexo] secret "${key}": using the plain copy`)
    if (await encryptionAvailable()) await refresh(data, key, plain, 're-encrypt from the plain copy')
    return { status: 'ok', value: plain }
  }
  console.error(`[nexo] secret "${key}" exists but no copy of it can be read`)
  return { status: 'unreadable' }
}

async function setSecret(key: string, value: string | null): Promise<void> {
  const data = await load()
  if (value === null) delete data.entries[key]
  else data.entries[key] = await encode(value)
  try {
    await persist(data)
  } catch (err) {
    console.error(`[nexo] could not save secret "${key}":`, err)
    throw err
  }
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

function checkKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new TypeError('invalid secret key')
}

export function installSecrets(): void {
  ipcMain.handle(IPC.secretRead, (event, key: unknown) => {
    if (!fromApp(event)) throw new Error('forbidden')
    checkKey(key)
    return serial(() => readSecret(key))
  })
  // Legacy shape: null for both "missing" and "unreadable".
  ipcMain.handle(IPC.secretGet, async (event, key: unknown) => {
    if (!fromApp(event)) throw new Error('forbidden')
    checkKey(key)
    const r = await serial(() => readSecret(key))
    return r.status === 'ok' ? r.value : null
  })
  ipcMain.handle(IPC.secretSet, (event, key: unknown, value: unknown) => {
    if (!fromApp(event)) throw new Error('forbidden')
    checkKey(key)
    if (value !== null && (typeof value !== 'string' || value.length > MAX_VALUE)) {
      throw new TypeError('secret value must be a string (max 64 KiB) or null')
    }
    return serial(() => setSecret(key, value))
  })
}
