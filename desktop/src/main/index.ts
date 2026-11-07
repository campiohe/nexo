// Owner: workstream B. Electron main process: window, security, capture, secrets.
import { app, BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions } from 'electron'
import { join, resolve } from 'node:path'
import icon from '../../resources/icon.png?asset'
import { IPC } from '../preload/api'
import { installCapture } from './capture'
import { devMode, isDev, platform, preloadArguments } from './platform'
import { installSecrets } from './secrets'
import { installSecurity, isAppUrl, openExternalSafe, rendererEntry } from './security'
import { loadWindowState, trackWindowState } from './window-state'

const BACKGROUND = '#0b0d11'
let mainWindow: BrowserWindow | null = null

function createMainWindow(): BrowserWindow {
  const state = loadWindowState({ width: 1280, height: 800, minWidth: 940, minHeight: 600 })
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: 'Nexo',
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    // Windows/macOS take the icon from the executable/bundle; Linux needs it on the window.
    ...(platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: preloadArguments(),
    },
  })
  if (state.maximized) win.maximize()
  trackWindowState(win)

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // DevTools: F12 / Ctrl+Shift+I (Cmd+Alt+I on macOS), unpackaged runs or --nexo-dev only.
  win.webContents.on('before-input-event', (event, input) => {
    if (!devMode || input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const combo =
      platform === 'darwin' ? input.meta && input.alt && key === 'i' : input.control && input.shift && key === 'i'
    if (key === 'f12' || combo) {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  // Mirror renderer warnings/errors (CSP violations included) to the terminal in dev.
  if (devMode || process.env.NEXO_LOG_RENDERER === '1') {
    win.webContents.on('console-message', ({ level, message, sourceId, lineNumber }) => {
      if (level === 'warning' || level === 'error') console.log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`)
    })
  }

  if (isDev) void win.loadURL(rendererEntry)
  else void win.loadFile(rendererEntry)
  return win
}

function installMenu(): void {
  if (platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  // macOS needs an app menu for Cmd+Q / Cmd+C / Cmd+V etc.
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    ...(devMode ? [{ role: 'viewMenu' } as MenuItemConstructorOptions] : []),
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function focusMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

/**
 * `--user-data-dir=<path>` gives each copy its own profile (scripts/win-run.sh runs two side by side).
 * Chromium/Electron may already honour the switch; setting the same path again is a no-op, so only call
 * setPath when it differs. Must run before anything touches userData and before the single-instance lock,
 * which Electron keys on the userData directory — so the lock is per profile.
 */
function applyUserDataDirSwitch(): void {
  const prefix = '--user-data-dir='
  const raw = process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length).replace(/^"(.*)"$/, '$1')
  if (!raw) return
  const dir = resolve(raw)
  if (resolve(app.getPath('userData')) !== dir) app.setPath('userData', dir)
}

applyUserDataDirSwitch()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // App name / userData folder ("Nexo") come from productName in package.json.
  if (platform === 'win32') app.setAppUserModelId('app.nexo.desktop')

  app.on('second-instance', focusMainWindow)

  void app.whenReady().then(() => {
    installSecurity()
    installMenu()
    installCapture()
    installSecrets()
    ipcMain.on(IPC.openExternal, (event, url: unknown) => {
      if (isAppUrl(event.senderFrame?.url)) openExternalSafe(url)
    })

    mainWindow = createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
      else focusMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (platform !== 'darwin') app.quit()
  })
}
