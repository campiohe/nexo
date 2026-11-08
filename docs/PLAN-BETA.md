# Nexo — Implementation Plan (Beta: native media engine)

**Date:** 2026-11-07 · **Spec:** [SPEC-BETA.md](./SPEC-BETA.md) · **Base:** v0.3.0-alpha.1

The beta ports **game and screen sharing on Windows** to the native helper `nexo-media.exe` (WGC capture,
hardware H.264 through Media Foundation, pre-encoded publish through the LiveKit C++ SDK). Voice, webcam,
viewing, and macOS/Linux stay as they are.

## Status (2026-11-08, branch `beta/native-media`)

| Phase | State |
|---|---|
| 0 · M0 spike | ✅ Done. Pre-encoded H.264 published from our own MF encoder: 1080p60, 0 dropped. Viewer check by eye still open |
| 1 · Contracts | ✅ Done |
| 2 · M1 video (N, S, E, R) | ✅ Done (`83a5a0c`) |
| 3 · Integration | ✅ Real supervisor + real helper + LiveKit end to end. ⏳ Your two-PC check and the alpha vs beta game benchmark |
| 4 · M2 audio | ✅ Done (`83924e6`). Include and exclude verified by measurement. ⏳ By-ear check, Windows 10 builds |
| 5 · M3 hardening | ✅ Device-loss rebuild, fast stop, LiveKit restart, shareId, motion ⇄ detail. ✅ GPU starvation (SPEC-BETA B2): pipelined conversion + zero-copy capture, 59.4 / 55.3 fps with a GPU-bound game in focus (was 15.6 / 6.7), on par with the alpha's texture path ([fps-gap benchmark](benchmarks/beta-m3-fps-gap.md)). ⏳ AMD/Intel encoders, real games |
| 6 · M4 release | ⏳ Docs done. Version bump, release notes and tag after the hardware checks |

## Decisions locked for the beta

| Topic | Decision |
|---|---|
| Engine | Fully native streaming path (SPEC-BETA D1–D5). The alpha `getDisplayMedia` path stays as the fallback |
| LiveKit SDK | C++ client SDK, pinned at **v1.13.1**, pre-encoded H.264 via `EncodedVideoSource` |
| Encoder | Media Foundation hardware H.264 MFT. No vendor SDKs in the beta |
| Stream identity | Second participant `<userId>#stream`, signed by the server (`voice:streamToken`) |
| Build | MSVC on Windows, driven from WSL by `scripts/native-build.sh`. CI on `windows-latest` |
| Scope | Window and monitor shares, all four presets, app audio and "system without Nexo" audio |

**Defaults taken (change them before Phase 2 if you disagree)**

- **No self-preview** for the streamer. The stage shows a "You're live" card with the helper's stats instead
  (SPEC-BETA §11.8).
- "Hide Nexo from the stream" is **on** by default for monitor shares.
- Capture engine setting defaults to **Native** on Windows when the helper reports a hardware encoder.
- **Mixed versions during rollout:** an alpha client watching a beta streamer sees `X#stream` as an extra
  participant with a stream tile. That's accepted: auto-update brings everyone to the beta quickly.

---

## Phase 0 — M0 spike (coordinator, sequential, gate)

Proves the riskiest assumption before anything else is built: **pre-encoded H.264 from our own MF encoder plays
in Nexo viewers**. No Electron or renderer changes are needed: the alpha UI already shows any participant's
ScreenShare track as a stream tile.

1. **Toolchain check.** `scripts/native-build.sh --doctor` finds VS 2022 Build Tools (`vswhere.exe`), the Windows
   11 SDK (with `cppwinrt` headers), CMake and Ninja, and prints what's missing.
2. **LiveKit SDK.** Check the v1.13.1 release assets for a Windows x64 bundle. If one exists, pin it in
   `native/livekit-sdk.lock` (version, URL, SHA-256) and have the build script download and verify it. If not,
   build once from source (`build.cmd release --bundle`), document the steps, and pin the source tag.
3. **Skeleton** `native/nexo-media/`: CMake presets (`windows-release`, `windows-debug`), C++20, links
   `WindowsApp.lib`, `d3d11`, `dxgi`, `mfplat`, `mf`, `mfuuid` and `LiveKit::livekit`. The output folder gets
   `livekit.dll`, `livekit_ffi.dll` and the app-local VC++ runtime DLLs.
4. **`--selftest`** prints capabilities as JSON: OS build, adapters (LUID, name, vendor), hardware H.264 MFTs
   per adapter, and WGC feature support (`ApiInformation`).
