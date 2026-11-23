// Plugins and the Music plugin ("listen together", docs/SPEC.md §5.4): the state machine (music.ts) driven
// directly with a fake clock and fake timers, then the socket events (`plugins:set`, `time:now`, `music:add`,
// `music:control`) through an in-process server with the same fakes. Run with `npm test -w server`.
import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client'
import type {
  AckResult,
  Bootstrap,
  Channel,
  ClientToServerEvents,
  MusicState,
  MusicTrackInfo,
  ServerPlugins,
  ServerToClientEvents,
  VoiceState,
} from '../../shared/protocol.ts'
import { MUSIC_MAX_ADD, MUSIC_MAX_QUEUE, MUSIC_MAX_TRACK_MS } from '../../shared/protocol.ts'
import { createMusic, MUSIC_LIMITS, parseTrackInfo, type MusicTimers } from '../src/music.ts'
import { MUSIC_ERRORS, PLUGIN_ERRORS, start, type NexoInstance, type StartOptions } from '../src/server.ts'

// ---------- fakes ----------

/** A manual clock plus timers that fire only when `advance` moves the clock past them. */
function fakeTime(start = 1_700_000_000_000) {
  const clock = { t: start }
  const pending = new Map<number, { at: number; fn: () => void }>()
  let nextId = 0
  const timers: MusicTimers = {
    set(fn, ms) {
      const id = ++nextId
      pending.set(id, { at: clock.t + Math.max(0, ms), fn })
      return id
    },
    clear: (h) => void pending.delete(h as number),
  }
  return {
    clock,
    now: () => clock.t,
    timers,
    pending: () => pending.size,
    /** Moves the clock forward, firing due timers in order (each at its own time). */
    advance(ms: number) {
      const target = clock.t + ms
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | undefined
        for (const e of pending) if (e[1].at <= target && (!due || e[1].at < due[1].at)) due = e
        if (!due) break
        pending.delete(due[0])
        clock.t = Math.max(clock.t, due[1].at)
        due[1].fn()
      }
      clock.t = target
    },
  }
}

let vid = 0
/** A valid track with a unique video id. */
function track(over: Partial<MusicTrackInfo> = {}): MusicTrackInfo {
  const id = `vid${String(++vid).padStart(8, '0')}`
  return { videoId: id, title: `Song ${id}`, artist: 'Artist', album: null, durationMs: 60_000, artwork: null, ...over }
}

// ---------- state machine ----------

