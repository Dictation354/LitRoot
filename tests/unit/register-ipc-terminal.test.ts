import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RootSummary } from '../../src/shared/contracts.js'
import { IPC } from '../../src/shared/contracts.js'
import type { AgentRelaySetupService } from '../../src/main/application/agent-relay-setup.js'
import type { AgentTerminalService } from '../../src/main/application/agent-terminal-service.js'
import type { LibraryService } from '../../src/main/application/library-service.js'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    fromWebContents: vi.fn(),
    showMessageBox: vi.fn(),
    showOpenDialog: vi.fn(),
    writeText: vi.fn(),
    showItemInFolder: vi.fn()
  }
})

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  clipboard: { writeText: electronMocks.writeText },
  dialog: {
    showMessageBox: electronMocks.showMessageBox,
    showOpenDialog: electronMocks.showOpenDialog
  },
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler
  },
  shell: { showItemInFolder: electronMocks.showItemInFolder }
}))

import { registerIpc } from '../../src/main/ipc/register-ipc.js'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined
  let reject: (reason?: unknown) => void = () => undefined
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

const registeredRoot: RootSummary = {
  id: 'root-one',
  path: '/research/root-one',
  label: 'Project root-one',
  status: 'ready',
  error: null,
  paperCount: 1,
  issueCount: 0,
  lastScannedAt: null,
  createdAt: '2026-08-20T00:00:00.000Z'
}

function harness(overrides: { removeRoot?: (rootId: string) => unknown } = {}): {
  mainWindow: { isDestroyed(): boolean; webContents: object }
  mainFrame: object
  webContents: { id: number; isDestroyed(): boolean; mainFrame: object }
  service: { listRoots: ReturnType<typeof vi.fn>; removeRoot: ReturnType<typeof vi.fn> }
  terminal: {
    isOwnerBusy: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    stopRoot: ReturnType<typeof vi.fn>
    releaseRootStop: ReturnType<typeof vi.fn>
  }
  lifecycle: { respond: ReturnType<typeof vi.fn> }
} {
  const mainFrame = {}
  const webContents = { id: 71, isDestroyed: () => false, mainFrame }
  const mainWindow = { isDestroyed: () => false, webContents }
  const service = {
    listRoots: vi.fn(() => [registeredRoot]),
    removeRoot: vi.fn(overrides.removeRoot ?? ((rootId: string) => rootId))
  }
  const terminal = {
    isOwnerBusy: vi.fn(() => false),
    start: vi.fn(),
    stopRoot: vi.fn(async () => undefined),
    releaseRootStop: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    stop: vi.fn()
  }
  const lifecycle = { respond: vi.fn() }
  electronMocks.fromWebContents.mockReturnValue(mainWindow)
  registerIpc(
    service as unknown as LibraryService,
    {} as AgentRelaySetupService,
    terminal as unknown as AgentTerminalService,
    () => mainWindow as never,
    lifecycle
  )
  return { mainWindow, mainFrame, webContents, service, terminal, lifecycle }
}

