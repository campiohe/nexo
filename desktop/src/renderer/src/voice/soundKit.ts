// The synthesis behind the UI sounds (voice/sounds.ts plays them). Pure Web Audio and no imports, so the
// same code also renders offline and in a standalone audition page.
//
// Direction: small physical objects in a small room, never plain beeps. Each family has its own material:
//   - mute / unmute / deafen / undeafen: one of several switch styles (SWITCH_STYLE picks the one the app
//     plays; see SWITCHES). Every style keeps off = down / duller, on = up / brighter, and deafen /
//     undeafen heavier and lower than mute / unmute.
//   - join / leave: two marimba strokes (wooden bar modes 1 : 4 : 9.9 plus a felt-mallet contact). Join
//     rises with a harder mallet, leave falls with a softer, darker one.
//   - message: one water droplet, a sine whose pitch glides up quickly, quieter than the rest.
//   - mention: a glass bell (free-bar modes 1 : 2.76 : 5.40, a detuned twin for shimmer) after a soft
//     grace strike: brighter and longer than a message.
//   - request (someone asks to sign in): a doorbell ding-dong on soft, warm metal tubes.
//   - nudge ("wake up"): a toy woodblock tok-tok, then a bright bell. Most noticeable of the set. A wood
//     block, not a door knock, so it can't be mistaken for someone at the real door.
// Every sound goes through a tiny synthetic room (a 0.4 s convolution reverb, mostly dry), and each play
// gets a few cents of detune, a fraction of a dB of level change and a fresh noise grain, so repeats
// aren't machine-identical.

type SwitchSound = 'mute' | 'unmute' | 'deafen' | 'undeafen'

/**
 * Mute / deafen sound sets:
 * - 'v1': tactile switch, filtered-noise clicks over a low body (the first redesign).
 * - 'pop': rounded tonal pops, a filtered triangle bending down (off) or up (on), no noise.
 * - 'toggle': a soft lowpassed click, then two damped kalimba-tine notes falling (off) or rising (on).
 * - 'cap': resonant "cavity" pops, a cap pressed on (off, dull and falling) or a cork pulled (on, rising).
 */
export type SwitchStyle = 'v1' | 'pop' | 'toggle' | 'cap'

/** The mute / deafen set the app plays. */
export const SWITCH_STYLE: SwitchStyle = 'toggle'

export type VoiceSound =
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'join'
  | 'leave'
  | 'nudge'
  | 'request'
  | 'message'
  | 'mention'

/** Modest peak level (the speaker test in Settings uses 0.25). */
const PEAK = 0.11
/** Per-play random pitch offset, ± cents (the whole sound moves together, so intervals stay in tune). */
const DETUNE_CENTS = 7
/** Per-play random level offset, ± dB. */
const LEVEL_JITTER_DB = 0.6
/** Length of the room impulse; also the tail after the last voice ends. */
const ROOM_SECS = 0.4
/** Room decay to -60 dB (RT60), seconds. */
const ROOM_RT60 = 0.36
/** Shared white-noise buffer; each click reads it from a random offset. */
const NOISE_SECS = 1
/** Every envelope ends with a linear fade from -60 dB to exactly 0 over this long: no click at the end. */
const FADE = 0.004

export interface SoundKit {
  readonly ctx: BaseAudioContext
  /** Dry bus, straight to the destination. */
  readonly dry: AudioNode
  /** Room reverb (stereo impulse, so it also adds a little width). */
  readonly room: ConvolverNode
  readonly noise: AudioBuffer
  /** Sine plus faint 2nd/3rd harmonics, so low "body" tones still register on small speakers. */
  readonly soft: PeriodicWave
}

/** Build the shared nodes and buffers for one context. They live as long as the context does. */
export function createSoundKit(c: BaseAudioContext, dest: AudioNode = c.destination): SoundKit {
  const dry = c.createGain()
  dry.connect(dest)
  const room = c.createConvolver()
  room.normalize = true
  room.buffer = roomImpulse(c)
  room.connect(dest)
  const noise = c.createBuffer(1, Math.round(c.sampleRate * NOISE_SECS), c.sampleRate)
  const nd = noise.getChannelData(0)
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1
  const soft = c.createPeriodicWave(new Float32Array([0, 0, 0, 0]), new Float32Array([0, 1, 0.12, 0.04]))
  return { ctx: c, dry, room, noise, soft }
}

