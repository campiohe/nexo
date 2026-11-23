// AudioWorklet of the emulator engine (engine/audio.ts). Plain JS on purpose: it's loaded as-is from 'self'
// (`?url&no-inline`), never bundled.
//
// The main thread posts each emulated frame's sound ({ l, r }: Float32Array at the core's rate, ~32040 Hz). This
// node resamples it to the context's rate (4-point Hermite) and plays it. Every other render quantum it reports
// how many source frames it has consumed so far ({ consumed }): that report is the emulator's clock (the main
// thread runs a frame whenever less than its target is queued), so the game runs exactly at the speed the sound
// card plays it, with no drift and no resampling-ratio tricks. Underruns play silence (and don't count).
const CAPACITY = 1 << 15 // source frames per channel (~1 s at 32 kHz)
const MAX_QUEUED = 1 << 14 // drop the oldest audio past ~0.5 s (a long main-thread stall)

class NexoEmulatorAudio extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.step = options.processorOptions.sourceRate / sampleRate
    this.l = new Float32Array(CAPACITY)
    this.r = new Float32Array(CAPACITY)
    this.read = 0 // integer read index (monotonic; masked on access)
    this.write = 0
    this.frac = 0
    this.consumed = 0
    this.quanta = 0
    this.alive = true
    this.port.onmessage = (e) => {
      const m = e.data
      if (m.type === 'samples') this.push(m.l, m.r)
      else if (m.type === 'clear') {
        this.consumed += this.write - this.read
        this.read = this.write
        this.frac = 0
      } else if (m.type === 'stop') this.alive = false
    }
  }

  push(l, r) {
    const n = l.length
    for (let i = 0; i < n; i++) {
      const w = (this.write + i) & (CAPACITY - 1)
      this.l[w] = l[i]
      this.r[w] = r[i]
    }
    this.write += n
    const queued = this.write - this.read
    if (queued > MAX_QUEUED) {
      const drop = queued - MAX_QUEUED
      this.read += drop
      this.consumed += drop
    }
  }

  process(_inputs, outputs) {
    if (!this.alive) return false
    const out = outputs[0]
    const outL = out[0]
    const outR = out[1] ?? out[0]
    const n = outL.length
    const mask = CAPACITY - 1
    const L = this.l
    const R = this.r
    let i = 0
    // Hermite needs samples at read-1 .. read+2.
    for (; i < n && this.write - this.read >= 3; i++) {
      const t = this.frac
      const p = this.read
      const a = (p - 1) & mask
      const b = p & mask
      const c = (p + 1) & mask
      const d = (p + 2) & mask
      outL[i] = hermite(L[a], L[b], L[c], L[d], t)
      outR[i] = hermite(R[a], R[b], R[c], R[d], t)
      this.frac += this.step
      const whole = Math.floor(this.frac)
      this.frac -= whole
      this.read += whole
      this.consumed += whole
    }
    for (; i < n; i++) {
      outL[i] = 0
      outR[i] = 0
    }
    if ((++this.quanta & 1) === 0) this.port.postMessage(this.consumed)
    return true
  }
}

function hermite(xm1, x0, x1, x2, t) {
  const c = (x1 - xm1) * 0.5
  const v = x0 - x1
  const w = c + v
  const a = w + v + (x2 - x0) * 0.5
  const bNeg = w + a
  return ((a * t - bNeg) * t + c) * t + x0
}

registerProcessor('nexo-emulator-audio', NexoEmulatorAudio)
