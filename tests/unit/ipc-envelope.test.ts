import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { IPC } from '../../src/shared/contracts.js'
import { ServiceClientError } from '../../src/main/service-client.js'

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const webContents = { mainFrame: {} }
  const window = { webContents }
  return { handlers, webContents, window }
})

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => electron.window },
  clipboard: { writeText: vi.fn(), writeImage: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electron.handlers.set(channel, handler)
    },
    removeHandler: vi.fn()
  },
  nativeImage: { createFromBuffer: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, writeFile: vi.fn(original.writeFile) }
})

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, rmSync: vi.fn(original.rmSync) }
})

import { registerIpc, unregisterIpc } from '../../src/main/ipc/register-ipc.js'
import type { AppController } from '../../src/main/app-controller.js'

function event(): IpcMainInvokeEvent {
  return {
    sender: electron.webContents,
    senderFrame: electron.webContents.mainFrame
  } as unknown as IpcMainInvokeEvent
}

beforeEach(() => {
  electron.handlers.clear()
  vi.clearAllMocks()
})
afterEach(() => unregisterIpc())

describe('IPC result envelopes', () => {
  it('wraps successful values and serializes known service errors with details', async () => {
    const controller = {
      runtimes: { listRuntimes: vi.fn(async () => []) },
      listProjects: vi.fn(async () => []),
      scan: vi.fn(async () => {
        throw new ServiceClientError(
          'doi_conflict',
          '当前项目中已存在使用该 DOI 的论文。',
          409,
          { existingPaperId: 'paper_aaaaaaaaaaaaaaaaaaaaaaaa' }
        )
      })
    } as unknown as AppController
    registerIpc(controller, () => [electron.window] as never, vi.fn())

    await expect(electron.handlers.get(IPC.projectsList)?.(event())).resolves.toEqual({
      ok: true,
      value: []
    })
    await expect(electron.handlers.get(IPC.projectsScan)?.(
      event(),
      'project_bbbbbbbbbbbbbbbbbbbbbbbb'
    )).resolves.toEqual({
      ok: false,
      error: {
        code: 'doi_conflict',
        message: '当前项目中已存在使用该 DOI 的论文。',
        details: { existingPaperId: 'paper_aaaaaaaaaaaaaaaaaaaaaaaa' }
      }
    })
  })

  it('maps unknown failures to internal_error without exposing a stack', async () => {
    const controller = {
      runtimes: { listRuntimes: vi.fn(async () => []) },
      removeProject: vi.fn(async () => { throw new Error('磁盘操作失败。') })
    } as unknown as AppController
    registerIpc(controller, () => [electron.window] as never, vi.fn())

    const result = await electron.handlers.get(IPC.projectsRemove)?.(
      event(),
      'project_bbbbbbbbbbbbbbbbbbbbbbbb'
    )
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal_error', message: '磁盘操作失败。' }
    })
    expect(JSON.stringify(result)).not.toContain('stack')
  })
})

