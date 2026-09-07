import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ cleanup: vi.fn(), close: vi.fn(async () => undefined), choice: vi.fn(() => 0) }))
vi.mock('../../src/main/app-controller.js', () => ({ AppController: class {
  start = async () => undefined
  close = calls.close
} }))
vi.mock('../../src/main/ipc/register-ipc.js', () => ({ registerIpc: vi.fn(), unregisterIpc: calls.cleanup }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true, whenReady: async () => undefined,
    isPackaged: false, getAppPath: () => '/tmp/litroot', quit: vi.fn()
  })
  class Window extends EventEmitter {
    static windows: Window[] = []
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn(), send: vi.fn() })
    constructor() { super(); Window.windows.push(this) }
    loadFile = vi.fn()
    loadURL = vi.fn()
    show = vi.fn()
  }
  return { app, BrowserWindow: Window, nativeImage: { createFromPath: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn(), unhandle: vi.fn() },
    session: { defaultSession: { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() } },
    dialog: { showMessageBoxSync: calls.choice } }
})

describe('window unload and quit lifecycle', () => {
  it('defaults to editing, keeps IPC/services on cancelled quit, and cleans up only after windows close', async () => {
    vi.stubGlobal('__dirname', '/tmp/litroot/out/main')
    const electron = await import('electron')
    await import('../../src/main/index.js')
    await vi.waitFor(() => expect((electron.BrowserWindow as unknown as { windows: unknown[] }).windows).toHaveLength(1))
    const window = (electron.BrowserWindow as unknown as { windows: Array<{ webContents: EventEmitter }> }).windows[0]!
    electron.app.emit('before-quit', { preventDefault: vi.fn() })
    const keepEditing = { preventDefault: vi.fn() }
    window.webContents.emit('will-prevent-unload', keepEditing)
    expect(calls.choice).toHaveBeenCalledWith(window, expect.objectContaining({
      buttons: ['返回编辑', '放弃未保存内容'], defaultId: 0, cancelId: 0
    }))
    expect(keepEditing.preventDefault).not.toHaveBeenCalled()
    expect(calls.cleanup).not.toHaveBeenCalled()
    expect(calls.close).not.toHaveBeenCalled()
    calls.choice.mockReturnValueOnce(1)
    const discard = { preventDefault: vi.fn() }
    window.webContents.emit('will-prevent-unload', discard)
    expect(discard.preventDefault).toHaveBeenCalledOnce()
    const finalQuit = { preventDefault: vi.fn() }
    electron.app.emit('will-quit', finalQuit)
    expect(finalQuit.preventDefault).toHaveBeenCalledOnce()
    expect(calls.cleanup).toHaveBeenCalledOnce()
    expect(calls.close).toHaveBeenCalledOnce()
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
    expect(electron.app.quit).not.toHaveBeenCalled()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(electron.app.quit).toHaveBeenCalledOnce()
    const completedQuit = { preventDefault: vi.fn() }
    electron.app.emit('will-quit', completedQuit)
    expect(completedQuit.preventDefault).not.toHaveBeenCalled()
    expect(calls.close).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })
})
