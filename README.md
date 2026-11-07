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

### Installer for friends

```bash
npm run dist:win -w desktop        # → desktop/release/  (NSIS installer .exe)
```

Send the `.exe` from `desktop/release/` to your friends. electron-builder can build the Windows
installer from Linux. If it asks for Wine, install it (`sudo apt install wine`) or run the same command
from a Windows checkout that has Node installed. The build is unsigned, so Windows SmartScreen shows a
warning: click **More info → Run anyway**.

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

## Known limitations (v1)

- **Stream audio echo:** on Windows, "include system audio" captures the *whole* system mix, including
  Nexo's own voice playback. Viewers then hear the voice chat echoed in the stream. Headphones alone don't
  fix this if they are the default output device. Instead, set Nexo's **speaker** (Settings → Audio & video)
  to a different device than the one the game plays on. Per-application audio capture is planned for v2.
- **Linux (and Wayland):** screen/window video works, but there is **no system audio** capture yet.
  macOS system audio is best-effort.
- Nexo is only available **while the host PC is on**, and the host's home upload carries every stream.
  The same Docker Compose setup can move to a VPS later (`use_external_ip: true` in `livekit.yaml`, with
  TLS in front).
- No account recovery, no roles: everyone can create, rename and delete channels. Plain `ws://` and
  `http://` are fine over Tailscale or a LAN, but a public deployment needs TLS.
- Windows builds are unsigned (SmartScreen warning).
