// Auto-update via electron-updater and GitHub releases (publish config in electron-builder.yml, which
// writes resources/app-update.yml into the packaged app and latest*.yml next to the installers).
//
// - Windows (NSIS) and Linux (AppImage): download in the background, install on "Restart to update" or
//   on the next quit. Never restarts on its own.
// - macOS: check only. Squirrel.Mac can't update ad-hoc signed / unsigned apps, so a newer release is
//   reported as 'available' with the release page as downloadUrl.
// - Dev builds and Linux without the AppImage: 'unsupported'.
//
// Test builds (README "Test builds"): versions like 0.4.0-test.1, tagged v0.4.0-test.1. electron-updater's GitHub
// provider treats `test` as a custom channel: alpha/beta/stable installs never pick those releases, and a test
// build only follows newer test releases. A test build leaves the lane with leaveTestBuilds() (Settings → App).
import { app, BrowserWindow, ipcMain, autoUpdater as nativeUpdater, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { IPC, type UpdateState } from '../preload/api'
import { platform } from './platform'
import { isAppUrl } from './security'

const RELEASES_URL = 'https://github.com/campiohe/nexo/releases'
const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
/** First prerelease identifier of a test build (0.4.0-test.1). */
const TEST_CHANNEL = 'test'

interface UpdaterDeps {
  /** Called on every state change (the tray uses it for its "Restart to update" item). */
  onState(state: UpdateState): void
  /** Called right before the app quits to install an update (lets close-to-tray know it must not block). */
  onQuitForUpdate(): void
}

const log = {
  info: (message?: unknown) => console.log('[updater]', message),
  warn: (message?: unknown) => console.warn('[updater]', message),
  error: (message?: unknown) => console.error('[updater]', message),
}

let deps: UpdaterDeps | null = null
const testBuild = new RegExp(`^\\d+\\.\\d+\\.\\d+-${TEST_CHANNEL}(?:[.+]|$)`).test(app.getVersion())
let state: UpdateState = { status: 'idle', currentVersion: app.getVersion(), canAutoInstall: false, ...(testBuild ? { testBuild } : {}) }

function unsupportedReason(): string | null {
  if (!app.isPackaged) return 'Updates are disabled in development builds.'
  if (platform === 'linux' && !process.env.APPIMAGE) {
    return 'Automatic updates only work in the AppImage. Download new versions from the releases page.'
  }
  return null
}

function releaseUrl(version: string): string | undefined {
  return VERSION_RE.test(version) ? `${RELEASES_URL}/tag/v${version}` : undefined
}

function setState(next: UpdateState): void {
  state = next
  deps?.onState(state)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IPC.updatesState, state)
  }
}

function base(): Pick<UpdateState, 'currentVersion' | 'canAutoInstall' | 'testBuild' | 'leavingTestBuilds'> {
  const { currentVersion, canAutoInstall, testBuild, leavingTestBuilds } = state
  return { currentVersion, canAutoInstall, ...(testBuild ? { testBuild } : {}), ...(leavingTestBuilds ? { leavingTestBuilds } : {}) }
}

function withVersion(info: UpdateInfo): Pick<UpdateState, 'version' | 'releaseNotesUrl'> {
  const version = String(info.version)
  return { version, releaseNotesUrl: releaseUrl(version) }
}

/** One short line for the UI; the full error (stack, response body) goes to the console. */
function describeError(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; statusCode?: unknown; message?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const message = typeof e.message === 'string' ? e.message : String(err)
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return 'The latest release has no update information yet.'
  if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND') {
    return 'No release found on GitHub.'
  }
  if (e.statusCode === 403 || e.statusCode === 429 || /\b(403|429)\b/.test(message.split('\n')[0])) {
    return 'GitHub is rate-limiting update checks. Try again later.'
  }
  if (
    /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION_|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY_)/.test(message) ||
    /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/.test(message)
  ) {
    return "Couldn't reach GitHub. Check your internet connection."
  }
  const line = message.split('\n')[0].trim()
  return line.length > 160 ? `${line.slice(0, 159)}…` : line || 'Update check failed.'
}

function onError(err: unknown): void {
  const error = describeError(err)
  // Keep the last good state: a failed background check must not hide an update that is ready or known.
  if (state.status === 'ready' || state.status === 'available') {
    setState({ ...state, error })
    return
  }
  const { version, releaseNotesUrl } = state
  setState({ ...base(), status: 'error', error, ...(version ? { version, releaseNotesUrl } : {}) })
}

/** Busy or already found something: a new check would only reset or re-download it. */
const shouldSkipCheck = (): boolean =>
  state.status === 'unsupported' || state.status === 'checking' || state.status === 'downloading' || state.status === 'ready'

async function check(): Promise<UpdateState> {
  if (shouldSkipCheck()) return state
  try {
    const result = await autoUpdater.checkForUpdates()
    // Download errors are reported through the 'error' event; don't leave the promise unhandled.
    result?.downloadPromise?.catch(() => undefined)
  } catch {
    // Already reported through the 'error' event.
  }
  return state
}

