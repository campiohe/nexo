# Beta M3 — closing the FPS gap under a GPU-bound game

**Date:** 2026-11-08 · **Helper:** nexo-media 0.4.0-dev (branch `beta/native-media`) · **Spec:** SPEC-BETA §1 (goal: an
uncapped, GPU-bound game streamed at 1080p60 reaches viewers at **≥ 55 fps**), §4.2–§4.6, risk B2 · **Follows:**
[beta-m3-gpu-priority.md](beta-m3-gpu-priority.md)

## Summary

- **The beta's old pipeline was worse than the alpha.** With the game in the foreground, the alpha (Chromium,
  with its default `WebRtcAllowWgcUsingTexture`) sent 57.2 fps (windowed) and 54.8 fps (heavy full screen). The
  beta sent 15.6 and 6.7.
- **The cause was our own GPU jobs, not WGC.** With no processing, WGC delivers 58.9 fps (windowed) and 56.5 fps
  (heavy) while the game is in the foreground. But each of our tiny jobs (a 0.02 ms copy) waited 37–91 ms on the
  3D queue. The MFT takes one frame at a time and sat waiting for our conversion of it, so encode ≈ 1 / latency.
- **The fix is pipelining, not priority.** The encoder now only gets frames whose conversion the GPU has
  finished, with up to six in flight, and the ring keeps WGC's own buffers instead of copying them. With these
  **new defaults**, the beta encodes **59.4 fps** (windowed) and **55.3 fps** (heavy full screen). It
  costs the game 1.0% / 1.0%.
- **≥ 55 fps: met in the windowed case, and at the edge in the heavy one.** The heavy case is bounded by what WGC
  delivers there (~55–56.5 fps even with no processing at all), and the beta now runs at that ceiling. So does the
  alpha with its texture flag: on frame rate under GPU load, the beta now **matches** the alpha rather than beating
  it clearly (+2 fps windowed, about equal in the heavy case). Its advantages stay the ones it was built for:
  process audio, encoder control, and an isolated process.
- **Priority doesn't help, on any API we can use without admin.** The levers from the previous benchmark, a
  D3D12 queue at `HIGH` priority (the same 22 ms waits as `NORMAL`; `GLOBAL_REALTIME` is refused), and D3D11On12
  (the NVIDIA MFT refuses that device) all fail. Only the **copy engine** escapes the contention (0.3 ms), and our
  conversion can't run there.

## Method

- **PC:** Windows 11 build 26200, NVIDIA GeForce RTX 3060 Ti (driver 32.0.15.9186), NVIDIA H.264 Encoder MFT,
  primary monitor 1920×1080 60 Hz. **Hardware-accelerated GPU scheduling (HAGS): on** (`dxdiag`: "Hardware
  Scheduling: DriverSupportState:Stable Enabled:True"; no `HwSchMode` override in
  `HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers`, so this is the Windows default for this GPU).
