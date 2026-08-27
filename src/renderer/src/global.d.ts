import type { LitRootBridge } from '../../shared/contracts'

declare global {
  interface Window {
    litroot?: LitRootBridge
  }
}

export {}
