// Owner: workstream B. Exposes NexoBridge (see ./api.ts) as window.nexo.
// Runs sandboxed: only contextBridge / ipcRenderer are available. Platform flags come from main via
// webPreferences.additionalArguments (see src/main/platform.ts).
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type CaptureSource, type NexoBridge } from './api'

function arg(name: string): string | undefined {
  const prefix = `--nexo-${name}=`
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length)
}

const platformArg = arg('platform')
const platform: NexoBridge['platform'] =
  platformArg === 'win32' || platformArg === 'darwin' || platformArg === 'linux' ? platformArg : 'linux'

const bridge: NexoBridge = {
  platform,
  supportsSystemAudio: arg('system-audio') === '1',
  usesSystemPicker: arg('system-picker') === '1',

  capture: {
    listSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke(IPC.listSources),
    selectSource: (id: string | null, withAudio: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.selectSource, id, withAudio),
  },

  secrets: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke(IPC.secretGet, key),
    set: (key: string, value: string | null): Promise<void> => ipcRenderer.invoke(IPC.secretSet, key, value),
  },

  openExternal: (url: string): void => ipcRenderer.send(IPC.openExternal, url),
}

contextBridge.exposeInMainWorld('nexo', bridge)
