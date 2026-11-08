# Nexo

Nexo is a self-hosted desktop app for a small group of friends: text channels, voice channels, webcam,
and screen or game sharing at up to 1080p60 while the others watch. No accounts, no email: you pick a
name and a color, and the app remembers you.

**Architecture.** An Electron + React desktop client talks to the **Nexo server** (Node, socket.io and
SQLite: identity, channels, messages, presence, voice state) for everything except media. Voice, video and
streams go through **LiveKit**, a self-hosted WebRTC SFU in Docker, using short-lived tokens the Nexo
server signs. See [docs/SPEC.md](docs/SPEC.md) for the full design and [docs/PLAN.md](docs/PLAN.md) for
the v1 plan.

```
Nexo Desktop (Windows) ──socket.io :3001──▶ Nexo server (WSL)
        └──────────────WebRTC :7880/:7881/:7882──▶ LiveKit (Docker, in WSL)
```

In v1 Nexo runs on the owner's PC: the server and LiveKit run inside WSL2, and friends connect over
[Tailscale](https://tailscale.com).

---

## Prerequisites

On the **host PC** (the one running Nexo):

- Windows 10/11 with **WSL2** (Ubuntu) and **systemd enabled** in WSL (`/etc/wsl.conf` has
  `[boot]` `systemd=true`).
- **Docker Engine** with the Compose plugin, installed **inside WSL** (`docker compose version` works).
  Docker Desktop also works, but host networking must be available.
- **Node.js ≥ 23.6** inside WSL (developed on Node 26). The server runs TypeScript directly, so there is
  no build step.
- `git`, `curl`, `openssl`, `unzip`.
- A free **Tailscale** account.

Windows itself needs **no Node**. The desktop app is built in WSL and runs with a Windows Electron
binary (see [Running the desktop client on Windows](#running-the-desktop-client-on-windows)).

Each **friend** needs Windows 10/11, the Nexo installer, and Tailscale.

---

## Quick start (host PC, inside WSL)

```bash
git clone <this repo> nexo && cd nexo

# 1. Config: copy the template and generate the LiveKit secret.
#    The secret must appear in BOTH LIVEKIT_API_SECRET and LIVEKIT_KEYS.
cp .env.example .env
S=$(openssl rand -hex 32)
sed -i "s/^LIVEKIT_API_SECRET=.*/LIVEKIT_API_SECRET=$S/; s/^LIVEKIT_KEYS=.*/LIVEKIT_KEYS=nexo: $S/" .env
unset S

# 2. Dependencies (server + desktop workspaces)
npm install

# 3. Media server (LiveKit in Docker, host networking)
npm run media
node --env-file=.env scripts/check-livekit.mjs   # ✓ LiveKit … accepted the API key

# 4. Nexo server (watch mode, port 3001)
npm run server

# 5. In a second WSL terminal: build the desktop app and launch it on Windows
scripts/win-run.sh

# 6. Which URL do I (and my friends) type into Nexo?
scripts/urls.sh
```

`scripts/dev-up.sh` does steps 3, 4 and 6 in one go: it starts LiveKit, checks the keys, prints the URLs,
then runs the server in the foreground (`--prod` runs it without watch mode). Ctrl+C stops the server.
LiveKit keeps running in the background until `npm run media:down`.

The SQLite database is stored in `server/data/nexo.db` (`DATA_DIR`). On first start the server creates
`#general`, `#clips-and-memes`, `Lounge` and `Gaming`.

---

## Tailscale setup (inside WSL)

Tailscale gives the WSL machine a private `100.x.y.z` address that your friends can reach from anywhere,
with no port forwarding or TLS needed, and traffic encrypted by WireGuard. Tailscale runs **inside WSL**
(not only on Windows), so WSL gets its own tailnet IP.

1. **Install** (official script, needs sudo):

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   ```

2. **Log in.** This prints a URL. Open it in your Windows browser and sign in.

   ```bash
   sudo tailscale up
   tailscale ip -4          # → 100.x.y.z  (the WSL machine's tailnet IP)
   ```

   Optional: in the Tailscale admin console, rename the machine (e.g. `nexo`) and turn off
   **key expiry** for it, so it doesn't drop off the tailnet after a few months.

3. **Tell LiveKit to advertise that IP** for media. Edit `.env`:

   ```ini
   LIVEKIT_NODE_IP=100.x.y.z
   ```

   Then restart LiveKit with `npm run media`. Compose recreates the container when the value changes.
   `scripts/urls.sh` warns you if `.env` or the running container don't match `tailscale ip -4`.
   (`livekit.yaml` sets `advertise_internal_ip: true`, so LiveKit also keeps advertising the WSL `172.x`
   address, which your own Windows client uses.)

4. **Get the URL to share:**

   ```bash
   scripts/urls.sh
   #   Friends (Tailscale):   http://100.x.y.z:3001
   #   This PC (Windows app): http://172.26.x.x:3001
   ```

   The server gives clients the LiveKit address automatically (`ws://<same host>:7880`). Only set
   `LIVEKIT_PUBLIC_URL` if LiveKit lives somewhere else.

5. **Let your friends in.** Pick one way in the [admin console](https://login.tailscale.com/admin/machines):
   - **Share the machine** (recommended): on the WSL machine, choose **⋯ → Share…** and send each friend
     the invite link. They only see this one machine, not your other devices.
   - **Invite them to your tailnet**: go to **Users → Invite users**. This gives them full tailnet
     membership, so check your access rules.

6. **Each friend:**
   1. Installs Tailscale for Windows from <https://tailscale.com/download>, signs in, and accepts your
      share or invite. Your machine then appears in their Tailscale list.
   2. Installs Nexo (the installer you send them, see below).
   3. Opens Nexo and enters the server URL `http://100.x.y.z:3001`, a name, a color, and the server
      password if you set one.

   Quick check from a friend's PC: opening `http://100.x.y.z:3001/health` in a browser should show
   `{"ok":true,…}`.

> Tip: set `SERVER_PASSWORD` in `.env` if you share the machine widely. It is asked only once, when a
> new person picks a name. Returning devices log in with their stored token.

---

## Running the desktop client on Windows

GUI apps always run on **Windows**, never inside WSL. Electron under WSLg can only capture Linux windows,
so it can't see Windows games, and it has no system audio.

### Development: build in WSL, run on Windows

```bash
scripts/win-run.sh                 # npm run build -w desktop, then launch on Windows
scripts/win-run.sh --no-build      # launch the last build again
NEXO_PROFILE=2 scripts/win-run.sh  # second, separate profile (log in as another user to test)
```

`scripts/win-run.sh` builds the app in WSL (`npm run build -w desktop`). The first time, it downloads
the matching Windows Electron binary (checksum-verified) into `%LOCALAPPDATA%\nexo-dev`. Then it copies
the build to the Windows filesystem and launches it there. Logs stream to the WSL terminal. Windows does
not need Node.

On the host PC, use the **`172.x` URL** from `scripts/urls.sh` (`http://172.26.x.x:3001`). Windows
reaches WSL directly on that address. If Tailscale is installed on Windows too, the `100.x` URL also
works. The WSL `172.x` IP can change after a reboot, so re-run `scripts/urls.sh` when that happens.

**Native share helper (beta, [SPEC-BETA](docs/SPEC-BETA.md)).** `scripts/win-run.sh --native` also builds
`nexo-media.exe` (`scripts/native-build.sh`, needs the Windows prerequisites in SPEC-BETA §9.2) and copies
`native/out/*` into the dev app's `resources/native/`. The copy stays there for later runs without `--native`.
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

Tuning and profiling flags (env, read by the helper; `scripts/win-run.sh` passes `NEXO_MEDIA_*` through):
`NEXO_MEDIA_PROFILE=1` logs a per-second `profile:` line (add `NEXO_MEDIA_PROFILE_RAW=1` to count WGC frames
with no processing), `NEXO_MEDIA_PIPELINE=0` / `NEXO_MEDIA_ZERO_COPY=0` turn off the pipelined conversion and
zero-copy capture, `NEXO_MEDIA_RGB_INPUT=1` feeds BGRA straight to the encoder when no scaling is needed
(experimental), `NEXO_MEDIA_WGC_BUFFERS` / `NEXO_MEDIA_WGC_MIN_INTERVAL_MS` override the frame pool,
`NEXO_MEDIA_H264_PROFILE=baseline` switches the H.264 profile.

Benchmarks and their tools: [docs/benchmarks](docs/benchmarks) (`native/tools/gpu-burn`, `queue-probe`,
`alpha-bench`). The tools run from the local-disk copy (`%LOCALAPPDATA%\nexo-dev\native\src\out`); don't run
`scripts/native-build.sh` during a benchmark, it replaces that folder.

### Installers for friends

Friends download from **[Releases](https://github.com/campiohe/nexo/releases)**. Each release has the
Windows `.exe`, the macOS `.dmg` and the Linux `.AppImage`. After the first install, Nexo updates itself
(see [Updates](#updates)).

To ship a new version:

1. Bump `version` in `package.json`, `desktop/package.json` and `server/package.json`, then run
   `npm install --package-lock-only`.
2. Optionally write `.github/release-notes/vX.Y.Z.md`. For a test build (`X.Y.Z-test.N`), see
   [Test builds](#test-builds).
3. Commit, then `git tag -a vX.Y.Z -m "Nexo vX.Y.Z" && git push origin main vX.Y.Z`.

The **Release** workflow (`.github/workflows/release.yml`) builds all three installers and publishes
the release. Tags with `-alpha`/`-beta`/`-rc` are marked as prereleases.

Installed apps find new versions through the release files (see [Updates](#updates)), so every release
must have, with the names electron-builder gave them:

- `Nexo-Setup-X.Y.Z.exe`, `Nexo-Setup-X.Y.Z.exe.blockmap` and `latest.yml` (Windows)
- `Nexo-X.Y.Z-universal.dmg`, `Nexo-X.Y.Z-universal.dmg.blockmap` and `latest-mac.yml` (macOS)
- `Nexo-X.Y.Z-x86_64.AppImage` and `latest-linux.yml` (Linux; the AppImage carries its own block map)

The workflow uploads all of them. If you ever upload by hand, don't rename anything: the `latest*.yml`
files name the installer that the app downloads.

The installers are unsigned, so Windows SmartScreen shows a warning: click **More info → Run anyway**.
For a local build, `npm run dist:win -w desktop` writes to `desktop/release/`. From Linux it may need
Wine; the CI build doesn't.

---

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | Nexo server port (socket.io + `GET /health`). |
| `HOST` | `0.0.0.0` | Interface the Nexo server binds. |
| `SERVER_NAME` | `Nexo` | Name shown in the app. |
| `SERVER_PASSWORD` | *(empty)* | Required from new users when set. |
| `DATA_DIR` | `./data` | SQLite location, relative to `server/`. |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | — | Used by the server to sign LiveKit tokens. Secret ≥ 32 characters. |
| `LIVEKIT_KEYS` | — | Used by the LiveKit container, exactly `key: secret`, matching the two above. |
| `LIVEKIT_NODE_IP` | *(empty = auto)* | IP LiveKit advertises for media. Set it to `tailscale ip -4`. |
| `LIVEKIT_PUBLIC_URL` | *(empty = derived)* | LiveKit URL handed to clients. Empty means `ws://<host the client used>:7880`. |
| `LIVEKIT_PORT` | `7880` | LiveKit signaling port used when deriving the URL above. |

Never commit `.env`. It is in `.gitignore`.

## Ports

| Port | Proto | Service | Who needs it |
|---|---|---|---|
| 3001 | TCP | Nexo server (socket.io, `/health`) | every client |
| 7880 | TCP | LiveKit signaling (WebSocket) + API | every client in voice; the Nexo server |
| 7881 | TCP | LiveKit ICE/TCP fallback (when UDP is blocked) | clients behind strict firewalls |
| 7882 | UDP | LiveKit media (single UDP port) | every client in voice |

LiveKit uses Docker **host networking**, so these ports are opened directly on the WSL machine. Over
Tailscale nothing needs to be forwarded on your router.

## Bandwidth

Everything passes through the host PC's internet connection (see SPEC §6.4).

- A **Game**-preset stream (1080p60) is about **8 Mbps**. The streamer uploads it once to LiveKit.
- LiveKit then sends it to every viewer, so the **host's upload** carries about **8 Mbps × viewers**
  (≈ 72 Mbps for 9 viewers), plus around 40 kbps per person for voice.
- With a slow home upload, use the **Smooth** preset (720p60, 4 Mbps) or keep the number of viewers low.
  Over Tailscale, peers usually connect directly. If Tailscale has to relay through DERP, expect lower
  throughput.

## Profile pictures

In **Settings → Profile**, choose **Upload picture** (PNG, JPEG, WebP or GIF; GIFs keep their first frame),
then drag and zoom the square crop. The app resizes the picture to 256×256 and uploads it as WebP
(≤ 512 KB). **Remove** goes back to the colored initials. Everyone sees the change right away.

On the server, pictures are stored as `DATA_DIR/avatars/<userId>`. Back that folder up along with `nexo.db`.
They are served over the same port as socket.io (3001), so there's nothing else to open. The HTTP API:

| Request | Auth | Result |
|---|---|---|
| `PUT /api/avatar` (body = image, `Content-Type` `image/webp`/`png`/`jpeg`, ≤ 512 KB) | `Authorization: Bearer <device token>` | `200 {user}` + `user:upsert` broadcast |
| `DELETE /api/avatar` | same | `200 {user}` + `user:upsert` broadcast |
| `GET /avatars/<userId>?v=<user.avatar>` | none | the image, cached long-term (the version changes on every upload) |

The server checks the file's magic bytes against its `Content-Type`. It doesn't decode images, so it needs
no native image libraries. Errors come back as JSON `{error}`: 400 empty, 401 bad token, 413 too big,
415 wrong type, 429 more than one change per 3 s.

## Images in chat

You can add up to **4 images** to a message in three ways: paste (Ctrl+V, e.g. a screenshot), drag
files onto the channel, or use the **📎** button. Text is optional. PNG, JPEG, WebP and GIF are
supported, and animated GIFs stay animated. The limit is **10 MB** per image. A bigger still image, such
as a 4K PNG screenshot, is converted to WebP automatically before upload. Click an image to view it full
size. **Open original** opens it in your browser. Deleting a message, or its channel, deletes its images
from the server.

**Hosts:** images are stored in `DATA_DIR/attachments/` (back it up with `nexo.db`). They're served on
the same port as everything else:

| Request | Auth | Result |
|---|---|---|
| `POST /api/attachments` (body = image, matching `Content-Type`, ≤ 10 MB) | `Authorization: Bearer <device token>` | `201 {attachment}`, pending until a message uses it |
| `GET /attachments/<id>` | none (the id is a random UUID) | the image, cached long-term |

Uploads that no message claims within an hour are deleted. The limit is 20 uploads per minute per user.
Older clients show only the text of messages with images. Older servers don't accept images, and the
app says so.

## Keybinds

**Settings → Keybinds.** Click a shortcut, then press the key, mouse button or combination (e.g.
**Ctrl+Shift+M**, **Mouse 5**, **Alt+Mouse 4**). **Esc** cancels, **Backspace** clears. The same
combination can't be used twice.

- **Global** (they work while a game has focus): **Push to talk**, **Toggle mute**, **Toggle deafen**,
  **Toggle screen share** and **Leave voice**. None are set by default, so they can't clash with your
  games. Toggle screen share stops your stream. If you aren't streaming, it **restarts your last
  stream** (same screen, or the same window found by its title, with the same quality and audio), so you
  never leave the game. Only the first time, or if that window is gone, it brings Nexo to the front with
  the share picker open.
- **In Nexo** (only while the window is focused): **Quick switcher** (Ctrl+K) and **Open settings**
  (Ctrl+,). Both can be rebound, cleared or reset.

Nexo only *listens* to the keys; the game still receives them too. Platform notes are the same as for
push to talk below.

## Noise suppression

**Settings → Audio & video → Noise suppression:**

| Mode | What it does |
|---|---|
| **Enhanced** (default) | [RNNoise](https://jmvalin.ca/demo/rnnoise/), a small neural network running on your PC (about 1–2% of one CPU core). It removes keyboard clicks, fans and background noise. |
| **Standard** | The browser's built-in suppressor. This was the default before v0.3. |
| **Off** | No suppression. Use it for music, or if your mic already does it. |

You can switch while in a call. **Hear yourself** plays your mic back with the selected mode, so use
headphones. In testing with keyboard, fan and hiss noise, the voice stayed at the same level, and its
margin above the noise grew from 11 dB (Off) to 24 dB (Standard) to 30 dB (Enhanced).

## Push to talk

In **Settings → Audio & video → Input mode**, choose **Push to talk**. Then click the key box (or use
**Settings → Keybinds**) and press any key, mouse button or combination. Mouse side buttons (Mouse 4/5) work well for gaming. Your mic is sent only
while you hold it, even when a game has focus, plus a short **release delay** (default 200 ms) so the
ends of words aren't cut off. Mute and deafen always win over push to talk. The voice panel shows a
**PTT** badge, and the mic button lights up while you're transmitting.

The global key hook uses [uiohook-napi](https://github.com/SnosMe/uiohook-napi):

- **Windows:** works out of the box.
- **macOS:** needs **System Settings → Privacy & Security → Accessibility** for Nexo.
- **Linux:** works on X11. On Wayland, push to talk and the global keybinds only work while the Nexo
  window is focused. The settings page shows a warning when the global hook isn't active.

## Friend volume

Right-click a friend in a voice channel (in the sidebar, the member list, or their tile on the voice
stage). Set their volume from **0–200%**, or **Mute for me**, which affects only what you hear.
Settings are remembered per friend on this device. Tiles show a small icon when you've changed
someone's volume. Deafen still silences everyone, and undeafening restores each friend's level.
Stream audio has its own volume slider on the stream tile.

## App settings

**Settings → App → "Close button minimizes Nexo to the system tray"** (on by default). With it on,
closing the window keeps Nexo running in the tray, and you stay in voice. The tray icon's menu has
**Open Nexo**, **Mute**, **Deafen**, **Leave voice** and **Quit Nexo**. Clicking the tray icon, or
starting Nexo again, brings the window back. Turn the setting off to make the close button quit the app.

**Settings → App → "Capture engine"** (Windows): **Native (beta)** (the default) or **Chromium**. The
native engine is a small helper program, `nexo-media.exe`. It captures the game, encodes it on your
graphics card's video encoder (NVIDIA, AMD or Intel) and streams it as a separate connection. It also
captures **only the game's audio** when you share a window, and **everything except Nexo** when you share
a screen, so viewers never hear the voice chat echoed in your stream. The row shows the graphics card and
encoder it found, or why native capture isn't available. Then streams use Chromium automatically, as they
do whenever the helper fails. A share with audio uses Chromium on Windows older than 10 version 2004.
When you share a screen, **"Hide Nexo from the stream"** in the share dialog (on by default) keeps Nexo's
own window out of it.

**Settings → App → "Fast game capture"** (Windows, on by default, Chromium engine only). Captured frames stay on the GPU
instead of being copied back to the CPU for every frame. That keeps streams smooth while a game keeps
the GPU busy. In testing, a GPU-bound game went from ~30 to ~55 stream fps. It takes effect after
restarting Nexo. Turn it off if your stream shows a black or frozen picture. On Windows older than
11 24H2 it only applies when you share a **window**, so share the game's window instead of the
entire screen.

## Updates

Nexo checks the [GitHub releases](https://github.com/campiohe/nexo/releases) 10 seconds after it starts,
then every 4 hours. **Settings → App → Updates** shows the version and the status, and has a
**Check for updates** button.

- **Windows** and the **Linux AppImage:** a new version downloads in the background (on Windows only the
  changed parts, when possible). Then a bar says **Nexo X.Y.Z is ready** with a **Restart to update**
  button, which says **Restart (leaves the call)** while you're in voice. The tray menu has the same
  item. Nexo never restarts on its own: if you dismiss the bar, the update installs the next time you
  quit Nexo.
- **macOS:** the app isn't signed with an Apple certificate, so it can't replace itself. Nexo tells you
  when a new version is out, and **Download** opens the release page. Install the new `.dmg` the same way
  as the first time.
- **Linux without the AppImage** and development builds (`scripts/win-run.sh`, `npm run dev`) don't
  update. The settings page says so.

Alpha builds update to the newest release, whether it's an alpha, a beta or stable; stable builds only
get stable releases. Beta builds take betas and stable releases but **never alphas**, so once a beta is
out, keep tagging `-beta` (or stable). (electron-updater skips `-rc` tags for alpha builds, so prefer
`-beta` for prereleases.) Checks that fail, for example when you're offline, only show up as a status line
in Settings.

### Test builds

To try a change with a few friends before everyone gets it, publish a **test build**: a version like
`0.4.0-test.1`, tagged `v0.4.0-test.1`, released the same way as any version (see
[Installers for friends](#installers-for-friends)). The release is marked as a prerelease.

- **Everyone else never gets it.** Alpha, beta and stable installs skip `-test` releases.
- **Testers install it once by hand** from the release page, over their current Nexo (settings and login
  are kept). From then on they update to newer test builds (`-test.2`, `-test.3`…) automatically, and only
  to those. **Settings → App → Updates** says "test build".
- **Back to regular releases:** **Settings → App → Updates → Leave test builds** downloads the newest
  regular release, even if its version number is lower (`0.4.0-beta.1` sorts below `0.4.0-test.3`), and
  installs it on the next restart. Testers who skip this stay on the last test build.
- Test builds talk to the same server as everyone else. If one needs server changes, those must keep
  working for the regular version too.
- The release workflow refuses a tag that doesn't match `desktop/package.json`, since the version decides
  which updates an install gets.

**Coming from v0.1.0-alpha.1?** That version has no updater. Download and install v0.2 by hand once;
it updates itself after that.

---

## Tests

```bash
npm test                   # = npm test -w server: protocol tests (boots a server on a random port)
npm run typecheck -w server
```

---

## Troubleshooting

**Chat works but voice/video won't connect (or friends can't hear/see you)**
1. Is LiveKit running and does it accept the keys? Run
   `node --env-file=.env scripts/check-livekit.mjs`, then check `docker compose logs livekit`.
2. Does `LIVEKIT_NODE_IP` in `.env` equal `tailscale ip -4`? Run `scripts/urls.sh`. It flags a mismatch
   and a running container that still has an old IP. After fixing it, run `npm run media`. Inside WSL,
   LiveKit's auto-detected IP (`10.255.255.254`) can't be reached from anywhere.
3. Media uses **UDP 7882**, falling back to **TCP 7881**. Something between the client and the host must
   allow them. Over Tailscale they are allowed by default. Check your tailnet ACLs if you changed them.
4. "LiveKit … not reachable" or `connect` timeouts on `:7880`: the client derives the LiveKit URL from
   the server URL it used. If you entered a hostname that doesn't resolve to the WSL machine, set
   `LIVEKIT_PUBLIC_URL`.
5. If you use WSL **mirrored networking**, Windows' Hyper-V firewall may block inbound connections to
   WSL. Allow ports 3001, 7880, 7881 and 7882/udp, or use the default NAT mode.

**A game stream drops to ~5–15 fps while the game has focus (fine after alt-tab)**: the GPU is maxed out.
Windows captures the screen on the GPU too, and a game that keeps the GPU at ~100% starves it. The game
itself still runs smoothly. Check these in order:
1. **Settings → App → Capture engine** is **Native** (Windows, the default when your GPU has a hardware
   encoder). It keeps its GPU work out of the game's way and held 55–60 fps in testing with a GPU-bound
   game in focus.
2. If Nexo uses the Chromium engine (your choice, or its fallback): **Settings → App → "Fast game
   capture"** is on (the default since v0.2.0-alpha.3). On Windows older than 11 24H2, share the game's
   **window** rather than the entire screen.
3. The game isn't **uncapped**. An uncapped game on a fast GPU can starve capture. Any cap
   fixes it: V-Sync, the game's max FPS, or the NVIDIA/AMD control panel.
4. On a **mid-range GPU in a heavy game** (GPU at ~96%, already below its cap): lower the graphics
   settings or the upscaler preset, then cap the FPS a bit below what it reaches. A cap above what the
   game reaches does nothing.

The stream can't be smoother than the game. Nexo detects starved capture and shows a hint under
**LIVE** in the voice panel. The panel shows the live capture fps. Hover it to see the send fps,
resolution and encoder. Raising Nexo's CPU or GPU priority doesn't help.

**"Wrong server password"**: the password is only checked when a *new* name is created. Check
`SERVER_PASSWORD` in `.env` (restart the server after changing it). Returning devices don't need it.

**"That name is already taken"**: names are unique and case-insensitive. Pick another one, or see
below if it was your own name on a lost device.

**Lost identity** (reinstalled the app, new PC, cleared app data): the device token is gone, and there is
no recovery in v1. Pick a new name. To free the old name for reuse, the host can rename the old user,
which keeps its messages:

```bash
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('server/data/nexo.db');
db.prepare(\"UPDATE users SET name = name || '-old' WHERE name = ? COLLATE NOCASE\").run(process.argv[1])" "Alice"
```

**Server won't start: "Port 3001 is already in use"**: another Nexo server is running
(`curl localhost:3001/health`), or change `PORT`.

**LiveKit log warns "UDP receive buffer is too small"**: this is harmless at friend-group scale. To
silence it, run `sudo sysctl -w net.core.rmem_max=5000000`.

**The friends' URL changed**: the tailnet IP is stable, but the WSL `172.x` IP isn't. Run
`scripts/urls.sh` again.

---

## Known limitations

- **Stream audio echo (Chromium engine only):** the native engine (Windows 10 2004+) captures only the
  shared app's audio, or everything except Nexo, so there is no echo. With the Chromium engine, "include
  system audio" captures the *whole* system mix, including Nexo's own voice playback, so viewers hear the
  voice chat echoed. Then set Nexo's **speaker** (Settings → Audio & video) to a different device than the
  one the game plays on.
- **Linux (and Wayland):** screen/window video works, but there is **no system audio** capture yet.
  macOS system audio is best-effort.
- Nexo is only available **while the host PC is on**, and the host's home upload carries every stream.
  The same Docker Compose setup can move to a VPS later (`use_external_ip: true` in `livekit.yaml`, with
  TLS in front).
- No account recovery, no roles: everyone can create, rename and delete channels. Plain `ws://` and
  `http://` are fine over Tailscale or a LAN, but a public deployment needs TLS.
- Windows builds are unsigned (SmartScreen warning).

---

## Contributing

Issues and pull requests are welcome. Before opening a PR, run `npm run typecheck` and `npm test`.
Architecture and design decisions are in [docs/SPEC.md](docs/SPEC.md).

## License

[MIT](LICENSE) © 2026 Henrique Campiotti