describe('music state machine', () => {
  let time: ReturnType<typeof fakeTime>
  let states: MusicState[]
  let music: ReturnType<typeof createMusic>
  const CH = 'ch1'
  const GRACE = MUSIC_LIMITS.advanceGraceMs
  const IDLE = 60_000
  const state = (r: MusicState | string): MusicState => {
    if (typeof r === 'string') assert.fail(`unexpected error: ${r}`)
    return r
  }

  beforeEach(() => {
    time = fakeTime()
    states = []
    let n = 0
    music = createMusic({ onState: (s) => states.push(s), now: time.now, timers: time.timers, idleClearMs: IDLE, newId: () => `q${++n}` })
  })

  test('track validation', () => {
    const ok = track()
    assert.deepEqual(parseTrackInfo({ ...ok, extra: 1 }), ok)
    assert.equal(parseTrackInfo({ ...ok, videoId: 'short' }), null)
    assert.equal(parseTrackInfo({ ...ok, videoId: 'abc$efghijk' }), null)
    assert.equal(parseTrackInfo({ ...ok, title: 'x'.repeat(201) }), null)
    assert.equal(parseTrackInfo({ ...ok, title: 'x'.repeat(200) })?.title.length, 200)
    assert.equal(parseTrackInfo({ ...ok, title: ' \n\t ' }), null)
    assert.equal(parseTrackInfo({ ...ok, title: '  A\n\tsong‮ ' })?.title, 'A song')
    assert.equal(parseTrackInfo({ ...ok, artist: '' })?.artist, '')
    assert.equal(parseTrackInfo({ ...ok, artist: 'y'.repeat(201) }), null)
    assert.equal(parseTrackInfo({ ...ok, artist: undefined }), null)
    assert.equal(parseTrackInfo({ ...ok, album: '  ' })?.album, null)
    assert.equal(parseTrackInfo({ ...ok, album: 'Album' })?.album, 'Album')
    assert.equal(parseTrackInfo({ ...ok, album: 3 }), null)
    assert.equal(parseTrackInfo({ ...ok, durationMs: 999 }), null)
    assert.equal(parseTrackInfo({ ...ok, durationMs: 1000 })?.durationMs, 1000)
    assert.equal(parseTrackInfo({ ...ok, durationMs: MUSIC_MAX_TRACK_MS })?.durationMs, MUSIC_MAX_TRACK_MS)
    assert.equal(parseTrackInfo({ ...ok, durationMs: MUSIC_MAX_TRACK_MS + 1 }), null)
    assert.equal(parseTrackInfo({ ...ok, durationMs: 1500.5 }), null)
    assert.equal(parseTrackInfo({ ...ok, durationMs: '60000' }), null)
    assert.equal(parseTrackInfo(null), null)
    // Artwork: dropped, never an error.
    const art = (artwork: unknown) => parseTrackInfo({ ...ok, artwork })?.artwork
    assert.equal(art('https://i.ytimg.com/vi/abc/hqdefault.jpg'), 'https://i.ytimg.com/vi/abc/hqdefault.jpg')
    assert.equal(art('https://ytimg.com/a.jpg'), 'https://ytimg.com/a.jpg')
    assert.equal(art('https://lh3.googleusercontent.com/abc=w120-h120'), 'https://lh3.googleusercontent.com/abc=w120-h120')
    assert.equal(art('http://i.ytimg.com/vi/abc/hqdefault.jpg'), null)
    assert.equal(art('https://example.com/a.jpg'), null)
    assert.equal(art('https://evilytimg.com/a.jpg'), null)
    assert.equal(art('https://i.ytimg.com.evil.com/a.jpg'), null)
    assert.equal(art('https://googleusercontent.com.evil.com/a.jpg'), null)
    assert.equal(art('https://user:pw@i.ytimg.com/a.jpg'), null)
    assert.equal(art('https://i.ytimg.com:8443/a.jpg'), null)
    assert.equal(art('not a url'), null)
    assert.equal(art(42), null)
  })

  test('add starts the first track now; next inserts after the current one; limits', () => {
    const [a, b, c, d] = [track(), track(), track(), track()]
    let s = state(music.add(CH, 'u1', [a, b], false))
    assert.equal(s.current?.videoId, a.videoId)
    assert.equal(s.current?.addedBy, 'u1')
    assert.equal(s.startedAt, time.clock.t)
    assert.equal(s.pausedAt, null)
    assert.deepEqual(s.queue.map((t) => t.videoId), [b.videoId])
    s = state(music.add(CH, 'u2', [c], false))
    s = state(music.add(CH, 'u2', [d], true))
    assert.deepEqual(s.queue.map((t) => t.videoId), [d.videoId, b.videoId, c.videoId])
    assert.equal(new Set([s.current!.queueId, ...s.queue.map((t) => t.queueId)]).size, 4)
    assert.equal(states.length, 3)
    assert.ok(states[0].rev < states[1].rev && states[1].rev < states[2].rev)

    assert.equal(music.add(CH, 'u1', [], false), MUSIC_ERRORS.invalidTrack)
    assert.equal(music.add(CH, 'u1', 'nope', false), MUSIC_ERRORS.invalidTrack)
    assert.equal(music.add(CH, 'u1', [track(), { ...track(), videoId: 'bad' }], false), MUSIC_ERRORS.invalidTrack)
    const many = Array.from({ length: MUSIC_MAX_ADD + 1 }, () => track())
    assert.equal(music.add(CH, 'u1', many, false), 'You can add at most 100 tracks at once')
    // 3 queued + 100 + 97 = 200 fits; one more doesn't.
    state(music.add(CH, 'u1', many.slice(0, 100), false))
    state(music.add(CH, 'u1', many.slice(0, MUSIC_MAX_QUEUE - 103), false))
    assert.equal(music.state(CH).queue.length, MUSIC_MAX_QUEUE)
    assert.equal(music.add(CH, 'u1', [track()], false), 'The queue is full (200 tracks)')
    assert.equal(states.length, 5) // errors don't broadcast
  })

  test('the queue limit counts the track that starts playing', () => {
    const many = Array.from({ length: 100 }, () => track())
    state(music.add('fresh', 'u', many, false)) // 1 current + 99 queued
    state(music.add('fresh', 'u', many.slice(0, 100), false)) // 199
    state(music.add('fresh', 'u', many.slice(0, 1), false)) // 200
    assert.equal(music.add('fresh', 'u', many.slice(0, 1), false), MUSIC_ERRORS.queueFull)
  })

  test('pause / play / seek timing', () => {
    const t0 = time.clock.t
    state(music.add(CH, 'u', [track({ durationMs: 120_000 })], false))
    time.advance(10_000)
    assert.equal(music.positionOf(CH), 10_000)
    let s = state(music.control(CH, { action: 'pause' }))
    assert.equal(s.startedAt, null)
    assert.equal(s.pausedAt, 10_000)
    time.advance(5000)
    assert.equal(music.positionOf(CH), 10_000)
    const before = states.length
    state(music.control(CH, { action: 'pause' })) // no-op: no broadcast
    assert.equal(states.length, before)
    s = state(music.control(CH, { action: 'seek', positionMs: 30_000 }))
    assert.equal(s.pausedAt, 30_000)
    s = state(music.control(CH, { action: 'play' }))
    assert.equal(s.startedAt, time.clock.t - 30_000)
    assert.equal(s.pausedAt, null)
    time.advance(1000)
    assert.equal(music.positionOf(CH), 31_000)
    s = state(music.control(CH, { action: 'seek', positionMs: 999_999 }))
    assert.equal(time.clock.t - s.startedAt!, 119_000) // clamped to durationMs - 1000
    s = state(music.control(CH, { action: 'seek', positionMs: -50 }))
    assert.equal(s.startedAt, time.clock.t)
    assert.equal(music.control(CH, { action: 'seek' }), MUSIC_ERRORS.invalidAction)
    assert.equal(music.control(CH, { action: 'seek', positionMs: Number.NaN }), MUSIC_ERRORS.invalidAction)
    assert.equal(music.control(CH, { action: 'dance' }), MUSIC_ERRORS.invalidAction)
    assert.ok(t0 < time.clock.t)
  })

  test('skip / previous (restart after 3 s, go back within 3 s)', () => {
    const [a, b, c] = [track(), track(), track()]
    state(music.add(CH, 'u', [a, b, c], false))
    // No history: previous restarts.
    time.advance(1000)
    let s = state(music.control(CH, { action: 'previous' }))
    assert.equal(s.current?.videoId, a.videoId)
    assert.equal(s.startedAt, time.clock.t)
    s = state(music.control(CH, { action: 'skip' }))
    assert.equal(s.current?.videoId, b.videoId)
    assert.equal(s.startedAt, time.clock.t)
    assert.deepEqual(s.queue.map((t) => t.videoId), [c.videoId])
    // After 3 s: restart the current one.
    time.advance(5000)
    s = state(music.control(CH, { action: 'previous' }))
    assert.equal(s.current?.videoId, b.videoId)
    assert.equal(s.startedAt, time.clock.t)
    // Within 3 s: back to a, b goes back to the front of the queue (same queueId).
    time.advance(2000)
    const bId = s.current!.queueId
    s = state(music.control(CH, { action: 'previous' }))
    assert.equal(s.current?.videoId, a.videoId)
    assert.deepEqual(s.queue.map((t) => t.queueId)[0], bId)
    assert.deepEqual(s.queue.map((t) => t.videoId), [b.videoId, c.videoId])
    // Skip while paused plays the next one.
    state(music.control(CH, { action: 'pause' }))
    s = state(music.control(CH, { action: 'skip' }))
    assert.equal(s.current?.videoId, b.videoId)
    assert.equal(s.startedAt, time.clock.t)
    // Skip past the end stops; previous then replays the last one.
    state(music.control(CH, { action: 'skip' }))
    s = state(music.control(CH, { action: 'skip' }))
    assert.equal(s.current, null)
    assert.equal(s.startedAt, null)
    assert.deepEqual(music.active(), [])
    s = state(music.control(CH, { action: 'previous' }))
    assert.equal(s.current?.videoId, c.videoId)
  })

  test('remove / move / clear / stop', () => {
    const tracks = [track(), track(), track(), track(), track()]
    let s = state(music.add(CH, 'u', tracks, false))
    const ids = s.queue.map((t) => t.queueId) // 4 queued
    s = state(music.control(CH, { action: 'move', queueId: ids[3], toIndex: 0 }))
    assert.deepEqual(s.queue.map((t) => t.queueId), [ids[3], ids[0], ids[1], ids[2]])
    s = state(music.control(CH, { action: 'move', queueId: ids[3], toIndex: 99 }))
    assert.deepEqual(s.queue.map((t) => t.queueId), [ids[0], ids[1], ids[2], ids[3]])
    s = state(music.control(CH, { action: 'move', queueId: ids[2], toIndex: -4 }))
    assert.deepEqual(s.queue.map((t) => t.queueId), [ids[2], ids[0], ids[1], ids[3]])
    assert.equal(music.control(CH, { action: 'move', queueId: ids[2] }), MUSIC_ERRORS.invalidAction)
    assert.equal(music.control(CH, { action: 'move', queueId: 'gone', toIndex: 0 }), 'That track is no longer in the queue')
    s = state(music.control(CH, { action: 'remove', queueId: ids[0] }))
    assert.deepEqual(s.queue.map((t) => t.queueId), [ids[2], ids[1], ids[3]])
    assert.equal(music.control(CH, { action: 'remove', queueId: ids[0] }), MUSIC_ERRORS.notInQueue)
    assert.equal(music.control(CH, { action: 'remove', queueId: s.current!.queueId }), MUSIC_ERRORS.notInQueue)
    s = state(music.control(CH, { action: 'clear' }))
    assert.deepEqual(s.queue, [])
    assert.equal(s.current?.videoId, tracks[0].videoId)
    const revBefore = s.rev
    s = state(music.control(CH, { action: 'stop' }))
    assert.deepEqual({ ...s, rev: 0 }, { channelId: CH, current: null, queue: [], startedAt: null, pausedAt: null, rev: 0 })
    assert.ok(s.rev > revBefore)
    assert.deepEqual(states.at(-1), s)
    assert.equal(time.pending(), 0)
    // A new session never goes back in rev.
    s = state(music.add(CH, 'u', [track()], false))
    assert.ok(s.rev > revBefore)
    assert.ok(s.rev > states.at(-2)!.rev)
  })

  test('auto-advance at the end of the track (+ grace), then stop', () => {
    const [a, b] = [track({ durationMs: 10_000 }), track({ durationMs: 20_000 })]
    state(music.add(CH, 'u', [a, b], false))
    time.advance(10_000 + GRACE - 1)
    assert.equal(music.state(CH).current?.videoId, a.videoId)
    time.advance(1)
    let s = music.state(CH)
    assert.equal(s.current?.videoId, b.videoId)
    assert.equal(s.startedAt, time.clock.t) // starts at advance time (not at a's nominal end)
    assert.deepEqual(states.at(-1), s)
    // Pausing cancels the advance; resuming reschedules from the position.
    time.advance(5000)
    state(music.control(CH, { action: 'pause' }))
    time.advance(60_000)
    assert.equal(music.state(CH).current?.videoId, b.videoId)
    state(music.control(CH, { action: 'play' }))
    // A seek moves the end.
    state(music.control(CH, { action: 'seek', positionMs: 18_000 }))
    time.advance(2000 + GRACE)
    s = music.state(CH)
    assert.equal(s.current, null)
    assert.deepEqual(s.queue, [])
    assert.deepEqual(states.at(-1), s)
    assert.equal(time.pending(), 0)
  })

  test('empty voice channel: paused, cleared after the idle delay; rejoining cancels the clear', () => {
    state(music.add(CH, 'u', [track(), track()], false))
    music.setOccupied(new Set([CH]))
    time.advance(4000)
    music.setOccupied(new Set())
    let s = music.state(CH)
    assert.equal(s.startedAt, null)
    assert.equal(s.pausedAt, 4000)
    assert.deepEqual(states.at(-1), s)
    music.setOccupied(new Set()) // still empty: nothing new
    assert.deepEqual(states.at(-1), s)
    time.advance(IDLE - 1)
    music.setOccupied(new Set([CH])) // someone is back: stays paused, not cleared
    time.advance(IDLE * 2)
    s = music.state(CH)
    assert.equal(s.pausedAt, 4000)
    assert.equal(s.current !== null, true)
    // Empty again: cleared after the full delay.
    music.setOccupied(new Set())
    time.advance(IDLE)
    s = music.state(CH)
    assert.equal(s.current, null)
    assert.deepEqual(states.at(-1)?.current, null)
    assert.deepEqual(music.active(), [])
  })

  test('drop and clearAll broadcast empty states; close stops the timers', () => {
    state(music.add('a', 'u', [track()], false))
    state(music.add('b', 'u', [track()], false))
    assert.equal(music.active().length, 2)
    music.drop('a')
    assert.deepEqual(states.at(-1)?.channelId, 'a')
    assert.equal(states.at(-1)?.current, null)
    music.drop('nothing') // no session: nothing broadcast
    assert.equal(states.at(-1)?.channelId, 'a')
    music.clearAll()
    assert.equal(states.at(-1)?.channelId, 'b')
    assert.deepEqual(music.active(), [])
    state(music.add('c', 'u', [track()], false))
    assert.equal(time.pending(), 1)
    const n = states.length
    music.close()
    assert.equal(time.pending(), 0)
    assert.equal(states.length, n)
  })
})

