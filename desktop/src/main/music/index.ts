// Music plugin, main-process side: the YouTube Music engine (engine.ts) behind window.nexo.music (IPC) and
// the nexo-music:// protocol that <audio> elements play (stream.ts). Each client talks to YouTube itself;
// nothing goes through the Nexo server.
//
// Network: InnerTube calls and the googlevideo media requests both use Node's fetch, on purpose. googlevideo
// URLs only work from the IP that resolved them, so both must leave through the same network stack
// (Electron's net.fetch would apply the system proxy to one and not the other).
import { app, ipcMain, protocol, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { IPC, type MusicEngineError } from '../../preload/api'
import { logLine } from '../log'
import { isAppUrl } from '../security'
import { MusicEngine, toPlainError } from './engine'
import { VIDEO_ID_RE } from './mapping'
import { errorResponse, TrackStreamer } from './stream'

export const MUSIC_SCHEME = 'nexo-music'
const MAX_QUERY = 200
const MAX_INPUT = 2048

/**
 * Must run before app 'ready'. Electron accepts only one registerSchemesAsPrivileged call per app: if
 * another privileged scheme is ever needed, add it to this call instead of making a second one.
 * standard + secure: a normal origin that the CSP can allow (media-src nexo-music:); stream: media
 * elements can play partial (206) responses; supportFetchAPI: the renderer may fetch() it (e.g. to read an
 * error code).
 */
export function registerMusicScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MUSIC_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  ])
}

type MusicResult<T> = { ok: true; data: T } | { ok: false; error: MusicEngineError }

const fail = (code: MusicEngineError['code'], message: string): MusicResult<never> => ({
  ok: false,
  error: { name: 'MusicEngineError', code, message },
})

async function settle<T>(p: Promise<T>): Promise<MusicResult<T>> {
  try {
    return { ok: true, data: await p }
  } catch (err) {
    return { ok: false, error: toPlainError(err) }
  }
}

const fromApp = (event: IpcMainInvokeEvent): boolean => isAppUrl(event.senderFrame?.url)

/** Referrers that say nothing about the page (file:// pages send none). */
const isBlankReferrer = (r: string): boolean => !r || r === 'about:client' || r === 'no-referrer'

/**
 * A request made by a web page (http/https referrer) other than Nexo's own (the dev server in development).
 * file:// referrers are the packaged renderer (Chromium may strip them to "file:///"), so only web pages
 * are refused; no web page should ever end up in this session anyway (security.ts blocks navigation).
 */
function fromWebPage(referrer: string): boolean {
  return /^https?:/i.test(referrer) && !isAppUrl(referrer)
}

/** Why each video's last stream load failed, for music.lastError (newest last; capped, expires). */
const lastErrors = new Map<string, { error: MusicEngineError; at: number }>()
const LAST_ERRORS_MAX = 100
const LAST_ERROR_TTL_MS = 10 * 60 * 1000

function rememberError(videoId: string, error: MusicEngineError): void {
  lastErrors.delete(videoId)
  lastErrors.set(videoId, { error: { name: 'MusicEngineError', code: error.code, message: error.message.slice(0, 300) }, at: Date.now() })
  while (lastErrors.size > LAST_ERRORS_MAX) lastErrors.delete(lastErrors.keys().next().value as string)
}

const ENGINE_CODES: readonly MusicEngineError['code'][] = ['bot-check', 'unavailable', 'network', 'engine']
function isEngineError(v: unknown): v is MusicEngineError {
  const e = v as Partial<MusicEngineError> | null
  return !!e && typeof e === 'object' && typeof e.message === 'string' && ENGINE_CODES.includes(e.code as MusicEngineError['code'])
}

export function installMusic(): void {
  const log = (level: 'INFO' | 'WARN' | 'ERROR', ...args: unknown[]): void => {
    logLine(level, ...args)
    if (level !== 'INFO' && !app.isPackaged) console.log(...args)
  }
  const engine = new MusicEngine({
    cacheDir: join(app.getPath('userData'), 'music'),
    location: /^[A-Z]{2}$/.test(app.getLocaleCountryCode()) ? app.getLocaleCountryCode() : undefined,
    fetch: globalThis.fetch.bind(globalThis),
    log,
  })
  const streamer = new TrackStreamer(engine, (input, init) => globalThis.fetch(input, init), log)

  // Registered on the default session (the only one the app's window uses). Only nexo-music://track/<id>,
  // only GET/HEAD, only from Nexo's own pages when the request says where it comes from.
  protocol.handle(MUSIC_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
    const referrer = isBlankReferrer(request.referrer) ? (request.headers.get('referer') ?? '') : request.referrer
    if (fromWebPage(referrer)) {
      log('WARN', `[music] refused ${MUSIC_SCHEME} request from ${referrer}`)
      return new Response(null, { status: 403 })
    }
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response(null, { status: 400 })
    }
    const m = /^\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)
    if (url.hostname !== 'track' || url.port || url.username || url.password || !m || !VIDEO_ID_RE.test(m[1])) {
      return new Response(null, { status: 404 })
    }
    const videoId = m[1]
    let res: Response
    try {
      res = await streamer.serve(videoId, request.method, request.headers.get('range'))
    } catch (err) {
      res = errorResponse(err)
    }
    // Remember why a load failed so the player can ask over IPC (music.lastError) instead of fetching here.
    if (res.ok) lastErrors.delete(videoId)
    else if (res.headers.has('x-nexo-music-error')) {
      const body: unknown = await res.clone().json().catch(() => null)
      if (isEngineError(body)) rememberError(videoId, body)
    }
    return res
  })

  ipcMain.handle(IPC.musicSearch, async (event, query: unknown) => {
    if (!fromApp(event)) throw new Error('forbidden')
    if (typeof query !== 'string' || query.length > MAX_QUERY) return fail('engine', 'invalid search query')
    return settle(engine.search(query))
  })
  ipcMain.handle(IPC.musicResolve, async (event, input: unknown) => {
    if (!fromApp(event)) throw new Error('forbidden')
    if (typeof input !== 'string' || input.length > MAX_INPUT) return fail('engine', 'invalid link or id')
    return settle(engine.resolve(input))
  })
  ipcMain.handle(IPC.musicLastError, (event, videoId: unknown) => {
    if (!fromApp(event)) throw new Error('forbidden')
    if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) return null
    const entry = lastErrors.get(videoId)
    if (!entry || Date.now() - entry.at > LAST_ERROR_TTL_MS) return null
    return entry.error
  })
  ipcMain.handle(IPC.musicPrefetch, async (event, videoId: unknown) => {
    if (!fromApp(event)) throw new Error('forbidden')
    if (typeof videoId === 'string' && VIDEO_ID_RE.test(videoId)) await engine.prefetch(videoId)
  })
}
