import type { LitRootBridge } from '../../shared/contracts'

export function bridge(): LitRootBridge {
  if (!window.litroot) throw new Error('LitRoot 安全桥接尚未就绪。')
  return window.litroot
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, '') : '操作失败。'
}
