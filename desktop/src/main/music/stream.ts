// nexo-music://track/<videoId> → the track's audio, proxied from googlevideo with HTTP range support.
//
// The <audio> element asks for open-ended ranges ("bytes=0-", and "bytes=N-" after a seek). googlevideo
// throttles or cuts long single requests, so the requested range is served as one streamed body built from
// sequential upstream range requests of at most CHUNK_BYTES (the first one small, for a fast start). The
// next upstream request starts only when the element has read the previous one (pull-based stream), and
// cancelling the body (seek, track change) aborts the upstream request.
//
// On 403/404/410 from googlevideo (URL expired, or bound to an IP we no longer have) the cached URL is
// dropped and the stream re-resolved once per response, keeping the same itag and length so byte offsets
// stay valid. Only URLs chosen by the engine (https://*.googlevideo.com/videoplayback) are ever fetched,
// redirects included: this is not a general proxy.
//
// No Electron imports: index.ts hands in the fetch implementation.
import { MusicError, toPlainError, type MusicEngine, type StreamInfo } from './engine'
import type { MusicEngineError } from '../../preload/api'

const FIRST_CHUNK_BYTES = 512 * 1024
const CHUNK_BYTES = 4 * 1024 * 1024
const MAX_REDIRECTS = 3
const UPSTREAM_TIMEOUT_MS = 20_000
const MAX_SHORT_READS = 5

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>

class StaleUrl extends Error {}

function isStreamHost(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && /(^|\.)googlevideo\.com$/.test(u.hostname) && u.pathname.startsWith('/videoplayback') && !u.username && !u.password && !u.port
  } catch {
    return false
  }
}

type Range = { start: number; end: number }

/** Single "bytes=" range → absolute range; 'unsatisfiable' → 416; null → whole file (no or ignorable header). */
export function parseRange(header: string | null, total: number): Range | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!m) return null // multi-range or another unit: ignore it and send everything (RFC 9110 allows that)
  const [, a, b] = m
  if (!a && !b) return 'unsatisfiable'
  let start: number
  let end: number
  if (!a) {
    const suffix = Number(b)
    if (suffix <= 0) return 'unsatisfiable'
    start = Math.max(0, total - suffix)
    end = total - 1
  } else {
    start = Number(a)
    end = b ? Math.min(Number(b), total - 1) : total - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= total || start > end) return 'unsatisfiable'
  return { start, end }
}

const ERROR_STATUS: Record<MusicEngineError['code'], number> = { 'bot-check': 429, unavailable: 404, network: 502, engine: 500 }

export function errorResponse(err: unknown): Response {
  const e = toPlainError(err)
  return new Response(JSON.stringify(e), {
    status: ERROR_STATUS[e.code],
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-nexo-music-error': e.code },
  })
}

export class TrackStreamer {
  constructor(
    private readonly engine: MusicEngine,
    private readonly fetchImpl: FetchFn,
    private readonly log: (level: 'INFO' | 'WARN' | 'ERROR', ...args: unknown[]) => void = () => {},
  ) {}

  /** GET/HEAD for one track with an optional Range header. Never throws: failures become error responses. */
  async serve(videoId: string, method: string, rangeHeader: string | null): Promise<Response> {
    try {
      let info = await this.engine.stream(videoId)
      const range = parseRange(rangeHeader, info.contentLength)
      if (range === 'unsatisfiable') {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${info.contentLength}`, 'accept-ranges': 'bytes' } })
      }
      const { start, end } = range ?? { start: 0, end: info.contentLength - 1 }
      const head = (i: StreamInfo): Headers =>
        new Headers({
          'content-type': i.mimeType,
          'content-length': String(end - start + 1),
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
          ...(range ? { 'content-range': `bytes ${start}-${end}/${i.contentLength}` } : {}),
        })
      const status = range ? 206 : 200
      if (method === 'HEAD') return new Response(null, { status, headers: head(info) })

      // Open the first upstream chunk before answering, so failures become a real error status.
      const abort = new AbortController()
      let refreshed = false
      let chunkEnd = start
      const open = async (from: number): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
        const to = Math.min(from + (from === start ? FIRST_CHUNK_BYTES : CHUNK_BYTES) - 1, end)
        chunkEnd = to
        try {
          return await this.fetchChunk(info, from, to, abort.signal)
        } catch (err) {
          if (!(err instanceof StaleUrl) || refreshed) throw err
          refreshed = true
          this.log('INFO', `[music] stream URL for ${videoId} refused (${err.message}), re-resolving`)
          this.engine.invalidate(videoId, info.url)
          const next = await this.engine.stream(videoId, { fresh: true })
          // A different file would make the byte offsets meaningless.
          if (next.itag !== info.itag || next.contentLength !== info.contentLength) {
            throw new MusicError('engine', 'the refreshed stream is a different file')
          }
          info = next
          return this.fetchChunk(info, from, to, abort.signal)
        }
      }

      let pos = start
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = await open(start)
      let shortReads = 0
      const body = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            for (;;) {
              if (pos > end) {
                controller.close()
                return
              }
              reader ??= await open(pos)
              const { done, value } = await reader.read()
              if (done) {
                reader = null
                // googlevideo sometimes ends a response early: continue from where it stopped.
                if (pos <= chunkEnd && ++shortReads > MAX_SHORT_READS) throw new MusicError('network', 'stream kept ending early')
                continue
              }
              if (!value?.byteLength) continue
              const piece = value.byteLength > end - pos + 1 ? value.subarray(0, end - pos + 1) : value
              pos += piece.byteLength
              controller.enqueue(piece)
              return
            }
          } catch (err) {
            abort.abort()
            if (!(err instanceof Error && err.name === 'AbortError')) this.log('WARN', `[music] stream ${videoId} failed at ${pos}:`, toPlainError(err).message)
            controller.error(err)
          }
        },
        cancel: () => {
          abort.abort()
          reader?.cancel().catch(() => {})
          reader = null
        },
      })
      return new Response(body, { status, headers: head(info) })
    } catch (err) {
      return errorResponse(err)
    }
  }

  /** One upstream range request (redirects followed by hand, googlevideo only) → body reader. */
  private async fetchChunk(info: StreamInfo, from: number, to: number, signal: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    let url = info.url
    for (let hop = 0; ; hop++) {
      if (!isStreamHost(url)) throw new MusicError('engine', 'refusing to fetch a non-googlevideo URL')
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { range: `bytes=${from}-${to}`, 'user-agent': info.userAgent, accept: '*/*' },
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        await res.body?.cancel().catch(() => {})
        if (!location || hop >= MAX_REDIRECTS) throw new MusicError('network', `googlevideo redirect without target (${res.status})`)
        url = new URL(location, url).toString()
        continue
      }
      if (res.status === 403 || res.status === 404 || res.status === 410) {
        await res.body?.cancel().catch(() => {})
        throw new StaleUrl(`HTTP ${res.status}`)
      }
      const contentRange = res.headers.get('content-range') ?? ''
      const ok =
        (res.status === 206 && contentRange.startsWith(`bytes ${from}-`)) ||
        (res.status === 200 && from === 0 && to === info.contentLength - 1)
      if (!ok || !res.body) {
        await res.body?.cancel().catch(() => {})
        throw new MusicError(res.status >= 500 || res.status === 429 ? 'network' : 'engine', `googlevideo answered ${res.status} ${contentRange}`)
      }
      return res.body.getReader()
    }
  }
}
