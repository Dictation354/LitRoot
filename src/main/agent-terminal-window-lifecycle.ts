import type { WebContents } from 'electron'
import type { AgentTerminalService } from './application/agent-terminal-service.js'

type AgentTerminalLifecycleService = Pick<
  AgentTerminalService,
  'beginOwnerReload' | 'finishOwnerReload'
>

export function registerAgentTerminalReloadLifecycle(
  webContents: WebContents,
  ownerId: number,
  terminal: () => AgentTerminalLifecycleService | null
): void {
  let rendererLoaded = false

  webContents.on('did-finish-load', () => {
    rendererLoaded = true
    terminal()?.finishOwnerReload(ownerId)
  })

  webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!rendererLoaded || isInPlace || !isMainFrame) return
    rendererLoaded = false
    void terminal()?.beginOwnerReload(ownerId)
  })
}