- **The "game":** `native/tools/gpu-burn`, as in the GPU-priority benchmark. Two setups:
  - **windowed** (the previous benchmark's setup): a normal window with a title bar, client area 1920×1080,
    `--iterations 1500` → ~153 fps alone. WGC captures the whole window, 1922×1112, so the Game preset output is
    1866×1080 and **every frame needs scaling**.
  - **full screen, heavy** (`--borderless 1 --iterations 3000`): a 1920×1080 popup at 0,0, like a game in
    borderless full screen, captured **1:1**; twice the per-frame GPU cost → ~81 fps alone. (At
    `--iterations 1500` the borderless popup doesn't starve anything, see "Which games starve us".)
- **Foreground:** gpu-burn is the foreground window and **takes the focus back** whenever something else gets it
  (new `--foreground 2`; it now also reports which process held the focus). The `fg` column is the share of
  seconds it was in the foreground; every result below is ≥ 97% unless marked.
- **The beta share:** `nexo-media.exe` over its stdio protocol, Game preset (box 1920×1080, 60 fps, 8 Mbps,
  `motion`, cursor off), **dry run**. `captureFps` = frames into the ring, `encodeFps` = access units out of the
  MFT. Runner: `native/tools/gpu-burn/bench-fps-gap.mjs` (configurations = sets of env levers).
- **The alpha share:** `native/tools/alpha-bench/`, a minimal Electron 45.2.3 app run with the Windows
  `electron.exe`: `setDisplayMediaRequestHandler` answers with gpu-burn's window from `desktopCapturer`;
  `getDisplayMedia` with the Game constraints (max 1920×1080, 60 fps), `contentHint = 'motion'`; an
  `RTCPeerConnection` loopback pair with H.264 High preferred (`setCodecPreferences`, as `session.ts` does),
  `maxBitrate` 8 Mbps, `maxFramerate` 60, `degradationPreference: 'maintain-framerate'`. Each second it logs the
  sender's `media-source` frame rate (capture) and `outbound-rtp` frame rate (encoded and sent), from the frame
  counters. It encodes with `MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)`, profile
  `64001f`, like the real alpha. Two configurations: with and without
  `--enable-features=WebRtcAllowWgcUsingTexture` (the alpha turns it on by default, `prefs.fastCapture`). The
  loopback receiver also decodes (the real alpha sends to the SFU instead), which costs the alpha a little GPU
  time that a real share wouldn't. Runner: `native/tools/alpha-bench/bench-alpha.mjs`.
- **Run:** per configuration, start gpu-burn, wait 1.5 s, start the share, skip 4 s, record **30 s** of 1 Hz
  samples next to gpu-burn's own fps; **2 rounds**, the second in reverse order. `no-share` is the game alone, the
  reference for "game cost". Background runs: 1 round × 20 s, `--foreground 0`.
- **Profiling:** `NEXO_MEDIA_PROFILE=1` (new) logs one `profile:` line per second; the tables of fps are measured
  **without** it (`--no-profile`), the breakdown tables with it (1 round × 15 s). See "Profile".
- **Reproduce:** `scripts/native-build.sh`, then
  `node native/tools/gpu-burn/bench-fps-gap.mjs --no-profile --configs no-share,legacy,default --trace`
  (add `--borderless 1 --iterations 3000` for the full-screen case, `--foreground 0` for the background) and
  `node native/tools/alpha-bench/bench-alpha.mjs --trace` (same flags; needs `scripts/win-run.sh` to have
  downloaded Electron once).

## Results

### Alpha vs beta, game in the foreground

Encoded/sent fps is what viewers get (before the network). "Game cost" is against gpu-burn alone in the same
setup. 2 rounds × 30 s each; `fg` 100% in every run.

**Windowed** (1922×1112 captured, scaled to 1866×1080; gpu-burn alone 151.8 fps (beta runs) / 152.8 (alpha runs)):

| Path | capture fps mean (min) | encoded/sent fps mean (p5 / min) | game fps | game cost |
|---|---|---|---|---|
| alpha, no flag | 36.0 (32.0) | 36.0 (33.0 / 32.0) | 149.4 | 2.2% |
| alpha, `WebRtcAllowWgcUsingTexture` (the alpha's default) | 57.3 (56.0) | 57.2 (56.0 / 53.0) | 149.5 | 2.2% |
| beta before this work (`legacy`) | 26.5 (14.1) | 15.6 (8.1 / 7.0) | 148.0 | 2.5% |
| **beta, new defaults** | **59.4 (58.0)** | **59.4 (58.0 / 58.0)** | 150.2 | **1.0%** |

**Full screen, heavy** (1920×1080 captured 1:1; gpu-burn alone 80.8 fps (beta runs) / 81.3 (alpha runs)):

| Path | capture fps mean (min) | encoded/sent fps mean (p5 / min) | game fps | game cost |
|---|---|---|---|---|
| alpha, no flag | 37.5 (32.6) | 37.5 (33.9 / 33.6) | 79.8 | 1.8% |
| alpha, `WebRtcAllowWgcUsingTexture` | 54.8 (53.0) | 54.8 (53.0 / 51.0) | 79.3 | 2.5% |
| beta before this work (`legacy`) | 13.4 (2.9) | 6.7 (1.9 / 1.9) | 78.9 | 2.3% |
| **beta, new defaults** | **55.3 (54.0)** | **55.3 (54.0 / 53.0)** | 80.0 | **1.0%** |

### Game in the background (windowed, 1 round × 20 s, `--foreground 0`)

| Path | capture fps | encoded/sent fps (min) | game fps | game cost |
|---|---|---|---|---|
| alpha, no flag | 47.4 | 47.4 (45.9) | 145.2 (alone 150.5) | 3.5% |
| alpha, texture flag | 57.5 | 57.4 (56.1) | 145.5 | 3.3% |
| beta `legacy` | 59.5 | 59.5 (59.0) | 144.7 (alone 148.3) | 2.4% |
| beta new defaults | 59.5 | 59.5 (58.0) | 146.2 | 1.4% |

With the game in the background nothing starves the beta (as the previous benchmark found). The alpha without
the texture flag still loses frames to its readback.

### Which games starve us

Starvation needs the game to keep the 3D queue full in the foreground. In single 15 s runs with the old pipeline:
the windowed gpu-burn (150 fps) starved it; a borderless full-screen gpu-burn at the same per-frame cost
(`--iterations 1500`, 160 fps) did **not** (59.8 fps encoded); a 1920×1040 borderless window (not covering the
taskbar, so composed by DWM) did (35 fps); and the borderless full-screen one at twice the cost (`--iterations
3000`, 80 fps) did, badly (7–14 fps). So both "windowed" and "heavy full screen" are realistic. The table
above uses one of each.

## Profile

`NEXO_MEDIA_PROFILE=1` (new) logs one line per second with, per stage, the mean/max of:

| Field | What |
|---|---|
| `wgc` | FrameArrived callbacks per second (WGC's delivery rate) and the gaps between them |
| `wgcDelay` | callback time − the frame's `SystemRelativeTime` (DWM → us) |
| `wgcCb` | CPU time in our FrameArrived (copy submission, lock waits) |
| `copyGpu` / `copyDone` | ring copy: GPU execution (D3D11 timestamp queries) / submission → completion (a fence signaled right after it) |
| `convertCpu` / `convertGpu` / `convertDone` | the same for the video-processor conversion |
| `convertQ` | pipelined conversion: submission → handed to the encoder |
| `encIn` / `encLatency` | `ProcessInput` CPU time / `ProcessInput` → access unit out |
| `wait` | share of the encode thread's time spent blocked |
| `age` | frame `SystemRelativeTime` → start of its conversion |

`NEXO_MEDIA_PROFILE_RAW=1` makes FrameArrived count the frame and close it at once, with no GPU work: the upper
bound WGC gives us. Values are ms (mean of 1 s means over 15 s), foreground, 1 round:

**Windowed**

| Config | wgc /s | gap max | wgcDelay | copyGpu | copyDone | convertDone | convertQ | encLatency | encode fps |
|---|---|---|---|---|---|---|---|---|---|
| raw (no processing) | 58.9 | 20.9 | 0.16 | – | – | – | – | – | – |
| legacy | 38.3 | 100.8 | 2.00 | 0.02 | **36.9** | **46.2** | – | **41.6** | ~28 |
| new defaults | 58.8 | 21.1 | 0.24 | – (no copy) | – | 12.9 | 13.0 | **1.9** | 58.8 |

**Full screen, heavy**

| Config | wgc /s | gap max | wgcDelay | copyGpu | copyDone | convertDone | convertQ | encLatency | encode fps |
|---|---|---|---|---|---|---|---|---|---|
| raw (no processing) | 56.5 | 25.7 | 1.74 | – | – | – | – | – | – |
| legacy | 17.2 | 227.8 | 19.4 | 0.02 | **91.1** | **107.9** | – | **116.3** | ~9 |
| new defaults | 55.1 | 25.9 | 2.04 | – | – | 27.8 | 28.9 | **1.9** | 54.8 |

What it says:

1. **WGC isn't the bottleneck.** With nothing to do, it delivers ~59 fps (windowed) and ~56 fps (heavy) to a
   process whose game is in the foreground.
2. **Our GPU work isn't expensive, it waits.** The ring copy executes in 0.02 ms but completes 37–91 ms after
   submission. The video processor doesn't even register on the 3D timestamps (`convertGpu` 0.00: the driver runs
   it elsewhere), yet its fence completes 46–108 ms later.
3. **Encode ≈ 1 / latency.** The MFT asks for one input at a time (`METransformNeedInput`), and the old loop gave
   it a frame whose conversion was still queued. The MFT waited for it (`encLatency` 42–116 ms), so the encoder
   ran at ~10–25 fps. Meanwhile the loop saw "busy" 250–340 times per second.
4. **Capture ≈ 2 buffers / copy latency.** DWM can't refill a pool buffer until our copy of it has run, so with
   two buffers and ~40–90 ms copies, capture fell to 17–38 fps.
5. **Once the encoder only gets finished conversions,** `encLatency` drops to 1.9 ms, and the conversion's own
   queueing also falls (13–28 ms instead of 46–108 ms) because nothing sits on the queue behind it waiting for the
   MFT. With several in flight, those waits overlap: 59 and 55 fps.

### How long a tiny job waits, per queue (`native/tools/queue-probe`)

One 1920×1080 BGRA `CopyResource` every 1/60 s, submit → fence completion, windowed gpu-burn in the foreground
(idle: 0.3–0.7 ms on every queue). 8 s per row.

| Queue | mean | p50 | p95 | max | jobs/s |
|---|---|---|---|---|---|
| D3D11 immediate context (the helper's) | 9.9 | 8.3 | 23.4 | 38.5 | 54.2 |
| D3D12 direct, NORMAL | 23.7 | 22.6 | 39.3 | 64.3 | 37.9 |
| D3D12 direct, **HIGH** | 22.3 | 19.9 | 39.2 | 63.6 | 38.8 |
| D3D12 direct, GLOBAL_REALTIME | – | – | – | – | `CreateCommandQueue` → `0x887A002B` (needs privilege) |
| D3D12 compute, NORMAL | 10.2 | 8.0 | 25.4 | 44.5 | 53.4 |
| D3D12 compute, HIGH | 10.9 | 9.7 | 25.8 | 38.5 | 53.2 |
| D3D12 **copy**, NORMAL / HIGH | **0.34** | 0.30 | 0.42 | 7.4 | 59.9 |

Queue priority makes no difference against the foreground game. The copy engine, which the game doesn't use, is
the only place a job doesn't wait.

## Experiments

Foreground. Single 15 s rounds (profile on) for the triage; the levers that mattered are in the 30 s × 2 tables
above and below.

| # | Experiment | Result | Kept? |
|---|---|---|---|
| a | **RGB input**: feed BGRA straight to the MFT when the frame is exactly the output size (`NEXO_MEDIA_RGB_INPUT=1`). The NVIDIA MFT lists ARGB32 (`d3dfmt 0x15`) but refuses it with a nominal range or interlace attribute (`MF_E_INVALIDMEDIATYPE`); with only size and rate it takes it. Frames that need scaling still go through the video processor (to BGRA, letterboxed). | Heavy full screen: 30.5 fps alone, 48.1 with zero-copy. A big step over `legacy`, but the MFT does its own RGB→YUV on a contended queue (`encLatency` ~18 ms, one frame in flight), so it stops at ~49. NV12 with pipelining does better. Not used for scaled sources. | **Opt-in** (default off). Colour of the MFT's own conversion not verified. |
| b | **Zero copy**: the ring keeps WGC's buffers (pool of 6) and gives each back once it is superseded and unused (`NEXO_MEDIA_ZERO_COPY`). | Alone, capture goes up (windowed 26.5 → 52.8, heavy 13.4 → 39.9) but encode does **not** follow (windowed 15.6 → 13.0, heavy 6.7 → 8.0): the encoder still waits on each queued conversion, and nothing else changed for it. With pipelining it is the best combination (+0.3 / +1.0 fps over pipelining alone, and one GPU job less per frame). | **Yes**, default on |
| c | **D3D11On12 on a HIGH-priority D3D12 queue** | The device works, but the NVIDIA MFT refuses it: `SetOutputType` → `0xC00D6D76` `MF_E_UNSUPPORTED_D3D_TYPE`. It wouldn't help anyway: `queue-probe` shows a HIGH direct queue waiting as long as a NORMAL one (22 ms) behind the foreground game. A two-device split (conversion on 11on12, MFT on plain D3D11, shared textures and fences) isn't worth building for no gain. | No (removed) |
| d | **WGC settings**: pool of 4 buffers (`NEXO_MEDIA_WGC_BUFFERS=4`), no `MinUpdateInterval` (`NEXO_MEDIA_WGC_MIN_INTERVAL_MS=0`), flush right after the ring copy | Windowed, old pipeline: 24.5 encode fps baseline; 4 buffers **10.7** (more copies queued, latencies double to 80–100 ms); no MinUpdateInterval 22.4; flush 23.8. `DirtyRegionMode` not tried: it changes what WGC reports as dirty, not how often it delivers. | Pool size and interval stay as env levers; flush removed |
| e1 | **Pipelined conversion** (`NEXO_MEDIA_PIPELINE`): after the conversion, signal a D3D11 fence and flush; hand the frame to the MFT only when the fence has completed; up to 6 conversions in flight | Windowed 15.6 → **59.1**, heavy 6.7 → **54.3**. The lever that matters. | **Yes**, default on |
| e2 | MFT not in low-latency mode (`MF_LOW_LATENCY` and `AVLowLatencyMode` off), to let it queue more input | Heavy, RGB + zero-copy: 49.3 vs 50.2: it still takes one frame at a time | No (removed) |
| – | Priority levers from the previous benchmark (`NEXO_MEDIA_GPU_PRIORITY`, `_GPU_SCHED_HIGH`, `_ABOVE_NORMAL`) | Not re-run: they changed nothing then, and `queue-probe` confirms priority isn't what's missing | Stay off |

### Full screen, heavy: each lever, 2 rounds × 30 s

gpu-burn alone: 80.8 fps. "Each lever alone" sets the other two off.

| Configuration | captureFps mean (min) | encodeFps mean (p5 / min) | gpu-burn fps | game cost |
|---|---|---|---|---|
| `legacy` (copy, blit, NV12 straight in) | 13.4 (2.9) | 6.7 (1.9 / 1.9) | 78.9 | 2.3% |
| RGB input alone | 49.9 (40.0) | 30.5 (22.0 / 20.0) | 79.4 | 1.7% |
| zero copy alone | 39.9 (37.0) | 8.0 (7.0 / 7.0) | 79.3 | 1.8% |
| pipelining alone | 54.3 (52.0) | 54.3 (52.0 / 52.0) | 79.6 | 1.4% |
| RGB input + zero copy | 55.1 (54.0) | 48.1 (46.0 / 45.0) | 80.3 | 0.6% |
| **zero copy + pipelining (new defaults)** | **55.3 (54.0)** | **55.3 (54.0 / 53.0)** | 80.0 | 1.0% |
| *WGC with no processing (`raw`, profile run)* | *56.5* | – | – | – |

`legacy` varies a lot in this setup from run to run (6.7 here; 8.6–14 in single 15 s runs). Its frame rate is
whatever the queueing happens to allow. The pipelined configurations vary by less than 1 fps.

## Adopted

| Lever | Default | Off switch / opt-in | Fallback |
|---|---|---|---|
| Zero copy (ring holds WGC buffers, pool of 6) | **on** | `NEXO_MEDIA_ZERO_COPY=0` | Ring full (every slot leased): the frame is dropped and its buffer given back at once |
| Pipelined conversion (fence, ≤ 6 in flight) | **on** | `NEXO_MEDIA_PIPELINE=0` | No `ID3D11Device5`/fences: unpipelined, logged |
| RGB input for 1:1 sources | off | `NEXO_MEDIA_RGB_INPUT=1` | MFT refuses ARGB32 → NV12; a frame that isn't exactly the output size → converted to BGRA (letterboxed) |
| WGC pool size / MinUpdateInterval | 6 (zero copy) or 2 / 1 ÷ fps | `NEXO_MEDIA_WGC_BUFFERS=<n>`, `NEXO_MEDIA_WGC_MIN_INTERVAL_MS=<ms>` (0 = unset) | – |
| Profiling | off | `NEXO_MEDIA_PROFILE=1`, `NEXO_MEDIA_PROFILE_RAW=1` | – |

Checked on the new defaults: device-loss rebuild (`NEXO_MEDIA_TEST_DEVICE_LOST_AFTER_MS`, monitor share, zero copy
and RGB input: rebuilt in ~190 ms, 60 fps after), a mid-share window resize (pool recreated with frames still
held; RGB input falls back from direct to the BGRA conversion), `detail` with the Lanczos compute scaler at 720p,
encoder rebuilds (they now drop pipelined frames of the old encoder's pool first), and window and monitor dry
runs. `ctest` passes with no /W4 warnings.

Costs: the zero-copy pool holds 6 BGRA buffers instead of 2 + 3 ring copies (≈ the same VRAM at 1080p). Pipelining
adds the conversion's queueing to the latency: 13–28 ms under the game here, a few ms otherwise. Before, the
same wait sat inside the MFT (42–116 ms), so end-to-end latency went down, not up.

## Conclusion

- **The beta now holds 59.4 fps in the windowed case and 55.3 in the heavy full-screen case,** from 15.6 and
  6.7. The windowed case clears the 55 fps goal comfortably. The heavy case sits at WGC's own delivery rate
  for that load (56.5 raw), so the goal is met **only as far as WGC allows**. A game that loads the GPU more than
  this, or keeps more of its frames queued, will push WGC itself below 55, and nothing in our pipeline can recover
  that.
- **Against the alpha:** before this work the beta was far behind it (15.6 vs 57.2 windowed). Now it is equal or
  slightly better on frame rate (59.4 vs 57.2; 55.3 vs 54.8). It also costs the game less (1.0% vs 2.2%
  windowed). The alpha's texture flag does most of what our pipelining does. The beta's reason to exist is no longer
  frame rate under load; it is everything else in SPEC-BETA §1.
- The game's cost stays well inside the ≤ 5% goal in every configuration.

## What's left, and what it would take

With the new defaults our own pipeline is no longer the limit in either setup: encode follows capture, and capture
follows what WGC delivers with no processing at all (the `raw` row). What remains is upstream of us.

- **WGC's own delivery under a heavy full-screen game (~55 fps here).** DWM produces the capture frames, and its
  copy for us waits behind the game too. Nothing in our process changes that.
- **Our conversion still runs on the contended 3D queue.** Pipelining hides its 13–28 ms queueing by keeping
  several frames in flight, at the price of that much extra latency. With a heavier game (longer waits than
  `kMaxConverted` frames can cover: 6 frames ≈ 100 ms at 60 fps) the rate would drop again.

Options, roughly by cost:

| Option | Gain | Cost / risk |
|---|---|---|
| **NVENC / AMF / QSV SDKs directly** instead of the MFT | More frames in flight than the MFT's one; NVENC takes ARGB and converts on its own engine without a 3D job of ours; lower latency | Three vendor SDKs to integrate, test and keep working (the MFT is one code path for all); NVENC session limits stay |
| **D3D12 video encode** (`ID3D12VideoEncodeCommandList`, video-encode queue) | Encode on the video engine's own queue, explicit fences, no MFT | Win11 22H2+ and recent drivers only; scaling and RGB→NV12 still need a 3D/compute job; a lot of new code |
| **D3D12 copy queue** for the frames that need no scaling (copy engine: 0.3 ms even under the game, see the queue table) | Takes our remaining 1:1 GPU work off the 3D queue | Needs the encoder to take RGB (the MFT's own conversion caps it at ~49 here) and cross-API sharing (shared NT handles + shared fences between a D3D12 device and the MFT's D3D11 device) |
| **`REALTIME` GPU scheduling class / `GLOBAL_REALTIME` queue** | Would let our jobs (and maybe DWM's capture work for us) pre-empt the game | Needs admin (`D3DKMTSetProcessSchedulingPriorityClass(REALTIME)`; the realtime queue fails with `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE` here). A service running elevated just for this is a security and install-friction cost we don't want |
| **Hook-based game capture** (OBS "Game Capture": inject into the game, copy its back buffer before Present) | Frames straight from the game, no DWM in the way | **Non-goal** (SPEC-BETA §1): code injection into games trips anti-cheat |
| **Ask the user to cap the game** (the existing "capped game" hint) | Leaves the GPU some slack, everything gets 60 | Already there; a hint, not a fix |