/** A small, slightly dark room: decaying noise that loses its highs as it fades, decorrelated L/R. */
function roomImpulse(c: BaseAudioContext): AudioBuffer {
  const sr = c.sampleRate
  const len = Math.round(sr * ROOM_SECS)
  const preDelay = Math.round(sr * 0.007)
  const fadeLen = Math.round(sr * 0.02)
  const tau = ROOM_RT60 / Math.log(1000)
  const buf = c.createBuffer(2, len, sr)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    let lp = 0
    for (let i = preDelay; i < len; i++) {
      // One-pole lowpass whose cutoff falls along the tail (air and furniture eat the highs first).
      const a = 0.75 - 0.6 * (i / len)
      lp += a * (Math.random() * 2 - 1 - lp)
      const fade = i > len - fadeLen ? (len - i) / fadeLen : 1
      d[i] = lp * Math.exp(-(i - preDelay) / sr / tau) * fade
    }
  }
  return buf
}

/** One play of one sound: a bus with its level and room send, plus bookkeeping to free the nodes. */
interface Voice {
  readonly c: BaseAudioContext
  readonly kit: SoundKit
  readonly bus: GainNode
  readonly t0: number
  /** Pitch multiplier for this play (± DETUNE_CENTS). */
  readonly pitch: number
  readonly rand: () => number
  /** Latest end time scheduled so far (absolute, context time). */
  end: number
  track(src: AudioScheduledSourceNode, nodes: readonly AudioNode[], end: number): void
}

function openVoice(kit: SoundKit, t0: number, level: number, wet: number, rand: () => number): Voice {
  const c = kit.ctx
  const jitter = (): number => rand() * 2 - 1
  const bus = c.createGain()
  bus.gain.value = PEAK * level * 10 ** ((jitter() * LEVEL_JITTER_DB) / 20)
  const send = c.createGain()
  send.gain.value = wet
  bus.connect(kit.dry)
  bus.connect(send)
  send.connect(kit.room)
  let live = 0
  const v: Voice = {
    c,
    kit,
    bus,
    t0,
    pitch: 2 ** ((jitter() * DETUNE_CENTS) / 1200),
    rand,
    end: t0,
    track(src, nodes, end) {
      live++
      v.end = Math.max(v.end, end)
      src.onended = () => {
        for (const n of nodes) n.disconnect()
        if (--live > 0) return
        bus.disconnect()
        send.disconnect()
      }
    },
  }
  return v
}

/** 0 → peak (linear, `attack`) → -60 dB (exponential, `decay`) → exactly 0 (linear, FADE). Returns the end. */
function envelope(p: AudioParam, t: number, peak: number, attack: number, decay: number): number {
  const top = t + attack
  const end = top + decay + FADE
  p.setValueAtTime(0, t)
  p.linearRampToValueAtTime(peak, top)
  p.exponentialRampToValueAtTime(peak * 0.001, top + decay)
  p.linearRampToValueAtTime(0, end)
  return end
}

interface ToneOpts {
  /** Start offset from the sound's start, seconds. */
  at: number
  /** Hz (before the per-play detune). */
  freq: number
  /** Level relative to the sound's level. */
  gain: number
  /** Time from peak to -60 dB, seconds. */
  decay: number
  attack?: number
  /** Glide to this frequency over `glideTime` (exponential, i.e. linear in pitch). */
  glideTo?: number
  glideTime?: number
  /** 'sine' (default), 'triangle' or the kit's soft wave (faint harmonics). */
  wave?: 'sine' | 'soft' | 'triangle'
  /** Run through a lowpass at this cutoff, Hz (follows the detune)... */
  lowpass?: number
  /** ...sweeping to this cutoff over `lowpassTime` (default: `glideTime`). */
  lowpassTo?: number
  lowpassTime?: number
}

