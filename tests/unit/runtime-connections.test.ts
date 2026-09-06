import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtimeMocks = vi.hoisted(() => ({
  client: vi.fn(),
  listRuntimes: vi.fn()
}))
const atomicWriteFileMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/litroot-test' },
  dialog: {}
}))

vi.mock('../../src/main/wsl-manager.js', () => ({
  ServiceRuntimeManager: class {
    readonly client = runtimeMocks.client
    readonly listRuntimes = runtimeMocks.listRuntimes
  }
}))

vi.mock('../../src/service/safe-fs.js', () => ({
  atomicWriteFile: atomicWriteFileMock
}))

import { AppController, parseConnections } from '../../src/main/app-controller.js'

const wslConnection = {
  projectId: 'project_aaaaaaaaaaaaaaaaaaaaaaaa',
  runtime: { kind: 'wsl', distribution: 'Ubuntu' } as const,
  path: '/home/me/research',
  name: 'Research'
}

beforeEach(() => {
  runtimeMocks.client.mockReset()
  runtimeMocks.listRuntimes.mockReset()
  atomicWriteFileMock.mockReset()
})

describe('runtime connection persistence', () => {
  it('starts project listing for different runtimes concurrently and keeps name sorting', async () => {
    const localConnection = {
      projectId: 'project_bbbbbbbbbbbbbbbbbbbbbbbb',
      runtime: { kind: 'local' } as const,
      path: '/data/zulu',
      name: 'Zulu'
    }
    let resolveLocal!: (client: { listProjects(): Promise<unknown[]> }) => void
    let resolveWsl!: (client: { listProjects(): Promise<unknown[]> }) => void
    runtimeMocks.client.mockImplementation((target: { kind: string }) => new Promise((resolve) => {
      if (target.kind === 'local') resolveLocal = resolve
      else resolveWsl = resolve
    }))
    const controller = new AppController(() => undefined)
    Reflect.set(controller, 'connections', [localConnection, wslConnection])

    const pending = controller.listProjects()
    await vi.waitFor(() => expect(runtimeMocks.client).toHaveBeenCalledTimes(2))
    resolveLocal({ listProjects: async () => [{
      id: localConnection.projectId,
      name: 'Zulu',
      path: localConnection.path,
      status: 'ready',
      error: null,
      paperCount: 0,
      issueCount: 0,
      years: [],
      lastScannedAt: null
    }] })
    resolveWsl({ listProjects: async () => [{
      id: wslConnection.projectId,
      name: 'Alpha',
      path: wslConnection.path,
      status: 'ready',
      error: null,
      paperCount: 0,
      issueCount: 0,
      years: [],
      lastScannedAt: null
    }] })

    await expect(pending).resolves.toMatchObject([
      { name: 'Alpha' },
      { name: 'Zulu' }
    ])
  })

  it('migrates schema v1 WSL distributions while reading', () => {
    expect(parseConnections({
      schemaVersion: 1,
      projects: [{
        projectId: 'project_aaaaaaaaaaaaaaaaaaaaaaaa',
        distribution: 'Ubuntu',
        path: '/home/me/research',
        name: 'Research'
      }]
    })).toEqual([{
      projectId: 'project_aaaaaaaaaaaaaaaaaaaaaaaa',
      runtime: { kind: 'wsl', distribution: 'Ubuntu' },
      path: '/home/me/research',
      name: 'Research'
    }])
  })

  it('reads schema v2 local runtime records', () => {
    expect(parseConnections({
      schemaVersion: 2,
      projects: [{
        projectId: 'project_bbbbbbbbbbbbbbbbbbbbbbbb',
        runtime: { kind: 'local' },
        path: '/data/research',
        name: 'Local'
      }]
    })[0]?.runtime).toEqual({ kind: 'local' })
  })

  it('removes the desktop connection when its WSL runtime is unavailable', async () => {
    const removeProject = vi.fn().mockRejectedValue(new Error('所选 WSL 发行版不存在。'))
    runtimeMocks.client.mockResolvedValue({ removeProject })
    runtimeMocks.listRuntimes.mockResolvedValue([{
      key: 'local', label: 'Windows 本机', target: { kind: 'local' }
    }])
    const controller = new AppController(() => undefined)
    Reflect.set(controller, 'connections', [wslConnection])

    await expect(controller.removeProject(wslConnection.projectId)).resolves.toBeUndefined()

    expect(Reflect.get(controller, 'connections')).toEqual([])
    expect(atomicWriteFileMock).toHaveBeenCalledWith(
      '/tmp/litroot-test/projects.json',
      `${JSON.stringify({ schemaVersion: 2, projects: [] }, null, 2)}\n`
    )
  })

  it('keeps the desktop connection when the WSL runtime remains available', async () => {
    const serviceError = new Error('LitRoot 服务启动失败。')
    runtimeMocks.client.mockRejectedValue(serviceError)
    runtimeMocks.listRuntimes.mockResolvedValue([{
      key: 'wsl:Ubuntu', label: 'WSL · Ubuntu', target: wslConnection.runtime
    }])
    const controller = new AppController(() => undefined)
    Reflect.set(controller, 'connections', [wslConnection])

    await expect(controller.removeProject(wslConnection.projectId)).rejects.toBe(serviceError)

    expect(Reflect.get(controller, 'connections')).toEqual([wslConnection])
    expect(atomicWriteFileMock).not.toHaveBeenCalled()
  })

  it('removes the service registration before persisting a normal disconnect', async () => {
    const removeProject = vi.fn().mockResolvedValue(undefined)
    runtimeMocks.client.mockResolvedValue({ removeProject })
    const controller = new AppController(() => undefined)
    Reflect.set(controller, 'connections', [wslConnection])

    await controller.removeProject(wslConnection.projectId)

    expect(removeProject).toHaveBeenCalledWith(wslConnection.projectId)
    expect(runtimeMocks.listRuntimes).not.toHaveBeenCalled()
    expect(atomicWriteFileMock).toHaveBeenCalledOnce()
  })
})
