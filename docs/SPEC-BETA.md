# Nexo Beta — Native Media Spec

**Status:** Released as v0.4.0-beta.1 · **Date:** 2026-11-08 · **Scope:** Windows streamer side (game and screen sharing)

The alpha (v0.1–v0.3) does everything inside Electron: Chromium captures the game, Chromium's WebRTC encodes it,
and livekit-client publishes it. The beta keeps Electron as the **interface shell** and moves the **heavy media
work** into native C++. On Windows the game is captured with **Windows.Graphics.Capture (WGC)**, called through
**C++/WinRT** on a **Direct3D 11** device we own. It is encoded by the GPU's **hardware H.264 encoder** and
published **pre-encoded** to LiveKit through **LiveKit's native C++ SDK**.

Game sharing and screen sharing (desktop, apps, code, slides) use the same pipeline. A monitor is just another
capture item, and the presets choose the encoder tuning. §4.9 covers what differs for screen content.

This document only covers what changes. Anything not mentioned here (server, chat, voice, viewing, macOS and
Linux) works as described in [SPEC.md](SPEC.md).

---

## 1. Why

**The alpha's problem.** When a game runs uncapped and keeps the GPU near 100%, Chromium's capture loop starves:
1080p60 shares drop to 3–8 fps (the `shareCaptureLow` hint in `voice/session.ts`). `WebRtcAllowWgcUsingTexture`
improved this (27 → 55 fps measured with a capped game) but did not fix it. The streamer still has to cap the game.
The usual fixes (GPU scheduling priority on the capture device, a short GPU-only path from capture to encode)
can't be applied to Chromium's GPU process from an Electron app.

**Measured in M3** (synthetic GPU-bound load in the foreground, [benchmarks/beta-m3-fps-gap.md](benchmarks/beta-m3-fps-gap.md)):
the alpha with its texture flag holds 55–57 fps there, and the beta's pipelined path 55–59 fps at less than half
the game cost (1.0% vs 2.2–2.5%). On frame rate the beta **matches** the alpha rather than beating it; the win is
process audio, encoder control and crash isolation. Real games on friends' PCs still need the M4 check.

**What owning the pipeline gives us**

| Capability | Alpha (Chromium) | Beta (native) |
|---|---|---|
| D3D11 device and its GPU priority | Chromium's, out of reach | Ours: `SetGPUThreadPriority`, `D3DKMTSetProcessSchedulingPriorityClass` |
| Capture to encoder path | Chromium internals, readbacks under some configs | WGC texture → `ID3D11VideoProcessor` (scale + BGRA→NV12) → hardware encoder, all on the GPU |
| Encoder settings | Whatever WebRTC picks. Rate control and GOP are opaque | Our choice: low-latency CBR, no B-frames, IDR on demand, and the bitrate follows LiveKit's congestion feedback |
| Stream audio | Whole system mix: viewers hear the voice chat echoed (SPEC R1) | **Process loopback**: only the game, or everything except Nexo |
| WGC options | Fixed | Cursor on/off, no yellow border (Win11), `MinUpdateInterval` (24H2) |
| Failure isolation | A capture problem is a GPU-process problem | Separate helper process: it can crash and be restarted without touching the UI |

**Goals**

- An uncapped, GPU-bound game streamed with the **Game** preset (1080p60) reaches viewers at **≥ 55 fps sustained**.
- The game's own frame rate drops **≤ 5%** while streaming.
- Stream audio **never contains Nexo's own audio** (voice chat, notification sounds).
- End-to-end latency no worse than the alpha's.
- Screen shares with the **Sharp** preset keep small text readable, and an idle desktop costs almost no bandwidth.
- The alpha path remains as an automatic fallback.

**Non-goals (beta)**

