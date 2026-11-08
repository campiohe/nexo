# Beta M3 — GPU priority vs. a GPU-bound game

**Date:** 2026-11-08 · **Helper:** nexo-media 0.4.0-dev (branch `beta/native-media`) · **Spec:** SPEC-BETA §1 (goals),
§4.3 (priority levers), risk B2

## Question

When a game runs uncapped and keeps the GPU at ~100%, does the native helper still capture and encode at the Game
preset's 60 fps? Which of the three non-admin levers from SPEC-BETA §4.3 help, and what do they cost the game?

| Lever | What it does | Env flag |
|---|---|---|
| GPU thread priority | `IDXGIDevice::SetGPUThreadPriority(7)` on the helper's D3D11 device | `NEXO_MEDIA_GPU_PRIORITY` |
| Scheduling class HIGH | `D3DKMTSetProcessSchedulingPriorityClass(HIGH)` for the helper process (REALTIME needs admin: not tested) | `NEXO_MEDIA_GPU_SCHED_HIGH` |
| ABOVE_NORMAL | `SetPriorityClass(ABOVE_NORMAL_PRIORITY_CLASS)`: CPU priority of every helper thread | `NEXO_MEDIA_ABOVE_NORMAL` |

## Method

- **PC:** Windows 11 build 26200, NVIDIA GeForce RTX 3060 Ti, NVIDIA H.264 Encoder MFT. Primary monitor 1920×1080
  60 Hz. Hardware-accelerated GPU scheduling at the Windows default (no `HwSchMode` override in the registry).
- **The "game":** `native/tools/gpu-burn` (built and installed with the helper). It is a D3D11 window
  (1920×1080 client area) on the high-performance GPU, with a flip-model swapchain, `Present(0, ALLOW_TEARING)` and
  a fixed-cost ALU-heavy pixel shader (`--iterations 1500`). Alone it renders ~153 fps with the GPU at 100%
  (1890 MHz, 174 W per `nvidia-smi`). It prints its own fps every second.
- **The share:** `nexo-media.exe` driven over its stdio protocol. It shares the gpu-burn window (WGC window capture)
  with the **Game preset** (box 1920×1080, 60 fps, 8 Mbps, `motion`, cursor off) as a **dry run**
  (`NEXO_MEDIA_DRY_RUN=1`): capture, convert and encode all run, and only the network send is skipped (it costs no
  GPU). The 1 Hz `stats` events give `captureFps` (frames WGC delivered) and `encodeFps` (frames out of the
  encoder).
- **Run:** per configuration, start gpu-burn, wait 1.5 s, start the share, skip 4 s of warm-up, then record
  **30 s** of helper stats and gpu-burn fps over the same seconds. Every lever is set explicitly to 0 or 1 for
  each run. **Two rounds**, the second in reverse order so thermal drift doesn't favour one configuration. The
  `no-share` row is gpu-burn alone, the reference for the game's cost.
- **Foreground:** gpu-burn is made the foreground window (`--foreground 1`, as when a game is being played) or
  shown without activation (`--foreground 0`), and reports whether it is foreground every second.
- **Reproduce:** `scripts/native-build.sh && node native/tools/gpu-burn/bench-gpu-priority.mjs --trace` (add
  `--foreground 0` for the background case, `--configs above-normal+sched-high,…` for pairs of levers).

## Results

### 1. Game in the foreground (the real case: the user is playing it)

2 rounds × 30 s per configuration. One run (sched-high, round 1) is excluded: forcing focus failed and gpu-burn
stayed in the background for the whole run, which (see below) is exactly the variable that decides the result.
"Game cost" is against gpu-burn alone (152.9 fps).

| Configuration | captureFps mean (min) | encodeFps mean (p5 / min) | gpu-burn fps | game cost |
|---|---|---|---|---|
| baseline (no lever) | 19.5 (8.5) | 10.2 (6.0 / 3.8) | 149.8 | 2.0% |
| GPU thread priority 7 | 20.7 (10.0) | 11.2 (5.7 / 5.0) | 149.5 | 2.2% |
| scheduling class HIGH (1 run) | 20.3 | 11.2 (– / 4.0) | 149.3 | 2.4% |
| ABOVE_NORMAL | 20.9 (8.0) | 11.2 (5.1 / 4.0) | 149.5 | 2.2% |
| all three | 19.6 (10.0) | 9.9 (5.1 / 5.0) | 149.5 | 2.2% |