// ---------- over sockets ----------

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>
type EventName = keyof ServerToClientEvents
type EventArg<E extends EventName> = Parameters<ServerToClientEvents[E]>[0]

const TIMEOUT = 3000
const tmpDirs: string[] = []
const clients: Client[] = []

function newDataDir() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'nexo-music-'))
  tmpDirs.push(dataDir)
  return dataDir
}

function boot(dataDir: string, opts: Partial<StartOptions> = {}): Promise<NexoInstance> {
  return start({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    serverName: 'Test Space',
    serverPassword: '',
    livekit: { apiKey: 'testkey', apiSecret: 'test-secret-that-is-at-least-32-characters-long', publicUrl: '', port: 7880 },
    log: false,
    ...opts,
  })
}

interface Conn {
  socket: Client
  boot: Bootstrap
  id: string
  token: string
}

function connect(url: string, auth: Record<string, unknown>): Promise<Conn> {
  const socket: Client = connectClient(url, { auth, transports: ['websocket'], forceNew: true, reconnection: false })
  clients.push(socket)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bootstrap timeout')), TIMEOUT)
    socket.once('bootstrap', (b) => {
      clearTimeout(timer)
      resolve({ socket, boot: b, id: b.me.id, token: b.token ?? (auth.token as string | undefined) ?? '' })
    })
    socket.once('connect_error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

const join = (url: string, name: string) => connect(url, { name, color: '#123456' })

function request<T>(socket: Client, event: keyof ClientToServerEvents, payload: unknown): Promise<AckResult<T>> {
  const raw = socket as unknown as { timeout(ms: number): { emitWithAck(e: string, p: unknown): Promise<AckResult<T>> } }
  return raw.timeout(TIMEOUT).emitWithAck(event, payload)
}

async function requestOk<T>(socket: Client, event: keyof ClientToServerEvents, payload: unknown): Promise<T> {
  const res = await request<T>(socket, event, payload)
  if (!res.ok) assert.fail(`${event} failed: ${res.error}`)
  return res.data
}

async function requestErr(socket: Client, event: keyof ClientToServerEvents, payload: unknown): Promise<string> {
  const res = await request<unknown>(socket, event, payload)
  assert.equal(res.ok, false, `${event} should have failed`)
  return (res as { error: string }).error
}

function nextEvent<E extends EventName>(socket: Client, event: E, match: (arg: EventArg<E>) => boolean = () => true): Promise<EventArg<E>> {
  const s = socket as unknown as { on(e: string, f: (a: unknown) => void): void; off(e: string, f: (a: unknown) => void): void }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off(event, handler)
      reject(new Error(`timed out waiting for "${event}"`))
    }, TIMEOUT)
    const handler = (arg: unknown) => {
      if (!match(arg as EventArg<E>)) return
      clearTimeout(timer)
      s.off(event, handler)
      resolve(arg as EventArg<E>)
    }
    s.on(event, handler)
  })
}

