# Nexo — Implementation Plan (v1)

**Date:** 2026-11-07 · **Spec:** [SPEC.md](./SPEC.md)

## Decisions locked for v1

| Topic | Decision |
|---|---|
| Hosting | Owner's PC. LiveKit + Nexo server in WSL2, friends join over Tailscale (installed inside WSL). |
| Friends' OS | Windows first. macOS and Linux should build and run, but system audio is best-effort there. |
| Webcam | Included (simple on/off, 720p). |
| Permissions | Everyone can create, rename and delete channels. Confirm dialog before deleting. |
| Stream audio echo (R1) | Accepted for v1. The share dialog suggests headphones. Per-app audio comes in v2. |

## Phase 0 — Foundation (done before fan-out)

Done by the coordinator so parallel work can't collide:

- npm workspaces (`server`, `desktop`) with all dependencies installed and the Electron binary downloaded.
- `shared/protocol.ts`: the wire contract between server and client.
- `desktop/src/preload/api.ts`: the `NexoBridge` contract between Electron main/preload and the renderer.
- Renderer **contract stubs** with exact exports: `net/socket.ts`, `store/app.ts`, `voice/session.ts`, `components/voice/{VoiceStage,VoiceControls,DeviceSettings}.tsx`.
- `styles/tokens.css`: design tokens (colors, radii, fonts).
- Build config: electron-vite, TypeScript projects, `@shared` / `@renderer` aliases.
- Server draft (`server/src/*`), LiveKit compose and config, `.env`.

## Phase 1 — Parallel workstreams

Each workstream owns a disjoint set of files. It may **read** anything, but **edits only its own files**. If a contract needs to change, the workstream reports it instead of editing someone else's file.

### A · Server and infrastructure

**Owns:** `server/**`, `docker-compose.yml`, `livekit.yaml`, `.env.example`, `scripts/**`, `README.md`

- Review and harden the draft server against SPEC §5, §7 and §8.
- Make LiveKit advertise a configurable node IP (`LIVEKIT_NODE_IP`, for the Tailscale IP).
- Write a `scripts/` helper that prints the URLs friends should use: the tailnet IP if present, otherwise the LAN or WSL IP.
- Write an **automated protocol test** (`server/test/protocol.test.ts`, run with `node --test`) that covers identity, channels, messages, history paging, typing, voice state and token minting.
- Start LiveKit with Docker and verify it accepts the server's tokens (for example with `RoomServiceClient.listRooms`, or by checking the token validates).
- Write the README: quick start, Tailscale setup, running the Windows client, ports, troubleshooting.

**Done when:** `npm test -w server` passes, LiveKit runs and accepts the keys, and the README is complete.

### B · Electron shell and capture

**Owns:** `desktop/src/main/**`, `desktop/src/preload/index.ts`, `desktop/src/renderer/index.html` (CSP), `desktop/electron-builder.yml`, `desktop/resources/**`

