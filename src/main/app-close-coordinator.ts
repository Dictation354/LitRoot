import type { AppCloseKind, AppCloseRequest } from '../shared/contracts.js'

export type CloseResolution = 'cancelled' | 'close-window' | 'quit' | 'stale'

interface PendingClose extends AppCloseRequest {
  windowId: number
}

export class AppCloseCoordinator {
  private sequence = 0
  private pending: PendingClose | null = null

  request(kind: AppCloseKind, windowId: number): AppCloseRequest {
    if (this.pending?.kind === kind && this.pending.windowId === windowId) {
      return { id: this.pending.id, kind: this.pending.kind }
    }
    const request: PendingClose = {
      id: `close_${Date.now().toString(36)}_${(++this.sequence).toString(36)}`,
      kind,
      windowId
    }
    this.pending = request
    return { id: request.id, kind: request.kind }
  }

  resolve(requestId: string, windowId: number, proceed: boolean): CloseResolution {
    const pending = this.pending
    if (!pending || pending.id !== requestId || pending.windowId !== windowId) return 'stale'
    this.pending = null
    if (!proceed) return 'cancelled'
    return pending.kind === 'quit' ? 'quit' : 'close-window'
  }

  clearWindow(windowId: number): void {
    if (this.pending?.windowId === windowId) this.pending = null
  }
}
