import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    fromWebContents: vi.fn()
  }
})

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  clipboard: { writeText: vi.fn() },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler
  },
  shell: { showItemInFolder: vi.fn() }
}))

import { registerIpc } from '../../src/main/ipc/register-ipc.js'

function handler(channel: string): IpcHandler {
  const value = electronMocks.handlers.get(channel)
  if (!value) throw new Error(`Missing IPC handler for ${channel}`)
  return value
}

function register(): {
  event: { sender: object; senderFrame: object }
  paperDigest: ReturnType<typeof vi.fn>
  researchLandscape: ReturnType<typeof vi.fn>
} {
  const paperDigest = vi.fn((paperId: string, rootId?: string) => ({ paperId, rootId }))
  const researchLandscape = vi.fn((request: unknown) => request)
  const service = { paperDigest, researchLandscape }
  const mainFrame = {}
  const webContents = { isDestroyed: () => false, mainFrame }
  const mainWindow = { isDestroyed: () => false, webContents }
  electronMocks.fromWebContents.mockReturnValue(mainWindow)
  registerIpc(
    service as unknown as LibraryService,
    {} as AgentRelaySetupService,
    {} as AgentTerminalService,
    () => mainWindow as never
  )
  return {
    event: { sender: webContents, senderFrame: mainFrame },
    paperDigest,
    researchLandscape
  }
}

describe('research insight IPC validation', () => {
  beforeEach(() => {
    electronMocks.handlers.clear()
    vi.clearAllMocks()
  })

  it('normalizes paper and root identifiers before forwarding a digest request', () => {
    const service = register()

    expect(handler(IPC.insightsPaper)(service.event, '  paper-one  ', '  root-one  ')).toEqual({
      paperId: 'paper-one',
      rootId: 'root-one'
    })
    expect(service.paperDigest).toHaveBeenCalledWith('paper-one', 'root-one')
    expect(() => handler(IPC.insightsPaper)(service.event, '', undefined)).toThrow(/paper is required/i)
    expect(() => handler(IPC.insightsPaper)(service.event, 'x'.repeat(201), undefined)).toThrow(/too long/i)
  })

  it('accepts only a bounded landscape scope and limit', () => {
    const service = register()

    expect(handler(IPC.insightsLandscape)(service.event, { rootId: ' root-one ', limit: 25.9 })).toEqual({
      rootId: 'root-one',
      limit: 25
    })
    expect(service.researchLandscape).toHaveBeenCalledWith({ rootId: 'root-one', limit: 25 })
    expect(handler(IPC.insightsLandscape)(service.event, undefined)).toEqual({})
    expect(() => handler(IPC.insightsLandscape)(service.event, { limit: 0 })).toThrow(/between 1 and 200/i)
    expect(() => handler(IPC.insightsLandscape)(service.event, { limit: 201 })).toThrow(/between 1 and 200/i)
    expect(() => handler(IPC.insightsLandscape)(service.event, { limit: Number.NaN })).toThrow(/finite number/i)
    expect(() => handler(IPC.insightsLandscape)(service.event, { rootId: '' })).toThrow(/research folder is required/i)
    expect(() => handler(IPC.insightsLandscape)(service.event, { unexpected: true })).toThrow(/unsupported field/i)
    expect(() => handler(IPC.insightsLandscape)(service.event, [])).toThrow(/must be an object/i)
  })
})