- Main window: about 1280×800, minimum 940×600, dark background color, no menu bar, remembers window bounds. Single-instance lock.
- Security: `contextIsolation`, `sandbox`, no node integration. Navigation and `window.open` are blocked, and http(s) links go to the system browser. Permission handler allows only `media` / `display-capture` / `fullscreen`. Tune the CSP in `index.html` so it works in both dev and production.
- Capture: implement `listSources` (screens and windows, thumbnails, icons, excluding Nexo's own window), `selectSource`, and `session.setDisplayMediaRequestHandler` (`audio: 'loopback'` on Windows/macOS when requested). On Linux Wayland, use the system picker.
- `secrets` via `safeStorage`, stored in a JSON file under `userData`, with a plain fallback when encryption is unavailable.
- Set `autoplayPolicy: 'no-user-gesture-required'` so remote audio plays.
- electron-builder config: appId, product name "Nexo", Windows NSIS, macOS dmg (with mic, camera and screen-capture usage descriptions), Linux AppImage. Generate an original app icon (SVG to PNG, simple geometric mark).

**Done when:** typecheck and `electron-vite build` pass, and `electron-builder --linux --dir` produces an unpacked app.

### C · Renderer core and chat

**Owns:** `desktop/src/renderer/src/{App.tsx, main.tsx, net/**, store/**, components/*.tsx (not components/voice/**), styles/** except tokens values}`

- `net/socket.ts`: the full contract. Websocket transport, `request()` with acks and timeout, handling for every server event, and the `UNKNOWN_TOKEN` path back to onboarding. Reconnect status flows into the store, and `onConnected` callbacks fire after each bootstrap.
- `store/app.ts`: complete the store (`me`, users, presence, channels, messages, typing expiry, selection), plus `store/settings.ts` (server URL and last channel in localStorage; the token in `window.nexo.secrets`).
- Onboarding screen (server URL, name, color swatches, optional password, readable errors).
- Layout: sidebar (server name, TEXT and VOICE sections with "+" to create, right-click or hover menu to rename and delete, voice members under each voice channel with mute, deafen and LIVE icons, `<VoiceControls/>` slot, user panel with a settings button). Center pane: text channel or `<VoiceStage/>`. Right: member list (online/offline, LIVE badge).
- Text channel: history with "load older" when scrolled to the top, auto-scroll to the bottom on new messages (unless the user has scrolled up), grouping of consecutive messages from the same author, timestamps, linkified URLs opened through `nexo.openExternal`, deleting your own messages, a multiline composer (Enter sends, Shift+Enter adds a new line), and a typing indicator.
- Settings modal: color, server info and disconnect, and the `<DeviceSettings/>` slot.
- Clicking a voice channel calls `useVoice.getState().join(id)` **and** selects it.

**Done when:** typecheck and build pass, and a headless run against the real server shows that chat works (see verification below).

### D · Voice, video and streaming

**Owns:** `desktop/src/renderer/src/voice/**`, `desktop/src/renderer/src/components/voice/**`

- `voice/session.ts`: the full contract on top of livekit-client. Get a token through `request('voice:token')`, then create a `Room` with `adaptiveStream` and `dynacast` and connect. Mic is on by default, with selected devices applied. Mute, deafen (remote volume 0 plus mic muted), camera, and switching channels (leave, then join). Re-send `voice:state` on every change **and** inside `onConnected` (to survive server reconnects). Clean up on leave and on window unload.
- Screen share with the four SPEC §6.2 presets. Call `nexo.capture.selectSource` before `getDisplayMedia`, apply `contentHint`, publish with the preset's bitrate, frame rate, degradation preference and H.264 codec, and the audio track as `ScreenShareAudio` with the stereo music preset. Handle the OS "stop sharing" event (`track.onended`).
- Remote audio: attach each track to its own audio element, honor deafen, and apply the selected output device.
- Expose participants and tracks to React (a small participants store or hook that re-renders on LiveKit events: speaking, mute changes, track publish and unpublish).
- `VoiceStage`: responsive grid; participant tiles with an avatar circle in the user's color, a speaking ring, mute icon and camera video; stream tiles with a LIVE badge and the streamer's name. Click to focus, double-click for fullscreen, and a per-stream volume slider for stream audio. Clicking a LIVE user who isn't being watched shows "Watch stream".
- `VoiceControls`: channel name, connection quality and status, buttons for mute, deafen, camera, share and leave.
- `SharePicker` modal: Screens and Windows tabs with thumbnails, a preset selector, an audio checkbox (disabled with an explanation when `!supportsSystemAudio`), a headphones hint, and a Wayland path.
- `DeviceSettings`: mic, speaker and camera selects, and a live mic level meter.

**Done when:** typecheck and build pass. LiveKit cannot be exercised headlessly here, so the logic must be reviewed carefully against the livekit-client typings in `node_modules/livekit-client/dist/src`.

## Phase 2 — Integration (coordinator)

1. Typecheck and build everything. Run the server tests.
2. Start LiveKit and the server. Launch the Electron app under WSLg, onboard, send messages, join voice, and check the logs and devtools console for errors.
3. Fix seams between workstreams and resolve any contract changes they reported.
4. Update the README with known limitations.

## Verification the user does (needs real hardware)

- Install Tailscale in WSL and log in. Run `scripts/` to get the friend URLs.
- Build the Windows client (`npm run dist:win -w desktop` on Windows) or run `npm run desktop` from a Windows checkout.
- Two-person test: voice, then a game share at the Game preset, checking audio and smoothness.

## Out of scope for v1 (tracked)

Push-to-talk, per-user volume for voice, per-application audio capture, DMs, uploads, reactions, editing, notifications and unread state, auto-update, code signing.

---

## v0.3 plan: images, global hotkeys, noise suppression (SPEC §13)

Three parallel workstreams in one working tree, with strict file ownership. Nobody commits. Integration,
Windows end-to-end checks and the release happen after all three finish.

| Workstream | Owns (creates or edits) | Must not touch |
|---|---|---|
| **I: Images** | `shared/protocol.ts` (Message/Attachment, `message:send`), `server/src/*` + `server/test/*` (new `attachments.ts`, db migration, send/delete/channel-delete cleanup, sweep, rate limit), renderer chat: `Composer.tsx`, `MessageList.tsx`, `MessageContent.tsx`, `TextChannel.tsx`, new `ImageLightbox.tsx`, new `net/attachments.ts`, `store/app.ts` (sendMessage signature), chat CSS | voice/*, main/*, preload/*, SettingsModal |
| **H: Hotkeys** | `desktop/src/main/ptt.ts` → `hotkeys.ts`, `main/index.ts` (install call only), `preload/api.ts`, `preload/index.ts`, `renderer/src/voice/ptt.ts`, `voice/prefs.ts` (binding fields), new `renderer/src/lib/keybinds.ts`, `App.tsx` (in-app shortcuts), `SettingsModal.tsx` (new Keybinds tab) | server, shared, chat components, `voice/session.ts` (use `useVoice.getState()` actions only), DeviceSettings |
| **N: Noise suppression** | new `renderer/src/voice/noise.ts`, `voice/session.ts` (mic capture/publish only), `voice/devices.ts` (noise-mode pref), `components/voice/DeviceSettings.tsx` (mode selector and mic test), `renderer/index.html` (CSP `'wasm-unsafe-eval'`), `desktop/package.json` + root `package-lock.json` (add `@sapphi-red/web-noise-suppressor`), `electron.vite.config.ts` if asset handling needs it | server, shared, main, preload, SettingsModal, voice/prefs.ts, voice/ptt.ts |

Each workstream finishes with:
- `npm run typecheck -w desktop`; for I, also `npm test -w server`. Errors in files another workstream
  owns are reported, not fixed.
- A short report listing the files changed, decisions taken, anything left for integration, and how to
  verify by hand.
