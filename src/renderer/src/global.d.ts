import type { PaperRelayBridge } from '../../shared/contracts'

declare global {
  interface Window {
    paperrelay?: PaperRelayBridge
  }
}

export {}
