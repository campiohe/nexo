# Nexo user guide

How to install Nexo, join a server, and use its features. Hosting a server is covered in
[SERVER.md](SERVER.md).

- [Install](#install)
- [Join a server](#join-a-server)
- [Profile pictures and banners](#profile-pictures-and-banners)
- [Images in chat](#images-in-chat)
- [Messages](#messages)
- [Notifications](#notifications)
- [Status, activity and profile cards](#status-activity-and-profile-cards)
- [Keybinds](#keybinds)
- [Push to talk](#push-to-talk)
- [Noise suppression](#noise-suppression)
- [Friend volume](#friend-volume)
- [Wake up a friend](#wake-up-a-friend)
- [Moving people between voice channels](#moving-people-between-voice-channels)
- [Picture in picture](#picture-in-picture)
- [Soundboard](#soundboard)
- [Music (listen together)](#music-listen-together)
- [Emulator](#emulator)
- [Appearance](#appearance)
- [Language and time](#language-and-time)
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

## Profile pictures and banners

In **Settings → Profile**, choose **Upload picture** (PNG, JPEG, WebP or GIF), then drag and zoom the
square crop. The app resizes the picture to 256×256 and uploads it as WebP (≤ 512 KB). **Remove** goes
back to the colored initials. Everyone sees the change right away.

**Animated pictures:** an animated GIF, WebP or PNG stays animated. Nexo crops every frame, resizes it to
160×160 and saves it as a GIF of at most 2 MB, simplifying it (fewer frames or colors, at most 10 seconds)
when needed and telling you if it did. To save CPU while you play, animated pictures show their first
frame and only move when you hover over them, on profile cards, and while that person is talking.

**Banner:** the strip at the top of your profile card. In **Settings → Profile → Banner**, pick a style
(Solid, Flow, Aurora, Waves, Dots or Swirl; the animated ones use your color) or choose **Upload banner**
(PNG, JPEG, WebP or GIF) and crop it to the card's wide shape. An uploaded banner replaces the style until
you **Remove** it; animated GIFs stay animated. Banners need a server on v1.3 or later.

## Images in chat

You can add up to **4 images** to a message in three ways: paste (Ctrl+V, e.g. a screenshot), drag
files onto the channel, or use the **📎** button. Text is optional. PNG, JPEG, WebP and GIF are
supported, and animated GIFs stay animated. The limit is **10 MB** per image. A bigger still image, such
as a 4K PNG screenshot, is converted to WebP automatically before upload. Click an image to view it full
size. **Open original** opens it in your browser. Deleting a message, or its channel, deletes its images
from the server.

Older clients show only the text of messages with images. Older servers don't accept images, and the
app says so.

## Messages

Hover over a message for its action bar: quick reactions, **React** (emoji picker), **Reply**, **Pin**,
**Edit** (your own messages) and **Delete**. Arrow keys move between messages.

- **Reactions:** click a reaction to add or remove yours; hover to see who reacted. Up to 20 different
  emoji per message.
- **Replies:** the reply shows a preview of the original; click it to jump there. Replying notifies the
  person you reply to.
- **Edit:** also with **↑** in an empty message box. Enter saves, Escape cancels; edited messages show
  "(edited)".
- **Mentions:** type `@` and pick someone, or `@everyone`. Messages that mention you are highlighted, and
  the channel gets a red badge until you read it.
- **Formatting:** `**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `||spoiler||` (click to reveal),
  `` `code` ``, code blocks with ```` ``` ```` (with a Copy button), `> quotes`, `#` headings and `-` lists.
  Shortcuts: Ctrl+B, Ctrl+I, Ctrl+U, Ctrl+E (code), Ctrl+Shift+X (strike). A message with only 1–3 emoji
  shows them large.
- **Emoji:** the smiley button in the message box, or type `:` and a name (`:joy:`, `:fire:`, `:+1:`).
- **Pins:** anyone can pin a message (up to 50 per channel). The pin button at the top of a text channel
  lists them. The person who pinned it, its author or an admin can unpin it.
- **Search:** the box at the top right (Ctrl+F). Searches ignore case and accents and match the start of
  words. Add `from:Name` or `in:#channel` to narrow it down. Click a result to jump to it.
- **Link previews:** links to YouTube, Spotify, SoundCloud, Vimeo and Reddit show a card with the title
  and thumbnail; videos open in your browser. Your server looks them up, so the sites never see your
  address. Turn them off in **Settings → Appearance**.

## Notifications

When Nexo isn't in front, or you're in another channel, new messages can show a Windows notification and
play a sound. Choose **All messages**, **Only mentions** (the default) or **Off** in **Settings →
Notifications**, where you can also turn off the sound and the taskbar flash and send a test notification.
Messages in quick succession are grouped per channel. Clicking a notification opens the channel. The
taskbar button and the tray icon show how many unread mentions you have.

## Status, activity and profile cards

Click your name at the bottom left to set your status: **Online**, **Idle** or **Do not disturb**, and a
custom status ("back at 9"). Do not disturb silences notification popups and sounds (wake-ups still ring).
Nexo sets you to Idle after 10 minutes without input, except while you're talking in voice or playing.
With several devices, Do not disturb on any of them wins, then Online, then Idle.

**What you're playing:** turn on **Settings → Activity → Share what I'm playing** (off by default) and
friends see "Playing *game*" next to your name. Nexo recognizes about 230 games and you can add others
from the list of running programs. Only the game's name is shared, and only while it runs.

Click anyone's name or picture to open their **profile card**: status, what they're playing, their voice
channel with **Join**, and **Mention** and **Wake up**.

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
the tray menu, so you can tell what happened while a game has focus. It also plays a sound when you
join or leave voice, when someone joins or leaves (or is moved in or out of) the voice channel you're in,
and when someone [wakes you up](#wake-up-a-friend). Sounds play on your selected speaker and only you
hear them; push to talk doesn't make a sound. Turn them off in **Settings → Audio & video → Sound
effects**.

In the voice channel you're in, whoever is speaking gets a green ring, both on the voice stage and next
to their name in the sidebar. A muted mic never lights up.

## Friend volume

Right-click a friend in a voice channel (in the sidebar, the member list, or their tile on the voice
stage). Set their volume from **0–200%**, or **Mute for me**, which affects only what you hear.
Settings are remembered per friend on this device. Tiles show a small icon when you've changed
someone's volume. Deafen still silences everyone, and undeafening restores each friend's level.
Stream audio has its own volume slider on the stream tile.

## Wake up a friend

When a friend in voice is muted or deafened, right-click them and choose **Wake up**, or click the bell
that appears when you hover over their name in the sidebar. They hear a chime (even while deafened), see
a message saying you're trying to get their attention, and their taskbar button flashes if Nexo isn't
in front. You can wake up the same person once every 15 seconds.

## Moving people between voice channels

Admins and the owner can move someone who is in voice to another voice channel: right-click them and
pick a channel under **Move to**, or drag their name in the sidebar onto another voice channel. Their
mute and deafen stay as they were; a camera or stream they had on stops. Admins can't move the owner.

Admins can drag channels in the sidebar to reorder them (or select one and press Alt+↑ / Alt+↓).

## Picture in picture

When you're in a call and go to another channel, the stream you're watching keeps playing in a small
floating player in the corner (if you aren't watching a stream, a friend's camera is shown instead).
Drag it to any corner. Click it to go back to the call, or close it with the **×** until something else
is shown. **Pop out** opens it in its own always-on-top window, which keeps playing while Nexo is
minimized or you're in a game; stream and camera tiles on the voice stage have a **Pop out** button too.

Who is watching a stream shows on the stream's tile, on your own "You're live" card and next to **LIVE**
in the sidebar.

## Soundboard

In voice, the **soundboard** button (in the voice toolbar and in the voice panel at the bottom left) opens
the board: click a sound to play it for everyone in your voice channel (once every 2 seconds). Hover a
sound to preview it just for you. **Add sound** takes any audio file: pick the part you want (up to 5
seconds), give it a name and an emoji. You can delete your own sounds; admins can delete any. Sounds play
on each listener's speakers, never through anyone's microphone, and not while you're deafened or have
muted that person. **Settings → Audio & video** has the soundboard volume and an on/off switch.

## Music (listen together)

An admin turns on **YouTube Music** in **Settings → Plugins**. Then, in a voice channel, click the music
button (the record in the voice toolbar) or **Play music** on the voice stage. Search YouTube Music for
songs, albums and playlists, or paste a music.youtube.com / youtube.com / youtu.be link, and choose **Add
to queue** or **Play next** (an album or playlist has **Add all**).

Everyone in the voice channel hears the same song at the same moment, and anyone there can pause, seek,
skip, go back and reorder or remove queued songs. Each person's Nexo plays the song from YouTube itself
(nothing goes through the voice chat), so the sound is full quality and you set your own **music volume**
in the bar or in **Settings → Audio & video**, where you can also turn on **Lower music while people
talk** (on by default) or stop music on this device. Deafening silences the music too. The sidebar shows
what's playing under each voice channel.

If a song can't play for you (YouTube sometimes blocks a song in your region, or asks a device to prove it
isn't a bot), the bar says so and offers **Retry**; it keeps playing for everyone else. When everyone leaves
the channel the music pauses, and the queue is cleared after 30 minutes.

## Emulator

An admin turns on **Emulator** in **Settings → Plugins**. It lets you play console games you own together:
one person (the **host**) runs the game on their computer, Nexo streams it to the voice channel, and friends
play along with their own keyboard or gamepad. It plays **Super Nintendo (SNES)**, **Mega Drive / Genesis**,
**PlayStation** and **Nintendo 64** games.

**Host a game.** In a voice channel, click the controller button in the voice toolbar and pick the game file
you own (or drop it on the game). Nexo tells the console from the file:

| Console | Pick |
| --- | --- |
| SNES | `.sfc`, `.smc`, `.swc`, `.fig` or a `.zip` with one |
| Mega Drive / Genesis | `.md`, `.gen`, `.smd`, `.bin` or a `.zip` with one |
| Nintendo 64 | `.z64`, `.n64`, `.v64` or a `.zip` with one |
| PlayStation | the `.cue` **together with all its `.bin` files** (select them all at once in the file picker), or a single `.chd`, `.pbp`, `.iso` or `.img` |

If Nexo can't tell (a `.bin` without a `.cue`), it asks whether it's a Mega Drive or a PlayStation game.
PlayStation games must be unzipped first. **PlayStation BIOS:** not needed. Nexo has a built-in replacement
that runs most games. If you own a PlayStation BIOS file (e.g. `scph1001.bin`), pick it together with the game for
the best compatibility. Nexo doesn't provide one. A disc takes a few seconds to read; a progress bar shows
it, with **Cancel**.

The game starts on your computer and becomes your stream in the call (you're LIVE, like when you share your
screen; starting a screen share replaces it, and **Stream it** puts the game back). You're player 1. The bar
under the game has **Pause** (for everyone), **Reset**, **Quick save** / **Quick load** (one slot, kept until
you load another game) and your own game **Volume** (it doesn't change what friends hear). **Load another
game** (or dropping files on the game) switches games, even to another console, without stopping the stream.
**Stop** ends it for everyone; so does leaving the voice channel.

**Play along.** Everyone in the channel sees the host's game on the stage, with the people in a strip below.
There are 4 controllers: click **Take** on a free one to play, **Leave** to give it up and just watch. The host
(or an admin) can put someone on a controller or free it with the **⋯** menu. **Hide** (or the controller button)
switches back to the people. Your keys only go to the game while it's on screen and you aren't typing.

**Controls.** Nexo uses one controller layout for every console, like an Xbox pad: buttons go by
**position** (A bottom, B right, X left, Y top), plus the bumpers (L / R), the triggers (L2 / R2) and clicking
the sticks (L3 / R3). **Show controls** next to the controllers lists what each one does on the game's console.

| Nexo control | Keyboard | Gamepad |
| --- | --- | --- |
| D-pad | arrows or **WASD** | d-pad (also the left stick on SNES and Mega Drive) |
| A (bottom) / B (right) / X (left) / Y (top) | **Space** or **J** / **K** / **L** / **I** (also **Z X C V**) | A / B / X / Y |
| L / R | **Q** / **E** | LB / RB |
| L2 / R2 | **U** / **O** | LT / RT |
| L3 / R3 | **F** / **G** | click the left / right stick |
| Start / Select | **Enter** / **Backspace** | Start / Back |

- **SNES:** bottom = B, right = A, left = Y, top = X, like on the SNES pad.
- **Mega Drive:** left = A, bottom = B, right = C; L / top / R = X / Y / Z (6-button games); Select = Mode.
- **PlayStation:** bottom = ✕, right = ○, left = □, top = △; L / R = L1 / R1, triggers = L2 / R2. The controller
  is a DualShock that starts in digital mode, like the real one: there the gamepad's left stick moves the d-pad.
  Games made for the sticks turn analog mode on themselves; in others, **L1 + R1 + Select** (keyboard **Q + E +
  Backspace**) is the DualShock's ANALOG button. On a keyboard the arrows are the d-pad, which most games accept
  (the few that need the analog sticks need a gamepad).
- **Nintendo 64:** the control stick is the gamepad's left stick, or the **arrows / WASD** on a keyboard. A = A,
  left = B, LT = Z, L / R = L / R, Start = Start. The **C buttons** are the gamepad's right stick, or top = C-up,
  right = C-down, RT = C-right and Select = C-left (on a keyboard: **I**, **K**, **O**, **Backspace**). The N64
  d-pad needs a gamepad.

Plug a gamepad in and press a button to use it.

**Performance.** SNES and Mega Drive games run on any computer. **PlayStation and especially Nintendo 64** games
need a stronger computer for the host (a recent desktop or gaming laptop): if the game stutters or its sound
crackles, the host's PC is too slow for that game. Players only watch the stream, so any computer works for them.

**Latency.** The host plays without delay. Everyone else sees the host's stream, so a button press travels to
the host's computer and the picture comes back: expect about 0.1–0.2 s on a good connection. That's fine for
most games (RPGs, puzzle, party and turn-based games); in fast action games the players feel it more than the
host does.

**Your game files stay on your computer.** Nexo never uploads them (only the game's name is shown to the
others), nor a BIOS, and never provides, downloads or links to games or BIOS files: play files you own.

## Appearance

**Settings → Appearance:**

- **Theme:** System, Dark, Midnight (true black) or Light.
- **Accent:** the highlight color for buttons, mentions and the speaking ring: Mint, Blue, Violet, Coral,
  Amber or Rose.
- **Title bar:** **With search** shows a **Jump to a channel** box at the top of the window (the same as
  Ctrl K); **Minimal** shows only the server name.
- **App icon:** Classic, Accent (your accent color), Paper or Mono. It changes the icon on the taskbar,
  in Alt+Tab and in the tray while Nexo runs. A shortcut pinned to the taskbar or Start menu keeps the
  default icon.
- **Zoom** (also Ctrl +, Ctrl − and Ctrl 0, or Ctrl + mouse wheel; 67–200%), **Compact messages** and
  **Show link previews**.

On Windows, Nexo draws its own title bar in the theme's colors. The minimize, maximize and close buttons
are the regular Windows ones (Snap Layouts included), and you move the window by dragging the bar.

## Language and time

**Settings → Language & time:**

- **Language:** **System** (your computer's language), **English** or **Português (Brasil)**. It changes
  right away, without restarting or leaving voice. The tray menu follows it too.
- **Clock:** **Automatic** (your computer's regional format), **12-hour** or **24-hour**, for every time
  Nexo shows.

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
- The installers are unsigned (SmartScreen warning on Windows, Gatekeeper on macOS).
