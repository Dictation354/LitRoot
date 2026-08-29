import { app, dialog, type BrowserWindow } from 'electron'
import { join, posix } from 'node:path'
import { readFile } from 'node:fs/promises'
import type {
  CreateFetchRunRequest,
  MetadataUpdateRequest,
  NoteReadRequest,
  NoteWriteRequest,
  PaperSearchRequest,
  PaperExportResult,
  ProjectSummary,
  RuntimeTarget,
  ServiceEvent
} from '../shared/contracts.js'
import { runtimeTargetKey, runtimeTargetSchema } from '../shared/contracts.js'
import { atomicWriteFile } from '../service/safe-fs.js'
import { ServiceRuntimeManager } from './wsl-manager.js'

interface ConnectionRecord {
  projectId: string
  runtime: RuntimeTarget
  path: string
  name: string
}

interface ConnectionDocument {
  schemaVersion: 2
  projects: ConnectionRecord[]
}

export function parseConnections(value: unknown): ConnectionRecord[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const projects = (value as Record<string, unknown>).projects
  if (!Array.isArray(projects)) return []
  return projects.flatMap((item): ConnectionRecord[] => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const runtime = runtimeTargetSchema.safeParse(record.runtime)
    const legacyDistribution = typeof record.distribution === 'string'
      ? record.distribution.trim()
      : ''
    if (
      typeof record.projectId !== 'string' ||
      (!runtime.success && !legacyDistribution) ||
      typeof record.path !== 'string' ||
      typeof record.name !== 'string'
    ) return []
    return [{
      projectId: record.projectId,
      runtime: runtime.success ? runtime.data : { kind: 'wsl', distribution: legacyDistribution },
      path: record.path,
      name: record.name
    }]
  })
}

export class AppController {
  readonly runtimes: ServiceRuntimeManager
  private readonly connectionsPath = join(app.getPath('userData'), 'projects.json')
  private connections: ConnectionRecord[] = []

  constructor(onEvent: (event: ServiceEvent) => void) {
    this.runtimes = new ServiceRuntimeManager(onEvent)
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
      const key = runtimeTargetKey(connection.runtime)
      grouped.set(key, [
        ...(grouped.get(key) ?? []),
        connection
      ])
    }
    const summaries: ProjectSummary[] = []
    for (const connections of grouped.values()) {
      const runtime = connections[0]!.runtime
      try {
        const client = await this.runtimes.client(runtime)
        const remote = new Map((await client.listProjects()).map((project) => [project.id, project]))
        for (const connection of connections) {
          const project = remote.get(connection.projectId)
          summaries.push(project
            ? { ...project, runtime }
            : {
                id: connection.projectId,
                name: connection.name,
                path: connection.path,
                runtime,
                status: 'error',
                error: '项目未在该运行环境中注册，请重新连接。',
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
            runtime,
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

  async addProject(runtime: RuntimeTarget, path: string, name?: string): Promise<ProjectSummary> {
    const client = await this.runtimes.client(runtime)
    const project = await client.registerProject(path, name)
    this.connections = this.connections.filter((item) => item.projectId !== project.id)
    this.connections.push({
      projectId: project.id,
      runtime,
      path: project.path,
      name: project.name
    })
    await this.persist()
    return { ...project, runtime }
  }

  async removeProject(projectId: string): Promise<void> {
    const connection = this.connection(projectId)
    await (await this.runtimes.client(connection.runtime)).removeProject(projectId)
    this.connections = this.connections.filter((item) => item.projectId !== projectId)
    await this.persist()
  }

  async pickProjectPath(window: BrowserWindow, runtime: RuntimeTarget): Promise<string | null> {
    const defaultPath = runtime.kind === 'wsl'
      ? `\\\\wsl.localhost\\${runtime.distribution}\\`
      : undefined
    const result = await dialog.showOpenDialog(window, {
      title: '选择 LitRoot 项目目录',
      buttonLabel: '选择项目',
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath ? { defaultPath } : {})
    })
    const selected = result.filePaths[0]
    if (result.canceled || !selected) return null
    return this.runtimes.toServicePath(runtime, selected)
  }

  clientFor(projectId: string) {
    const connection = this.connection(projectId)
    return this.runtimes.client(connection.runtime)
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

  markPaperOpened(projectId: string, paperId: string) {
    return this.clientFor(projectId).then((client) => client.markPaperOpened(projectId, paperId))
  }

  async paperHostPath(projectId: string, paperId: string): Promise<string> {
    const connection = this.connection(projectId)
    const paper = await (await this.runtimes.client(connection.runtime)).getPaper(projectId, paperId)
    const relativePath = posix.normalize(paper.relativePath.replaceAll('\\', '/'))
    if (
      relativePath === '..' || relativePath.startsWith('../') || posix.isAbsolute(relativePath) ||
      !relativePath.startsWith('papers/')
    ) throw new Error('论文路径无效。')
    const servicePath = connection.runtime.kind === 'local'
      ? join(connection.path, ...relativePath.split('/'))
      : posix.join(connection.path, relativePath)
    return this.runtimes.toHostPath(connection.runtime, servicePath)
  }

  async exportPapers(
    window: BrowserWindow,
    projectId: string,
    paperIds: string[],
    includeImages: boolean
  ): Promise<PaperExportResult | null> {
    const connection = this.connection(projectId)
    const selected = await dialog.showOpenDialog(window, {
      title: includeImages ? '导出文本和图片' : '导出文本',
      buttonLabel: '导出到此目录',
      properties: ['openDirectory', 'createDirectory']
    })
    const hostDestination = selected.filePaths[0]
    if (selected.canceled || !hostDestination) return null
    const destination = await this.runtimes.toServicePath(connection.runtime, hostDestination)
    const client = await this.runtimes.client(connection.runtime)
    const request = { projectId, paperIds, destination, includeImages }
    const plan = await client.planExport(request)
    if (plan.conflicts.length > 0) {
      const preview = plan.conflicts.slice(0, 20).join('\n')
      const confirmation = await dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['取消', '覆盖'],
        defaultId: 0,
        cancelId: 0,
        title: '确认覆盖导出文件',
        message: `${plan.conflicts.length} 个导出文件已存在。`,
        detail: `${preview}${plan.conflicts.length > 20 ? `\n…另有 ${plan.conflicts.length - 20} 个文件` : ''}`
      })
      if (confirmation.response !== 1) return null
    }
    return client.exportPapers({ ...request, approvedConflicts: plan.conflicts })
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
    return this.runtimes.asset(connection.runtime, projectId, paperId, source)
  }

  async close(): Promise<void> {
    await this.runtimes.close()
  }

  private connection(projectId: string): ConnectionRecord {
    const connection = this.connections.find((item) => item.projectId === projectId)
    if (!connection) throw new Error('项目未在桌面应用中注册。')
    return connection
  }

  private async persist(): Promise<void> {
    const document: ConnectionDocument = { schemaVersion: 2, projects: this.connections }
    await atomicWriteFile(this.connectionsPath, `${JSON.stringify(document, null, 2)}\n`)
  }
}