function tone(v: Voice, o: ToneOpts): void {
  const { c } = v
  const t = v.t0 + o.at
  const osc = c.createOscillator()
  if (o.wave === 'soft') osc.setPeriodicWave(v.kit.soft)
  else if (o.wave === 'triangle') osc.type = 'triangle'
  const glideTime = o.glideTime ?? 0.04
  osc.frequency.setValueAtTime(o.freq * v.pitch, t)
  if (o.glideTo) osc.frequency.exponentialRampToValueAtTime(o.glideTo * v.pitch, t + glideTime)
  const g = c.createGain()
  g.gain.value = 0
  const end = envelope(g.gain, t, o.gain, o.attack ?? 0.002, o.decay)
  const nodes: AudioNode[] = [osc, g]
  if (o.lowpass) {
    const f = c.createBiquadFilter()
    f.type = 'lowpass'
    f.Q.value = 0
    f.frequency.setValueAtTime(o.lowpass * v.pitch, t)
    const sweepEnd = t + (o.lowpassTime ?? glideTime)
    if (o.lowpassTo) f.frequency.exponentialRampToValueAtTime(o.lowpassTo * v.pitch, sweepEnd)
    osc.connect(f)
    f.connect(g)
    nodes.push(f)
  } else {
    osc.connect(g)
  }
  g.connect(v.bus)
  v.track(osc, nodes, end)
  osc.start(t)
  osc.stop(end + 0.005)
}

/** [frequency ratio, relative gain, decay seconds] of one vibration mode of a struck object. */
type Mode = readonly [ratio: number, gain: number, decay: number]

/** A struck bar / tube / glass: a few sine modes, each with its own decay (higher modes die faster). */
function strike(v: Voice, at: number, freq: number, gain: number, modes: readonly Mode[], attack = 0.0015): void {
  for (const [ratio, g, decay] of modes) tone(v, { at, freq: freq * ratio, gain: gain * g, decay, attack })
}

/** A damped kalimba tine: the fundamental, a faint octave, and a short inharmonic "tick" for the attack. */
function tine(v: Voice, at: number, freq: number, gain: number, decay: number): void {
  strike(v, at, freq, gain, [
    [1, 1, decay],
    [2, 0.16, decay * 0.5],
    [5.4, 0.1, 0.012],
  ])
}

interface NoiseOpts {
  at: number
  gain: number
  decay: number
  attack?: number
  type: BiquadFilterType
  /** Filter frequency, Hz (follows the per-play detune). */
  freq: number
  /** Bandpass quality, or resonance in dB for low/highpass. */
  q?: number
  /** Sweep the filter to this frequency over `sweepTime` (default: the whole decay). */
  sweepTo?: number
  sweepTime?: number
}

/** A filtered noise burst: clicks, mallet contact, the "air" of a switch. */
function noise(v: Voice, o: NoiseOpts): void {
  const { c } = v
  const t = v.t0 + o.at
  const src = c.createBufferSource()
  src.buffer = v.kit.noise
  const f = c.createBiquadFilter()
  f.type = o.type
  f.Q.value = o.q ?? 0.7
  f.frequency.setValueAtTime(o.freq * v.pitch, t)
  if (o.sweepTo) f.frequency.exponentialRampToValueAtTime(o.sweepTo * v.pitch, t + (o.sweepTime ?? o.decay))
  const g = c.createGain()
  g.gain.value = 0
  const end = envelope(g.gain, t, o.gain, o.attack ?? 0.001, o.decay)
  src.connect(f)
  f.connect(g)
  g.connect(v.bus)
  v.track(src, [src, f, g], end)
  src.start(t, v.rand() * (NOISE_SECS - 0.3))
  src.stop(end + 0.005)
}