/** Sets `conn`'s voice channel and waits until `observer` sees it. */
async function setVoice(conn: Conn, observer: Conn, channelId: string | null) {
  const seen = nextEvent(observer.socket, 'voice:states', (states: VoiceState[]) => {
    const s = states.find((v) => v.userId === conn.id)
    return channelId === null ? !s : s?.channelId === channelId
  })
  ;(conn.socket as unknown as { emit(e: string, p: unknown): void }).emit('voice:state', {
    channelId,
    muted: false,
    deafened: false,
    camera: false,
    streaming: false,
  })
  await seen
}

after(() => {
  for (const c of clients) c.close()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

describe('plugins and music over sockets', () => {
  const IDLE = 60_000
  let dataDir: string
  let time: ReturnType<typeof fakeTime>
  let server: NexoInstance
  let owner: Conn
  let member: Conn
  let bob: Conn
  let lounge: Channel
  let gaming: Channel
  let general: Channel

  const bootOpts = () => ({ now: time.now, musicTimers: time.timers, musicIdleClearMs: IDLE, musicLimit: { count: 1000, windowMs: 1000 } })

  before(async () => {
    dataDir = newDataDir()
    time = fakeTime()
    server = await boot(dataDir, bootOpts())
    owner = await join(server.url, 'Olivia')
    member = await join(server.url, 'Mia')
    bob = await join(server.url, 'Bob')
    lounge = owner.boot.channels.find((c) => c.name === 'Lounge')!
    gaming = owner.boot.channels.find((c) => c.name === 'Gaming')!
    general = owner.boot.channels.find((c) => c.name === 'general')!
  })
  after(() => server.close())

  test('bootstrap: plugins off by default, no music', () => {
    assert.deepEqual(owner.boot.plugins, { music: false, emulator: false })
    assert.deepEqual(owner.boot.music, [])
  })

  test('time:now answers with the server clock', async () => {
    assert.deepEqual(await requestOk(member.socket, 'time:now', {}), { now: time.clock.t })
  })

  test('the Music plugin off: music events are refused', async () => {
    await setVoice(member, owner, lounge.id)
    assert.equal(await requestErr(member.socket, 'music:add', { channelId: lounge.id, tracks: [track()] }), 'The Music plugin is off')
    assert.equal(await requestErr(member.socket, 'music:control', { channelId: lounge.id, action: 'pause' }), MUSIC_ERRORS.pluginOff)
  })

  test('plugins:set: admins only, known plugins, broadcast', async () => {
    assert.equal(await requestErr(member.socket, 'plugins:set', { plugin: 'music', enabled: true }), 'Only admins can change plugins')
    assert.equal(await requestErr(owner.socket, 'plugins:set', { plugin: 'radio', enabled: true }), 'Unknown plugin')
    assert.equal(await requestErr(owner.socket, 'plugins:set', { plugin: 'music', enabled: 'yes' }), PLUGIN_ERRORS.invalid)
    const changed = nextEvent(bob.socket, 'plugins:changed')
    assert.deepEqual(await requestOk<ServerPlugins>(owner.socket, 'plugins:set', { plugin: 'music', enabled: true }), { music: true, emulator: false })
    assert.deepEqual(await changed, { music: true, emulator: false })
  })

  test('music: channel and voice checks', async () => {
    assert.equal(await requestErr(member.socket, 'music:add', { channelId: general.id, tracks: [track()] }), 'Voice channel not found')
    assert.equal(await requestErr(member.socket, 'music:add', { channelId: 'nope', tracks: [track()] }), 'Voice channel not found')
    assert.equal(
      await requestErr(member.socket, 'music:add', { channelId: gaming.id, tracks: [track()] }),
      'Join the voice channel to control its music',
    )
    assert.equal(await requestErr(bob.socket, 'music:control', { channelId: lounge.id, action: 'skip' }), MUSIC_ERRORS.notInChannel)
    assert.equal(await requestErr(member.socket, 'music:add', { channelId: lounge.id, tracks: [{ ...track(), videoId: 'x' }] }), 'Invalid track')
    assert.equal(await requestErr(member.socket, 'music:control', { channelId: lounge.id, action: 'nope' }), 'Invalid music action')
  })

  test('add broadcasts to everyone (not only the channel); bootstrap carries active sessions', async () => {
    const [a, b] = [track(), track()]
    const seenByBob = nextEvent(bob.socket, 'music:state')
    const s = await requestOk<MusicState>(member.socket, 'music:add', { channelId: lounge.id, tracks: [a, b] })
    assert.equal(s.channelId, lounge.id)
    assert.equal(s.current?.videoId, a.videoId)
    assert.equal(s.current?.addedBy, member.id)
    assert.equal(s.startedAt, time.clock.t)
    assert.deepEqual(await seenByBob, s)
    const late = await join(server.url, 'Late')
    assert.deepEqual(late.boot.music, [s])
    assert.deepEqual(late.boot.plugins, { music: true, emulator: false })
    late.socket.close()
  })

  test('control + auto-advance on the timer', async () => {
    time.advance(20_000)
    let s = await requestOk<MusicState>(member.socket, 'music:control', { channelId: lounge.id, action: 'pause' })
    assert.equal(s.pausedAt, 20_000)
    s = await requestOk<MusicState>(member.socket, 'music:control', { channelId: lounge.id, action: 'play' })
    assert.equal(s.startedAt, time.clock.t - 20_000)
    const next = s.queue[0]
    const advanced = nextEvent(bob.socket, 'music:state', (st) => st.current?.queueId === next.queueId)
    time.advance(40_000 + MUSIC_LIMITS.advanceGraceMs)
    s = await advanced
    assert.equal(s.startedAt, time.clock.t)
    assert.deepEqual(s.queue, [])
  })

  test('the last one leaving pauses; rejoining cancels the clear; empty for the idle delay clears', async () => {
    time.advance(5000)
    let paused = nextEvent(bob.socket, 'music:state', (st) => st.channelId === lounge.id && st.pausedAt !== null)
    await setVoice(member, owner, null)
    let s = await paused
    assert.equal(s.pausedAt, 5000)
    time.advance(IDLE - 1000)
    await setVoice(member, owner, lounge.id)
    time.advance(IDLE)
    s = await requestOk<MusicState>(member.socket, 'music:control', { channelId: lounge.id, action: 'play' })
    assert.equal(s.current !== null, true)
    // Moved to another channel by voice:state: lounge empties.
    paused = nextEvent(bob.socket, 'music:state', (st) => st.channelId === lounge.id && st.pausedAt !== null)
    await setVoice(member, owner, gaming.id)
    await paused
    const cleared = nextEvent(bob.socket, 'music:state', (st) => st.channelId === lounge.id && st.current === null)
    time.advance(IDLE)
    s = await cleared
    assert.deepEqual(s.queue, [])
  })

  test('disconnecting and voice:move also empty a channel', async () => {
    const mia2 = await connect(server.url, { token: member.token })
    await setVoice(mia2, owner, lounge.id)
    await requestOk<MusicState>(mia2.socket, 'music:add', { channelId: lounge.id, tracks: [track()] })
    let paused = nextEvent(bob.socket, 'music:state', (st) => st.channelId === lounge.id && st.pausedAt !== null)
    mia2.socket.close()
    await paused
    await setVoice(member, owner, lounge.id)
    await requestOk<MusicState>(member.socket, 'music:control', { channelId: lounge.id, action: 'play' })
    paused = nextEvent(bob.socket, 'music:state', (st) => st.channelId === lounge.id && st.pausedAt !== null)
    await requestOk<null>(owner.socket, 'voice:move', { userId: member.id, channelId: gaming.id })
    await paused
    await requestOk<MusicState>(member.socket, 'music:control', { channelId: gaming.id, action: 'stop' })
    // An account removed while alone in voice.
    const temp = await join(server.url, 'Temp')
    await setVoice(temp, owner, lounge.id)
    await requestOk<MusicState>(temp.socket, 'music:control', { channelId: lounge.id, action: 'play' })
    paused = nextEvent(bob.socket, 'music:state', (st) => st.channelId === lounge.id && st.pausedAt !== null)
    await requestOk<null>(owner.socket, 'user:remove', { userId: temp.id })
    await paused
  })

  test('deleting the voice channel drops its session', async () => {
    const room = await requestOk<Channel>(owner.socket, 'channel:create', { name: 'Doomed', type: 'voice' })
    await setVoice(member, owner, room.id)
    await requestOk<MusicState>(member.socket, 'music:add', { channelId: room.id, tracks: [track()] })
    const dropped = nextEvent(bob.socket, 'music:state', (st) => st.channelId === room.id && st.current === null)
    await requestOk<null>(owner.socket, 'channel:delete', { channelId: room.id })
    await dropped
    const late = await join(server.url, 'Later')
    assert.equal(late.boot.music?.some((st) => st.channelId === room.id), false)
    late.socket.close()
  })

  test('turning the plugin off clears every session; the setting survives a restart', async () => {
    await setVoice(member, owner, lounge.id)
    await setVoice(bob, owner, gaming.id)
    await requestOk<MusicState>(member.socket, 'music:add', { channelId: lounge.id, tracks: [track()] })
    await requestOk<MusicState>(bob.socket, 'music:add', { channelId: gaming.id, tracks: [track()] })
    const clearedLounge = nextEvent(owner.socket, 'music:state', (st) => st.channelId === lounge.id && st.current === null)
    const clearedGaming = nextEvent(owner.socket, 'music:state', (st) => st.channelId === gaming.id && st.current === null)
    await requestOk(owner.socket, 'plugins:set', { plugin: 'music', enabled: false })
    await clearedLounge
    await clearedGaming
    assert.equal(await requestErr(member.socket, 'music:control', { channelId: lounge.id, action: 'play' }), MUSIC_ERRORS.pluginOff)

    // Persisted: on → restart → still on.
    await requestOk(owner.socket, 'plugins:set', { plugin: 'music', enabled: true })
    await server.close()
    server = await boot(dataDir, bootOpts())
    const again = await connect(server.url, { token: owner.token })
    assert.deepEqual(again.boot.plugins, { music: true, emulator: false })
    assert.deepEqual(again.boot.music, [])
  })
})

describe('music with the real clock and timers', () => {
  let server: NexoInstance
  after(() => server.close())

  test('the queue advances on its own at the end of a track', async () => {
    server = await boot(newDataDir(), { musicAdvanceGraceMs: 0 })
    const owner = await join(server.url, 'Olivia')
    const lounge = owner.boot.channels.find((c) => c.name === 'Lounge')!
    await requestOk(owner.socket, 'plugins:set', { plugin: 'music', enabled: true })
    const second = await connect(server.url, { token: owner.token })
    await setVoice(owner, second, lounge.id)
    const before = Date.now()
    const s = await requestOk<MusicState>(owner.socket, 'music:add', { channelId: lounge.id, tracks: [track({ durationMs: 1000 })] })
    const { now } = await requestOk<{ now: number }>(owner.socket, 'time:now', {})
    assert.ok(now >= before && now <= Date.now())
    const ended = await nextEvent(second.socket, 'music:state', (st) => st.current === null)
    assert.ok(Date.now() - s.startedAt! >= 1000)
    assert.ok(ended.rev > s.rev)
  })
})

describe('music rate limit', () => {
  let server: NexoInstance
  after(() => server.close())

  test('music:add + music:control share a per-user limit across sockets', async () => {
    server = await boot(newDataDir(), { musicLimit: { count: 3, windowMs: 60_000 } })
    const owner = await join(server.url, 'Olivia')
    const second = await connect(server.url, { token: owner.token })
    const lounge = owner.boot.channels.find((c) => c.name === 'Lounge')!
    await requestOk(owner.socket, 'plugins:set', { plugin: 'music', enabled: true })
    await setVoice(owner, second, lounge.id)
    await requestOk(owner.socket, 'music:add', { channelId: lounge.id, tracks: [track()] })
    await requestOk(owner.socket, 'music:control', { channelId: lounge.id, action: 'pause' })
    await requestOk(second.socket, 'music:control', { channelId: lounge.id, action: 'play' })
    assert.equal(await requestErr(second.socket, 'music:control', { channelId: lounge.id, action: 'pause' }), 'Slow down')
    assert.equal(await requestErr(owner.socket, 'music:add', { channelId: lounge.id, tracks: [track()] }), MUSIC_ERRORS.slowDown)
  })
})
