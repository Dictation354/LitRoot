import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import type {
  CreateFetchRunRequest,
  MetadataUpdateRequest,
  NoteReadRequest,
  NoteWriteRequest,
  PaperSearchRequest,
  ProjectSummary
} from '../shared/contracts.js'
import { atomicWriteFile } from './safe-fs.js'
import { initializeProject } from './project-layout.js'
import { LitRootProject } from './project.js'
import { ServiceEventBus } from './events.js'
import { LitRootError } from './errors.js'

interface RegistryRecord {
  id: string
  path: string
}

interface RegistryDocument {
  schema_version: 1
  projects: RegistryRecord[]
}

function defaultRegistryPath(): string {
  const configRoot = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configRoot, 'litroot', 'projects.json')
}

function parseRegistry(value: unknown): RegistryDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { schema_version: 1, projects: [] }
  }
  const record = value as Record<string, unknown>
  const projects = Array.isArray(record.projects)
    ? record.projects.flatMap((item): RegistryRecord[] => {
        if (
          typeof item === 'object' && item !== null && !Array.isArray(item) &&
          typeof (item as Record<string, unknown>).id === 'string' &&
          typeof (item as Record<string, unknown>).path === 'string'
        ) {
          return [{
            id: String((item as Record<string, unknown>).id),
            path: String((item as Record<string, unknown>).path)
          }]
        }
        return []
      })
    : []
  return { schema_version: 1, projects }
}

export class ProjectRegistry {
  readonly events = new ServiceEventBus()
  private readonly projects = new Map<string, LitRootProject>()
  private readonly registryPath: string

  constructor(
    registryPath = process.env.LITROOT_REGISTRY_PATH || defaultRegistryPath(),
    private readonly paperFetchExecutable = process.env.PAPER_FETCH_BIN
  ) {
    this.registryPath = registryPath
  }

  async start(): Promise<void> {
    let records: RegistryRecord[] = []
    try {
      records = parseRegistry(JSON.parse(await readFile(this.registryPath, 'utf8'))).projects
    } catch {
      // The registry is optional on first launch. Project files remain the source of truth.
    }
    for (const record of records) {
      try {
        const layout = await initializeProject(record.path)
        if (layout.id !== record.id || this.projects.has(layout.id)) continue
        const project = new LitRootProject(layout, this.events, this.paperFetchExecutable)
        this.projects.set(layout.id, project)
        void project.start().catch(() => undefined)
      } catch {
        // One unavailable registration must not prevent other WSL projects from opening.
      }
    }
  }

  list(): ProjectSummary[] {
    return [...this.projects.values()]
      .map((project) => project.summary())
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  }

  async register(path: string, name?: string): Promise<ProjectSummary> {
    const layout = await initializeProject(path, name)
    const existing = this.projects.get(layout.id)
    if (existing) return existing.summary()
    if ([...this.projects.values()].some((project) => project.layout.root === layout.root)) {
      throw new LitRootError('project_already_registered', '该项目已经注册。', 409)
    }
    const project = new LitRootProject(layout, this.events, this.paperFetchExecutable)
    this.projects.set(layout.id, project)
    try {
      await project.start()
      await this.persist()
      return project.summary()
    } catch (error) {
      this.projects.delete(layout.id)
      await project.close().catch(() => undefined)
      throw error
    }
  }

  async remove(projectId: string): Promise<void> {
    const project = this.projects.get(projectId)
    if (!project) return
    this.projects.delete(projectId)
    await project.close()
    await this.persist()
  }

  require(projectId: string): LitRootProject {
    const project = this.projects.get(projectId)
    if (!project) throw new LitRootError('project_not_found', '项目未注册或不属于当前 WSL 服务。', 404)
    return project
  }

  search(request: PaperSearchRequest) {
    return this.require(request.projectId).search(request)
  }

  getPaper(projectId: string, paperId: string) {
    return this.require(projectId).getPaper(paperId)
  }

  updateMetadata(request: MetadataUpdateRequest) {
    return this.require(request.projectId).updateMetadata(request)
  }

  readNote(request: NoteReadRequest) {
    return this.require(request.projectId).readNote(request.kind, request.paperId)
  }

  writeNote(request: NoteWriteRequest) {
    return this.require(request.projectId).writeNote(
      request.kind,
      request.content,
      request.expectedRevision,
      request.paperId
    )
  }

  createFetch(request: CreateFetchRunRequest) {
    return this.require(request.projectId).fetch.create(request)
  }

  async close(): Promise<void> {
    await Promise.all([...this.projects.values()].map((project) => project.close()))
    this.projects.clear()
  }

  private async persist(): Promise<void> {
    const document: RegistryDocument = {
      schema_version: 1,
      projects: [...this.projects.values()].map((project) => ({
        id: project.layout.id,
        path: project.layout.root
      }))
    }
    await mkdir(dirname(this.registryPath), { recursive: true })
    await atomicWriteFile(this.registryPath, `${JSON.stringify(document, null, 2)}\n`)
  }
}
