import { basename } from 'node:path'
import type {
  IndexIssue,
  LibrarySummary,
  PaperDetail,
  PaperDigest,
  PaperListItem,
  PaperSearchRequest,
  PaperUserDraft,
  PaperUserDraftInput,
  PaperUserState,
  PaperUserStatePatch,
  RootSummary,
  ResearchLandscape,
  ResearchLandscapeRequest,
  ScanResult
} from '../../shared/contracts.js'
import {
  buildPaperDigest,
  buildResearchLandscape,
  MAX_LANDSCAPE_PAPERS
} from '../analysis/research-insights.js'
import { LibraryDatabase, type CatalogPaperIdentity } from '../db/library-database.js'
import { PaperUserDatabase } from '../db/paper-user-database.js'
import { RootScanner } from '../ingest/scanner.js'
import { validateRootPath } from '../ingest/walk.js'
import { RootWatcher } from '../ingest/watch.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class LibraryService {
  private readonly scanner: RootScanner
  private readonly watcher: RootWatcher
  private closePromise: Promise<void> | null = null

  constructor(
    readonly database: LibraryDatabase,
    readonly userDatabase: PaperUserDatabase = new PaperUserDatabase()
  ) {
    this.scanner = new RootScanner(database)
    this.watcher = new RootWatcher(this.scanner, (rootId, error) => {
      this.database.updateRootStatus(rootId, 'error', `Folder watcher failed: ${errorMessage(error)}`)
    })
  }

  initialize(): void {
    for (const root of this.database.listRoots()) {
      this.watcher.watch(root.id, root.path)
      void this.scanner.scan(root.id).catch(() => undefined)
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = (async () => {
      try {
        await this.watcher.close()
      } finally {
        await this.scanner.cancelAll()
        try {
          this.database.close()
        } finally {
          this.userDatabase.close()
        }
      }
    })()
    return this.closePromise
  }

  summary(): LibrarySummary {
    const identities = this.database.listPaperIdentities()
    this.userDatabase.reconcilePaperIdentities(identities)
    return {
      ...this.database.summary(),
      ...this.userDatabase.counts(identities.map((identity) => identity.paperId))
    }
  }

  listRoots(): RootSummary[] {
    return this.database.listRoots()
  }

  async addRoot(path: string, label?: string): Promise<RootSummary> {
    const canonicalPath = await validateRootPath(path)
    const root = this.database.registerRoot(canonicalPath, label?.trim() || basename(canonicalPath))
    this.watcher.watch(root.id, root.path)
    void this.scanner.scan(root.id).catch(() => undefined)
    return root
  }

  async rescan(rootId: string): Promise<ScanResult> {
    return this.scanner.scan(rootId)
  }

  async removeRoot(rootId: string): Promise<void> {
    try {
      await this.watcher.unwatch(rootId)
    } finally {
      await this.scanner.cancel(rootId)
    }
    this.database.removeRoot(rootId)
  }

  searchPapers(request: PaperSearchRequest): PaperListItem[] {
    if (request.userView) {
      this.userDatabase.reconcilePaperIdentities(this.database.listPaperIdentities())
    }
    const paperIds = request.userView ? this.userDatabase.listPaperIds(request.userView) : undefined
    const papers = this.database.searchPapers(request, paperIds)
    this.userDatabase.reconcilePaperIdentities(
      papers.flatMap((paper) => {
        const identity = this.database.getPaperIdentity(paper.id)
        return identity ? [identity] : []
      })
    )
    const summaries = this.userDatabase.getPaperSummaries(papers.map((paper) => paper.id))
    return papers.map((paper) => ({
      ...paper,
      userState: summaries.get(paper.id) ?? paper.userState
    }))
  }

  getPaper(paperId: string, rootId?: string): PaperDetail | null {
    const paper = this.database.getPaper(paperId, rootId)
    if (!paper) return null
    const identity = this.database.getPaperIdentity(paper.id)
    if (identity) this.userDatabase.reconcilePaperIdentities([identity])
    return {
      ...paper,
      userState: this.userDatabase.getPaperState(paper.id),
      userDraft: this.userDatabase.getPaperDraft(paper.id)
    }
  }

  updateUserState(paperId: string, patch: PaperUserStatePatch): PaperUserState {
    const identity = this.requirePaperIdentity(paperId)
    this.userDatabase.reconcilePaperIdentities([identity])
    return this.userDatabase.updatePaperState(paperId, patch, identity)
  }

  saveDraft(paperId: string, draft: PaperUserDraftInput): PaperUserDraft {
    const identity = this.requirePaperIdentity(paperId)
    this.userDatabase.reconcilePaperIdentities([identity])
    return this.userDatabase.savePaperDraft(paperId, draft, identity)
  }

  discardDraft(paperId: string): void {
    this.userDatabase.discardPaperDraft(paperId)
  }

  commitDraft(paperId: string): PaperUserState {
    const identity = this.requirePaperIdentity(paperId)
    this.userDatabase.reconcilePaperIdentities([identity])
    return this.userDatabase.commitPaperDraft(paperId, identity)
  }

  markOpened(paperId: string): PaperUserState {
    const identity = this.requirePaperIdentity(paperId)
    this.userDatabase.reconcilePaperIdentities([identity])
    return this.userDatabase.markPaperOpened(paperId, identity)
  }

  paperDigest(paperId: string, rootId?: string): PaperDigest {
    if (rootId && !this.database.getRoot(rootId)) {
      throw new Error('This research folder is no longer registered.')
    }
    const paper = this.database.getAnalysisPaper(paperId, rootId)
    if (!paper) {
      throw new Error(
        rootId
          ? 'This paper is not available in the selected research folder.'
          : 'This paper is no longer available in PaperRelay.'
      )
    }
    return buildPaperDigest(paper)
  }

  researchLandscape(request: ResearchLandscapeRequest = {}): ResearchLandscape {
    const rootId = request.rootId
    if (rootId && !this.database.getRoot(rootId)) {
      throw new Error('This research folder is no longer registered.')
    }
    const requestedLimit =
      typeof request.limit === 'number' && Number.isFinite(request.limit)
        ? request.limit
        : MAX_LANDSCAPE_PAPERS
    const limit = Math.min(
      MAX_LANDSCAPE_PAPERS,
      Math.max(1, Math.trunc(requestedLimit))
    )
    const paperCount = this.database.countAnalysisPapers(rootId)
    const papers = this.database.listAnalysisPapers(rootId, limit)
    return buildResearchLandscape(papers, { paperCount, rootId: rootId ?? null })
  }

  listIssues(rootId?: string): IndexIssue[] {
    return this.database.listIssues(rootId)
  }

  resolveLocationPath(locationId: string): string | null {
    return this.database.resolveLocationPath(locationId)
  }

  resolveAssetPath(paperId: string, assetIndex: number, rootId?: string): string | null {
    return this.database.resolveAssetPath(paperId, assetIndex, rootId)
  }

  private requirePaperIdentity(paperId: string): CatalogPaperIdentity {
    const identity = this.database.getPaperIdentity(paperId)
    if (!identity) {
      throw new Error('This paper is no longer available in PaperRelay.')
    }
    return identity
  }
}
