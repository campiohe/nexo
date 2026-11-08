# Hosting a Nexo server

Everyone in a friend group connects to one Nexo server. This guide is for whoever runs it.

**On Windows, use the Nexo Server download**: one zip, no Node, Docker or WSL, and you can play on the
same PC. The manual setups below (Linux, VPS, WSL with Docker) are the advanced option.

- [Nexo Server for Windows (recommended)](#nexo-server-for-windows-recommended)
- [How it fits together](#how-it-fits-together)
- [Advanced: Linux host or VPS](#advanced-linux-host-or-vps)
- [Advanced: Windows host (WSL)](#advanced-windows-host-wsl)
- [Letting your friends in](#letting-your-friends-in)
- [Configuration (`.env`)](#configuration-env)
- [Ports](#ports)
- [Bandwidth](#bandwidth)
- [Data and backups](#data-and-backups)
- [Updating the server](#updating-the-server)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## Nexo Server for Windows (recommended)

1. Download `Nexo-Server-<version>-win-x64.zip` from **[Releases](https://github.com/campiohe/nexo/releases)**
   (the same release as the app) and extract it anywhere, for example `Documents\Nexo Server`.
2. Double-click **`nexo-server.exe`**. If Windows says "Windows protected your PC", click **More info →
   Run anyway** (the program isn't code-signed).
3. The first time, it asks two things: a **server name** and a **password** for new friends (press Enter
   to keep the suggestions; the password is generated, like `moss-tiger-41`).
4. Windows Firewall asks to allow `nexo-server.exe` and `livekit-server.exe`: click **Allow** on both.
5. Send your friends what's in the **Invite your friends** box: the server address and the password.
   You play on the same PC: join with `http://localhost:3001`.

Keep the window open while you play (Ctrl+C stops the server). It shows who's online, who's in voice and
your upload, and it tells you when the first friend connects from outside your network.

### How friends reach you

The server checks your network when it starts and tells you in plain words:

- **Tailscale** (if it's running on this PC): it invites friends with your Tailscale address, and opens
  nothing on your router. This works on every internet connection. See [Tailscale](#tailscale-recommended).
- **Automatic port forwarding (UPnP)**: without Tailscale, it asks your router to forward the ports
  ([Ports](#ports)) while it runs, and invites friends with your public address.
- **"Your internet provider doesn't let friends connect to you directly (CGNAT)"**: many providers share one
  public address among customers, and no port forwarding can work. Use Tailscale.
- **"Automatic port forwarding is not available"**: UPnP is off in your router. Turn it on in the router's
  settings, forward the [ports](#ports) by hand, or use Tailscale.
- People in the same house can always use the **Same network** address.

`nexo-server setup` → **Advanced** lets you force a mode: `auto` (the default: Tailscale if it's running,
else UPnP, else local network), `tailscale`, `public` or `lan`.

### Commands

Run these in a terminal in the folder (or add `--data <folder>` to use another data folder):

| Command | Does |
|---|---|
| `nexo-server` | Start (asks the setup questions the first time) |
| `nexo-server invite` | Show the invite again |
| `nexo-server status` | Is it running, who's online, ports, version |
| `nexo-server setup` | Change the name, password, ports or network mode |
| `nexo-server backup` | Save a copy of the database (safe while it runs) |
| `nexo-server rename-user <old> <new>` | Free a name (see [Lost identity](#troubleshooting)) |
| `nexo-server autostart on` / `off` | Start the server when you log in to Windows |
| `nexo-server update` | Download and install the newest server (stop the server first) |

Double-clicking the exe while the server already runs just shows the invite again.

### Where your data is

`%LOCALAPPDATA%\Nexo Server`: the database (`nexo.db`), pictures (`attachments`, `avatars`), settings
(`config.json`, including the password), the generated LiveKit config and logs (`logs\nexo-server.log`).
Back up this folder (or use `nexo-server backup` plus the two picture folders).

### Updating

When a newer server exists, the window says so when it starts. Stop the server, run
`nexo-server update`, and start it again. Or download the new zip and replace the two exe files; your data
folder stays where it is. Keep the server on the same version as your friends' apps (both update from the
same releases).

### Moving from a manual setup

The server uses the same database and data layout. Point it at your existing data folder and keep your
`.env` values as environment variables if you want (they take priority over `config.json`):

```
nexo-server --data C:\path\to\nexo\server\data
```

Stop the old server and LiveKit (Docker) first: they use the same ports.

---

## How it fits together

The desktop app talks to the **Nexo server** (Node, socket.io and SQLite: identity, channels, messages,
presence, voice state) for everything except media. Voice, video and streams go through **LiveKit**, a
self-hosted WebRTC SFU in Docker, using short-lived tokens the Nexo server signs. See
[SPEC.md](SPEC.md) for the full design.

```
Nexo Desktop ──socket.io :3001──────────────▶ Nexo server (Node)
      └──────WebRTC :7880/:7881/:7882──▶ LiveKit (Docker)      } same host
```

Both run on the same machine. Friends only need the Nexo app and the server URL, which looks like
`http://<host>:3001`. The server tells clients where LiveKit is (`ws://<same host>:7880`).

---

## Advanced: Linux host or VPS

### What you need

- **Node.js ≥ 23.6** (`engines` in `server/package.json`; developed on Node 26). The server runs
  TypeScript directly, so there is no build step.
- **Docker Engine** with the Compose plugin (`docker compose version` works). LiveKit uses Docker
  **host networking**.
- `git`, `curl`, `openssl`.
- Upload bandwidth for the streams (see [Bandwidth](#bandwidth)). A small VPS (e.g. 2 vCPU / 2 GB) is
  plenty.

### Install

```bash
git clone https://github.com/campiohe/nexo.git && cd nexo

# 1. Config: copy the template and generate the LiveKit secret.
#    The secret must appear in BOTH LIVEKIT_API_SECRET and LIVEKIT_KEYS.
cp .env.example .env
S=$(openssl rand -hex 32)
sed -i "s/^LIVEKIT_API_SECRET=.*/LIVEKIT_API_SECRET=$S/; s/^LIVEKIT_KEYS=.*/LIVEKIT_KEYS=nexo: $S/" .env
unset S

# 2. Dependencies (server + desktop workspaces). A server-only host can skip
#    the Electron download, which the server never uses.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install

# 3. Media server (LiveKit in Docker, host networking)
npm run media
node --env-file=.env scripts/check-livekit.mjs   # ✓ LiveKit … accepted the API key

# 4. Try the Nexo server in the foreground (port 3001). Ctrl+C stops it.
npm run start -w server

# 5. Which URL do my friends type into Nexo?
scripts/urls.sh
```

Set `SERVER_NAME` and, if the server is reachable by people outside your group, `SERVER_PASSWORD` in
`.env` (see [Configuration](#configuration-env)).

**Which IP LiveKit advertises.** Media flows directly between each client and LiveKit, so LiveKit must
advertise an address your friends can reach:

- **Over Tailscale:** set `LIVEKIT_NODE_IP` in `.env` to `tailscale ip -4` (see
  [Tailscale](#tailscale-recommended)).
- **On a VPS with a public IP:** set `use_external_ip: true` in `livekit.yaml` (LiveKit then discovers
  its public IP via STUN), or set `LIVEKIT_NODE_IP` to the public IP.
- **On a LAN only:** leaving `LIVEKIT_NODE_IP` empty (auto-detect) is usually fine.

After changing `.env` or `livekit.yaml`, run `npm run media` again. Compose recreates the container when
the value changes.

The SQLite database is stored in `server/data/nexo.db` (`DATA_DIR`). On first start the server creates
`#general`, `#clips-and-memes`, `Lounge` and `Gaming`.

### Run it as a service (systemd)

LiveKit already restarts on its own (`restart: unless-stopped` in `docker-compose.yml`, as long as the
Docker service starts at boot). For the Nexo server, a systemd unit keeps it running and starts it at
boot. It runs the same command as `npm run start -w server`:

```ini
# /etc/systemd/system/nexo-server.service
[Unit]
Description=Nexo server
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/nexo/server
ExecStart=/usr/bin/node --env-file-if-exists=../.env src/index.ts
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

Replace `YOUR_USER` and the path, and use the output of `command -v node` for `ExecStart` (with nvm,
Node lives under `~/.nvm/versions/node/…`). Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nexo-server
systemctl status nexo-server        # is it running?
journalctl -u nexo-server -f        # follow the logs
curl localhost:3001/health          # {"ok":true,"name":"Nexo"}
```

The server shuts down cleanly on `SIGTERM`, so `systemctl restart nexo-server` is safe. Everyone
reconnects on their own.

### Firewall

Open the [ports](#ports) to the clients that need them. For example, with `ufw`:

```bash
# Friends connect over Tailscale: allow everything that arrives on the tailnet interface.
sudo ufw allow in on tailscale0

# Or, on a public host: open the four ports.
sudo ufw allow 3001/tcp
sudo ufw allow 7880/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 7882/udp
```

On a VPS, also check the provider's own firewall or security group.

---

## Advanced: Windows host (WSL)

On Windows, the server and LiveKit run inside WSL2. This is how the original Nexo host runs.

### What you need

- Windows 10/11 with **WSL2** (Ubuntu) and **systemd enabled** in WSL (`/etc/wsl.conf` has
  `[boot]` `systemd=true`).
- **Docker Engine** with the Compose plugin, installed **inside WSL** (`docker compose version` works).
  Docker Desktop also works, but host networking must be available.
- **Node.js ≥ 23.6** inside WSL, plus `git`, `curl`, `openssl`, `unzip`.
- A free **Tailscale** account (see [Tailscale](#tailscale-recommended)).

Windows itself needs **no Node**. Install the Nexo app on Windows from
[Releases](https://github.com/campiohe/nexo/releases) like everyone else. GUI apps always run on
**Windows**, never inside WSL: Electron under WSLg can only capture Linux windows, so it can't see
Windows games, and it has no system audio.

### Install

Inside WSL, follow the [Linux install steps](#install). With systemd enabled in WSL, the
[systemd service](#run-it-as-a-service-systemd) works there too.

`scripts/dev-up.sh` is a shortcut for steps 3–5: it starts LiveKit, checks the keys, prints the URLs,
then runs the server in the foreground (`--prod` runs it without watch mode). Ctrl+C stops the server.
LiveKit keeps running in the background until `npm run media:down`. If `LIVEKIT_NODE_IP` is empty and
Tailscale is up, it uses the tailnet IP for that run.

### WSL networking notes

- **Your own app** on the host PC uses the **`172.x` URL** from `scripts/urls.sh`
  (`http://172.26.x.x:3001`). Windows reaches WSL directly on that address. If Tailscale is installed on
  Windows too, the `100.x` URL also works. The WSL `172.x` IP can change after a reboot, so re-run
  `scripts/urls.sh` when that happens.
- `livekit.yaml` sets `advertise_internal_ip: true`, so LiveKit advertises both the tailnet IP (for your
  friends) and the WSL `172.x` address (for your own Windows client).
- Inside WSL, LiveKit's auto-detected IP (`10.255.255.254`) can't be reached from anywhere, so
  `LIVEKIT_NODE_IP` must be set (to `tailscale ip -4`).
- If you use WSL **mirrored networking**, Windows' Hyper-V firewall may block inbound connections to
  WSL. Allow ports 3001, 7880, 7881 and 7882/udp, or use the default NAT mode.

---

## Letting your friends in

There are two ways to make the server reachable from outside your home:

| Option | Effort | Notes |
|---|---|---|
| **Tailscale** (recommended) | Low | Everyone joins one tailnet and uses the host's `100.x` IP. No port forwarding or TLS needed, and it is encrypted by WireGuard. |
| **Port forwarding / public IP** | Medium | Forward or open 3001, 7880, 7881 and 7882/udp. Needs TLS in front (see below). |

### Tailscale (recommended)

Tailscale gives the host a private `100.x.y.z` address that your friends can reach from anywhere, with no
port forwarding or TLS needed, and traffic encrypted by WireGuard. On a Windows host, Tailscale runs
**inside WSL** (not only on Windows), so WSL gets its own tailnet IP.

1. **Install** (official script, needs sudo):

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   ```

2. **Log in.** This prints a URL. Open it in a browser and sign in.

   ```bash
   sudo tailscale up
   tailscale ip -4          # → 100.x.y.z  (the host's tailnet IP)
   ```

   Optional: in the Tailscale admin console, rename the machine (e.g. `nexo`) and turn off
   **key expiry** for it, so it doesn't drop off the tailnet after a few months.

3. **Tell LiveKit to advertise that IP** for media. Edit `.env`:

   ```ini
   LIVEKIT_NODE_IP=100.x.y.z
   ```

   Then restart LiveKit with `npm run media`. Compose recreates the container when the value changes.
   `scripts/urls.sh` warns you if `.env` or the running container don't match `tailscale ip -4`.

4. **Get the URL to share:**

   ```bash
   scripts/urls.sh
   #   Friends (Tailscale):   http://100.x.y.z:3001
   #   This PC (Windows app): http://172.26.x.x:3001
   ```

   The server gives clients the LiveKit address automatically (`ws://<same host>:7880`). Only set
   `LIVEKIT_PUBLIC_URL` if LiveKit lives somewhere else.

5. **Let your friends in.** Pick one way in the [admin console](https://login.tailscale.com/admin/machines):
   - **Share the machine** (recommended): on the host machine, choose **⋯ → Share…** and send each friend
     the invite link. They only see this one machine, not your other devices.
   - **Invite them to your tailnet**: go to **Users → Invite users**. This gives them full tailnet
     membership, so check your access rules.

6. **Each friend:**
   1. Installs Tailscale from <https://tailscale.com/download>, signs in, and accepts your share or
      invite. Your machine then appears in their Tailscale list.
   2. Installs Nexo from [Releases](https://github.com/campiohe/nexo/releases) (see the
      [User guide](USER-GUIDE.md#install)).
   3. Opens Nexo and enters the server URL `http://100.x.y.z:3001`, a name, a color, and the server
      password if you set one.

   Quick check from a friend's PC: opening `http://100.x.y.z:3001/health` in a browser should show
   `{"ok":true,…}`.

> Tip: set `SERVER_PASSWORD` in `.env` if you share the machine widely. It is asked only once, when a
> new person picks a name. Returning devices log in with their stored token.

### Port forwarding or a public host

Open (or forward on your router) 3001/tcp, 7880/tcp, 7881/tcp and 7882/udp to the host, and make sure
LiveKit advertises the public IP (see [Which IP LiveKit advertises](#install)).

Plain `ws://` and `http://` are fine over Tailscale or a LAN, but a public deployment needs TLS: put a
reverse proxy (for example Caddy) in front of both the Nexo server (`https://`) and LiveKit signaling
(`wss://`). The server hands out `wss://` automatically when the client connected over HTTPS (it honors
`X-Forwarded-Proto`). If LiveKit is served on another host name or port, set `LIVEKIT_PUBLIC_URL` to its
`wss://` URL. Also set `SERVER_PASSWORD`.

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
| `LIVEKIT_NODE_IP` | *(empty = auto)* | IP LiveKit advertises for media. Over Tailscale, set it to `tailscale ip -4`. |
| `LIVEKIT_PUBLIC_URL` | *(empty = derived)* | LiveKit URL handed to clients. Empty means `ws://<host the client used>:7880`. |
| `LIVEKIT_PORT` | `7880` | LiveKit signaling port used when deriving the URL above. |

Never commit `.env`. It is in `.gitignore`. Restart the server after changing it
(`sudo systemctl restart nexo-server`), and LiveKit after changing a `LIVEKIT_*` value it uses
(`npm run media`).

## Ports

| Port | Proto | Service | Who needs it |
|---|---|---|---|
| 3001 | TCP | Nexo server (socket.io, `/health`, pictures and images) | every client |
| 7880 | TCP | LiveKit signaling (WebSocket) + API | every client in voice; the Nexo server |
| 7881 | TCP | LiveKit ICE/TCP fallback (when UDP is blocked) | clients behind strict firewalls |
| 7882 | UDP | LiveKit media (single UDP port) | every client in voice |

LiveKit uses Docker **host networking**, so these ports are opened directly on the host (on Windows,
the WSL machine). Over Tailscale nothing needs to be forwarded on your router.

## Bandwidth

Everything passes through the host's internet connection (see [SPEC §6.4](SPEC.md#64-bandwidth-budget-game-preset-10-people)).

- A **Game**-preset stream (1080p60) is about **8 Mbps**. The streamer uploads it once to LiveKit.
- LiveKit then sends it to every viewer, so the **host's upload** carries about **8 Mbps × viewers**
  (≈ 72 Mbps for 9 viewers), plus around 40 kbps per person for voice.
- With a slow home upload, use the **Smooth** preset (720p60, 4 Mbps) or keep the number of viewers low.
  Over Tailscale, peers usually connect directly. If Tailscale has to relay through DERP, expect lower
  throughput.

## Data and backups

Everything the server keeps is in `DATA_DIR` (default `server/data/`):

- `nexo.db`: users, channels, messages (SQLite).
- `avatars/<userId>`: profile pictures.
- `attachments/`: images posted in chat.

Back up the whole folder. Stop the server first so the database is consistent:

```bash
sudo systemctl stop nexo-server
cp -a server/data server/data.bak-$(date +%F)    # data.bak-* is gitignored
sudo systemctl start nexo-server
```

Pictures and images are served over the same port as socket.io (3001), so there's nothing else to open.
Uploads that no message claims within an hour are deleted. Deleting a message, or its channel, deletes
its images from the server.

## Updating the server

Server and app versions are released together. Update the server when a new
[release](https://github.com/campiohe/nexo/releases) is out:

```bash
cd ~/nexo
sudo systemctl stop nexo-server
cp -a server/data server/data.bak-$(date +%F)    # back up first
git pull
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
npm run media                                     # picks up a new LiveKit image or config, if any
sudo systemctl start nexo-server
curl localhost:3001/health
```

Without the systemd service, stop the server with Ctrl+C and start it again with `npm run start -w server`
(or `scripts/dev-up.sh --prod`).

---

## Troubleshooting

**Chat works but voice/video won't connect (or friends can't hear/see you)**
1. Is LiveKit running and does it accept the keys? Run
   `node --env-file=.env scripts/check-livekit.mjs`, then check `docker compose logs livekit`.
2. Does `LIVEKIT_NODE_IP` in `.env` equal `tailscale ip -4`? Run `scripts/urls.sh`. It flags a mismatch
   and a running container that still has an old IP. After fixing it, run `npm run media`. Inside WSL,
   LiveKit's auto-detected IP (`10.255.255.254`) can't be reached from anywhere.
3. Media uses **UDP 7882**, falling back to **TCP 7881**. Something between the client and the host must
   allow them. Over Tailscale they are allowed by default. Check your tailnet ACLs if you changed them,
   and your [firewall](#firewall).
4. "LiveKit … not reachable" or `connect` timeouts on `:7880`: the client derives the LiveKit URL from
   the server URL it used. If you entered a hostname that doesn't resolve to the host machine, set
   `LIVEKIT_PUBLIC_URL`.
5. If you use WSL **mirrored networking**, Windows' Hyper-V firewall may block inbound connections to
   WSL. Allow ports 3001, 7880, 7881 and 7882/udp, or use the default NAT mode.

**"Wrong server password"**: the password is only checked when a *new* name is created. Check
`SERVER_PASSWORD` in `.env` (restart the server after changing it). Returning devices don't need it.

**Lost identity** (a friend reinstalled the app, got a new PC, cleared app data): the device token is
gone, and there is no recovery. They pick a new name. To free the old name for reuse, rename the old
user, which keeps its messages:

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

## Limitations

- Nexo is only available **while the host is on**, and the host's upload carries every stream.
- No account recovery, no roles: everyone can create, rename and delete channels.
- Plain `ws://` and `http://` are fine over Tailscale or a LAN, but a public deployment needs TLS.