5. **`--test-pattern`** renders a moving D3D11 pattern (color bars plus a moving block per frame, so dropped
   frames show), then converts to NV12, encodes with the MF encoder, and publishes as ScreenShare through
   `EncodedVideoSource`. It logs `takeFeedback()` (keyframe requests, target bitrate).
6. **Dev token.** `scripts/stream-token.mjs` (same style as `check-livekit.mjs`, using `livekit-server-sdk` and
   `.env`) prints a `<userId>#stream` token with the beta grants for a given room.
7. **Viewer check.** Run `scripts/win-run.sh`, join the voice channel, watch the `#stream` participant's tile.
   Also join late, after the pattern has started.
8. **Record the answers** to SPEC-BETA §11 questions 1–5 and 7 in the spec (a "Resolved" column), and correct
   §4 or §6 wherever the real API differs.

**Gate:** the pattern plays at 60 fps in Nexo. A viewer joining late gets a picture within ~1 s (the keyframe
request reaches us). Bitrate feedback arrives and changes the encoder's bitrate. **If pre-encoded publishing can't
be made to work, stop here** and revisit D1/D3 before writing anything else.

---

## Phase 1 — Contracts (coordinator)

Fixed before the fan-out so the workstreams can't collide.

- `shared/protocol.ts`: `'voice:streamToken': (p: { channelId: string }, ack: Ack<StreamCredentials>) => void`
  with `StreamCredentials { url, token, identity }`.
- `shared/stream.ts`: `streamIdentity(userId)`, `streamOwner(identity): string | null`. Server and renderer use
  the same helpers.
- `desktop/src/main/native-media/protocol.ts`: protocol v1 commands and events (SPEC-BETA §6). The mirror,
  `native/nexo-media/src/ipc/protocol.hpp`, is owned by workstream N and must match it.
- `desktop/src/preload/api.ts`: the `NativeShareApi` type (`capabilities`, `start`, `update`, `stop`, `on`), its
  IPC channel names, and `AppPrefs.captureEngine: 'native' | 'chromium'`.
- `desktop/scripts/fake-nexo-media.mjs`: a **fake helper** that speaks protocol v1. It reports capabilities with a
  fake encoder, goes `connecting` → `live`, and sends 1 Hz stats. `FAKE_NEXO_MEDIA=encoder-unavailable|crash|
  source-closed|stall` simulates failures. It runs with `ELECTRON_RUN_AS_NODE=1` on the Electron binary, so it
  also works on Windows without Node and under WSLg. Main uses it when `NEXO_MEDIA_FAKE=1`.

---

## Phase 2 — Parallel workstreams (M1: video)

Strict file ownership, as in v0.3. A workstream may read anything but edits only its own files. A contract
change is reported to the coordinator, not made directly. Nobody commits.

| Workstream | Owns (creates or edits) | Must not touch |
|---|---|---|
| **N: Native helper** | `native/**`, `scripts/native-build.sh` | `desktop/**`, `server/**`, `shared/**` |
| **S: Server** | `server/src/**`, `server/test/**` | `shared/**` (Phase 1 contract), `desktop/**`, `native/**` |
| **E: Electron main, preload, packaging** | `desktop/src/main/**` (except `native-media/protocol.ts`), `desktop/src/preload/index.ts`, `desktop/electron-builder.yml`, `scripts/win-run.sh`, `.github/workflows/release.yml` | renderer, server, `native/**` |
| **R: Renderer** | `desktop/src/renderer/src/voice/**`, `components/voice/**`, `components/SettingsModal.tsx` | main, preload, server, `native/**` |

### N · Native helper

- `d3d/device`: adapter pick (high-performance first, must have a hardware H.264 MFT with a matching LUID),
  device flags, multithread protection, device-lost detection with a rebuild hook.
- `capture/wgc`: item from an HWND, or an HMONITOR via `MonitorFromRect`. Free-threaded frame pool, session
  options gated by `ApiInformation`, `Recreate` on resize, `Closed` → `ended`. `CopyResource` into a ring
  texture. Stalled detection.
- `video/convert`: `ID3D11VideoProcessor` BGRA → NV12, output size picked once (aspect fit, even dimensions, no
  upscale), letterboxing after that. BT.709 limited range.
- `video/encoder_mf`: enumerate by LUID, async MFT event loop, the SPEC-BETA §4.6 settings, the `motion`
  (CBR) and `detail` (peak-constrained VBR plus max QP) profiles, forced IDR at most every 500 ms, live bitrate
  changes, an SPS/PPS cache with repair on IDRs, Annex B output.