// Struck-object mode sets.
/** Tuned marimba bar, hard mallet. */
const MARIMBA: readonly Mode[] = [
  [1, 1, 0.24],
  [3.99, 0.22, 0.055],
  [9.88, 0.05, 0.02],
]
/** Same bar, softer mallet: less of the upper modes. */
const MARIMBA_SOFT: readonly Mode[] = [
  [1, 1, 0.24],
  [3.99, 0.1, 0.045],
  [9.88, 0.015, 0.015],
]
/** Glass / free bar (inharmonic), with a slightly detuned twin of the fundamental that shimmers. */
const GLASS: readonly Mode[] = [
  [1, 1, 0.36],
  [1.0065, 0.35, 0.3],
  [2.756, 0.22, 0.12],
  [5.404, 0.07, 0.045],
]
/** Doorbell tube: warm, mostly harmonic, a touch of an inharmonic overtone. */
const TUBE: readonly Mode[] = [
  [1, 1, 0.3],
  [2.0, 0.14, 0.14],
  [2.92, 0.05, 0.06],
]
/** Bright bell for the nudge: octave and glassy overtones over a shimmering fundamental. */
const BELL: readonly Mode[] = [
  [1, 1, 0.44],
  [1.006, 0.3, 0.4],
  [2.0, 0.24, 0.2],
  [2.756, 0.16, 0.12],
  [5.404, 0.05, 0.05],
]
/** Wood block: one strong resonance and a quick inharmonic overtone. */
const WOOD: readonly Mode[] = [
  [1, 1, 0.055],
  [2.38, 0.25, 0.025],
]

interface Recipe {
  /**
   * Level relative to PEAK. Balanced on perceived loudness, not peak (K-weighted, loudest 50 ms, measured
   * offline): switches ≈ -30 dB, message -29, join / leave -27, request -26, mention -25.5, nudge -24.5.
   * Peaks stay at or below 1.25 × PEAK.
   */
  level: number
  /** Room send. */
  wet: number
  draw(v: Voice): void
}