Per-second encode rates stay between 4 and 26 fps for every configuration, every second of every run.

### 2. Game in the background (visible, not focused: `--foreground 0`)

1 round × 20 s. gpu-burn alone: 146.7 fps.

| Configuration | captureFps mean (min) | encodeFps mean (min) | gpu-burn fps | game cost |
|---|---|---|---|---|
| baseline (no lever) | 59.6 (59) | 59.6 (59) | 142.0 | 3.2% |
| GPU thread priority 7 | 59.8 (59) | 59.8 (59) | 142.5 | 2.9% |
| scheduling class HIGH | 59.8 (59) | 59.8 (59) | 142.7 | 2.7% |
| ABOVE_NORMAL | 59.8 (59) | 59.7 (59) | 142.6 | 2.8% |
| all three | 59.7 (59) | 59.8 (59) | 142.8 | 2.7% |

### How the foreground variable was found

The first two matrices let gpu-burn's focus happen by chance (it starts from WSL, and Windows' foreground lock
sometimes refuses it focus). They looked bimodal: "all three" gave 59.3 fps in one round and 34.9 in another,
ABOVE_NORMAL alone 29 and 59.7, and pairs of levers ~10 fps. Logging gpu-burn's foreground state every second
showed a perfect split: every run at ~60 fps had the game *not* in the foreground; every run at ~10 fps had it
in the foreground, whatever the levers. gpu-burn now forces the state it is asked for (`--foreground 1|0`) and
the runner reports it (`fg` column, per-second trace with `--trace`).

All three levers report success without admin rights on this PC (`SetGPUThreadPriority(7)` → S_OK,
`D3DKMTSetProcessSchedulingPriorityClass(HIGH)` → STATUS_SUCCESS, `SetPriorityClass` → TRUE). They are applied;
they just don't change the outcome.

## Conclusion

- **None of the three non-admin levers helps.** With the game in the foreground the helper is starved to
  ~10 fps encoded (~20 fps captured) with or without them; with the game in the background it already holds
  60 fps without them. Windows' GPU scheduler favours the foreground process, and neither a GPU thread
  priority of 7, the HIGH scheduling class nor an ABOVE_NORMAL process class outranks that boost here.
- **Defaults: all three stay off** (`kGpuThreadPriorityDefault`, `kGpuSchedulingHighDefault`,
  `kAboveNormalDefault` in `src/d3d/device.hpp`). The env flags remain as opt-in switches (`=1`) for testing on
  other GPUs and drivers.
- **The §1 goal (≥ 55 fps with an uncapped GPU-bound game) is not met** on this NVIDIA PC: risk B2 has
  materialised. The game's own cost is fine (2–3%, inside the ≤ 5% goal), because the helper does so little GPU
  work. That work just waits too long behind the game's.
- **Where to look next** (not done in this pass, in order of expected payoff):
  1. Skip the video processor for 1:1 shares. The NVIDIA H.264 MFT accepts `D3DFMT_A8R8G8B8` (ARGB32) input
     as well as NV12 (logged with `NEXO_MEDIA_LOG=debug`), so a game window that needs no scaling could go WGC
     texture → encoder, with no 3D-engine blit of our own to be starved. The colour conversion would then run
     inside the encoder.
  2. Return the WGC buffer without our own copy (hold the frame until it is encoded, with a bigger pool). That
     removes our other per-frame GPU job and DWM's wait on it.
  3. D3D12 (or D3D11-on-12) with a high-priority or compute/copy queue, so our small jobs don't queue behind
     the game's graphics work.
  4. The REALTIME scheduling class needs admin: out of scope, but it would tell us whether priority alone can
     beat the foreground boost.
- Re-run on AMD and Intel GPUs (the vendor matrix) before generalising: the foreground boost and how the
  priority classes interact with hardware scheduling are vendor- and driver-specific.