/**
 * Test build → regular releases: from now on the updater takes the newest alpha, beta or stable release, and
 * installs it even though its version is lower (0.4.0-beta.1 < 0.4.0-test.3 in semver). It downloads in the
 * background and installs on restart, like any update.
 */
async function leaveTestBuilds(): Promise<UpdateState> {
  if (!state.testBuild || state.leavingTestBuilds || state.status === 'unsupported') return state
  if (state.status === 'checking' || state.status === 'downloading') return state
  log.info('leaving test builds: following regular releases')
  // The GitHub provider reads the channel on every check. As "alpha" it takes the first alpha, beta or stable
  // release in the feed and skips custom channels like "test". Setting a channel also allows downgrades.
  autoUpdater.channel = 'alpha'
  autoUpdater.allowDowngrade = true
  // Back to idle so a downloaded test update ('ready') doesn't block the check. The regular release's download
  // then replaces it as the update that installs on restart or quit.
  setState({ ...base(), leavingTestBuilds: true, status: 'idle' })
  return check()
}

/** Quits and installs a downloaded update (status 'ready'); ignored otherwise. */
export function installUpdate(): void {
  if (state.status !== 'ready' || !state.canAutoInstall) return
  log.info(`installing ${state.version ?? 'update'} and restarting`)
  // Windows: silent NSIS install, then start Nexo again. AppImage: replace the file and start the new one.
  autoUpdater.quitAndInstall(true, true)
}

function wireEvents(): void {
  autoUpdater.on('checking-for-update', () => {
    // Don't flash the banner away while a periodic check re-confirms a known update.
    if (state.status === 'available') return
    setState({ ...base(), status: 'checking' })
  })
  autoUpdater.on('update-not-available', () => {
    setState({ ...base(), status: 'up-to-date' })
  })
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    const v = withVersion(info)
    if (state.canAutoInstall) {
      setState({ ...base(), ...v, status: 'downloading', percent: 0 })
    } else {
      setState({ ...base(), ...v, status: 'available', downloadUrl: v.releaseNotesUrl ?? RELEASES_URL })
    }
  })
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)))
    if (state.status === 'downloading' && state.percent === percent) return
    const { version, releaseNotesUrl } = state
    setState({ ...base(), version, releaseNotesUrl, status: 'downloading', percent })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info(`update ${info.version} downloaded; it installs on restart or quit`)
    setState({ ...base(), ...withVersion(info), status: 'ready' })
  })
  autoUpdater.on('error', (err: Error) => onError(err))

  // BaseUpdater.quitAndInstall() emits this right before app.quit(), once the installer has started.
  nativeUpdater.on('before-quit-for-update', () => {
    deps?.onQuitForUpdate()
    // The AppImage is started again before this process exits: let it take the single-instance lock.
    app.releaseSingleInstanceLock()
  })
}

function fromApp(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return isAppUrl(event.senderFrame?.url)
}

export function getUpdateState(): UpdateState {
  return state
}

export function installUpdater(d: UpdaterDeps): void {
  deps = d
  ipcMain.handle(IPC.updatesGetState, (event) => {
    if (!fromApp(event)) throw new Error('forbidden')
    return state
  })
  ipcMain.handle(IPC.updatesCheck, (event) => {
    if (!fromApp(event)) throw new Error('forbidden')
    return check()
  })
  ipcMain.handle(IPC.updatesLeaveTest, (event) => {
    if (!fromApp(event)) throw new Error('forbidden')
    return leaveTestBuilds()
  })
  ipcMain.on(IPC.updatesInstall, (event) => {
    if (fromApp(event)) installUpdate()
  })

  const reason = unsupportedReason()
  if (reason) {
    log.info(`disabled: ${reason}`)
    setState({ ...base(), status: 'unsupported', reason })
    return
  }

  const canAutoInstall = platform === 'win32' || platform === 'linux'
  state = { ...state, canAutoInstall }
  autoUpdater.logger = log
  autoUpdater.autoDownload = canAutoInstall
  autoUpdater.autoInstallOnAppQuit = canAutoInstall
  // Alphas follow the newest GitHub release, prerelease or stable (the github provider picks the first
  // alpha/beta/stable entry of the releases feed). Stable builds only look at /releases/latest. Test builds
  // follow test releases only (see the header).
  autoUpdater.allowPrerelease = autoUpdater.currentVersion.prerelease.length > 0
  // Never install an older version, even if an older line gets a newer release on GitHub.
  autoUpdater.allowDowngrade = false
  wireEvents()
  log.info(
    `enabled (${platform}, ${state.currentVersion}, prereleases ${autoUpdater.allowPrerelease ? 'on' : 'off'}, ` +
      `${testBuild ? 'test builds, ' : ''}` +
      `${canAutoInstall ? 'download + install on quit' : 'check only'})`,
  )

  setTimeout(() => void check(), FIRST_CHECK_DELAY_MS)
  setInterval(() => void check(), CHECK_INTERVAL_MS)
}
