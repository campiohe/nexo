// JavaScript evaluator for youtubei.js (Platform.shim.eval): runs the signature / "n" deciphering code that
// youtubei.js extracts from YouTube's player script. That code is YouTube's, downloaded at runtime: treat it as
// untrusted. It runs in a fresh V8 context with nothing from Node or Electron in it (DONT_CONTEXTIFY: an
// ordinary global object of the new context, no interceptors forwarding to a host object, so no
// `this.constructor.constructor('return process')` escape), with eval/new Function and WebAssembly compilation
// disabled, a CPU timeout, and the result handed back as a JSON string (a primitive: no object from the
// sandbox ever reaches main). Each call gets a new context, so nothing persists between calls.
//
// Only needed for clients whose stream URLs are ciphered (the YTMUSIC fallback); ANDROID_VR / VISIONOS / IOS
// return plain URLs.
import vm from 'node:vm'

/** BuildScriptResult from youtubei.js (utils/javascript/JsExtractor): `output` ends with `return process(…)`. */
interface PlayerScript {
  output: string
}

const TIMEOUT_MS = 3000
const MAX_SCRIPT_CHARS = 4 * 1024 * 1024

export function evaluatePlayerScript(data: PlayerScript, _env: Record<string, unknown>): { sig?: string; n?: string } {
  if (!data || typeof data.output !== 'string' || data.output.length > MAX_SCRIPT_CHARS) {
    throw new Error('player script missing or too large')
  }
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    name: 'nexo-music-player',
    codeGeneration: { strings: false, wasm: false },
    // Promise jobs queued by the script run inside runInContext, under the same timeout.
    microtaskMode: 'afterEvaluate',
  })
  const code = `JSON.stringify((function () {\n${data.output}\n})())`
  const out: unknown = vm.runInContext(code, context, { timeout: TIMEOUT_MS, displayErrors: false })
  if (typeof out !== 'string' || out.length > 64 * 1024) throw new Error('player script returned no result')
  const parsed: unknown = JSON.parse(out)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('player script returned no result')
  const r = parsed as Record<string, unknown>
  return {
    sig: typeof r.sig === 'string' ? r.sig : undefined,
    n: typeof r.n === 'string' ? r.n : undefined,
  }
}
