// What the nativeShare start/update/stop/release IPC handlers return. Electron drops custom Error properties
// across ipcRenderer.invoke (and contextBridge does too), so failures travel as data and the preload turns
// them back into a rejection carrying `code` and `fallback`. Shared by main and preload (types only).
import type { NativeShareError } from '../../preload/api'

export type NativeShareInvokeResult = { ok: true } | { ok: false; error: NativeShareError }