- Hook or inject-based game capture (like OBS's "Game Capture"). WGC is a public OS API with no injection, so it
  stays safe with anti-cheat.
- Native capture on macOS or Linux. Those keep the alpha path.
- Native **receiving or decoding**. Viewers keep using livekit-client in the renderer.
- Simulcast for streams (same as the alpha: one layer).
- Webcam and mic. They stay in Chromium.

---

## 2. Decisions

| # | Decision | Alternatives considered | Why |
|---|---|---|---|
| D1 | **Native publish:** the helper publishes the stream to LiveKit directly | (A) native capture, then hand frames back to Chromium via Electron's `sharedTexture` and keep livekit-client | Removes Chromium from the streaming path entirely, including encode. `sharedTexture` is experimental and built for offscreen rendering. 60 fps through it is unproven. |
| D2 | **LiveKit C++ client SDK** (`livekit/client-sdk-cpp`) | Rust SDK (`livekit` crate) | The helper is C++ (C++/WinRT, D3D11, Media Foundation). The C++ SDK wraps the same Rust FFI, so there's no hand-written C++↔Rust boundary. **Pre-encoded video** is available from C++ SDK **v1.11.0** (`EncodedVideoSource`). |
| D3 | **Pre-encoded H.264**: we run the encoder and the SDK only packetizes and sends | Hand raw NV12 to `VideoSource` and let libwebrtc encode | Raw frames would mean a GPU→CPU readback per frame, plus libwebrtc's encoder choice. Pre-encoded keeps every frame on the GPU, and the SDK forwards rate-control targets and keyframe requests to us. |
| D4 | **Media Foundation hardware H.264 MFT** (D3D11-aware, async) | NVENC / AMF / QSV SDKs directly | One code path for NVIDIA, AMD and Intel. All three ship hardware H.264 MFTs. Vendor SDKs stay an option later if a vendor's MFT misbehaves. |
| D5 | **Separate helper process `nexo-media.exe`**, not an N-API addon | Addon loaded in Electron main or a `utilityProcess` | Crash isolation (GPU drivers, device-removed, the FFI layer). Its own GPU scheduling priority class. No Node ABI coupling, and LiveKit's DLLs sit next to an exe we control. |
| D6 | **The stream is a second LiveKit participant** (`<userId>#stream`) | Share one participant between the renderer and the helper | Two processes can't share one LiveKit connection. The identity suffix is server-signed, so the renderer can trust the mapping back to the owner. |
| D7 | **Built on Windows, driven from WSL** (`scripts/native-build.sh` runs MSVC through `cmd.exe`) | clang-cl + xwin cross-compile in WSL | Official toolchain, matches CI, no extra SDK repackaging. The LiveKit SDK officially supports MSVC only. |

---

## 3. Architecture

```
┌──────────────────────── Windows PC (streamer) ─────────────────────────────────────────────┐
│                                                                                            │
│  Electron main ──stdio JSON lines──▶ nexo-media.exe                                        │
│     ▲   │                              │                                                   │
│     │ IPC (preload: nexo.nativeShare)  ├─ D3D11 device (high-perf adapter, GPU priority)    │
│     │   ▼                              ├─ WGC: GraphicsCaptureItem(HWND|HMONITOR) → FramePool│
│  Renderer (UI, voice, viewing)         ├─ VideoProcessor: scale/letterbox, BGRA → NV12      │
│     │                                  ├─ MF hardware H.264 encoder (async, D3D11 surfaces) │
│     │                                  ├─ WASAPI process loopback (game | all-but-Nexo)    │
│     │                                  └─ LiveKit C++ SDK: Room as "<userId>#stream"         │
│     │                                       ├─ EncodedVideoSource (H.264, ScreenShare)       │
│     │                                       └─ AudioSource (48 kHz, ScreenShareAudio)        │
│     │ livekit-client as "<userId>"                         │                               │
└─────┼──────────────────────────────────────────────────────┼───────────────────────────────┘
      │ mic, webcam, subscriptions                            │ stream video + audio
      ▼                                                       ▼
                         LiveKit SFU  (room voice-<channelId>)
                                   │
                                   ▼  viewers: unchanged livekit-client playback
```

The Nexo server's only new duty is signing the stream participant's token (§7).

---

## 4. The helper: `nexo-media.exe`

### 4.1 Lifecycle

- Electron main spawns it **lazily** on the first native share in a voice session. It stays warm while the user
  is in voice and exits when they leave voice or quit the app.
- **Parent watchdog:** the helper exits when stdin closes, **and** it waits on a `SYNCHRONIZE` handle to the
  parent PID (passed as `--parent-pid`), so it never outlives a crashed Electron.
- **Crash policy:** if the helper exits unexpectedly during a share, main restarts it once and resumes the share.
  A second crash within 60 s turns native sharing off for the session, falls back to the alpha path, and shows a
  toast.
- **Secrets:** the LiveKit token reaches the helper **only over stdin**, never in argv (visible to other
  processes) and never in logs.

### 4.2 Threads

| Thread | Work |
|---|---|
| Control | Reads stdin commands and writes events/stats to stdout (§6) |
| Capture | WGC `FrameArrived` (free-threaded frame pool). **Zero copy** (default): the ring keeps WGC's own buffer and gives it back once a newer frame replaced it and no conversion or encoder still uses it. `NEXO_MEDIA_ZERO_COPY=0` restores the M1 path (`CopyResource` into our own ring texture, buffer returned at once) |
| Encode | Woken by each new captured frame and **rate-capped** at the preset fps (a fixed timer drifting against the display's 60 Hz lost ~25% of frames in M0). Takes the **latest** captured texture, converts, encodes, and passes the access unit to `EncodedVideoSource::captureFrame`. Polls `takeFeedback()` every frame. **Pipelined** (default, `NEXO_MEDIA_PIPELINE`): each conversion ends with a D3D11 fence, and a frame goes to the MFT only once its fence completed, with up to 6 conversions in flight. Under a GPU-bound foreground game our jobs wait 37–108 ms on the 3D queue; the MFT takes one frame at a time, so handing it unfinished frames capped encode at ≈ 1 / that wait (M3: 6.7–15.6 fps → 55–59 fps, [benchmarks/beta-m3-fps-gap.md](benchmarks/beta-m3-fps-gap.md)) |
| Audio | WASAPI event-driven capture, 10 ms int16 frames, then `AudioSource::captureFrame` |
| SDK | LiveKit's internal threads (FFI runtime) |

### 4.3 D3D11 device and GPU priority

- Adapter: `IDXGIFactory6::EnumAdapterByGpuPreference(HIGH_PERFORMANCE)`, then the first adapter that **also has a
  hardware H.264 MFT** (matched by `MFT_ENUM_ADAPTER_LUID`). Capture, conversion and encode all live on that one
  device, with no cross-adapter copies on our side.
- `D3D11CreateDevice(..., D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT)`, with
  `ID3D10Multithread::SetMultithreadProtected(TRUE)` (shared with the MFT through `IMFDXGIDeviceManager`).
- **Priority experiments** (M3, measured): `IDXGIDevice::SetGPUThreadPriority(7)`,
  `D3DKMTSetProcessSchedulingPriorityClass(HIGH)` (REALTIME needs admin: out of scope), process priority class
  `ABOVE_NORMAL`. **Result: none of them changes the frame rate**, so all stay off by default and are opt-in env
  flags (`NEXO_MEDIA_GPU_PRIORITY`, `NEXO_MEDIA_GPU_SCHED_HIGH`, `NEXO_MEDIA_ABOVE_NORMAL`). What decides the
  frame rate is whether the GPU-bound game is the **foreground** window
  ([benchmarks/beta-m3-gpu-priority.md](benchmarks/beta-m3-gpu-priority.md)).
- **Device removed** (`DXGI_ERROR_DEVICE_REMOVED`/`RESET`): rebuild the device, frame pool, converter and encoder.
  The LiveKit tracks **stay published**: the first new frame is an IDR, so viewers see a short freeze (≈ 0.2 s
  measured), not a disconnect. A failed rebuild is retried after 2 s. A second failure, or more than 3 losses in
  60 s, ends the share with `ended device-lost`, and the renderer falls back to Chromium once.

### 4.4 Capture (WGC through C++/WinRT)

- Item: `IGraphicsCaptureItemInterop::CreateForWindow(hwnd)` or `CreateForMonitor(hmonitor)`.
- `Direct3D11CaptureFramePool::CreateFreeThreaded(device, B8G8R8A8UIntNormalized, 6, size)`: 6 buffers because
  zero copy holds some of them while their conversion waits on the GPU (2 with `NEXO_MEDIA_ZERO_COPY=0`;
  `NEXO_MEDIA_WGC_BUFFERS` overrides). M3 measured that WGC itself isn't the bottleneck: with no processing it
  delivers 56.5–58.9 fps behind a GPU-bound foreground game.
- Session options, applied when the OS supports them (checked with
  `ApiInformation::IsPropertyPresent`):

  | Option | Value | Min OS |
  |---|---|---|
  | `IsCursorCaptureEnabled` | per share (on by default) | Win10 2004 |
  | `IsBorderRequired` | `false` (after `GraphicsCaptureAccess::RequestAccessAsync(Borderless)`). Works for an unpackaged exe, but only when it runs from a local disk: from `\\wsl$` it fails with `0x80070490` | Win11 |
  | `MinUpdateInterval` | `1 / preset fps` | Win11 24H2 |

- **Size changes** (`ContentSize` differs from the pool size): `Recreate` the pool. The **encoder output size never
  changes during a share** (`EncodedVideoSource` is created with a fixed size), so the converter letterboxes the
  new content into the existing output size.
- **Item closed** (window closed): emit `ended { reason: "source-closed" }`.
- **Minimized window:** WGC stops delivering. The encoder repeats nothing. The UI shows "Window minimized" from the
  `stalled` flag in stats.
- **Idle content:** WGC fires only when content changes. The encoder skips ticks without a new frame, but re-encodes
  the last frame at least once per second and whenever a keyframe is requested.

### 4.5 Convert and scale

- `ID3D11VideoProcessor`: BGRA (capture) → NV12 (encoder input), scaled to the output size and keeping the aspect
  ratio with black bars.
- **Output size** is picked once at share start: the source's aspect ratio fit inside the preset's box (e.g.
  1920×1080 for Game), rounded down to even dimensions, never upscaled.
- Color: BT.709 limited range, signaled in the SPS VUI.
- HDR sources are captured as 8-bit BGRA (Windows tone-maps them). Proper HDR handling is an open question (§11).

### 4.6 Hardware encoder (Media Foundation)

- Discover: `MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, …, H.264
  output)`, then filter by adapter LUID. Unlock the async MFT (`MF_TRANSFORM_ASYNC_UNLOCK`), set
  `MFT_MESSAGE_SET_D3D_MANAGER`, and drive it with `METransformNeedInput` / `METransformHaveOutput`.
- Settings (`ICodecAPI` / `MF_LOW_LATENCY`):

  | Setting | Value |
  |---|---|
  | Low latency | `MF_LOW_LATENCY = TRUE` |
  | Rate control | CBR (`eAVEncCommonRateControlMode_CBR`), `AVEncCommonMeanBitRate` = preset max, changed live |
  | B-frames | 0 |
  | GOP | Very long. IDR **on demand** (`AVEncVideoForceKeyFrame`), at most one every 500 ms |
  | Profile | High (what the alpha already publishes). Verify against what the SDK negotiates in SDP (§11) |
  | Output | Annex B access units. **SPS + PPS on every IDR** (if the MFT doesn't emit them, prepend the cached ones) |

- **Feedback loop** (each encode tick): `source->takeFeedback()`
  - `keyframe_requested` → force an IDR on the next frame (new viewer, loss).
  - `rate_control.target_bitrate_bps` → `min(target, preset.maxBitrate)`, applied when it changes by > 5%.
  - `rate_control.framerate_fps` is only **logged**. It is libwebrtc's estimate of the *input* rate, so obeying it
    would lock an idle screen share at ~1 fps (§11.2). Frame-rate degradation follows the §4.9 policy instead.
- **Live changes:** bitrate changes apply through `ICodecAPI`. A `contentHint` (CBR ⇄ peak-constrained VBR) or
  fps change doesn't apply mid-stream on the NVIDIA MFT (it accepts the value but keeps the old mode), so the
  helper reads the mode back and, if needed, **recreates only the encoder** with an IDR (≈ 50 ms).
- **No hardware MFT**, the session limit reached (consumer NVIDIA GPUs cap concurrent NVENC sessions), or encoder
  creation fails → report `encoder-unavailable` and fall back to the alpha path.
- Timestamps: WGC `SystemRelativeTime` (QPC-based) converted to µs → `frame.timestamp_us`.

### 4.7 Stream audio (WASAPI process loopback)

`ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS{ PROCESS_LOOPBACK,
{ targetPid, mode } })`

| Share kind | Mode | Target PID | Result |
|---|---|---|---|
| Window | `INCLUDE_TARGET_PROCESS_TREE` | owner of the HWND (`GetWindowThreadProcessId`) | Only that app's audio (and its child processes) |
| Screen | `EXCLUDE_TARGET_PROCESS_TREE` | Electron main's PID | Everything **except** Nexo (voice chat, sounds) |

- `features.processLoopback` is reported on **Windows 10 2004+ (build 19041)**, the same floor OBS's application
  audio capture uses. A failed activation at share time is an `audio-failed` error: the video keeps going. On
  older builds the renderer sends shares **with audio** to the Chromium engine (one toast per session).
- `app` mode on a monitor source is treated as `system-but-nexo`.

- Format requested: 48 kHz, stereo, 16-bit PCM (process loopback doesn't support `GetMixFormat`; we name the format).
- If process loopback delivers nothing for 30 ms (silent source, on some builds), the audio thread fills silence on
  a 10 ms clock to keep timing steady. It never fills in the middle of flowing audio.
- Published as `AudioSource(48000, 2)` with source ScreenShareAudio, track `screen-audio`, 128 kbps, DTX off.
- This resolves **SPEC R1** (voice chat echoed into the stream) for both window and screen shares.

### 4.8 Publishing (LiveKit C++ SDK)

- `livekit::initialize()` once per process, `livekit::shutdown()` on exit. SDK logs go through `setLogCallback`
  into our stdout `log` events.
- `Room::connect(url, token, { auto_subscribe = false })`: the stream participant never subscribes to anything.
- Video: `std::make_shared<EncodedVideoSource>(VideoCodec::H264, outW, outH)`, published as a ScreenShare track
  named `screen` (simulcast is off for pre-encoded sources).
- Audio: `AudioSource` → `LocalAudioTrack`, published as ScreenShareAudio, named `screen-audio`.
- Reconnects: the SDK re-publishes after a full reconnect (since v1.12.3). The helper reports `reconnecting` /
  `connected` state events.
- **Pinned SDK version** (start: v1.13.1, 2026-11-05). The SDK sits behind our own `publish/` module so version
  changes stay contained.

### 4.9 Screen share (desktop, apps, text)

Same capture, convert, encode and publish path as a game. Only the tuning differs, and the preset's `contentHint`
(SPEC §6.2) chooses it. All four presets go native.

**Degradation is ours now.** In the alpha, WebRTC applied `degradationPreference` by scaling or dropping frames
inside its own encoder. A pre-encoded source can't be rescaled by the SDK, so the helper reacts to
`rate_control` feedback itself:

| | `motion` (Smooth, Game, Source) | `detail` (Sharp) |
|---|---|---|
| Rate control | CBR at the target bitrate | Peak-constrained VBR: peak = target, mean ≈ 60% of it (tunable) |
| Under low bandwidth | Keep fps and let quality drop. Below a floor (≈ 1.5 Mbps at 1080p) step fps down, never under 30 | **Keep quality, drop fps** (down to 5 fps). Cap the max QP (`AVEncVideoMaxQP`) so text stays readable |
| Output size | Fixed for the share (§4.4) | Fixed for the share (§4.4) |

**Static content.** A desktop that isn't changing produces no WGC frames, so the encoder sends nothing apart from
the 1 fps refresh (§4.4) and keyframes on request. An idle screen share costs almost no bandwidth.

**Scaling quality.** Text suffers most from downscaling (for example a 4K monitor sent at 1080p). M1 uses the
D3D11 video processor. M3 compares it with our own compute-shader scaler (bicubic or Lanczos) for `detail` and
keeps the better one. Users who need 1:1 text pick **Source** (1440p).

**Hiding Nexo from the share.** When sharing a monitor, Electron main calls `setContentProtection(true)` on Nexo's
windows for the share's duration (on Windows: `WDA_EXCLUDEFROMCAPTURE`, Win10 2004+), so chat and the member list
don't show up in the stream. A checkbox in the picker controls it ("Hide Nexo from the stream", on by default). It
also blocks the streamer's own screenshots of Nexo while sharing, which the checkbox's hint mentions.

**Other details**

- **Cursor:** captured by default for both kinds. Games usually hide it anyway.
- **One monitor per share**, as in the alpha. There's no "all displays" source.
- **App windows** (browser, IDE) behave like game windows. Their audio uses the same include-process-tree mode
  (§4.7), so sharing a browser window streams that browser's audio only.

---

## 5. Source selection

The picker UI and its thumbnails keep using `desktopCapturer` (SPEC §4.2). Main translates the chosen id for the
helper:

| desktopCapturer source | Passed to the helper |
|---|---|
| `window:<id>:0` | `{ kind: "window", hwnd: <id> }`. On Windows Chromium's window id is the HWND (confirm in M0). The helper checks `IsWindow` |
| `screen:<id>:0` | `{ kind: "monitor", rect }`: main finds the `Display` with the source's `display_id` and passes its **physical** bounds (`screen.dipToScreenRect`). The helper resolves it with `MonitorFromRect` |

**Minimized windows.** `desktopCapturer` skips minimized windows, and a full-screen game minimizes itself as soon
as you alt-tab to Nexo to open the picker, so the game you want to share was missing (found in the first test
build, with CS2). With the native engine, main asks the helper for its `windows` list and adds the minimized ones
Chromium left out, as `window:<hwnd>:0` sources with `minimized: true`, the exe's icon and no thumbnail. The
helper sizes such a share from the window's **restored** size (`GetWindowPlacement`, or the monitor's work area
when it was maximized) instead of the ~160×28 stub WGC reports while minimized, which the encoder rejected. The
stream shows the share as stalled until you switch back to the game, then starts. The Chromium engine can't
capture these, so they're only listed when the capture engine is Native.

---

## 6. Main ↔ helper protocol

Newline-delimited JSON over stdio, one object per line. TypeScript types live in
`desktop/src/main/native-media/protocol.ts`, mirrored in `native/nexo-media/src/ipc/protocol.hpp`. Every command
has an `id`, and the matching `result` echoes it.

**Commands (main → helper)**

| `type` | Payload | Notes |
|---|---|---|
| `hello` | `{ protocol: 1 }` | Answered with capabilities (below) |
| `start` | `{ source, preset: { width, height, fps, maxBitrate, contentHint: "motion" \| "detail" }, cursor, audio: "off" \| "app" \| "system-but-nexo", excludePid, livekit: { url, token } }` | One share at a time |
| `update` | `{ preset? , cursor? }` | Bitrate/fps live. A size change needs a restart (fixed source size) |
| `stop` | `{}` | Unpublish, disconnect the stream participant |
| `shutdown` | `{}` | Clean exit |
| `windows` | `{}` | Answered with `windows: [{ hwnd, title, pid, exe, minimized }]`: visible, titled, unowned, uncloaked top-level windows that aren't tool windows, the helper's own excluded (§5). An older helper answers `protocol` (unknown command), and main lists nothing extra |

**Events (helper → main)**

| `type` | Payload |
|---|---|
| `result` | `{ id, ok, error? }` |
| `capabilities` | `{ version, osBuild, adapter, encoder: { name, vendor } \| null, features: { borderless, minUpdateInterval, cursorToggle, processLoopback } }` |
| `state` | `"connecting" \| "live" \| "reconnecting" \| "stopped"` |
| `stats` (1 Hz) | `{ captureFps, encodeFps, targetBitrate, sentBitrate?, keyframes, droppedFrames, stalled, encoder }` |
| `ended` | `{ reason: "source-closed" \| "stopped" \| "device-lost" \| "error" }` |
| `error` | `{ code, message }`, e.g. `encoder-unavailable`, `capture-failed`, `livekit-connect`, `audio-failed` |
| `log` | `{ level, message }`. Main forwards these to the console. Never contains the token |

`nexo-media.exe --selftest` prints `capabilities` and exits. Useful for bug reports and CI.
`nexo-media.exe --test-pattern --url … --token-stdin` publishes a synthetic moving pattern (M0, debugging
without a game).

---

## 7. Server changes

New socket.io event, next to `voice:token`:

```
voice:streamToken { channelId } → { url, token, identity }
```

- Allowed only when the caller is **currently in that voice channel** (server-side voice state).
- Identity `<userId>#stream`, name = the user's name, the same `metadata` as their voice token, TTL `LIMITS.tokenTtl`.
- Grant: `roomJoin`, `canPublish`, **`canSubscribe: false`**, `canPublishData: false`,
  **`canPublishSources: ['screen_share', 'screen_share_audio']`**.
- `voice:token` itself is unchanged.

Because the server signs the identity, any client can trust `X#stream` to be X's stream without further checks.

---

## 8. Desktop (Electron) changes

### 8.1 Main

- `src/main/native-media/` spawns and supervises the helper, with the protocol codec. Exe path:
  `process.resourcesPath/native/nexo-media.exe` when packaged, `NEXO_MEDIA_EXE` / the dev copy otherwise.
- IPC (sender frame checked with `isAppUrl`, like `capture.ts`): `nativeShare:capabilities`, `nativeShare:start`,
  `nativeShare:update`, `nativeShare:stop`. Events go to the renderer: `nativeShare:state|stats|ended|error`.
- Main fills in `excludePid = process.pid` and the translated source (§5). The renderer never sends HWNDs or PIDs.
- Monitor shares with "Hide Nexo from the stream" set: `setContentProtection(true)` on every Nexo window while
  the share is live, restored when it ends for any reason, including a helper crash (§4.9).

### 8.2 Preload

`window.nexo.nativeShare`: `capabilities()`, `start(opts)` → `{ shareId }`, `update(opts)`, `stop()`, `release()`,
`onEvent(cb)`. Main numbers every accepted start, and **every event carries its `shareId`**: the renderer ignores
events of any other share, and main only attributes helper events to a share after the helper answered its
`start`. A late `ended` from the previous share can't end a new one. Failed calls reject with a plain object
`{ name: 'NativeShareError', code, message, fallback }`, because Electron drops custom Error properties across IPC.

### 8.3 Renderer

- **`startShare`** picks the engine. If native is available (Windows, helper `capabilities.encoder` non-null, setting
  on), it calls `voice:streamToken` and then `nativeShare.start`. Otherwise it uses the alpha `getDisplayMedia` path.
  A native start that fails with `encoder-unavailable` / `capture-failed` retries once on the alpha path and shows
  a toast.
- **Participants:** identities ending in `#stream` are not listed as members and get no tile. Their ScreenShare /
  ScreenShareAudio publications are attached to the **owner's** view model in `voice/participants.ts`. "Watch",
  stream volume and subscription decisions (`wantsSubscription`, `watchStream`) stay keyed by the owner's identity.
  The owner → stream participant mapping happens in `session.ts`.
- **Own stream:** never subscribed (that would download our own upload). The streamer's tile shows a "You're
  live" card with stats from the helper. A self-preview toggle is an open question (§11).
- **Stats and hints:** `shareStats` is fed from helper `stats`. `shareCaptureLow` uses `captureFps` the same way,
  and the encoder name appears where the alpha shows `encoderImplementation`.
- **Share picker:** for screen sources, a "Hide Nexo from the stream" checkbox (on by default). The audio checkbox
  says what it captures: "App audio" for a window, "System audio (without Nexo)" for a screen.
- **Unchanged:** presets (SPEC §6.2), the "toggle screen share" hotkey that restarts the last stream, and leaving
  voice ending the share (the helper also gets `stop`).

### 8.4 Settings

Settings → App → **Capture engine:** `Native (beta)` (default on Windows when available) / `Chromium`. The
existing `fastCapture` option only applies to the Chromium engine.

---

## 9. Build, packaging, CI

### 9.1 Layout

```
native/
  nexo-media/
    CMakeLists.txt, CMakePresets.json      C++20, MSVC, /W4, static analysis in CI
    src/main.cpp                           args, control loop, lifecycle, watchdog
    src/ipc/protocol.hpp                   JSON (nlohmann/json, FetchContent)
    src/d3d/device.{hpp,cpp}               adapter pick, device, GPU priority, device-lost
    src/capture/wgc.{hpp,cpp}              item, frame pool, session options
    src/video/convert.{hpp,cpp}            ID3D11VideoProcessor scale/letterbox → NV12
    src/video/encoder_mf.{hpp,cpp}         async hardware MFT, rate control, IDR, SPS/PPS
    src/audio/loopback.{hpp,cpp}           WASAPI process loopback
    src/publish/livekit.{hpp,cpp}          Room, EncodedVideoSource, AudioSource, feedback
    tests/                                 Annex B / NAL parsing, protocol codec (ctest)
  .gitignore                               build/, third_party/livekit-sdk-*/
scripts/native-build.sh                    build on Windows, driven from WSL
```

### 9.2 Windows prerequisites (dev PC)

- Visual Studio 2022 or 2026 (v18), Community or **Build Tools**, with *Desktop development with C++*: MSVC,
  CMake ≥ 3.25, Ninja, and a **Windows 11 SDK** (it ships the C++/WinRT projection headers under
  `Include\<ver>\cppwinrt`). Verified with VS 18 / MSVC 14.51 / SDK 10.0.26100.
- LiveKit C++ SDK: the **prebuilt Windows x64 release bundle** (`livekit-sdk-windows-x64-<ver>.zip`, Release-only
  MSVC build). It is pinned in `native/livekit-sdk.lock` (version, URL, SHA-256) and **downloaded by CMake** into
  `native/third_party/`. No Rust, vcpkg or Protobuf needed. Because the bundle is Release-only, the debug preset
  also links the release C runtime (`/MD`).

### 9.3 `scripts/native-build.sh` (from WSL)

1. `rsync` `native/` to `%LOCALAPPDATA%\nexo-dev\native\src`. MSVC, Ninja and cargo are slow or break on
   `\\wsl$` UNC paths.
2. Find `vcvars64.bat` with `vswhere.exe`, then from a Windows working directory run the same four commands CI
   runs (inside `native/nexo-media`): `cmake --preset windows-release`, `cmake --build --preset windows-release`,
   `ctest --preset windows-release`, `cmake --install build/windows-release --prefix ../out`. CMake fetches the
   LiveKit SDK on the first configure.
3. The install puts `nexo-media.exe`, `livekit.dll`, `livekit_ffi.dll` and the app-local VC++ runtime DLLs
   (`vcruntime140*.dll`, `msvcp140*.dll`, `concrt140.dll`) flat in `src\out\`, so friends don't need the
   redistributable installed. The script copies them back to the repo's `native/out/` (gitignored).

Flags: `--doctor` (toolchain check), `--debug`, `--clean`.

`scripts/win-run.sh` gains a `--native` step that runs the build (skipped with `--no-build`) and copies `out\` to
`$APP_DIR/resources/native/`.

### 9.4 Packaging and CI

- `electron-builder.yml` (win): `extraResources: [{ from: ../native/out, to: native }]`, outside the asar.
- Release workflow, Windows job: build the helper (MSVC is preinstalled on `windows-latest`), run `ctest` and
  `nexo-media.exe --selftest`, then package. A missing helper fails the Windows build. macOS and Linux are
  unaffected.
- Unsigned `nexo-media.exe`: same SmartScreen story as the installer (SPEC R6). An unsigned exe that captures the
  screen, records audio and opens network connections may trip antivirus heuristics (§10).

---

## 10. Risks

| # | Risk | Impact | Handling |
|---|---|---|---|
| B1 | **The C++ SDK is young:** pre-encoded since v1.11.0 (2026-09), frequent releases | Medium | Pin the version, keep it behind `publish/`, M0 proves the path end to end before anything else is built on it |
| B2 | GPU priority doesn't fix starvation on its own | High (the main goal) | **Happened, then mitigated (M3).** With the GPU-bound game in the foreground the M1 pipeline encoded 6.7–15.6 fps, whatever the priority levers (D3D12 `HIGH` queues and D3D11On12 don't help either). Pipelining our conversions and zero-copy capture (§4.2) bring it to **59.4 fps windowed / 55.3 fps heavy full screen** at 1% game cost, which is WGC's own ceiling in the heavy case and on par with the alpha's texture path (57.2 / 54.8): [benchmarks/beta-m3-fps-gap.md](benchmarks/beta-m3-fps-gap.md). Beyond that needs vendor encoder SDKs or D3D12 video encode (post-beta). The capped-game hint stays |
| B3 | Two congestion controllers on one uplink (Chromium for voice, the helper for the stream) | Low | Voice is ~40 kbps. The stream reacts to its own feedback. Watch for voice drops in M3 tests |
| B4 | Hardware MFT quirks by vendor (missing SPS/PPS, latency, session limits) | Medium | SPS/PPS repair, test matrix across NVIDIA/AMD/Intel, fallback to the alpha path |
| B5 | Exclusive fullscreen games: window capture may show black | Medium | Most "fullscreen" games run flip-model borderless on Win10/11. Otherwise recommend screen capture |
| B6 | Antivirus false positives on the unsigned helper | Medium | Document. Consider code signing before a wider release |
| B7 | Stream participant visible to the stack as an extra participant (join/leave sounds, counts) | Low | Renderer filters `#stream` everywhere participants are listed or announced |
| B8 | Hybrid laptops: game on the dGPU, display on the iGPU | Low | Adapter pick prefers high-performance. DWM handles the cross-adapter copy |

---

## 11. Open questions (answered by the M0 spike unless noted)

1. **Windows SDK bundle:** is a prebuilt Windows x64 bundle published for v1.13.1, and what is its asset name?
   *Resolved (M0):* yes, `livekit-sdk-windows-x64-1.13.1.zip` (11.9 MB, SHA-256 `6696ee87…360b9d`, MSVC, Release
   only, `livekit_ffi` 0.13.4). It ships `bin/livekit.dll` + `livekit_ffi.dll`, `lib/livekit.lib` and a CMake
   package (`LiveKit::livekit`). Pinned in `native/livekit-sdk.lock`. CMake downloads and verifies it, so no Rust or
   vcpkg is needed. A `-capture-` variant also exists; we don't need it.
2. **C++ API details:** exact `EncodedVideoSource` constructor and `captureFrame` return type, `takeFeedback()`
   return type, and whether `rate_control` is optional. Read from `include/livekit/encoded_video_source.h`.
   *Resolved (M0):* `EncodedVideoSource(VideoCodec codec, int width, int height)` (throws outside [1, 65535]).
   `[[nodiscard]] bool captureFrame(const Frame&) const` with `Frame{ is_keyframe, width, height (0,0 = source
   size), timestamp_us (0 = now), std::vector<uint8_t> data, optional metadata }`. It copies the payload and
   returns "accepted". It is not safe for concurrent calls. `[[nodiscard]] Feedback takeFeedback() const` returns
   `Feedback{ bool keyframe_requested; std::optional<RateControl{ uint64_t target_bitrate_bps; double
   framerate_fps }> rate_control }`: **`rate_control` is optional** (latest value wins), and polling it from
   another thread is allowed. Two behaviors matter for §4.6. (a) `framerate_fps` is libwebrtc's *input* frame-rate
   estimate, so using it as the tick cap would lock an idle screen share at 1 fps. The helper logs it and doesn't
   obey it. (b) After any frame dropped before the passthrough encoder, the SDK holds delta frames and requests a
   keyframe. Expect a burst of requests in the first second of a share (27 measured), which the 500 ms IDR limit
   folds into one extra IDR.
3. **TrackSource enumerators** for ScreenShare / ScreenShareAudio in C++ (only `SOURCE_CAMERA` /
   `SOURCE_MICROPHONE` were confirmed). Does `publishVideoTrack` accept a screen-share source for a pre-encoded
   track?
   *Resolved (M0):* `TrackSource::SOURCE_SCREENSHARE = 3`, `SOURCE_SCREENSHARE_AUDIO = 4`. `publishVideoTrack`
   accepts any source and, for an `EncodedVideoSource`, forces `VideoEncoderBackend::PreEncoded`, the source's
   codec and no simulcast. The helper calls `publishTrack` with those same options plus explicit
   `video_encoding{max_bitrate, max_framerate}`, because the SDK's default screen-share encoding caps the frame
   rate and WebRTC would drop our frames. Verified on the local SFU: track `screen`, source 3, `video/H264`,
   1920×1080, live for 40 s.
4. **H.264 profile:** what `profile-level-id` the C++ SDK negotiates, and whether a High-profile bitstream under it
   plays in viewers' Chromium.
   *Resolved (M0, partly):* the passthrough encoder factory offers
   `profile-level-id=42e01f;level-asymmetry-allowed=1;packetization-mode=1` (Constrained Baseline 3.1). It matches
   by codec only and forwards the bytes unchanged ("SDP profile parameters constrain real encoders, not a
   pass-through"). The NVIDIA MFT emits High@4.2 (`profile_idc 100`, `level_idc 42`) at 1080p60. Chromium decodes
   from the in-band SPS, and level asymmetry is allowed, so this is expected to play. **The viewer check must
   confirm it.** Fallback without a rebuild: `NEXO_MEDIA_H264_PROFILE=baseline` (constrained baseline, matches the
   SDP, about 10–15% less efficient).
5. **Stereo** `AudioSource(48000, 2)`: supported?
   *Resolved (M0, from headers and source):* yes. `AudioSource(int sample_rate, int num_channels, int
   queue_size_ms = 0)` with interleaved int16 `AudioFrame`s, and the Rust SDK adds `stereo=1` to the Opus fmtp in
   single-PC mode (the C++ default). M2 checks it by ear.
6. **Process loopback minimum build:** confirm against Microsoft docs; SPEC.md assumed Win10 2004. Older builds get
   window-only/no audio or the alpha path.
   *Resolved (M2):* gated on build 19041 (Windows 10 2004), like OBS's application audio capture. Verified on
   build 26200: include mode captures the target at its exact level (−40 dBFS tone); exclude mode removes it
   (−70 to −84 dBFS). Builds 19041–19045 are not yet tested on real hardware.
7. **Chromium window source id == HWND** on Windows.
   *Resolved (M0, verified):* yes. `desktopCapturer.getSources` in Electron 45 on this PC returned
   `window:30017576:0`, `window:198836:0` and `window:133152:0`, exactly the `MainWindowHandle`s of those windows
   (Chromium's `DesktopMediaID` uses WebRTC's `WindowId`, which on Windows is the HWND). Screens are
   `screen:<index>:0` with a separate `display_id` (an index, not an HMONITOR), so §5's `display_id` → physical
   rect → `MonitorFromRect` is the right mapping. A secondary portrait monitor at (1920, −499, 1080×1920)
   resolved correctly.
8. **Self-preview** for the streamer: none, a low-fps local preview from the helper, or subscribing to our own
   stream? (Product decision, before M1 UI work.)
9. **HDR games:** capture as FP16 and tone-map ourselves, or rely on Windows' SDR conversion? (After M3.)

---

## 12. Milestones

| M | Deliverable | Exit criteria |
|---|---|---|
| **M0 Spike** | `native-build.sh` builds a C++/WinRT exe linked to the LiveKit SDK. `--test-pattern` publishes MF-encoded H.264 to a room with a hand-made `#stream` token | A Nexo viewer watches the pattern at 60 fps. Open questions 1–5 and 7 answered. If pre-encoded publishing fails, stop and revisit D1/D3 |
| **M1 Video** | WGC → convert → MF encode → publish, for windows and monitors with all four presets (`motion` and `detail` tuning, §4.9). Server `voice:streamToken`. Main supervisor + IPC, hide Nexo from monitor shares. Renderer engine switch, `#stream` participant mapping, stats | Game and screen shares work in the real app. Alpha fallback works. Benchmark vs alpha recorded |
| **M2 Audio** | Process loopback (app and all-but-Nexo modes), ScreenShareAudio | Viewers hear the game and never the voice chat |
| **M3 Hardening** | Device lost, resize, minimize, reconnect, helper crash restart, GPU priority experiments, `detail` scaler comparison, vendor matrix, packaging + CI | §1 goals met on at least one GPU per vendor, or documented why not |
| **M4 Beta release** | Native engine on by default on Windows, `v0.4.0-beta.1` | Friends stream a session of real games with no fallback triggered |

**Benchmark protocol** (M1 and M3): the same uncapped GPU-bound game, the Game preset, a 5-minute run, alpha vs
beta. Record viewer-side received fps (tile stats), the game's fps (in-game counter or PresentMon), streamer
CPU/GPU %, and glass-to-glass latency (a millisecond clock on the streamer's screen photographed next to the
viewer's).
