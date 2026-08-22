import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { registerAgentTerminalReloadLifecycle } from '../../src/main/agent-terminal-window-lifecycle.js'

type Listener = (...args: unknown[]) => void

class FakeWebContents {
  private readonly listeners = new Map<string, Listener[]>()

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

describe('agent terminal renderer lifecycle', () => {
  it('cleans up only a subsequent full main-frame navigation and releases after load', () => {
    const webContents = new FakeWebContents()
    const terminal = {
      beginOwnerReload: vi.fn(async () => undefined),
      finishOwnerReload: vi.fn()
    }
    registerAgentTerminalReloadLifecycle(
      webContents as unknown as WebContents,
      71,
      () => terminal
    )

    webContents.emit('did-start-navigation', {}, 'file:///initial.html', false, true)
    expect(terminal.beginOwnerReload).not.toHaveBeenCalled()

    webContents.emit('did-finish-load')
    expect(terminal.finishOwnerReload).toHaveBeenCalledOnce()
    expect(terminal.finishOwnerReload).toHaveBeenLastCalledWith(71)

    webContents.emit('did-start-navigation', {}, 'file:///initial.html#section', true, true)
    webContents.emit('did-start-navigation', {}, 'file:///child.html', false, false)
    expect(terminal.beginOwnerReload).not.toHaveBeenCalled()

    webContents.emit('did-start-navigation', {}, 'file:///initial.html', false, true)
    expect(terminal.beginOwnerReload).toHaveBeenCalledOnce()
    expect(terminal.beginOwnerReload).toHaveBeenLastCalledWith(71)

    webContents.emit('did-start-navigation', {}, 'file:///redirect.html', false, true)
    expect(terminal.beginOwnerReload).toHaveBeenCalledOnce()

    webContents.emit('did-finish-load')
    expect(terminal.finishOwnerReload).toHaveBeenCalledTimes(2)
    expect(terminal.finishOwnerReload).toHaveBeenLastCalledWith(71)
  })
})