- `video/pacer`: the encode tick, latest-frame-wins, the 1 fps idle refresh, and the degradation policy from
  SPEC-BETA §4.9 (motion steps fps down to 30 under a bitrate floor, detail down to 5). **Pure logic, no
  D3D**, so it's unit-testable.
- `publish/livekit`: connect (`auto_subscribe = false`), `EncodedVideoSource` + ScreenShare publish, feedback
  poll into encoder and pacer, `state` events across reconnects.
- `main.cpp`: protocol loop, parent watchdog (stdin EOF plus the `--parent-pid` handle), `--selftest`,
  `--test-pattern`, and `log` events with the token redacted.
- `tests/` (ctest): Annex B / NAL parsing, SPS/PPS repair, output size, pacer and degradation, protocol codec.

**Done when:** ctest passes, the helper builds from WSL, and driving it by hand (piping protocol v1 JSON into
stdin) shares a real game window and a monitor that a Nexo viewer can watch.

### S · Server

- `voice:streamToken`: the channel must exist and be a voice channel, **and**
  `voiceStates.get(userId)` must point at that channel from **this socket**. Identity from `streamIdentity()`,
  the user's name and metadata, TTL `LIMITS.tokenTtl`. Grants per SPEC-BETA §7 (`canSubscribe: false`,
  `canPublishData: false`, `canPublishSources: ['screen_share', 'screen_share_audio']`).
- Tests in `server/test/protocol.test.ts`: rejects when not in voice, in another channel, or from another
  socket. On success, decode the JWT payload and check the identity, room and every grant field.

**Done when:** `npm test -w server` passes.

### E · Electron main, preload, packaging

- `main/native-media/supervisor.ts`: lazy spawn. Exe path: `process.resourcesPath/native/nexo-media.exe` when
  packaged, the dev copy, `NEXO_MEDIA_EXE`, or the fake helper with `NEXO_MEDIA_FAKE=1`. JSON-lines codec,
  `hello` and a capabilities cache, command ids with timeouts, restart once then fall back (SPEC-BETA §4.1). Kill
  on leaving voice and on quit. Windows only, unless the fake is on.
- IPC handlers (`isAppUrl` sender checks, like `capture.ts`) that forward `state`, `stats`, `ended` and `error`
  to the renderer. The token goes from the renderer to main to the helper's stdin, never into a log.
- `capture.ts`: translate a picker id into a helper source: `window:<hwnd>` → `{ kind: "window", hwnd }`;
  `screen:` → the `Display` with that `display_id` → `screen.dipToScreenRect` → `{ kind: "monitor", rect }`.
- Content protection: while a monitor share with "hide Nexo" is live, call `setContentProtection(true)` on all
  windows. Restore on every end path, including a helper crash.
