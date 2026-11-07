/// <reference types="vite/client" />
import type { NexoBridge } from '../../preload/api'

declare global {
  interface Window {
    nexo: NexoBridge
  }
}