function handler(channel: string): IpcHandler {
  const registered = electronMocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler for ${channel}`)
  return registered
}

describe('agent terminal IPC authority', () => {
  beforeEach(() => {
    electronMocks.handlers.clear()
    vi.clearAllMocks()
  })

  it('rejects a child-frame sender before starting or prompting for a terminal', async () => {
    const { webContents, terminal } = harness()
    const event = { sender: webContents, senderFrame: {} }

    await expect(
      handler(IPC.agentTerminalStart)(event, { rootId: 'root-one' })
    ).rejects.toThrow(/active PaperRelay window/i)

    expect(terminal.start).not.toHaveBeenCalled()
    expect(electronMocks.showMessageBox).not.toHaveBeenCalled()
  })

  it('uses the main-owned prompt and does not spawn when workspace write is canceled', async () => {
    const { mainWindow, mainFrame, webContents, terminal } = harness()
    electronMocks.showMessageBox.mockResolvedValue({ response: 0 })
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(
      handler(IPC.agentTerminalStart)(event, {
        rootId: 'root-one',
        access: 'workspace-write'
      })
    ).resolves.toBeNull()

    expect(electronMocks.showMessageBox).toHaveBeenCalledWith(
      mainWindow,
      expect.objectContaining({ type: 'warning', defaultId: 0, cancelId: 0 })
    )
    expect(terminal.start).not.toHaveBeenCalled()
  })

  it('keeps a root start-blocked until library removal settles', async () => {
    const removalGate = deferred<string>()
    const removalEntered = deferred<void>()
    const { mainFrame, service, terminal, webContents } = harness({
      removeRoot: (rootId) => {
        removalEntered.resolve()
        return removalGate.promise.then(() => rootId)
      }
    })

    const removal = handler(IPC.rootsRemove)(
      { sender: webContents, senderFrame: mainFrame },
      'root-one'
    ) as Promise<unknown>
    await removalEntered.promise
    expect(terminal.stopRoot).toHaveBeenCalledWith('root-one')
    expect(terminal.releaseRootStop).not.toHaveBeenCalled()

    removalGate.resolve('done')
    await expect(removal).resolves.toBe('root-one')
    expect(service.removeRoot).toHaveBeenCalledWith('root-one')
    expect(terminal.releaseRootStop).toHaveBeenCalledWith('root-one')
  })

  it('releases the root start block when library removal fails', async () => {
    const removalError = new Error('catalog removal failed')
    const { mainFrame, terminal, webContents } = harness({
      removeRoot: () => Promise.reject(removalError)
    })

    await expect(
      handler(IPC.rootsRemove)(
        { sender: webContents, senderFrame: mainFrame },
        'root-one'
      )
    ).rejects.toBe(removalError)

    expect(terminal.releaseRootStop).toHaveBeenCalledWith('root-one')
  })
})

describe('IPC main-frame authority', () => {
  beforeEach(() => {
    electronMocks.handlers.clear()
    vi.clearAllMocks()
  })

  it('rejects every invoke handler from a child frame before any side effect', async () => {
    const { service, terminal, webContents } = harness()
    const handlers = [...electronMocks.handlers.entries()]
    expect(handlers.length).toBeGreaterThan(20)

    for (const [channel, invoke] of handlers) {
      let thrown: unknown = null
      try {
        await invoke({ sender: webContents, senderFrame: {} })
      } catch (error) {
        thrown = error
      }
      expect({
        channel,
        message: thrown instanceof Error ? thrown.message : null
      }).toEqual({
        channel,
        message: expect.stringMatching(/active PaperRelay window/i)
      })
    }

    expect(service.listRoots).not.toHaveBeenCalled()
    expect(service.removeRoot).not.toHaveBeenCalled()
    expect(terminal.start).not.toHaveBeenCalled()
    expect(terminal.stopRoot).not.toHaveBeenCalled()
    expect(electronMocks.showOpenDialog).not.toHaveBeenCalled()
    expect(electronMocks.showMessageBox).not.toHaveBeenCalled()
    expect(electronMocks.writeText).not.toHaveBeenCalled()
    expect(electronMocks.showItemInFolder).not.toHaveBeenCalled()
  })
})

describe('application lifecycle IPC authority', () => {
  beforeEach(() => {
    electronMocks.handlers.clear()
    vi.clearAllMocks()
  })

  it('accepts a strictly typed close response from the active main frame', () => {
    const { mainWindow, mainFrame, webContents, lifecycle } = harness()

    expect(
      handler(IPC.lifecycleRespondToClose)(
        { sender: webContents, senderFrame: mainFrame },
        'close-request-1',
        true
      )
    ).toBeUndefined()

    expect(lifecycle.respond).toHaveBeenCalledWith(mainWindow, 'close-request-1', true)
  })

  it('rejects child frames and malformed close responses', () => {
    const { mainFrame, webContents, lifecycle } = harness()

    expect(() =>
      handler(IPC.lifecycleRespondToClose)(
        { sender: webContents, senderFrame: {} },
        'close-request-1',
        true
      )
    ).toThrow(/active PaperRelay window/i)
    expect(() =>
      handler(IPC.lifecycleRespondToClose)(
        { sender: webContents, senderFrame: mainFrame },
        'close-request-1',
        'yes'
      )
    ).toThrow(/true or false/i)

    expect(lifecycle.respond).not.toHaveBeenCalled()
  })

  it('rejects draft mutations from a child frame before touching the service', () => {
    const { webContents } = harness()

    expect(() =>
      handler(IPC.papersSaveDraft)(
        { sender: webContents, senderFrame: {} },
        'paper-one',
        { note: 'private', tagInput: 'methods' }
      )
    ).toThrow(/active PaperRelay window/i)
  })
})