- `prefs.ts`: `captureEngine`. `fastCapture` stays and only applies to the Chromium engine.
- Packaging: `scripts/win-run.sh --native` (build, then copy the helper's `out\` into `resources/native/`).
  `electron-builder.yml` win `extraResources`. In `release.yml`, the Windows job builds the helper and runs ctest
  and `--selftest` before `electron-builder`.

**Done when:** typecheck and build pass, and with the fake helper (Windows via `win-run.sh`, or WSLg) every
supervisor path works: start, stats, ended, error, crash → restart, a second crash → fallback signal.

### R · Renderer

- `voice/session.ts` `startShare`: pick the engine (setting plus capabilities). Native flow: `voice:streamToken` →
  `nativeShare.start` (preset including `contentHint`, audio mode, hide-Nexo). Helper stats feed `shareStats` /
  `shareCaptureLow`. `ended` and `error` are handled, with **one** retry on the Chromium path plus a toast. Stop on
  leave. The "toggle screen share" hotkey restarts the last native share. `streaming` voice state is announced as
  before.
- `voice/participants.ts` + session: `#stream` participants are hidden from member lists, tiles and join/leave
  handling. Their ScreenShare / ScreenShareAudio publications join the owner's view model. `watchStream`,
  `wantsSubscription` and stream volume stay keyed by the owner. **Never subscribe to your own stream
  participant.**
- `VoiceStage`: a "You're live" card for your own native share (preset, fps, bitrate, encoder, stalled or
  minimized notice).
- `SharePicker`: a "Hide Nexo from the stream" checkbox for screen sources (native engine only), and audio labels
  "App audio" (window) / "System audio (without Nexo)" (screen).
- `SettingsModal` → App: the **Capture engine** selector (Windows only), showing the helper's adapter and encoder,
  or why native isn't available.

**Done when:** typecheck and build pass, the full share UI flow works against the fake helper, and the Chromium
path (macOS, Linux, fallback) still works unchanged.

---

## Phase 3 — Integration and M1 exit (coordinator + you on Windows)

1. `npm run typecheck`, `npm test`, `scripts/native-build.sh`, ctest.
2. `scripts/win-run.sh --native` with two profiles on one PC (`NEXO_PROFILE=2`). One streams a window, then a
   monitor, with each preset, and the other watches. Check the hide-Nexo, fallback and restart paths.
3. **You:** a real uncapped game streamed to a second PC. Run the SPEC-BETA §12 benchmark (alpha vs beta, Game
   preset, 5 min) and record it in `docs/benchmarks/beta-m1.md`. Also run a Sharp-preset text check: an IDE at
   normal font size, readable on the viewer's screen.
4. Fix seams and resolve any contract changes the workstreams reported.

---

## Phase 4 — M2: stream audio

- **N:** `audio/wasapi_capture`, one class configured for process loopback (later reusable for other WASAPI
  capture). `ActivateAudioInterfaceAsync` with include-tree (window) and exclude-tree (screen) modes. 48 kHz
  stereo int16, or a downmix if §11.5 says mono only. A 10 ms silence-fill clock. `AudioSource` publish as
  ScreenShareAudio. An `audio-failed` error keeps the video running.
- **E:** pass the audio mode and `excludePid = process.pid`.
- **R:** no new UI beyond the Phase 2 labels. Stream volume already applies.
- **Verification (you):** share a game window and the viewer hears only the game. Share a screen while talking in
  voice and the viewer hears your voice **once** (from voice), never echoed in the stream.
- Update SPEC.md R1 as resolved on Windows.

---

## Phase 5 — M3 hardening

| Scenario | Expected |
|---|---|
| Game window resized or aspect changed | Letterboxed, the stream continues, no republish |
| Window minimized, then restored | Stats `stalled` → "Window minimized" card, then resumes |
| Shared window closed | `ended: source-closed`, the share stops cleanly in the UI |
| GPU reset (`dxcap -forcetdr`) | Device rebuilt, the stream resumes with an IDR, track still published |
| LiveKit restarted or network drop | `reconnecting` → `live` |
| Helper killed (`taskkill`) | Restarts once and resumes. A second time within 60 s → Chromium fallback plus a toast |
| Electron killed | Helper exits by itself (watchdog) |
| Leaving voice or quitting during a share | Clean stop, content protection restored |
| No hardware encoder (`NEXO_MEDIA_DISABLE_HW=1`) | `encoder-unavailable` → Chromium path |
| NVENC session limit (OBS recording at the same time) | `encoder-unavailable` → Chromium path |
| Multi-monitor with mixed DPI | The right monitor is captured at its physical size |
| HDR display | Picture correct (SDR-converted), notes for §11.9 |
| Windows 10 22H2 | Missing features (borderless, `MinUpdateInterval`) degrade quietly |

Measurements:

- **GPU priority matrix:** baseline / `SetGPUThreadPriority(7)` / scheduling class HIGH / both, each measuring
  captureFps under an uncapped game. Keep what helps, as defaults.
- **`detail` scaler:** video processor vs a compute-shader bicubic/Lanczos scaler, 4K text sent at 1080p.
- **Vendor matrix:** at least one NVIDIA, one AMD and one Intel PC among your friends.
- **Antivirus:** Windows Defender scan of the installer and the helper.

---

## Phase 6 — M4: beta release

- Capture engine defaults to Native. Version `0.4.0-beta.1` (the release workflow already marks `-beta` tags as
  prereleases).
- `.github/release-notes/v0.4.0-beta.1.md`.
- README: the Windows prerequisites for building the helper, `scripts/native-build.sh`, and pasting
  `nexo-media.exe --selftest` output into bug reports. SPEC.md: link to SPEC-BETA, update R1 and R3.
- **Exit:** a full session of real games with friends and no fallback triggered.

---

## Verification you do (needs real hardware)

- Install the Windows prerequisites (VS 2022 Build Tools, *Desktop development with C++*, a Windows 11 SDK).
- Phase 0 viewer check, the Phase 3 benchmark and text check, the Phase 4 audio checks, and the Phase 5 vendor
  matrix with friends' PCs.

## Out of scope for the beta (tracked)

Native voice, webcam and viewing. Native capture on macOS and Linux. HDR streaming. Simulcast. HEVC and AV1.
Vendor encoder SDKs. Code signing.