const SWITCHES: Record<SwitchStyle, Record<SwitchSound, Recipe>> = {
  // Tactile switch: filtered-noise clicks over a short body tone that drops in pitch. Off = the bright
  // latch tick first and the low thunk last (closing), on = thunk first, bright tick last (opening).
  // Deafen / undeafen are a heavier switch with a muffle sweep closing (deafen) or opening (undeafen).
  v1: {
    mute: {
      level: 1.35,
      wet: 0.07,
      draw(v) {
        noise(v, { at: 0, gain: 0.35, decay: 0.012, type: 'bandpass', freq: 4200, q: 1.4 })
        noise(v, { at: 0.028, gain: 0.7, decay: 0.022, type: 'bandpass', freq: 1500, q: 1 })
        tone(v, { at: 0.028, freq: 240, glideTo: 150, glideTime: 0.04, gain: 0.75, decay: 0.085, wave: 'soft' })
      },
    },
    // Small switch, opening: the thunk first (a higher body), then a bright tick with a tiny spring ping.
    unmute: {
      level: 1.7,
      wet: 0.07,
      draw(v) {
        noise(v, { at: 0, gain: 0.6, decay: 0.018, type: 'bandpass', freq: 2000, q: 1 })
        tone(v, { at: 0.003, freq: 310, glideTo: 255, glideTime: 0.03, gain: 0.7, decay: 0.065, wave: 'soft' })
        noise(v, { at: 0.035, gain: 0.3, decay: 0.012, type: 'bandpass', freq: 5200, q: 1.8 })
        tone(v, { at: 0.035, freq: 2650, gain: 0.08, decay: 0.035 })
      },
    },
    // Heavier switch with a muffle: a hiss closing from bright to dull, landing on a deep thunk. ~145 ms.
    deafen: {
      level: 1.12,
      wet: 0.08,
      draw(v) {
        noise(v, { at: 0, gain: 0.3, attack: 0.012, decay: 0.08, type: 'lowpass', freq: 4000, sweepTo: 450, q: 2 })
        noise(v, { at: 0.05, gain: 0.6, decay: 0.024, type: 'bandpass', freq: 900, q: 1.2 })
        tone(v, { at: 0.05, freq: 190, glideTo: 112, glideTime: 0.05, gain: 0.9, decay: 0.09, wave: 'soft' })
      },
    },
    // Heavier switch, opening: the thunk, then the hiss swelling from dull to bright ("the room comes back").
    undeafen: {
      level: 1.43,
      wet: 0.08,
      draw(v) {
        noise(v, { at: 0, gain: 0.55, decay: 0.02, type: 'bandpass', freq: 1100, q: 1.2 })
        tone(v, { at: 0, freq: 175, glideTo: 135, glideTime: 0.04, gain: 0.8, decay: 0.075, wave: 'soft' })
        noise(v, {
          at: 0.025,
          gain: 0.28,
          attack: 0.03,
          decay: 0.07,
          type: 'bandpass',
          freq: 700,
          sweepTo: 4500,
          q: 0.8,
        })
      },
    },
  },
  // Rounded tonal pops, no noise: a triangle through a moving lowpass, like a muted bubble / soft button.
  // Mute bends down while the filter closes, unmute bends up while it opens. Deafen / undeafen are a lower
  // double pop (bop-bop) stepping down / up.
  pop: {
    mute: {
      level: 1.15,
      wet: 0.07,
      draw(v) {
        tone(v, {
          at: 0,
          freq: 640,
          glideTo: 330,
          glideTime: 0.06,
          lowpass: 2600,
          lowpassTo: 700,
          wave: 'triangle',
          gain: 1,
          attack: 0.004,
          decay: 0.1,
        })
      },
    },
    unmute: {
      level: 1.19,
      wet: 0.07,
      draw(v) {
        tone(v, {
          at: 0,
          freq: 340,
          glideTo: 660,
          glideTime: 0.05,
          lowpass: 900,
          lowpassTo: 3200,
          wave: 'triangle',
          gain: 1,
          attack: 0.004,
          decay: 0.09,
        })
      },
    },
    deafen: {
      level: 1.22,
      wet: 0.08,
      draw(v) {
        tone(v, {
          at: 0,
          freq: 430,
          glideTo: 300,
          glideTime: 0.04,
          lowpass: 1800,
          lowpassTo: 900,
          wave: 'triangle',
          gain: 0.7,
          attack: 0.004,
          decay: 0.055,
        })
        tone(v, {
          at: 0.05,
          freq: 300,
          glideTo: 160,
          glideTime: 0.06,
          lowpass: 1000,
          lowpassTo: 400,
          wave: 'triangle',
          gain: 1,
          attack: 0.004,
          decay: 0.085,
        })
      },
    },
    undeafen: {
      level: 1.23,
      wet: 0.08,
      draw(v) {
        tone(v, {
          at: 0,
          freq: 200,
          glideTo: 290,
          glideTime: 0.04,
          lowpass: 600,
          lowpassTo: 1200,
          wave: 'triangle',
          gain: 0.7,
          attack: 0.004,
          decay: 0.055,
        })
        tone(v, {
          at: 0.05,
          freq: 290,
          glideTo: 440,
          glideTime: 0.05,
          lowpass: 1000,
          lowpassTo: 2400,
          wave: 'triangle',
          gain: 1,
          attack: 0.004,
          decay: 0.085,
        })
      },
    },
  },
  // Soft physical toggle: a warm lowpassed click with a little thump (no bright hiss), then two short,
  // damped kalimba-tine notes that carry the direction: falling = off, rising = on. Mute / unmute on
  // A5 / E5, deafen / undeafen lower on G4 / D4 with a heavier click and thump.
  toggle: {
    mute: {
      level: 1.22,
      wet: 0.08,
      draw(v) {
        noise(v, { at: 0, gain: 0.35, decay: 0.008, type: 'lowpass', freq: 1300, q: 0 })
        tone(v, { at: 0, freq: 180, glideTo: 130, glideTime: 0.02, gain: 0.35, decay: 0.025, wave: 'soft' })
        tine(v, 0.012, 880, 0.55, 0.045)
        tine(v, 0.05, 659.3, 0.85, 0.085)
      },
    },
    unmute: {
      level: 1.2,
      wet: 0.08,
      draw(v) {
        noise(v, { at: 0, gain: 0.35, decay: 0.008, type: 'lowpass', freq: 1600, q: 0 })
        tone(v, { at: 0, freq: 190, glideTo: 140, glideTime: 0.02, gain: 0.35, decay: 0.025, wave: 'soft' })
        tine(v, 0.012, 659.3, 0.55, 0.045)
        tine(v, 0.05, 880, 0.85, 0.085)
      },
    },
    deafen: {
      level: 1.12,
      wet: 0.09,
      draw(v) {
        noise(v, { at: 0, gain: 0.45, decay: 0.01, type: 'lowpass', freq: 800, q: 0 })
        tone(v, { at: 0, freq: 140, glideTo: 95, glideTime: 0.03, gain: 0.6, decay: 0.04, wave: 'soft' })
        tine(v, 0.015, 392, 0.6, 0.05)
        tine(v, 0.055, 293.7, 0.95, 0.085)
      },
    },
    undeafen: {
      level: 1.12,
      wet: 0.09,
      draw(v) {
        noise(v, { at: 0, gain: 0.45, decay: 0.01, type: 'lowpass', freq: 950, q: 0 })
        tone(v, { at: 0, freq: 150, glideTo: 105, glideTime: 0.03, gain: 0.6, decay: 0.04, wave: 'soft' })
        tine(v, 0.015, 293.7, 0.6, 0.05)
        tine(v, 0.055, 392, 0.95, 0.085)
      },
    },
  },
  // Resonant cavity: noise through a narrow (high-Q) bandpass rings like a hollow object instead of hissing.
  // Mute = pressing a cap on (dull, the resonance falls), unmute = pulling a cork (a pop that rises).
  // Deafen = hands over your ears (a low resonance sinking, "the world gets muffled"), undeafen = taking
  // them off (a swell rising back open).
  cap: {
    mute: {
      level: 2.34,
      wet: 0.07,
      draw(v) {
        const cap = { type: 'bandpass', q: 10 } as const
        noise(v, { ...cap, at: 0, gain: 1, decay: 0.06, freq: 900, sweepTo: 420, sweepTime: 0.04 })
        tone(v, { at: 0.004, freq: 230, glideTo: 140, glideTime: 0.04, gain: 0.5, decay: 0.07, wave: 'soft' })
      },
    },
    unmute: {
      level: 4.3,
      wet: 0.07,
      draw(v) {
        const cork = { type: 'bandpass', q: 10 } as const
        noise(v, { ...cork, at: 0, gain: 1, decay: 0.055, freq: 520, sweepTo: 1400, sweepTime: 0.035 })
        tone(v, { at: 0.004, freq: 400, glideTo: 820, glideTime: 0.03, gain: 0.3, decay: 0.055 })
      },
    },
    deafen: {
      level: 1.64,
      wet: 0.09,
      draw(v) {
        noise(v, {
          at: 0,
          gain: 1,
          attack: 0.01,
          decay: 0.12,
          type: 'bandpass',
          freq: 1200,
          sweepTo: 220,
          sweepTime: 0.11,
          q: 6,
        })
        tone(v, { at: 0.03, freq: 160, glideTo: 95, glideTime: 0.06, gain: 0.6, decay: 0.1, wave: 'soft' })
      },
    },
    undeafen: {
      level: 1.88,
      wet: 0.09,
      draw(v) {
        tone(v, { at: 0, freq: 110, glideTo: 170, glideTime: 0.05, gain: 0.6, decay: 0.08, wave: 'soft' })
        noise(v, {
          at: 0,
          gain: 1,
          attack: 0.025,
          decay: 0.1,
          type: 'bandpass',
          freq: 250,
          sweepTo: 1600,
          sweepTime: 0.1,
          q: 6,
        })
      },
    },
  },
}

