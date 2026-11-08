// The alpha's capture path, reduced to what matters for frame rate (docs/benchmarks/beta-m3-fps-gap.md):
// setDisplayMediaRequestHandler answers getDisplayMedia with one window (desktopCapturer), the page captures it
// at the Game preset (1920x1080 max, 60 fps) and sends it through an RTCPeerConnection loopback pair with H.264
// preferred, 8 Mbps, maxFramerate 60, like voice/session.ts publishes a screen share.
//
//   electron.exe <this dir> --hwnd=<decimal HWND> [--enable-features=WebRtcAllowWgcUsingTexture]
//
// stdout, one JSON object per line: {"type":"ready","pid":…}, then every second
//   {"type":"stats","captureFps":…,"sendFps":…,"encoder":…,"codec":…,"qualityLimitation":…,"width":…,"height":…}
// and {"type":"error","message":…} if the capture can't start.
const { app, BrowserWindow, desktopCapturer, protocol, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// The page comes from a privileged scheme rather than file:// (loading file:// from this folder failed with
// ERR_FAILED on the test PC). `secure` makes it a secure context, which getDisplayMedia requires.
protocol.registerSchemesAsPrivileged([{ scheme: 'bench', privileges: { standard: true, secure: true } }])

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const hwnd = arg('hwnd')
// The flag the alpha sets from prefs.fastCapture (desktop/src/main/index.ts). Chromium also reads it from argv;
// appending it here makes sure it applies whichever way Electron was started.
const features = arg('enable-features')
if (features) app.commandLine.appendSwitch('enable-features', features)
app.setPath('userData', path.join(app.getPath('temp'), 'nexo-alpha-bench'))

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

app.whenReady().then(async () => {
  protocol.handle('bench', () => new Response(fs.readFileSync(path.join(__dirname, 'index.html')), { headers: { 'content-type': 'text/html' } }))
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } })
    const source = hwnd ? sources.find((s) => s.id.startsWith(`window:${hwnd}:`)) : sources.find((s) => s.id.startsWith('screen:'))
    if (!source) {
      out({ type: 'error', message: `no capture source for hwnd ${hwnd}`, sources: sources.map((s) => s.id) })
      callback(null)
      return
    }
    out({ type: 'source', id: source.id, name: source.name })
    callback({ video: source })
  })

  // Visible but tiny and out of the way: a hidden window gets throttled, and the alpha's window is visible too.
  const win = new BrowserWindow({
    width: 320,
    height: 200,
    x: 0,
    y: 0,
    show: true,
    focusable: false,
    skipTaskbar: true,
    webPreferences: { backgroundThrottling: false },
  })
  win.showInactive()
  win.webContents.on('console-message', (event) => {
    const text = event.message
    if (typeof text === 'string' && text.startsWith('{')) process.stdout.write(text + '\n')
  })
  await win.loadURL('bench://app/index.html')
  // userGesture: getDisplayMedia wants transient activation; the alpha calls it from a click.
  await win.webContents.executeJavaScript('start()', true).catch((e) => out({ type: 'error', message: String(e) }))
  out({ type: 'ready', pid: process.pid })
})

app.on('window-all-closed', () => app.quit())
// Stopped by the runner (taskkill /PID from the `ready` line). Not on stdin EOF: through WSL interop stdin can
// read as closed at once, which quit the app before its page had loaded.