describe('opening paper images', () => {
  const projectId = 'project_aaaaaaaaaaaaaaaaaaaaaaaa'
  const paperId = 'paper_bbbbbbbbbbbbbbbbbbbbbbbb'
  const source = 'assets/结果 ①.png'
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  function registerAsset(response: Response) {
    const asset = vi.fn(async () => response)
    registerIpc({ asset } as unknown as AppController, () => [electron.window] as never, vi.fn())
    return asset
  }

  function openImage(invokeEvent = event(), imageSource = source) {
    return electron.handlers.get(IPC.papersOpenImage)?.(invokeEvent, projectId, paperId, imageSource)
  }

  it.each([
    ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/gif', '.gif'],
    ['image/webp', '.webp'], ['image/avif', '.avif']
  ])('opens original bytes with the extension for %s and cleans up on exit', async (contentType, extension) => {
    const asset = registerAsset(new Response(bytes, { headers: { 'content-type': contentType } }))
    await expect(openImage()).resolves.toEqual({ ok: true, value: null })
    expect(asset).toHaveBeenCalledWith(projectId, paperId, source)
    const path = vi.mocked(shell.openPath).mock.calls[0]![0]
    expect(extname(path)).toBe(extension)
    expect(await readFile(path)).toEqual(bytes)
    unregisterIpc()
    expect(existsSync(dirname(path))).toBe(false)
  })

  it('keeps successive opens in separate directories until exit', async () => {
    const asset = registerAsset(new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    await openImage()
    asset.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    await openImage()
    const paths = vi.mocked(shell.openPath).mock.calls.map(([path]) => path)
    expect(paths).toHaveLength(2)
    expect(dirname(paths[0]!)).not.toBe(dirname(paths[1]!))
    expect(paths.every((path) => existsSync(path))).toBe(true)
    unregisterIpc()
    expect(paths.every((path) => !existsSync(dirname(path)))).toBe(true)
  })

  it.each([
    [404, 'image/png'], [200, 'text/html'], [200, 'constructor']
  ])('rejects unavailable or unsupported assets (%s, %s)', async (status, contentType) => {
    registerAsset(new Response(bytes, { status, headers: { 'content-type': contentType } }))
    await expect(openImage()).resolves.toMatchObject({ ok: false })
    expect(writeFile).not.toHaveBeenCalled()
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('rejects untrusted frames and invalid source parameters before reading an asset', async () => {
    const asset = registerAsset(new Response(bytes))
    await expect(openImage({ ...event(), senderFrame: {} } as IpcMainInvokeEvent))
      .resolves.toMatchObject({ ok: false })
    await expect(openImage(event(), '')).resolves.toMatchObject({ ok: false })
    expect(asset).not.toHaveBeenCalled()
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('cleans up when writing the temporary file fails', async () => {
    registerAsset(new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('Disk full'))
    await expect(openImage()).resolves.toMatchObject({ ok: false, error: { message: 'Disk full' } })
    const path = String(vi.mocked(writeFile).mock.calls[0]![0])
    expect(existsSync(dirname(path))).toBe(false)
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it.each(['message', 'rejection'])('reports shell failures (%s) and removes the temporary file', async (failure) => {
    registerAsset(new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    if (failure === 'message') vi.mocked(shell.openPath).mockResolvedValueOnce('No default viewer')
    else vi.mocked(shell.openPath).mockRejectedValueOnce(new Error('No default viewer'))
    await expect(openImage()).resolves.toMatchObject({ ok: false })
    const path = vi.mocked(shell.openPath).mock.calls[0]![0]
    expect(existsSync(dirname(path))).toBe(false)
  })

  it('does not block exit when a viewer prevents deletion', async () => {
    registerAsset(new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    await openImage()
    const directory = dirname(vi.mocked(shell.openPath).mock.calls[0]![0])
    vi.mocked(rmSync).mockImplementationOnce(() => { throw new Error('File in use') })
    try {
      expect(() => unregisterIpc()).not.toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})


it('validates item cancellation indexes before forwarding over IPC', async () => {
  const cancelFetchItem = vi.fn(async () => ({ state: 'cancelling' }))
  registerIpc({ cancelFetchItem } as unknown as AppController, () => [electron.window] as never, async () => undefined)
  const handler = electron.handlers.get(IPC.fetchCancelItem)!
  await handler(event(), 'project_aaaaaaaaaaaaaaaaaaaaaaaa', 'run_bbbbbbbbbbbbbbbbbbbbbbbb', 2)
  expect(cancelFetchItem).toHaveBeenCalledWith('project_aaaaaaaaaaaaaaaaaaaaaaaa', 'run_bbbbbbbbbbbbbbbbbbbbbbbb', 2)
  for (const index of [0, 51, 1.5, '1']) await handler(event(), 'project_aaaaaaaaaaaaaaaaaaaaaaaa', 'run_bbbbbbbbbbbbbbbbbbbbbbbb', index)
  expect(cancelFetchItem).toHaveBeenCalledTimes(1)
})