const RECIPES: Record<Exclude<VoiceSound, SwitchSound>, Recipe> = {
  // Someone (or you) entered the voice channel: two rising marimba strokes, A4 → E5, hard mallet. ~340 ms.
  join: {
    level: 0.95,
    wet: 0.16,
    draw(v) {
      noise(v, { at: 0, gain: 0.12, decay: 0.008, type: 'lowpass', freq: 2200 })
      strike(v, 0, 440, 0.7, MARIMBA)
      noise(v, { at: 0.085, gain: 0.14, decay: 0.008, type: 'lowpass', freq: 2200 })
      strike(v, 0.085, 659.3, 1, MARIMBA)
    },
  },
  // ...left it: two falling strokes, D5 → A4, softer and darker mallet.
  leave: {
    level: 1.02,
    wet: 0.16,
    draw(v) {
      noise(v, { at: 0, gain: 0.08, decay: 0.008, type: 'lowpass', freq: 1300 })
      strike(v, 0, 587.3, 0.85, MARIMBA_SOFT)
      noise(v, { at: 0.09, gain: 0.07, decay: 0.008, type: 'lowpass', freq: 1300 })
      strike(v, 0.09, 440, 0.9, MARIMBA_SOFT)
    },
  },
  // Someone nudged you ("wake up"): wood block tok-tok, then a bright bell (E6). ~670 ms. Heard while
  // deafened too: deafen silences the call's <audio> elements, not this context.
  nudge: {
    level: 0.92,
    wet: 0.18,
    draw(v) {
      for (const [at, f] of [
        [0, 1020],
        [0.1, 960],
      ] as const) {
        noise(v, { at, gain: 0.35, decay: 0.02, type: 'bandpass', freq: f, q: 6 })
        strike(v, at, f, 0.6, WOOD, 0.001)
      }
      noise(v, { at: 0.22, gain: 0.06, decay: 0.006, type: 'highpass', freq: 5000 })
      strike(v, 0.22, 1318.5, 0.85, BELL)
    },
  },
  // Someone asks to sign in (docs/SPEC-ACCOUNTS.md §4): a soft doorbell ding-dong, E5 → C5. ~440 ms.
  request: {
    level: 0.98,
    wet: 0.18,
    draw(v) {
      strike(v, 0, 659.3, 0.85, TUBE, 0.005)
      noise(v, { at: 0, gain: 0.05, decay: 0.01, type: 'lowpass', freq: 1800 })
      strike(v, 0.16, 523.3, 1, TUBE, 0.005)
      noise(v, { at: 0.16, gain: 0.05, decay: 0.01, type: 'lowpass', freq: 1800 })
    },
  },
  // A chat message in a channel you're not looking at (lib/notify.ts): one water droplet. ~130 ms.
  message: {
    level: 1.08,
    wet: 0.2,
    draw(v) {
      tone(v, { at: 0, freq: 520, glideTo: 1350, glideTime: 0.05, gain: 1, attack: 0.002, decay: 0.11 })
    },
  },
  // Someone mentioned you: a soft grace strike, then a glass bell (A5 → D6). ~440 ms.
  mention: {
    level: 0.74,
    wet: 0.2,
    draw(v) {
      strike(v, 0, 880, 0.4, [
        [1, 1, 0.1],
        [2.756, 0.15, 0.04],
      ])
      noise(v, { at: 0.075, gain: 0.05, decay: 0.006, type: 'highpass', freq: 4500 })
      strike(v, 0.075, 1174.7, 1, GLASS)
    },
  },
}

function isSwitch(sound: VoiceSound): sound is SwitchSound {
  return sound === 'mute' || sound === 'unmute' || sound === 'deafen' || sound === 'undeafen'
}

/**
 * Schedule `sound` on the kit at context time `when`. Returns how long (seconds from `when`) until
 * everything, room tail included, is silent.
 */
export function playSound(
  kit: SoundKit,
  sound: VoiceSound,
  when = kit.ctx.currentTime + 0.01,
  rand: () => number = Math.random,
  switchStyle: SwitchStyle = SWITCH_STYLE,
): number {
  const r = isSwitch(sound) ? SWITCHES[switchStyle][sound] : RECIPES[sound]
  const v = openVoice(kit, when, r.level, r.wet, rand)
  r.draw(v)
  return v.end - when + ROOM_SECS
}
