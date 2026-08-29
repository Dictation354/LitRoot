import { constants } from 'node:fs'
import { copyFile, lstat, mkdir } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type {
  MetadataUpdateRequest,
  NoteKind,
  PaperDetail,
  PaperExportExecuteRequest,
  PaperExportPlan,
  PaperExportRequest,
  PaperExportResult,
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
import { readPaperAsset, validatedImageFileInside, type AssetPayload } from './assets.js'
import { candidateAssetPath } from './paper-markdown.js'
import { canonicalDirectory, canonicalFileInside, isPathInside, portableRelativePath } from './safe-fs.js'
import type { PaperFetchCommand } from './paper-fetch-command.js'

interface ExportEntry {
  relativePath: string
  sourcePath: string
  kind: 'paper' | 'image'
}

async function pathKind(path: string): Promise<'missing' | 'file' | 'directory' | 'unsafe'> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return 'unsafe'
    if (info.isFile()) return 'file'
    if (info.isDirectory()) return 'directory'
    return 'unsafe'
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 'missing'
    throw error
  }
}

async function validateExportTarget(root: string, target: string): Promise<void> {
  if (!isPathInside(root, target) || target === root) {
    throw new LitRootError('invalid_export_path', '导出目标越出所选目录。')
  }
  const parts = relative(root, dirname(target)).split(/[\\/]/).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = resolve(current, part)
    const kind = await pathKind(current)
    if (kind === 'missing') break
    if (kind !== 'directory') {
      throw new LitRootError('unsafe_export_target', '导出目标包含符号链接或非目录路径。')
    }
  }
  const kind = await pathKind(target)
  if (kind === 'directory' || kind === 'unsafe') {
    throw new LitRootError('unsafe_export_target', '导出目标是目录、符号链接或特殊文件。')
  }
}

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
    paperFetchCommand?: string | PaperFetchCommand
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
      paperFetchCommand
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

  markPaperOpened(paperId: string): string {
    const openedAt = this.database.markOpened(paperId)
    if (!openedAt) throw new LitRootError('paper_not_found', '论文不存在。', 404)
    this.events.emit({ type: 'papers.changed', projectId: this.layout.id, at: openedAt })
    return openedAt
  }

  async planExport(request: PaperExportRequest): Promise<PaperExportPlan> {
    const destination = await canonicalDirectory(request.destination)
    const entries = await this.exportEntries(request.paperIds, request.includeImages)
    const conflicts: string[] = []
    for (const entry of entries) {
      const target = resolve(destination, entry.relativePath)
      await validateExportTarget(destination, target)
      if (await pathKind(target) === 'file') conflicts.push(entry.relativePath)
    }
    return { files: entries.map((entry) => entry.relativePath), conflicts }
  }

  async exportPapers(request: PaperExportExecuteRequest): Promise<PaperExportResult> {
    const destination = await canonicalDirectory(request.destination)
    const entries = await this.exportEntries(request.paperIds, request.includeImages)
    const approved = new Set(request.approvedConflicts)
    for (const entry of entries) {
      const target = resolve(destination, entry.relativePath)
      await validateExportTarget(destination, target)
      if (await pathKind(target) === 'file' && !approved.has(entry.relativePath)) {
        throw new LitRootError('export_conflict', `导出目标已存在：${entry.relativePath}`, 409)
      }
    }

    const result: PaperExportResult = { papers: 0, images: 0, files: 0, failures: [] }
    for (const entry of entries) {
      const target = resolve(destination, entry.relativePath)
      try {
        await mkdir(dirname(target), { recursive: true })
        await validateExportTarget(destination, target)
        await copyFile(
          entry.sourcePath,
          target,
          approved.has(entry.relativePath) ? 0 : constants.COPYFILE_EXCL
        )
        result.files += 1
        result[entry.kind === 'paper' ? 'papers' : 'images'] += 1
      } catch (error) {
        result.failures.push({
          relativePath: entry.relativePath,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return result
  }

  private async exportEntries(paperIds: string[], includeImages: boolean): Promise<ExportEntry[]> {
    const entries = new Map<string, ExportEntry>()
    for (const paperId of paperIds) {
      const paper = this.database.get(paperId)
      const filePath = this.database.filePath(paperId)
      if (!paper || !filePath) throw new LitRootError('paper_not_found', '论文不存在。', 404)
      const markdown = await canonicalFileInside(this.layout.root, filePath)
      if (!markdown) throw new LitRootError('invalid_paper_path', '论文文件不存在或越出项目边界。')
      const paperRelative = portableRelativePath(relative(this.layout.root, filePath))
      if (!paperRelative || paperRelative.startsWith('../')) {
        throw new LitRootError('invalid_paper_path', '论文文件越出项目边界。')
      }
      entries.set(paperRelative, { relativePath: paperRelative, sourcePath: markdown, kind: 'paper' })
      if (!includeImages) continue
      for (const source of paper.assetPaths) {
        const candidate = candidateAssetPath(filePath, source)
        if (!candidate) continue
        const image = await validatedImageFileInside(this.layout.root, candidate)
        if (!image) continue
        const imageRelative = portableRelativePath(relative(this.layout.root, candidate))
        if (!imageRelative || imageRelative.startsWith('../')) continue
        entries.set(imageRelative, { relativePath: imageRelative, sourcePath: image, kind: 'image' })
      }
    }
    return [...entries.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath))
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
