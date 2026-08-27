import type {
  MetadataUpdateRequest,
  NoteKind,
  PaperDetail,
  PaperSearchRequest,
  PaperSearchResult,
  ProjectSummary,
  ScanResult
} from '../shared/contracts.js'
import { MetadataConflictError, LitRootError } from './errors.js'
import { normalizeDoi } from './identity.js'
import { applyMetadataPatch, MetadataStore } from './metadata.js'
import { NoteStore } from './notes.js'
import { ProjectDatabase } from './project-database.js'
import type { ProjectLayout } from './project-layout.js'
import { ProjectScanner } from './scanner.js'
import type { ServiceEventBus } from './events.js'
import { ProjectWatcher } from './watcher.js'
import { PaperFetchRunner } from './fetch-runner.js'
import { readPaperAsset, type AssetPayload } from './assets.js'

export class LitRootProject {
  private readonly database: ProjectDatabase
  private readonly metadata: MetadataStore
  private readonly scanner: ProjectScanner
  private readonly watcher: ProjectWatcher
  private readonly notes: NoteStore
  readonly fetch: PaperFetchRunner
  private status: ProjectSummary['status'] = 'connecting'
  private error: string | null = null

  constructor(
    readonly layout: ProjectLayout,
    private readonly events: ServiceEventBus,
    paperFetchExecutable?: string
  ) {
    this.database = new ProjectDatabase(layout.database)
    this.metadata = new MetadataStore(layout.metadata)
    this.scanner = new ProjectScanner(layout, this.database, this.metadata, events)
    this.watcher = new ProjectWatcher(layout, this.scanner, events)
    this.notes = new NoteStore(layout, this.database)
    this.fetch = new PaperFetchRunner(
      layout,
      this.database,
      this.scanner,
      events,
      paperFetchExecutable
    )
  }

  async start(): Promise<void> {
    try {
      this.status = 'scanning'
      await this.fetch.load()
      await this.scanner.scan()
      await this.watcher.start()
      this.error = null
      this.status = this.database.summary().paperCount > 0 ? 'ready' : 'empty'
    } catch (error) {
      this.status = 'error'
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  summary(): ProjectSummary {
    const summary = this.database.summary()
    return {
      id: this.layout.id,
      name: this.layout.name,
      path: this.layout.root,
      status: this.status,
      error: this.error,
      paperCount: summary.paperCount,
      issueCount: summary.issueCount,
      years: summary.years,
      lastScannedAt: summary.lastScannedAt
    }
  }

  async scan(): Promise<ScanResult> {
    this.status = 'scanning'
    try {
      const result = await this.scanner.scan()
      this.status = this.database.summary().paperCount > 0 ? 'ready' : 'empty'
      this.error = null
      return result
    } catch (error) {
      this.status = 'error'
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  search(request: PaperSearchRequest): PaperSearchResult {
    return this.database.search(request)
  }

  getPaper(paperId: string): PaperDetail | null {
    return this.database.get(paperId)
  }

  async updateMetadata(request: MetadataUpdateRequest): Promise<PaperDetail> {
    const current = this.database.get(request.paperId)
    if (!current) throw new LitRootError('paper_not_found', '论文不存在。', 404)
    const next = applyMetadataPatch(current.overrides, request.patch ?? {}, request.restore ?? [])
    const normalizedDoi = next.doi === undefined
      ? current.fetchedMetadata.doi
      : normalizeDoi(next.doi) ?? ''
    if (normalizedDoi) {
      const conflict = this.database.findByDoi(normalizedDoi, request.paperId)
      if (conflict) throw new MetadataConflictError(conflict.id)
    }
    await this.metadata.write(request.paperId, current.relativePath, next)
    const detail = this.database.updateOverrides(request.paperId, next)
    if (!detail) throw new LitRootError('paper_not_found', '论文不存在。', 404)
    this.events.emit({ type: 'papers.changed', projectId: this.layout.id, at: new Date().toISOString() })
    return detail
  }

  async readNote(kind: NoteKind, paperId?: string) {
    return this.notes.read(kind, paperId)
  }

  async writeNote(kind: NoteKind, content: string, expectedRevision: string, paperId?: string) {
    const note = await this.notes.write(kind, content, expectedRevision, paperId)
    this.events.emit({
      type: 'note.changed',
      projectId: this.layout.id,
      at: new Date().toISOString(),
      kind,
      paperId: kind === 'paper' ? (paperId ?? null) : null,
      revision: note.revision
    })
    return note
  }

  readAsset(paperId: string, source: string): Promise<AssetPayload | null> {
    return readPaperAsset(this.layout, this.database, paperId, source)
  }

  async close(): Promise<void> {
    await this.watcher.close()
    await this.fetch.close()
    await this.scanner.close()
    this.database.close()
  }
}
