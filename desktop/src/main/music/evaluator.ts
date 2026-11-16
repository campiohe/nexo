// JavaScript evaluator for youtubei.js (Platform.shim.eval): runs the signature / "n" deciphering code that
// youtubei.js extracts from YouTube's player script. That code is YouTube's, downloaded at runtime: treat it as
// untrusted. It runs in a worker thread (evaluatorWorker.ts) with V8 heap and stack limits and a wall-clock
// limit enforced from here (the worker is terminated and replaced), inside a locked-down V8 context there. A
// script that loops, allocates without bound or overflows the stack costs at most one worker, never the main
// process. Only a JSON string comes back, and only fixed messages leave on failure: no value produced by the
// sandbox ever reaches the main thread.
//
// One worker is reused across calls (they are queued, one at a time) and recreated after any failure.
//
// Only needed for clients whose stream URLs are ciphered (the YTMUSIC fallback); ANDROID_VR / VISIONOS / IOS
// return plain URLs.
//
// No Electron imports: the caller hands in how to start the worker (index.ts: electron-vite's `?nodeWorker`
// import, which bundles evaluatorWorker.ts as its own file next to the main bundle).
import type { Worker, WorkerOptions } from 'node:worker_threads'
import type { EvaluatorReply, EvaluatorRequest } from './evaluatorWorker'

export type SpawnWorker = (options: WorkerOptions) => Worker

/** BuildScriptResult from youtubei.js (utils/javascript/JsExtractor): `output` ends with `return process(…)`. */
interface PlayerScript {
  output: string
}

export type PlayerEvaluator = (data: PlayerScript, env: Record<string, unknown>) => Promise<{ sig?: string; n?: string }>

const MAX_SCRIPT_CHARS = 4 * 1024 * 1024
/** In-worker CPU limit is 3 s; this also covers worker startup and GC thrashing near the heap limit. */
const CALL_TIMEOUT_MS = 8000
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }

const failure = (): Error => new Error('player script failed')

export function createPlayerEvaluator(spawn: SpawnWorker): PlayerEvaluator {
  let worker: Worker | null = null
  let seq = 0
  let queue: Promise<unknown> = Promise.resolve()

  const getWorker = (): Worker => {
    if (worker) return worker
    // env {}: the worker gets an empty process.env (it has no use for the app's).
    const w = spawn({ name: 'nexo-music-evaluator', resourceLimits: RESOURCE_LIMITS, env: {} })
    w.unref()
    w.on('error', () => {}) // reported to the pending call by its own listener
    w.on('exit', () => {
      if (worker === w) worker = null
    })
    worker = w
    return w
  }

  const runOne = (script: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      let w: Worker
      try {
        w = getWorker()
      } catch {
        reject(failure())
        return
      }
      const id = ++seq
      const finish = (out: string | null, kill: boolean): void => {
        clearTimeout(timer)
        w.off('message', onMessage)
        w.off('error', onGone)
        w.off('exit', onGone)
        if (kill || out === null) {
          // A worker that failed, timed out or ran out of memory is not reused.
          if (worker === w) worker = null
          void w.terminate().catch(() => {})
        }
        if (out === null) reject(failure())
        else resolve(out)
      }
      const onMessage = (msg: unknown): void => {
        const r = msg as Partial<EvaluatorReply> | null
        if (!r || r.id !== id) return
        finish(r.ok === true && typeof (r as { out?: unknown }).out === 'string' ? (r as { out: string }).out : null, false)
      }
      const onGone = (): void => finish(null, true)
      const timer = setTimeout(() => finish(null, true), CALL_TIMEOUT_MS)
      w.on('message', onMessage)
      w.on('error', onGone)
      w.on('exit', onGone)
      w.postMessage({ id, script } satisfies EvaluatorRequest)
    })

  return (data) => {
    if (!data || typeof data.output !== 'string' || data.output.length > MAX_SCRIPT_CHARS) {
      return Promise.reject(new Error('player script missing or too large'))
    }
    const script = data.output
    const result = queue.then(() => runOne(script))
    queue = result.catch(() => {})
    return result.then((out) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(out)
      } catch {
        throw new Error('player script returned no result')
      }
      if (typeof parsed !== 'object' || parsed === null) throw new Error('player script returned no result')
      const r = parsed as Record<string, unknown>
      return {
        sig: typeof r.sig === 'string' ? r.sig : undefined,
        n: typeof r.n === 'string' ? r.n : undefined,
      }
    })
  }
}
