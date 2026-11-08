# Nexo user guide

How to install Nexo, join a server, and use its features. Hosting a server is covered in
[SERVER.md](SERVER.md).

- [Install](#install)
- [Join a server](#join-a-server)
- [Profile pictures](#profile-pictures)
- [Images in chat](#images-in-chat)
- [Keybinds](#keybinds)
- [Push to talk](#push-to-talk)
- [Noise suppression](#noise-suppression)
- [Friend volume](#friend-volume)
- [App settings](#app-settings)
- [Updates](#updates)
- [Test builds](#test-builds)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

---

## Install

Download the file for your system from **[Releases](https://github.com/campiohe/nexo/releases)**. Each
release has the Windows `.exe`, the macOS `.dmg` and the Linux `.AppImage`. After the first install, Nexo
updates itself (see [Updates](#updates)).

The installers are **not code-signed**, so your OS will warn you the first time.

- **Windows:** run `Nexo-Setup-<version>.exe`. If SmartScreen says "Windows protected your PC", click
  **More info → Run anyway**.
- **macOS:** open the `.dmg` and drag Nexo to **Applications**. The first time, **right-click Nexo →
  Open → Open** (double-clicking only shows a warning). If macOS says the app "is damaged" or still
  refuses to open it, run this in Terminal:

  ```bash
  xattr -cr /Applications/Nexo.app
  ```

- **Linux:** make the AppImage executable and run it:

  ```bash
  chmod +x Nexo-*.AppImage && ./Nexo-*.AppImage
  ```

## Join a server

1. If the host uses [Tailscale](https://tailscale.com/download), install it, sign in, and accept the
   host's share or invite.
2. Ask the host for the server URL. It looks like `http://100.x.y.z:3001`.
3. Open Nexo, enter that URL, a name, a color, and the server password if the host set one.

No accounts, no email: the app remembers you on this device. To check that you can reach the host, open
`http://100.x.y.z:3001/health` in a browser. It should show `{"ok":true,…}`.

---

## Profile pictures

In **Settings → Profile**, choose **Upload picture** (PNG, JPEG, WebP or GIF; GIFs keep their first frame),
then drag and zoom the square crop. The app resizes the picture to 256×256 and uploads it as WebP
(≤ 512 KB). **Remove** goes back to the colored initials. Everyone sees the change right away.

## Images in chat

You can add up to **4 images** to a message in three ways: paste (Ctrl+V, e.g. a screenshot), drag
files onto the channel, or use the **📎** button. Text is optional. PNG, JPEG, WebP and GIF are
supported, and animated GIFs stay animated. The limit is **10 MB** per image. A bigger still image, such
as a 4K PNG screenshot, is converted to WebP automatically before upload. Click an image to view it full
size. **Open original** opens it in your browser. Deleting a message, or its channel, deletes its images
from the server.

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
[push to talk](#push-to-talk).

## Push to talk

In **Settings → Audio & video → Input mode**, choose **Push to talk**. Then click the key box (or use
**Settings → Keybinds**) and press any key, mouse button or combination. Mouse side buttons (Mouse 4/5)
work well for gaming. Your mic is sent only while you hold it, even when a game has focus, plus a short
**release delay** (default 200 ms) so the ends of words aren't cut off. Mute and deafen always win over
push to talk. The voice panel shows a **PTT** badge, and the mic button lights up while you're
transmitting.

The global key hook uses [uiohook-napi](https://github.com/SnosMe/uiohook-napi):

- **Windows:** works out of the box.
- **macOS:** needs **System Settings → Privacy & Security → Accessibility** for Nexo.
- **Linux:** works on X11. On Wayland, push to talk and the global keybinds only work while the Nexo
  window is focused. The settings page shows a warning when the global hook isn't active.

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

## Sound effects and speaking indicators

Nexo plays a short sound when you mute, unmute, deafen or undeafen, from the buttons, your keybinds or
the tray menu, so you can tell what happened while a game has focus. It plays on your selected speaker
and only you hear it; push to talk doesn't make a sound. Turn it off in **Settings → Audio & video →
Sound effects**.

In the voice channel you're in, whoever is speaking gets a green ring, both on the voice stage and next
to their name in the sidebar. A muted mic never lights up.

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
own window out of it. A full-screen game minimizes itself when you alt-tab to Nexo: the share dialog still
lists it, marked **Minimized**, and the stream starts when you switch back to the game.

**Settings → App → "Fast game capture"** (Windows, on by default, Chromium engine only). Captured frames
stay on the GPU instead of being copied back to the CPU for every frame. That keeps streams smooth while a
game keeps the GPU busy. In testing, a GPU-bound game went from ~30 to ~55 stream fps. It takes effect
after restarting Nexo. Turn it off if your stream shows a black or frozen picture. On Windows older than
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
get stable releases. Beta builds take betas and stable releases but **never alphas**. Checks that fail,
for example when you're offline, only show up as a status line in Settings.

**Coming from v0.1.0-alpha.1?** That version has no updater. Download and install v0.2 by hand once;
it updates itself after that.

## Test builds

A **test build** (a version like `0.4.0-test.1`) is a way to try a change with a few friends before
everyone gets it. The release is marked as a prerelease.

- **Everyone else never gets it.** Alpha, beta and stable installs skip `-test` releases.
- **Testers install it once by hand** from the release page, over their current Nexo (settings and login
  are kept). From then on they update to newer test builds (`-test.2`, `-test.3`…) automatically, and only
  to those. **Settings → App → Updates** says "test build".
- **Back to regular releases:** **Settings → App → Updates → Leave test builds** downloads the newest
  regular release, even if its version number is lower (`0.4.0-beta.1` sorts below `0.4.0-test.3`), and
  installs it on the next restart. Testers who skip this stay on the last test build.
- Test builds talk to the same server as everyone else.

Publishing one is covered in [DEVELOPMENT.md](DEVELOPMENT.md#test-builds).

---

## Troubleshooting

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

**Chat works but voice/video won't connect**: usually a host-side problem. Send your host the
[server troubleshooting](SERVER.md#troubleshooting) steps.

**"Wrong server password"**: the password is only checked when a *new* name is created. Ask the host to
check it. Returning devices don't need it.

**"That name is already taken"**: names are unique and case-insensitive. Pick another one, or see
below if it was your own name on a lost device.

**Lost identity** (reinstalled the app, new PC, cleared app data): the device token is gone, and there is
no recovery. Pick a new name. The host can free the old name for reuse (see
[SERVER.md](SERVER.md#troubleshooting)), which keeps its messages.

## Known limitations

- **Stream audio echo (Chromium engine only):** the native engine (Windows 10 2004+) captures only the
  shared app's audio, or everything except Nexo, so there is no echo. With the Chromium engine, "include
  system audio" captures the *whole* system mix, including Nexo's own voice playback, so viewers hear the
  voice chat echoed. Then set Nexo's **speaker** (Settings → Audio & video) to a different device than the
  one the game plays on.
- **Linux (and Wayland):** screen/window video works, but there is **no system audio** capture yet.
  macOS system audio is best-effort.
- Nexo is only available **while the host is on**.
- No account recovery, no roles: everyone can create, rename and delete channels.
- The installers are unsigned (SmartScreen warning on Windows, Gatekeeper on macOS).
