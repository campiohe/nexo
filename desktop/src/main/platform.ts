// Platform capability flags, computed once in main and handed to the preload via additionalArguments.
import { app } from 'electron'

export type NexoPlatform = 'win32' | 'darwin' | 'linux'

export const platform: NexoPlatform =
  process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'

/**
 * Linux + Wayland session: Chromium/WebRTC then captures through the xdg-desktop-portal (PipeWire),
 * which shows the OS picker. Mirrors webrtc::DesktopCapturer::IsRunningUnderWayland().
 * NEXO_SYSTEM_PICKER=1/0 overrides the detection (debugging only).
 */
export const usesSystemPicker: boolean = (() => {
  const override = process.env.NEXO_SYSTEM_PICKER
  if (override === '1' || override === '0') return override === '1'
  if (platform !== 'linux') return false
  return (process.env.XDG_SESSION_TYPE ?? '').toLowerCase().startsWith('wayland') && !!process.env.WAYLAND_DISPLAY
})()

/**
 * getDisplayMedia + `audio: 'loopback'` (system mix) is documented as Windows-only in Electron 45's typings.
 * macOS loopback (ScreenCaptureKit / CoreAudio tap, macOS 14.2+) is unverified, so it is opt-in via
 * NEXO_MAC_SYSTEM_AUDIO=1 until someone tests it on a Mac. Linux: not available through Electron.
 */
export const supportsSystemAudio: boolean =
  platform === 'win32' || (platform === 'darwin' && process.env.NEXO_MAC_SYSTEM_AUDIO === '1')

/** Renderer served by the electron-vite dev server (HMR). */
export const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL

/**
 * Developer conveniences (DevTools shortcuts, renderer console mirrored to stdout): any unpackaged run,
 * or `--nexo-dev` (used by scripts/win-run.sh, which runs `electron.exe <appdir> --user-data-dir=… --nexo-dev`).
 */
export const devMode = !app.isPackaged || process.argv.includes('--nexo-dev')

/** Arguments appended to the renderer's process.argv; parsed by src/preload/index.ts. */
export function preloadArguments(): string[] {
  return [
    `--nexo-platform=${platform}`,
    `--nexo-system-audio=${supportsSystemAudio ? 1 : 0}`,
    `--nexo-system-picker=${usesSystemPicker ? 1 : 0}`,
  ]
}
