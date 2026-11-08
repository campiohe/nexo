# Developing Nexo

How to run Nexo from source, work on the native share helper, run the tests, and ship a release. For the
design, see [SPEC.md](SPEC.md) and, for the native capture engine, [SPEC-BETA.md](SPEC-BETA.md). The
build plans are in [PLAN.md](PLAN.md) (v1) and [PLAN-BETA.md](PLAN-BETA.md).

- [Repository layout](#repository-layout)
- [Dev setup](#dev-setup)
- [Running the desktop client on Windows](#running-the-desktop-client-on-windows)
- [Native share helper](#native-share-helper)
- [Server HTTP API](#server-http-api)
- [Tests](#tests)
- [Releasing](#releasing)
- [Contributing](#contributing)

---

## Repository layout

| Path | What |
|---|---|
| `desktop/` | Electron + React desktop app |
| `server/` | Nexo server (Node, socket.io, SQLite; TypeScript run natively) |
| `server-cli/` | `nexo-server`, the one-download server for hosts ([SPEC-SERVER-CLI](SPEC-SERVER-CLI.md)) |
| `shared/` | Wire types and constants shared by both |
| `native/` | `nexo-media.exe`, the native Windows capture helper ([SPEC-BETA](SPEC-BETA.md)) |
| `scripts/` | Dev and host scripts (`dev-up.sh`, `urls.sh`, `win-run.sh`, `native-build.sh`, …) |
| `docker-compose.yml`, `livekit.yaml` | LiveKit |
| `.env.example` | Shared config for the server and LiveKit |

## Dev setup

The dev environment is a Linux shell (on Windows: WSL2) with the same prerequisites as a server host:
Node.js ≥ 23.6 (developed on Node 26), Docker with the Compose plugin, `git`, `curl`, `openssl`, `unzip`.

Do steps 1–3 of the [server install](SERVER.md#install) (`.env` with a LiveKit secret, dependencies,
LiveKit), but run a plain `npm install` so the desktop workspace gets its Electron binary. Then:

```bash
# 4. Nexo server (watch mode, port 3001)
npm run server

# 5. In a second terminal: the desktop app
scripts/win-run.sh          # from WSL: build and launch on Windows (see below)
npm run dev -w desktop      # or, on Linux/macOS: electron-vite dev

# 6. Which URL do I type into Nexo?
scripts/urls.sh
```

`scripts/dev-up.sh` does steps 3, 4 and 6 in one go: it starts LiveKit, checks the keys, prints the URLs,
then runs the server in the foreground (`--prod` runs it without watch mode). Ctrl+C stops the server.
LiveKit keeps running in the background until `npm run media:down`.

## Running the desktop client on Windows

GUI apps always run on **Windows**, never inside WSL. Electron under WSLg can only capture Linux windows,
so it can't see Windows games, and it has no system audio.

```bash
scripts/win-run.sh                 # npm run build -w desktop, then launch on Windows
scripts/win-run.sh --no-build      # launch the last build again
NEXO_PROFILE=2 scripts/win-run.sh  # second, separate profile (log in as another user to test)
```

`scripts/win-run.sh` builds the app in WSL (`npm run build -w desktop`). The first time, it downloads
the matching Windows Electron binary (checksum-verified) into `%LOCALAPPDATA%\nexo-dev`. Then it copies
the build to the Windows filesystem and launches it there. Logs stream to the WSL terminal. Windows does
not need Node.

On the host PC, use the **`172.x` URL** from `scripts/urls.sh` (`http://172.26.x.x:3001`). See
[WSL networking notes](SERVER.md#wsl-networking-notes).

## Native share helper

The native capture engine (beta, [SPEC-BETA](SPEC-BETA.md)) is a separate program, `nexo-media.exe`.
`scripts/win-run.sh --native` also builds it (`scripts/native-build.sh`, needs the Windows prerequisites in
[SPEC-BETA §9.2](SPEC-BETA.md#92-windows-prerequisites-dev-pc)) and copies `native/out/*` into the dev
app's `resources/native/`. The copy stays there for later runs without `--native`.
`scripts/native-build.sh --doctor` checks the Windows toolchain and prints what's missing.

To work on the Electron side without the helper, use the fake one, `desktop/scripts/fake-nexo-media.mjs`.
It speaks the same protocol and is run by the Electron binary itself, so it also works with `npm run dev`
on Linux:

```bash
NEXO_MEDIA_FAKE=1 scripts/win-run.sh                       # fake helper: connecting → live → 1 Hz stats
NEXO_MEDIA_FAKE=1 FAKE_NEXO_MEDIA=crash scripts/win-run.sh # see the modes below
NEXO_MEDIA_DEBUG=1 scripts/win-run.sh --native             # log every helper command/event (token redacted)
```

`FAKE_NEXO_MEDIA` modes (comma-separated): `encoder-unavailable`, `crash`, `source-closed`, `stall`,
`livekit-connect`, `encoder-lost`, `device-lost`, `audio-failed`, `idle`, `no-audio`.
`NEXO_MEDIA_EXE=<path>` points main at another helper build.

The helper can also be driven directly (from a local-disk copy; borderless capture fails from `\\wsl$`):

```bash
native/out/nexo-media.exe --selftest            # adapter, hardware encoder, capture/audio features (JSON)
node --env-file=.env scripts/stream-token.mjs voice-<channelId> <userId> |
  native/out/nexo-media.exe --test-pattern --url ws://<WSL IP>:7880 --token-stdin --duration 120
```

The `--selftest` output is also what to paste into a bug report about native capture.

Tuning and profiling flags (env, read by the helper; `scripts/win-run.sh` passes `NEXO_MEDIA_*` through):
`NEXO_MEDIA_PROFILE=1` logs a per-second `profile:` line (add `NEXO_MEDIA_PROFILE_RAW=1` to count WGC frames
with no processing), `NEXO_MEDIA_PIPELINE=0` / `NEXO_MEDIA_ZERO_COPY=0` turn off the pipelined conversion and
zero-copy capture, `NEXO_MEDIA_RGB_INPUT=1` feeds BGRA straight to the encoder when no scaling is needed
(experimental), `NEXO_MEDIA_WGC_BUFFERS` / `NEXO_MEDIA_WGC_MIN_INTERVAL_MS` override the frame pool,
`NEXO_MEDIA_H264_PROFILE=baseline` switches the H.264 profile.

Benchmarks and their tools: [docs/benchmarks](benchmarks) (`native/tools/gpu-burn`, `queue-probe`,
`alpha-bench`). The tools run from the local-disk copy (`%LOCALAPPDATA%\nexo-dev\native\src\out`); don't run
`scripts/native-build.sh` during a benchmark, it replaces that folder.

## Server HTTP API

Besides socket.io ([SPEC §8](SPEC.md#8-wire-protocol-socketio)), the server serves profile pictures and chat
images over the same port (3001).

**Profile pictures** are stored as `DATA_DIR/avatars/<userId>`:

| Request | Auth | Result |
|---|---|---|
| `PUT /api/avatar` (body = image, `Content-Type` `image/webp`/`png`/`jpeg`, ≤ 512 KB) | `Authorization: Bearer <device token>` | `200 {user}` + `user:upsert` broadcast |
| `DELETE /api/avatar` | same | `200 {user}` + `user:upsert` broadcast |
| `GET /avatars/<userId>?v=<user.avatar>` | none | the image, cached long-term (the version changes on every upload) |

The server checks the file's magic bytes against its `Content-Type`. It doesn't decode images, so it needs
no native image libraries. Errors come back as JSON `{error}`: 400 empty, 401 bad token, 413 too big,
415 wrong type, 429 more than one change per 3 s.

**Chat images** are stored in `DATA_DIR/attachments/`:

| Request | Auth | Result |
|---|---|---|
| `POST /api/attachments` (body = image, matching `Content-Type`, ≤ 10 MB) | `Authorization: Bearer <device token>` | `201 {attachment}`, pending until a message uses it |
| `GET /attachments/<id>` | none (the id is a random UUID) | the image, cached long-term |

Uploads that no message claims within an hour are deleted. The limit is 20 uploads per minute per user.

## Tests

```bash
npm test                   # server protocol tests (boots a server on a random port) + server CLI tests
npm run typecheck          # server + desktop + server CLI
npm run typecheck -w server
```

---

## Server CLI

`server-cli/` packages the server for hosts ([SPEC-SERVER-CLI](SPEC-SERVER-CLI.md)): `src/main.ts` (entry),
`src/cli/` (setup, config.json, commands, lock, logs), `src/network/` (LAN, Tailscale, STUN, UPnP),
`src/livekit.ts` (LiveKit config and supervision). It imports the server's sources and runs it in-process.

```bash
npm run dev -w server-cli -- --data /tmp/nexo-dev-data     # from source (needs a LiveKit binary: NEXO_LIVEKIT_BIN)
npm run build -w server-cli       # dist/nexo-server.cjs (esbuild bundle)
npm run build:win -w server-cli   # dist/win-x64/: nexo-server.exe (Node single executable) + livekit-server.exe
```

`build:win` downloads the pinned Node 24 `node.exe` and LiveKit Windows zip (`server-cli/scripts/node.lock`,
`livekit.lock`, SHA-256 verified, cached in `server-cli/.cache/`), works from WSL or Windows, and takes
about 10 s with a warm cache. Run the exe from a local Windows disk, not `\\wsl$`. To test without
firewall prompts, bind to loopback: `HOST=127.0.0.1` (from WSL: `HOST=127.0.0.1 WSLENV=HOST ./nexo-server.exe`).

Keep the LiveKit pin in `livekit.lock` equal to `docker-compose.yml`.

---

## Releasing

Friends download from **[Releases](https://github.com/campiohe/nexo/releases)**. Each release has the
Windows `.exe`, the macOS `.dmg` and the Linux `.AppImage`. After the first install, Nexo updates itself
(see [Updates](USER-GUIDE.md#updates)).

To ship a new version:

1. Bump `version` in `package.json`, `desktop/package.json`, `server/package.json` and
   `server-cli/package.json`, then run `npm install --package-lock-only`. The workflow refuses a tag that
   doesn't match `desktop/package.json`, or a `server-cli` version that differs from it.
2. Optionally write `.github/release-notes/vX.Y.Z.md`. For a test build (`X.Y.Z-test.N`), see
   [Test builds](#test-builds).
3. Commit, then `git tag -a vX.Y.Z -m "Nexo vX.Y.Z" && git push origin main vX.Y.Z`.

The **Release** workflow (`.github/workflows/release.yml`) builds all three installers and the Windows
server zip (`Nexo-Server-X.Y.Z-win-x64.zip` + `.sha256`, which `nexo-server update` uses), and publishes
the release. Tags with `-alpha`/`-beta`/`-rc` are marked as prereleases.

Installed apps find new versions through the release files, so every release must have, with the names
electron-builder gave them:

- `Nexo-Setup-X.Y.Z.exe`, `Nexo-Setup-X.Y.Z.exe.blockmap` and `latest.yml` (Windows)
- `Nexo-X.Y.Z-universal.dmg`, `Nexo-X.Y.Z-universal.dmg.blockmap` and `latest-mac.yml` (macOS)
- `Nexo-X.Y.Z-x86_64.AppImage` and `latest-linux.yml` (Linux; the AppImage carries its own block map)

The workflow uploads all of them. If you ever upload by hand, don't rename anything: the `latest*.yml`
files name the installer that the app downloads.

The installers are unsigned, so Windows SmartScreen shows a warning: click **More info → Run anyway**.
For a local build, `npm run dist:win -w desktop` writes to `desktop/release/`. From Linux it may need
Wine; the CI build doesn't.

### Update lanes

Alpha builds update to the newest release, whether it's an alpha, a beta or stable; stable builds only
get stable releases. Beta builds take betas and stable releases but **never alphas**, so once a beta is
out, keep tagging `-beta` (or stable). (electron-updater skips `-rc` tags for alpha builds, so prefer
`-beta` for prereleases.)

### Test builds

To try a change with a few friends before everyone gets it, publish a **test build**: a version like
`0.4.0-test.1`, tagged `v0.4.0-test.1`, released the same way as any version (see
[Releasing](#releasing)). The release is marked as a prerelease. What testers see, and how they leave the
lane, is in the [User guide](USER-GUIDE.md#test-builds).

- Alpha, beta and stable installs skip `-test` releases, and a test build only follows newer test builds.
- Test builds talk to the same server as everyone else. If one needs server changes, those must keep
  working for the regular version too.
- The release workflow refuses a tag that doesn't match `desktop/package.json`, since the version decides
  which updates an install gets.

---

## Contributing

Issues and pull requests are welcome. Before opening a PR, run `npm run typecheck` and `npm test`.
Architecture and design decisions are in [SPEC.md](SPEC.md).
