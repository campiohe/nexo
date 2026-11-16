// Worker thread side of evaluator.ts: runs one player script at a time in a fresh, locked-down V8 context and
// answers with a JSON string (or a bare failure). Started by evaluator.ts with resourceLimits, so a script
// that allocates without bound kills this worker, not the main process.
//
// The script is untrusted (YouTube's code, downloaded at runtime). Nothing it produces is ever touched here
// except through `typeof` on the completion value: a thrown value is caught without a binding (no
// instanceof, no property reads, no inspection, which could run getters / proxy traps / inspect hooks),
// and the result must be a primitive string. The reply posted to the main thread is built only from our own
// values, so nothing from the sandbox crosses over, not even by structured clone.
//
// The context: DONT_CONTEXTIFY (an ordinary global object of the new context, no interceptors forwarding to
// a host object, so no `this.constructor.constructor('return process')` escape), eval/new Function and
// WebAssembly compilation disabled, a CPU timeout, and Promise jobs drained inside runInContext under that
// same timeout (microtaskMode 'afterEvaluate'). Each call gets a new context.
import { parentPort } from 'node:worker_threads'
import vm from 'node:vm'

const TIMEOUT_MS = 3000
const MAX_SCRIPT_CHARS = 4 * 1024 * 1024
const MAX_RESULT_CHARS = 64 * 1024

export type EvaluatorRequest = { id: number; script: string }
export type EvaluatorReply = { id: number; ok: true; out: string } | { id: number; ok: false }

function run(script: string): string | null {
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    name: 'nexo-music-player',
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  })
  const code = `JSON.stringify((function () {\n${script}\n})())`
  let out: unknown
  try {
    out = vm.runInContext(code, context, { timeout: TIMEOUT_MS, displayErrors: false })
  } catch {
    // Deliberately unbound: the thrown value may be a hostile object.
    return null
  }
  // typeof never runs sandbox code (no traps for it), and a string is a primitive: safe to keep.
  return typeof out === 'string' && out.length <= MAX_RESULT_CHARS ? out : null
}

const port = parentPort
if (port) {
  port.on('message', (msg: unknown) => {
    const req = msg as Partial<EvaluatorRequest> | null
    const id = typeof req?.id === 'number' ? req.id : -1
    const script = req?.script
    let reply: EvaluatorReply = { id, ok: false }
    if (typeof script === 'string' && script.length <= MAX_SCRIPT_CHARS) {
      const out = run(script)
      if (out !== null) reply = { id, ok: true, out }
    }
    port.postMessage(reply)
  })
}
