import { app, dialog, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type {
  CreateFetchRunRequest,
  MetadataUpdateRequest,
  NoteReadRequest,
  NoteWriteRequest,
  PaperSearchRequest,
  ProjectSummary,
  ServiceEvent
} from '../shared/contracts.js'
import { atomicWriteFile } from '../service/safe-fs.js'
import { WslServiceManager } from './wsl-manager.js'

interface ConnectionRecord {
  projectId: string
  distribution: string
  path: string
  name: string
}

interface ConnectionDocument {
  schemaVersion: 1
  projects: ConnectionRecord[]
}

function parseConnections(value: unknown): ConnectionRecord[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const projects = (value as Record<string, unknown>).projects
  if (!Array.isArray(projects)) return []
  return projects.flatMap((item): ConnectionRecord[] => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    if (
      typeof record.projectId !== 'string' ||
      typeof record.distribution !== 'string' ||
      typeof record.path !== 'string' ||
      typeof record.name !== 'string'
    ) return []
    return [{
      projectId: record.projectId,
      distribution: record.distribution,
      path: record.path,
      name: record.name
    }]
  })
}

export class AppController {
  readonly wsl: WslServiceManager
  private readonly connectionsPath = join(app.getPath('userData'), 'projects.json')
  private connections: ConnectionRecord[] = []

  constructor(onEvent: (event: ServiceEvent) => void) {
    this.wsl = new WslServiceManager(onEvent)
  }

  async start(): Promise<void> {
    try {
      this.connections = parseConnections(JSON.parse(await readFile(this.connectionsPath, 'utf8')))
    } catch {
      this.connections = []
    }
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const grouped = new Map<string, ConnectionRecord[]>()
    for (const connection of this.connections) {
      grouped.set(connection.distribution, [
        ...(grouped.get(connection.distribution) ?? []),
        connection
      ])
    }
    const summaries: ProjectSummary[] = []
    for (const [distribution, connections] of grouped) {
      try {
        const client = await this.wsl.client(distribution)
        const remote = new Map((await client.listProjects()).map((project) => [project.id, project]))
        for (const connection of connections) {
          const project = remote.get(connection.projectId)
          summaries.push(project
            ? { ...project, distribution }
            : {
                id: connection.projectId,
                name: connection.name,
                path: connection.path,
                distribution,
                status: 'error',
                error: '项目未在该 WSL 服务中注册，请重新连接。',
                paperCount: 0,
                issueCount: 0,
                years: [],
                lastScannedAt: null
              })
        }
      } catch (error) {
        for (const connection of connections) {
          summaries.push({
            id: connection.projectId,
            name: connection.name,
            path: connection.path,
            distribution,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            paperCount: 0,
            issueCount: 0,
            years: [],
            lastScannedAt: null
          })
        }
      }
    }
    return summaries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  }

  async addProject(distribution: string, path: string, name?: string): Promise<ProjectSummary> {
    const client = await this.wsl.client(distribution)
    const project = await client.registerProject(path, name)
    this.connections = this.connections.filter((item) => item.projectId !== project.id)
    this.connections.push({
      projectId: project.id,
      distribution,
      path: project.path,
      name: project.name
    })
    await this.persist()
    return { ...project, distribution }
  }

  async removeProject(projectId: string): Promise<void> {
    const connection = this.connection(projectId)
    await (await this.wsl.client(connection.distribution)).removeProject(projectId)
    this.connections = this.connections.filter((item) => item.projectId !== projectId)
    await this.persist()
  }

  async pickProjectPath(window: BrowserWindow, distribution: string): Promise<string | null> {
    const defaultPath = process.platform === 'win32'
      ? `\\\\wsl.localhost\\${distribution}\\`
      : undefined
    const result = await dialog.showOpenDialog(window, {
      title: '选择 LitRoot 项目目录',
      buttonLabel: '选择项目',
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath ? { defaultPath } : {})
    })
    const selected = result.filePaths[0]
    if (result.canceled || !selected) return null
    return this.wsl.toWslPath(distribution, selected)
  }

  clientFor(projectId: string) {
    const connection = this.connection(projectId)
    return this.wsl.client(connection.distribution)
  }

  scan(projectId: string) {
    return this.clientFor(projectId).then((client) => client.scan(projectId))
  }

  search(request: PaperSearchRequest) {
    return this.clientFor(request.projectId).then((client) => client.search(request))
  }

  getPaper(projectId: string, paperId: string) {
    return this.clientFor(projectId).then((client) => client.getPaper(projectId, paperId))
  }

  updateMetadata(request: MetadataUpdateRequest) {
    return this.clientFor(request.projectId).then((client) => client.updateMetadata(request))
  }

  readNote(request: NoteReadRequest) {
    return this.clientFor(request.projectId).then((client) => client.readNote(request))
  }

  writeNote(request: NoteWriteRequest) {
    return this.clientFor(request.projectId).then((client) => client.writeNote(request))
  }

  createFetch(request: CreateFetchRunRequest) {
    return this.clientFor(request.projectId).then((client) => client.createFetch(request))
  }

  listFetch(projectId: string) {
    return this.clientFor(projectId).then((client) => client.listFetch(projectId))
  }

  getFetch(projectId: string, runId: string) {
    return this.clientFor(projectId).then((client) => client.getFetch(projectId, runId))
  }

  cancelFetch(projectId: string, runId: string) {
    return this.clientFor(projectId).then((client) => client.cancelFetch(projectId, runId))
  }

  resumeFetch(projectId: string, runId: string) {
    return this.clientFor(projectId).then((client) => client.resumeFetch(projectId, runId))
  }

  asset(projectId: string, paperId: string, source: string): Promise<Response> {
    const connection = this.connection(projectId)
    return this.wsl.asset(connection.distribution, projectId, paperId, source)
  }

  async close(): Promise<void> {
    await this.wsl.close()
  }

  private connection(projectId: string): ConnectionRecord {
    const connection = this.connections.find((item) => item.projectId === projectId)
    if (!connection) throw new Error('项目未在桌面应用中注册。')
    return connection
  }

  private async persist(): Promise<void> {
    const document: ConnectionDocument = { schemaVersion: 1, projects: this.connections }
    await atomicWriteFile(this.connectionsPath, `${JSON.stringify(document, null, 2)}\n`)
  }
}
