import type { LitRootTransportBridge } from '../../shared/contracts'

declare global {
  interface Window {
    litroot?: LitRootTransportBridge
  }
}

export {}
