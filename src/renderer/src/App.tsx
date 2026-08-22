import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import type {
  AgentRelaySetup,
  IndexIssue,
  InsightEvidence,
  LibrarySummary,
  PaperAsset,
  PaperDigest,
  PaperDetail,
  PaperListItem,
  PaperLocation,
  PaperRelayBridge,
  PaperSearchRequest,
  PaperSection,
  ResearchLandscape,
  RootStatus,
  RootSummary
} from '../../shared/contracts'
import { AgentRelaySheet, type AgentRelayAction } from './AgentRelaySheet'
import { AgentTerminalPanel } from './AgentTerminalPanel'
import { DetailWorkspaceLayout } from './DetailWorkspaceLayout'
import paperRelayLogo from './assets/paperrelay-app-icon.png'
import { Icon } from './icons'
import {
  type AuthorYearReferenceAlias,
  extractAuthorYearAliases,
  isReferenceSection,
  type NumberedReference,
  numberStructuredReferences,
  parseNumberedReferences,
  referenceAnchorId
} from '../../shared/citation-crossrefs'
import { readerAssets } from '../../shared/reader-assets'
import { parseMarkdownTable } from '../../shared/markdown-table'
import { isDisplayMathText, splitMathTextBlocks } from '../../shared/math-text'
import { visibleReaderSections } from '../../shared/reader-sections'
import { MathText } from './MathText'
import { NotePreview } from './NotePreview'
import { PaperDigestContent } from './PaperDigestContent'
import {
  READER_NOTES_HEADING_ID,
  READER_NOTES_PANEL_ID,
  ReaderWorkspaceLayout
} from './ReaderWorkspaceLayout'
import { ResearchRadarWorkspace } from './ResearchRadarWorkspace'
import {
  readWorkspacePanelPreferences,
  type WorkspacePanelId,
  withWorkspacePanelVisibility,
  writeWorkspacePanelPreferences
} from './panel-preferences'
import {
  WORKSPACE_LIBRARY_PANEL_ID,
  WORKSPACE_NAVIGATION_PANEL_ID,
  WORKSPACE_TERMINAL_TOGGLE_ID,
  WorkspacePanelRail
} from './WorkspacePanelRail'
import {
  EMPTY_RESOURCE_ERRORS,
  withResourceError,
  type ResourceErrorKey
} from './resource-errors'
import {
  useDurablePaperDraft,
  type DraftPersistenceStatus
} from './useDurablePaperDraft'
import {
  intentLabel,
  shouldResolveDraft,
  type WorkspaceIntent,
  type WorkspaceScopeIntent
} from './workspace-transitions'

type Scope = WorkspaceScopeIntent

type Sort = NonNullable<PaperSearchRequest['sort']>
type UserView = NonNullable<PaperSearchRequest['userView']>
type ReadingStatus = PaperListItem['userState']['readingStatus']
type PaperUserState = PaperDetail['userState']
type PaperUserStatePatch = Parameters<PaperRelayBridge['papers']['updateUserState']>[1]
type ReaderTab = 'reader' | 'digest' | 'locations'
type WorkspaceMode = 'paper' | 'radar'
type NoteMode = 'write' | 'preview'
type RelayCopyAction = AgentRelayAction | 'paper' | `root:${string}`
type UserStateAction = 'favorite' | 'reading-status' | 'notes'

interface ToastState {
  id: number
  tone: 'success' | 'error' | 'neutral'
  message: string
}

const POLL_INTERVAL = 6000
const RESULT_PAGE_SIZE = 200
const SCOPE_STORAGE_KEY = 'paperrelay.library.scope'
const SORT_STORAGE_KEY = 'paperrelay.library.sort'
const MAX_NOTE_CHARACTERS = 20_000
const MAX_TAG_INPUT_CHARACTERS = 2_000
const MAX_TAGS = 24
const MAX_TAG_CHARACTERS = 64

function paperSearchRequest(
  scope: Scope,
  query: string,
  sort: Sort,
  offset = 0
): PaperSearchRequest {
  const request: PaperSearchRequest = {
    sort,
    limit: RESULT_PAGE_SIZE + 1,
    offset
  }
  if (query) request.query = query
  if (scope.kind === 'root') request.rootId = scope.rootId
  if (scope.kind === 'attention') request.attention = true
  if (scope.kind === 'user') request.userView = scope.userView
  return request
}

function libraryRevision(summary: LibrarySummary): string {
  return JSON.stringify({
    paperCount: summary.paperCount,
    fullTextCount: summary.fullTextCount,
    issueCount: summary.issueCount,
    favoriteCount: summary.favoriteCount,
    readingListCount: summary.readingListCount,
    reviewedCount: summary.reviewedCount,
    scanning: summary.scanning,
    roots: summary.roots.map((root) => ({
      id: root.id,
      status: root.status,
      error: root.error,
      paperCount: root.paperCount,
      issueCount: root.issueCount,
      lastScannedAt: root.lastScannedAt
    }))
  })
}

function storedScope(): Scope {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(SCOPE_STORAGE_KEY) ?? 'null')
    if (value && typeof value === 'object' && 'kind' in value) {
      const candidate = value as { kind?: unknown; rootId?: unknown; userView?: unknown }
      if (candidate.kind === 'all' || candidate.kind === 'attention') return { kind: candidate.kind }
      if (
        candidate.kind === 'user' &&
        (candidate.userView === 'favorites' ||
          candidate.userView === 'reading_list' ||
          candidate.userView === 'reviewed')
      ) {
        return { kind: 'user', userView: candidate.userView }
      }
      if (candidate.kind === 'root' && typeof candidate.rootId === 'string') {
        return { kind: 'root', rootId: candidate.rootId }
      }
    }
  } catch {
    // Local preference restoration is best-effort.
  }
  return { kind: 'all' }
}

function storedSort(): Sort {
  try {
    const value = window.localStorage.getItem(SORT_STORAGE_KEY)
    if (value === 'updated' || value === 'title' || value === 'year') return value
  } catch {
    // Local preference restoration is best-effort.
  }
  return 'updated'
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [delay, value])

  return debounced
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong'
}

function formatDate(value: string | null): string {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  }).format(date)
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function relativeTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const elapsed = date.getTime() - Date.now()
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const minutes = Math.round(elapsed / 60_000)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(elapsed / 3_600_000)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  const days = Math.round(elapsed / 86_400_000)
  if (Math.abs(days) < 31) return formatter.format(days, 'day')
  return formatDate(value)
}

function contentLabel(paper: PaperListItem): string {
  if (paper.warningCount > 0) return 'Needs attention'
  if (paper.contentKind === 'fulltext') return 'Full text'
  if (paper.contentKind === 'abstract_only') return 'Abstract only'
  return 'Metadata only'
}

function paperAuthors(authors: string[]): string {
  if (authors.length === 0) return 'Unknown authors'
  if (authors.length <= 2) return authors.join(', ')
  return `${authors[0]} et al.`
}

function scopeTitle(scope: Scope, roots: RootSummary[]): string {
  if (scope.kind === 'all') return 'All Papers'
  if (scope.kind === 'attention') return 'Needs Attention'
  if (scope.kind === 'user') {
    if (scope.userView === 'favorites') return 'Favorites'
    if (scope.userView === 'reading_list') return 'Reading List'
    return 'Reviewed'
  }
  return roots.find((root) => root.id === scope.rootId)?.label ?? 'Research Folder'
}

function readingStatusLabel(status: ReadingStatus): string {
  switch (status) {
    case 'none':
      return 'No reading status'
    case 'to_read':
      return 'To read'
    case 'reading':
      return 'Reading'
    case 'reviewed':
      return 'Reviewed'
  }
}

function isInReadingList(status: ReadingStatus): boolean {
  return status === 'to_read' || status === 'reading'
}

function matchesUserView(userView: UserView, userState: PaperListItem['userState']): boolean {
  if (userView === 'favorites') return userState.favorite
  if (userView === 'reading_list') return isInReadingList(userState.readingStatus)
  return userState.readingStatus === 'reviewed'
}

function userCountDelta(current: boolean, next: boolean): number {
  return Number(next) - Number(current)
}

function summaryAfterUserStateChange(
  summary: LibrarySummary,
  previous: PaperListItem['userState'],
  next: PaperListItem['userState']
): LibrarySummary {
  return {
    ...summary,
    favoriteCount: Math.max(
      0,
      summary.favoriteCount + userCountDelta(previous.favorite, next.favorite)
    ),
    readingListCount: Math.max(
      0,
      summary.readingListCount +
        userCountDelta(
          isInReadingList(previous.readingStatus),
          isInReadingList(next.readingStatus)
        )
    ),
    reviewedCount: Math.max(
      0,
      summary.reviewedCount +
        userCountDelta(
          previous.readingStatus === 'reviewed',
          next.readingStatus === 'reviewed'
        )
    )
  }
}

function normalizeTagDraft(value: string): { tags: string[]; error: string | null } {
  const rawTags = value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
  if (rawTags.length > MAX_TAGS) {
    return { tags: [], error: `Use no more than ${MAX_TAGS} tags.` }
  }
  const longTag = rawTags.find((tag) => tag.length > MAX_TAG_CHARACTERS)
  if (longTag) {
    return {
      tags: [],
      error: `Keep each tag to ${MAX_TAG_CHARACTERS} characters or fewer.`
    }
  }

  const seen = new Set<string>()
  const tags = rawTags.filter((tag) => {
    const key = tag.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { tags, error: null }
}

function rootStatusLabel(status: RootStatus): string {
  switch (status) {
    case 'pending':
      return 'Waiting to scan'
    case 'scanning':
      return 'Scanning'
    case 'ready':
      return 'Up to date'
    case 'empty':
      return 'No papers yet'
    case 'unavailable':
      return 'Unavailable'
    case 'error':
      return 'Scan issue'
  }
}

function slug(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
  return normalized || fallback
}

export function evidenceTargetId(
  evidence: InsightEvidence,
  paper: Pick<PaperDetail, 'abstract' | 'references' | 'sections'>
): string {
  const sectionAtEvidence =
    evidence.sectionIndex === null ? null : paper.sections[evidence.sectionIndex] ?? null
  const sectionTarget = sectionAtEvidence
    ? `${slug(sectionAtEvidence.heading, 'section')}-${evidence.sectionIndex}`
    : null

  if (evidence.source === 'abstract' || evidence.sectionKind?.toLowerCase() === 'abstract') {
    if (paper.abstract) return 'paper-abstract'
    if (sectionTarget) return sectionTarget
    const abstractIndex = paper.sections.findIndex(
      (section) => section.kind.toLowerCase() === 'abstract'
    )
    const abstractSection = paper.sections[abstractIndex]
    return abstractSection
      ? `${slug(abstractSection.heading, 'section')}-${abstractIndex}`
      : 'paper-article-header'
  }
  if (
    evidence.source === 'reference' ||
    (sectionAtEvidence && isReferenceSection(sectionAtEvidence))
  ) {
    const usesStructuredFallback =
      !paper.sections.some(
        (section) =>
          isReferenceSection(section) && parseNumberedReferences(section.text).length > 0
      ) && paper.references.length > 0
    if (sectionAtEvidence && isReferenceSection(sectionAtEvidence)) {
      return usesStructuredFallback ? 'paper-references' : sectionTarget ?? 'paper-article-header'
    }
    if (usesStructuredFallback) return 'paper-references'
    const referenceIndex = paper.sections.findIndex(isReferenceSection)
    const referenceSection = paper.sections[referenceIndex]
    if (referenceSection) {
      return `${slug(referenceSection.heading, 'section')}-${referenceIndex}`
    }
    return paper.references.length > 0 ? 'paper-references' : 'paper-article-header'
  }
  return sectionTarget ?? 'paper-article-header'
}

function App(): React.JSX.Element {
  const bridge = window.paperrelay

  if (!bridge) {
    return <BridgeUnavailable />
  }

  return <PaperRelayWorkspace bridge={bridge} />
}

function PaperRelayWorkspace({ bridge }: { bridge: PaperRelayBridge }): React.JSX.Element {
  const [summary, setSummary] = useState<LibrarySummary | null>(null)
  const [scope, setScope] = useState<Scope>(storedScope)
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebouncedValue(query.trim(), 180)
  const [sort, setSort] = useState<Sort>(storedSort)
  const [papers, setPapers] = useState<PaperListItem[]>([])
  const [issues, setIssues] = useState<IndexIssue[]>([])
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null)
  const [selectedIssue, setSelectedIssue] = useState<IndexIssue | null>(null)
  const [paper, setPaper] = useState<PaperDetail | null>(null)
  const [readerTab, setReaderTab] = useState<ReaderTab>('reader')
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('paper')
  const [paperDigest, setPaperDigest] = useState<PaperDigest | null>(null)
  const [paperDigestBusy, setPaperDigestBusy] = useState(false)
  const [paperDigestError, setPaperDigestError] = useState<string | null>(null)
  const [paperDigestReloadVersion, setPaperDigestReloadVersion] = useState(0)
  const [pendingEvidence, setPendingEvidence] = useState<InsightEvidence | null>(null)
  const [researchLandscape, setResearchLandscape] = useState<ResearchLandscape | null>(null)
  const [researchLandscapeBusy, setResearchLandscapeBusy] = useState(false)
  const [researchLandscapeError, setResearchLandscapeError] = useState<string | null>(null)
  const [researchLandscapeReloadVersion, setResearchLandscapeReloadVersion] = useState(0)
  const [panelPreferences, setPanelPreferences] = useState(() =>
    readWorkspacePanelPreferences(window.localStorage)
  )
  const [pendingWorkspaceIntent, setPendingWorkspaceIntent] =
    useState<WorkspaceIntent | null>(null)
  const [transitionBusy, setTransitionBusy] = useState<'save' | 'discard' | null>(null)
  const [transitionError, setTransitionError] = useState<string | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [listBusy, setListBusy] = useState(true)
  const [hasMorePapers, setHasMorePapers] = useState(false)
  const [loadingMorePapers, setLoadingMorePapers] = useState(false)
  const [detailBusy, setDetailBusy] = useState(false)
  const [addingRoot, setAddingRoot] = useState(false)
  const [busyRootIds, setBusyRootIds] = useState<Set<string>>(new Set())
  const [revealLocationId, setRevealLocationId] = useState<string | null>(null)
  const [rootMenuId, setRootMenuId] = useState<string | null>(null)
  const [confirmRoot, setConfirmRoot] = useState<RootSummary | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [detailReloadVersion, setDetailReloadVersion] = useState(0)
  const [agentRelaySetup, setAgentRelaySetup] = useState<AgentRelaySetup | null>(null)
  const [agentRelayLoading, setAgentRelayLoading] = useState(true)
  const [agentRelayOpen, setAgentRelayOpen] = useState(false)
  const [terminalRunning, setTerminalRunning] = useState(false)
  const [relayCopyAction, setRelayCopyAction] = useState<RelayCopyAction>(null)
  const [userStateBusy, setUserStateBusy] = useState<{
    action: UserStateAction
    paperId: string
  } | null>(null)
  const [resourceErrors, setResourceErrors] = useState(EMPTY_RESOURCE_ERRORS)
  const [toast, setToast] = useState<ToastState | null>(null)
  const requestId = useRef(0)
  const summaryRequestId = useRef(0)
  const loadingMoreRef = useRef(false)
  const summaryRevision = useRef<string | null>(null)
  const agentRelayTriggerRef = useRef<HTMLButtonElement>(null)
  const requestWorkspaceIntentRef = useRef<(intent: WorkspaceIntent) => void>(() => undefined)
  const pendingWorkspaceIntentRef = useRef<WorkspaceIntent | null>(null)
  const lifecyclePreparationId = useRef(0)
  const allowUnloadRef = useRef(false)
  const externallySelectedPaperId = useRef<string | null>(null)

  const roots = summary?.roots ?? []
  const activeTitle = scopeTitle(scope, roots)
  const activeRootId = scope.kind === 'root' ? scope.rootId : undefined
  const notesOpen = panelPreferences.notes
  const paperDraft = useDurablePaperDraft(bridge.papers, paper)
  const parsedPaperDraftTags = useMemo(
    () => normalizeTagDraft(paperDraft.tagInput),
    [paperDraft.tagInput]
  )

  const setResourceError = useCallback(
    (resource: ResourceErrorKey, nextError: string | null): void => {
      setResourceErrors((current) => withResourceError(current, resource, nextError))
    },
    []
  )

  const setPanelOpen = useCallback((panel: WorkspacePanelId, open: boolean): void => {
    setPanelPreferences((current) => withWorkspacePanelVisibility(current, panel, open))
  }, [])

  const togglePanel = useCallback((panel: WorkspacePanelId): void => {
    setPanelPreferences((current) =>
      withWorkspacePanelVisibility(current, panel, !current[panel])
    )
  }, [])

  const setNotesOpen = useCallback(
    (open: boolean): void => setPanelOpen('notes', open),
    [setPanelOpen]
  )

  const hideTerminal = useCallback((): void => {
    setPanelOpen('terminal', false)
    window.requestAnimationFrame(() => {
      document.getElementById(WORKSPACE_TERMINAL_TOGGLE_ID)?.focus()
    })
  }, [setPanelOpen])

  const showToast = useCallback((message: string, tone: ToastState['tone'] = 'neutral') => {
    setToast({ id: Date.now(), message, tone })
  }, [])

  const refreshSummary = useCallback(
    async (showLoading = false): Promise<boolean> => {
      const currentRequest = ++summaryRequestId.current
      if (showLoading) setSummaryLoading(true)
      try {
        const next = await bridge.library.summary()
        if (currentRequest !== summaryRequestId.current) return false
        const revision = libraryRevision(next)
        const changed = summaryRevision.current !== revision
        summaryRevision.current = revision
        setSummary(next)
        setResourceError('summary', null)
        return changed
      } catch (nextError) {
        if (currentRequest !== summaryRequestId.current) return false
        setResourceError('summary', errorMessage(nextError))
        return false
      } finally {
        if (currentRequest === summaryRequestId.current) setSummaryLoading(false)
      }
    },
    [bridge, setResourceError]
  )

  const refreshAll = useCallback(async (): Promise<void> => {
    if (await refreshSummary()) setRefreshVersion((value) => value + 1)
  }, [refreshSummary])

  const refreshAgentRelay = useCallback(async (): Promise<void> => {
    setAgentRelayLoading(true)
    try {
      const setup = await bridge.agentRelay.setup()
      setAgentRelaySetup(setup)
    } catch (nextError) {
      setAgentRelaySetup({
        available: false,
        databasePath: 'Unavailable',
        serverPath: 'Unavailable',
        codexConfig: '',
        cliCommand: '',
        testPrompt: '',
        error: errorMessage(nextError)
      })
    } finally {
      setAgentRelayLoading(false)
    }
  }, [bridge])

  const replacePaperUserState = useCallback(
    (paperId: string, nextUserState: PaperUserState): void => {
      setPapers((current) =>
        current.map((item) =>
          item.id === paperId ? { ...item, userState: nextUserState } : item
        )
      )
      setPaper((current) =>
        current?.id === paperId ? { ...current, userState: nextUserState } : current
      )
    },
    []
  )

  useEffect(() => {
    void refreshSummary(true)
  }, [refreshSummary])

  useEffect(() => {
    void refreshAgentRelay()
  }, [refreshAgentRelay])

  useEffect(
    () =>
      bridge.lifecycle.onCloseRequested((request) => {
        requestWorkspaceIntentRef.current(
          request.kind === 'quit'
            ? { kind: 'quit', requestId: request.id }
            : { kind: 'close-window', requestId: request.id }
        )
      }),
    [bridge]
  )

  useEffect(() => {
    if (!paperDraft.dirty) return
    const guardUnload = (event: BeforeUnloadEvent): void => {
      if (allowUnloadRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guardUnload)
    return () => window.removeEventListener('beforeunload', guardUnload)
  }, [paperDraft.dirty])

  useEffect(() => {
    try {
      window.localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify(scope))
    } catch {
      // The library remains usable when preferences cannot be persisted.
    }
  }, [scope])

  useEffect(() => {
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, sort)
    } catch {
      // The library remains usable when preferences cannot be persisted.
    }
  }, [sort])

  useEffect(() => {
    writeWorkspacePanelPreferences(window.localStorage, panelPreferences)
  }, [panelPreferences])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshAll()
    }, POLL_INTERVAL)
    return () => window.clearInterval(timer)
  }, [refreshAll])

  useEffect(() => {
    const currentRequest = ++requestId.current
    let live = true
    loadingMoreRef.current = false
    setLoadingMorePapers(false)
    setHasMorePapers(false)
    setListBusy(true)
    setResourceError('load-more', null)

    const request = paperSearchRequest(scope, debouncedQuery, sort)

    const issueRequest = scope.kind === 'attention' ? bridge.papers.issues() : Promise.resolve([])

    void Promise.all([bridge.papers.search(request), issueRequest])
      .then(([nextPapers, nextIssues]) => {
        if (!live || currentRequest !== requestId.current) return
        setPapers(nextPapers.slice(0, RESULT_PAGE_SIZE))
        setHasMorePapers(nextPapers.length > RESULT_PAGE_SIZE)
        setIssues(nextIssues)
        setResourceError('list', null)
      })
      .catch((nextError: unknown) => {
        if (!live) return
        setResourceError('list', errorMessage(nextError))
      })
      .finally(() => {
        if (live && currentRequest === requestId.current) setListBusy(false)
      })

    return () => {
      live = false
    }
  }, [bridge, debouncedQuery, refreshVersion, scope, setResourceError, sort])

  const loadMorePapers = useCallback(async (): Promise<void> => {
    if (!hasMorePapers || listBusy || loadingMoreRef.current) return
    const currentRequest = requestId.current
    const offset = papers.length
    loadingMoreRef.current = true
    setLoadingMorePapers(true)

    try {
      const nextPapers = await bridge.papers.search(
        paperSearchRequest(scope, debouncedQuery, sort, offset)
      )
      if (currentRequest !== requestId.current) return
      const page = nextPapers.slice(0, RESULT_PAGE_SIZE)
      setPapers((current) => {
        if (current.length !== offset) return current
        const existingIds = new Set(current.map((paper) => paper.id))
        return [...current, ...page.filter((paper) => !existingIds.has(paper.id))]
      })
      setHasMorePapers(nextPapers.length > RESULT_PAGE_SIZE)
      setResourceError('load-more', null)
    } catch (nextError) {
      if (currentRequest === requestId.current) {
        setResourceError('load-more', errorMessage(nextError))
      }
    } finally {
      loadingMoreRef.current = false
      if (currentRequest === requestId.current) setLoadingMorePapers(false)
    }
  }, [
    bridge,
    debouncedQuery,
    hasMorePapers,
    listBusy,
    papers.length,
    scope,
    setResourceError,
    sort
  ])

  useEffect(() => {
    if (selectedIssue) return
    if (pendingEvidence) return
    if (
      selectedPaperId &&
      externallySelectedPaperId.current === selectedPaperId
    ) return
    if (selectedPaperId && papers.some((item) => item.id === selectedPaperId)) return
    if (
      workspaceMode === 'radar' &&
      selectedPaperId &&
      researchLandscape?.nodes.some((node) => node.paperId === selectedPaperId)
    ) {
      return
    }
    if (
      selectedPaperId &&
      paperDraft.paperId === selectedPaperId &&
      paperDraft.dirty
    ) return
    const nextPaperId = papers[0]?.id ?? null
    setPaper(null)
    setDetailBusy(Boolean(nextPaperId))
    setSelectedPaperId(nextPaperId)
    setReaderTab('reader')
  }, [
    paperDraft.dirty,
    paperDraft.paperId,
    papers,
    pendingEvidence,
    researchLandscape,
    selectedIssue,
    selectedPaperId,
    workspaceMode
  ])

  useEffect(() => {
    if (!selectedPaperId || selectedIssue) {
      setPaper(null)
      setDetailBusy(false)
      setResourceError('detail', null)
      return
    }

    let live = true
    setDetailBusy(true)
    setResourceError('detail', null)
    void bridge.papers
      .get(selectedPaperId, activeRootId)
      .then((nextPaper) => {
        if (!live) return
        setPaper(nextPaper)
        setResourceError('detail', null)
      })
      .catch((nextError: unknown) => {
        if (!live) return
        setResourceError('detail', errorMessage(nextError))
      })
      .finally(() => {
        if (live) setDetailBusy(false)
      })

    return () => {
      live = false
    }
  }, [
    activeRootId,
    bridge,
    detailReloadVersion,
    selectedIssue,
    selectedPaperId,
    setResourceError
  ])

  useEffect(() => {
    if (
      !pendingEvidence ||
      workspaceMode !== 'paper' ||
      !paper ||
      paper.id !== pendingEvidence.paperId
    ) {
      return
    }
    const targetId = evidenceTargetId(pendingEvidence, paper)
    const frame = window.requestAnimationFrame(() => {
      const target =
        document.getElementById(targetId) ?? document.getElementById('paper-article-header')
      if (!target) {
        setPendingEvidence(null)
        return
      }
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.tabIndex = -1
      target.focus({ preventScroll: true })
      setPendingEvidence(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [paper, pendingEvidence, workspaceMode])

  useEffect(() => {
    if (!selectedPaperId || selectedIssue || workspaceMode !== 'paper') {
      setPaperDigest(null)
      setPaperDigestBusy(false)
      setPaperDigestError(null)
      return
    }

    let live = true
    setPaperDigest((current) =>
      current?.paperId === selectedPaperId && current.rootId === (activeRootId ?? null)
        ? current
        : null
    )
    setPaperDigestBusy(true)
    setPaperDigestError(null)
    void bridge.insights
      .paper(selectedPaperId, activeRootId)
      .then((nextDigest) => {
        if (!live) return
        setPaperDigest(nextDigest)
      })
      .catch((nextError: unknown) => {
        if (!live) return
        setPaperDigestError(errorMessage(nextError))
      })
      .finally(() => {
        if (live) setPaperDigestBusy(false)
      })

    return () => {
      live = false
    }
  }, [
    activeRootId,
    bridge,
    detailReloadVersion,
    paperDigestReloadVersion,
    selectedIssue,
    selectedPaperId,
    workspaceMode
  ])

  useEffect(() => {
    if (workspaceMode !== 'radar') {
      setResearchLandscapeBusy(false)
      return
    }

    let live = true
    setResearchLandscape((current) =>
      current?.rootId === (activeRootId ?? null) ? current : null
    )
    setResearchLandscapeBusy(true)
    setResearchLandscapeError(null)
    void bridge.insights
      .landscape(activeRootId ? { rootId: activeRootId, limit: 200 } : { limit: 200 })
      .then((nextLandscape) => {
        if (!live) return
        setResearchLandscape(nextLandscape)
      })
      .catch((nextError: unknown) => {
        if (!live) return
        setResearchLandscapeError(errorMessage(nextError))
      })
      .finally(() => {
        if (live) setResearchLandscapeBusy(false)
      })

    return () => {
      live = false
    }
  }, [
    activeRootId,
    bridge,
    refreshVersion,
    researchLandscapeReloadVersion,
    workspaceMode
  ])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!summary || scope.kind !== 'root') return
    if (!summary.roots.some((root) => root.id === scope.rootId)) setScope({ kind: 'all' })
  }, [scope, summary])

  useEffect(() => {
    if (!selectedIssue || listBusy || scope.kind !== 'attention') return
    const needle = query.trim().toLowerCase()
    const matchesQuery =
      !needle ||
      `${selectedIssue.message} ${selectedIssue.relativePath} ${selectedIssue.rootLabel}`
        .toLowerCase()
        .includes(needle)
    if (matchesQuery && issues.some((issue) => issue.id === selectedIssue.id)) return
    setSelectedIssue(null)
    setSelectedPaperId(papers[0]?.id ?? null)
  }, [issues, listBusy, papers, query, scope.kind, selectedIssue])

  const commitScope = (nextScope: Scope): void => {
    externallySelectedPaperId.current = null
    setWorkspaceMode('paper')
    setScope(nextScope)
    setSelectedIssue(null)
    setRootMenuId(null)
  }

  const commitOpenResearchRadar = (): void => {
    if (scope.kind === 'attention' || scope.kind === 'user') setScope({ kind: 'all' })
    setSelectedIssue(null)
    setRootMenuId(null)
    setWorkspaceMode('radar')
  }

  const commitRadarScope = (nextScope: Scope): void => {
    setScope(nextScope)
    setSelectedIssue(null)
  }

  const openSelectedPaperDigest = (): void => {
    if (!selectedPaperId) return
    externallySelectedPaperId.current = selectedPaperId
    setQuery('')
    setWorkspaceMode('paper')
    setReaderTab('digest')
  }

  const addRoot = async (): Promise<void> => {
    setAddingRoot(true)
    try {
      const root = await bridge.roots.addWithPicker()
      if (!root) return
      requestWorkspaceIntent({ kind: 'change-scope', scope: { kind: 'root', rootId: root.id } })
      await refreshAll()
      showToast(`Connected “${root.label}”`, 'success')
    } catch (nextError) {
      showToast(errorMessage(nextError), 'error')
    } finally {
      setAddingRoot(false)
    }
  }

  const rescanRoot = async (root: RootSummary): Promise<void> => {
    setRootMenuId(null)
    setBusyRootIds((current) => new Set(current).add(root.id))
    try {
      const result = await bridge.roots.rescan(root.id)
      await refreshAll()
      const noun = result.discovered === 1 ? 'artifact' : 'artifacts'
      const issueNote = result.issues > 0 ? ` · ${result.issues} need attention` : ''
      showToast(`Scan complete · ${result.discovered} ${noun}${issueNote}`, 'success')
    } catch (nextError) {
      showToast(errorMessage(nextError), 'error')
    } finally {
      setBusyRootIds((current) => {
        const next = new Set(current)
        next.delete(root.id)
        return next
      })
    }
  }

  const removeRoot = async (): Promise<void> => {
    if (!confirmRoot) return
    const root = confirmRoot
    const currentRoot = summary?.roots.find((candidate) => candidate.id === root.id)
    if (busyRootIds.has(root.id) || currentRoot?.status === 'scanning') {
      showToast('Wait for the active scan to finish before removing this folder.', 'neutral')
      return
    }
    setBusyRootIds((current) => new Set(current).add(root.id))
    try {
      await bridge.roots.remove(root.id)
      if (scope.kind === 'root' && scope.rootId === root.id) setScope({ kind: 'all' })
      setConfirmRoot(null)
      await refreshAll()
      showToast(`Removed “${root.label}” from PaperRelay`, 'success')
    } catch (nextError) {
      showToast(errorMessage(nextError), 'error')
    } finally {
      setBusyRootIds((current) => {
        const next = new Set(current)
        next.delete(root.id)
        return next
      })
    }
  }

  const revealLocation = async (location: PaperLocation): Promise<void> => {
    setRevealLocationId(location.id)
    try {
      await bridge.system.revealLocation(location.id)
    } catch (nextError) {
      showToast(errorMessage(nextError), 'error')
    } finally {
      setRevealLocationId(null)
    }
  }

  const updatePaperUserState = async (
    paperId: string,
    patch: PaperUserStatePatch,
    action: UserStateAction
  ): Promise<PaperUserState | null> => {
    if (userStateBusy) return null
    const previousUserState =
      paper?.id === paperId
        ? paper.userState
        : papers.find((item) => item.id === paperId)?.userState
    setUserStateBusy({ action, paperId })

    try {
      const nextUserState = await bridge.papers.updateUserState(paperId, patch)
      replacePaperUserState(paperId, nextUserState)
      if (previousUserState) {
        setSummary((current) =>
          current
            ? summaryAfterUserStateChange(current, previousUserState, nextUserState)
            : current
        )
      } else {
        void refreshSummary()
      }

      if (scope.kind === 'user' && !matchesUserView(scope.userView, nextUserState)) {
        setPapers((current) => current.filter((item) => item.id !== paperId))
      }
      if (patch.favorite !== undefined || patch.readingStatus !== undefined) {
        setRefreshVersion((value) => value + 1)
      }

      if (action === 'favorite') {
        showToast(nextUserState.favorite ? 'Added to Favorites' : 'Removed from Favorites', 'success')
      } else if (action === 'reading-status') {
        showToast('Reading status updated', 'success')
      } else {
        showToast('Private notes saved', 'success')
      }
      return nextUserState
    } catch (nextError) {
      showToast(errorMessage(nextError), 'error')
      return null
    } finally {
      setUserStateBusy((current) =>
        current?.paperId === paperId && current.action === action ? null : current
      )
    }
  }

  const commitCurrentDraft = async (announce = true): Promise<boolean> => {
    if (!paper) return true
    if (!paperDraft.dirty) {
      try {
        await paperDraft.flush()
        setTransitionError(null)
        return true
      } catch (nextError) {
        const nextMessage = errorMessage(nextError)
        setTransitionError(nextMessage)
        showToast(nextMessage, 'error')
        return false
      }
    }
    if (parsedPaperDraftTags.error) {
      setTransitionError(parsedPaperDraftTags.error)
      setReaderTab('reader')
      setNotesOpen(true)
      return false
    }
    if (userStateBusy) return false
    const paperId = paper.id
    setUserStateBusy({ action: 'notes', paperId })
    try {
      const nextUserState = await paperDraft.commit()
      replacePaperUserState(paperId, nextUserState)
      setPaper((current) =>
        current?.id === paperId
          ? { ...current, userState: nextUserState, userDraft: null }
          : current
      )
      setTransitionError(null)
      if (announce) showToast('Private notes saved', 'success')
      return true
    } catch (nextError) {
      const nextMessage = errorMessage(nextError)
      setTransitionError(nextMessage)
      showToast(nextMessage, 'error')
      return false
    } finally {
      setUserStateBusy((current) =>
        current?.paperId === paperId && current.action === 'notes' ? null : current
      )
    }
  }

  const discardCurrentDraft = async (): Promise<boolean> => {
    if (!paper) return true
    try {
      await paperDraft.discard()
      setPaper((current) =>
        current?.id === paper.id ? { ...current, userDraft: null } : current
      )
      setTransitionError(null)
      return true
    } catch (nextError) {
      const nextMessage = errorMessage(nextError)
      setTransitionError(nextMessage)
      showToast(nextMessage, 'error')
      return false
    }
  }

  const runRelayCopy = async (
    action: Exclude<RelayCopyAction, null>,
    operation: () => Promise<void>,
    successMessage: string
  ): Promise<void> => {
    setRelayCopyAction(action)
    try {
      await operation()
      showToast(successMessage, 'success')
    } catch (nextError) {
      showToast(errorMessage(nextError), 'error')
    } finally {
      setRelayCopyAction((current) => (current === action ? null : current))
    }
  }

  const copyCodexConfig = (): void => {
    void runRelayCopy(
      'config',
      () => bridge.agentRelay.copyCodexConfig(),
      'Codex setup copied'
    )
  }

  const copyTestPrompt = (): void => {
    void runRelayCopy(
      'prompt',
      () => bridge.agentRelay.copyTestPrompt(),
      'Test prompt copied'
    )
  }

  const copyPaperReference = (paperId: string, rootId: string | null): void => {
    void runRelayCopy(
      'paper',
      () => bridge.agentRelay.copyPaperReference(paperId, rootId ?? undefined),
      'Agent reference copied'
    )
  }

  const copyRootContext = (rootId: string): void => {
    setRootMenuId(null)
    void runRelayCopy(
      `root:${rootId}`,
      () => bridge.agentRelay.copyRootContext(rootId),
      'Project context copied'
    )
  }

  const closeAgentRelay = useCallback((): void => {
    setAgentRelayOpen(false)
    window.requestAnimationFrame(() => agentRelayTriggerRef.current?.focus())
  }, [])

  const commitPaperSelection = (paperId: string): void => {
    setSelectedIssue(null)
    if (paperId !== selectedPaperId) {
      setPaper(null)
      setDetailBusy(true)
    }
    setSelectedPaperId(paperId)
    setReaderTab('reader')
    void bridge.papers
      .markOpened(paperId)
      .then((nextUserState) => replacePaperUserState(paperId, nextUserState))
      .catch((nextError: unknown) => showToast(errorMessage(nextError), 'error'))
  }

  const openResearchEvidence = (evidence: InsightEvidence): void => {
    externallySelectedPaperId.current = evidence.paperId
    setQuery('')
    setPendingEvidence(evidence)
    setWorkspaceMode('paper')
    setReaderTab('reader')
    commitPaperSelection(evidence.paperId)
  }

  const openResearchPaper = (paperId: string): void => {
    externallySelectedPaperId.current = paperId
    setQuery('')
    setPendingEvidence(null)
    setWorkspaceMode('paper')
    commitPaperSelection(paperId)
  }

  const executeWorkspaceIntent = (intent: WorkspaceIntent): void => {
    switch (intent.kind) {
      case 'select-paper':
        externallySelectedPaperId.current = null
        commitPaperSelection(intent.paperId)
        return
      case 'select-issue':
        externallySelectedPaperId.current = null
        setSelectedPaperId(null)
        setSelectedIssue(intent.issue)
        return
      case 'change-scope':
        commitScope(intent.scope)
        return
      case 'open-radar':
        commitOpenResearchRadar()
        return
      case 'change-radar-scope':
        commitRadarScope(intent.scope)
        return
      case 'remove-root': {
        const root = roots.find((candidate) => candidate.id === intent.rootId)
        if (root) setConfirmRoot(root)
        return
      }
      case 'reload-paper':
        setDetailReloadVersion((value) => value + 1)
        return
      case 'close-window':
      case 'quit':
        allowUnloadRef.current = true
        void bridge.lifecycle
          .respondToClose(intent.requestId, true)
          .catch((nextError: unknown) => {
            allowUnloadRef.current = false
            showToast(errorMessage(nextError), 'error')
          })
        return
    }
  }

  const requestWorkspaceIntent = (intent: WorkspaceIntent): void => {
    if (intent.kind === 'close-window' || intent.kind === 'quit') {
      const preparationId = ++lifecyclePreparationId.current
      pendingWorkspaceIntentRef.current = intent
      void paperDraft
        .flush()
        .then(() => {
          if (preparationId !== lifecyclePreparationId.current) return
          const preparedIntent = pendingWorkspaceIntentRef.current
          pendingWorkspaceIntentRef.current = null
          if (
            preparedIntent?.kind === 'close-window' ||
            preparedIntent?.kind === 'quit'
          ) {
            executeWorkspaceIntent(preparedIntent)
          }
        })
        .catch((nextError: unknown) => {
          if (preparationId !== lifecyclePreparationId.current) return
          setPendingWorkspaceIntent(pendingWorkspaceIntentRef.current)
          setTransitionError(errorMessage(nextError))
          setReaderTab('reader')
          setNotesOpen(true)
        })
      return
    }
    if (
      shouldResolveDraft(
        paperDraft.paperId
          ? { paperId: paperDraft.paperId, dirty: paperDraft.dirty }
          : null,
        selectedPaperId,
        intent
      )
    ) {
      lifecyclePreparationId.current += 1
      pendingWorkspaceIntentRef.current = intent
      setPendingWorkspaceIntent(intent)
      setTransitionError(null)
      setReaderTab('reader')
      setNotesOpen(true)
      return
    }
    executeWorkspaceIntent(intent)
  }

  const resolveDraftAndContinue = async (action: 'save' | 'discard'): Promise<void> => {
    if (!pendingWorkspaceIntent || transitionBusy) return
    setTransitionBusy(action)
    const intent = pendingWorkspaceIntentRef.current ?? pendingWorkspaceIntent
    try {
      const lifecycleIntent = intent.kind === 'close-window' || intent.kind === 'quit'
      let resolved: boolean
      if (action === 'save' && lifecycleIntent) {
        try {
          await paperDraft.flush()
          setTransitionError(null)
          resolved = true
        } catch (nextError) {
          const nextMessage = errorMessage(nextError)
          setTransitionError(nextMessage)
          showToast(nextMessage, 'error')
          resolved = false
        }
      } else {
        resolved =
          action === 'save'
            ? await commitCurrentDraft(false)
            : await discardCurrentDraft()
      }
      if (!resolved) return
      const nextIntent = pendingWorkspaceIntentRef.current ?? intent
      lifecyclePreparationId.current += 1
      pendingWorkspaceIntentRef.current = null
      setPendingWorkspaceIntent(null)
      setTransitionError(null)
      executeWorkspaceIntent(nextIntent)
    } finally {
      setTransitionBusy(null)
    }
  }

  const cancelWorkspaceIntent = (): void => {
    if (transitionBusy) return
    const intent = pendingWorkspaceIntentRef.current ?? pendingWorkspaceIntent
    lifecyclePreparationId.current += 1
    pendingWorkspaceIntentRef.current = null
    allowUnloadRef.current = false
    setPendingWorkspaceIntent(null)
    setTransitionError(null)
    if (intent?.kind === 'close-window' || intent?.kind === 'quit') {
      void bridge.lifecycle
        .respondToClose(intent.requestId, false)
        .catch((nextError: unknown) => showToast(errorMessage(nextError), 'error'))
    }
  }

  const chooseScope = (nextScope: Scope): void =>
    requestWorkspaceIntent({ kind: 'change-scope', scope: nextScope })

  const openResearchRadar = (): void => requestWorkspaceIntent({ kind: 'open-radar' })

  const chooseRadarRoot = (rootId: string | null): void =>
    requestWorkspaceIntent({
      kind: 'change-radar-scope',
      scope: rootId ? { kind: 'root', rootId } : { kind: 'all' }
    })

  const selectPaper = (paperId: string): void => {
    requestWorkspaceIntent({ kind: 'select-paper', paperId })
  }

  const selectIssue = (issue: IndexIssue): void => {
    requestWorkspaceIntent({ kind: 'select-issue', issue })
  }

  requestWorkspaceIntentRef.current = requestWorkspaceIntent

  const activeRoot =
    scope.kind === 'root' ? roots.find((root) => root.id === scope.rootId) ?? null : null
  const currentListPaper = papers.find((candidate) => candidate.id === paper?.id)
  const sourceChanged = Boolean(
    paper && currentListPaper && currentListPaper.updatedAt !== paper.updatedAt
  )
  const confirmRootBusy = Boolean(
    confirmRoot &&
      (busyRootIds.has(confirmRoot.id) ||
        roots.find((candidate) => candidate.id === confirmRoot.id)?.status === 'scanning')
  )
  const recoveringLifecycleDraft = Boolean(
    pendingWorkspaceIntent?.kind === 'close-window' ||
      pendingWorkspaceIntent?.kind === 'quit'
  )

  return (
    <>
      <div
        aria-hidden={agentRelayOpen ? true : undefined}
        className={`app-shell ${
          panelPreferences.navigation ? '' : 'is-navigation-panel-hidden'
        } ${panelPreferences.library ? '' : 'is-library-panel-hidden'}`}
        inert={agentRelayOpen ? true : undefined}
      >
      <WorkspacePanelRail
        libraryOpen={panelPreferences.library}
        navigationOpen={panelPreferences.navigation}
        notesAvailable={Boolean(workspaceMode === 'paper' && paper && !selectedIssue)}
        notesOpen={Boolean(
          workspaceMode === 'paper' && paper && !selectedIssue && readerTab === 'reader' && notesOpen
        )}
        onToggleLibrary={() => togglePanel('library')}
        onToggleNavigation={() => togglePanel('navigation')}
        onToggleNotes={() => {
          if (workspaceMode !== 'paper' || !paper || selectedIssue) return
          if (readerTab === 'reader' && notesOpen) {
            setNotesOpen(false)
            return
          }
          setReaderTab('reader')
          setNotesOpen(true)
        }}
        onToggleTerminal={() => togglePanel('terminal')}
        terminalOpen={panelPreferences.terminal}
        terminalRunning={terminalRunning}
      />
      <Sidebar
        agentRelayTriggerRef={agentRelayTriggerRef}
        agentRelayLoading={agentRelayLoading}
        agentRelaySetup={agentRelaySetup}
        addingRoot={addingRoot}
        busyRootIds={busyRootIds}
        onAddRoot={() => void addRoot()}
        onChooseScope={chooseScope}
        onCopyRootContext={copyRootContext}
        onOpenAgentRelay={() => {
          setRootMenuId(null)
          agentRelayTriggerRef.current?.blur()
          setAgentRelayOpen(true)
        }}
        onOpenResearchRadar={openResearchRadar}
        onOpenRootMenu={(rootId) => setRootMenuId(rootMenuId === rootId ? null : rootId)}
        onRemoveRoot={(root) => {
          setRootMenuId(null)
          requestWorkspaceIntent({ kind: 'remove-root', rootId: root.id })
        }}
        onRescanRoot={(root) => void rescanRoot(root)}
        rootMenuId={rootMenuId}
        relayCopyAction={relayCopyAction}
        researchRadarActive={workspaceMode === 'radar'}
        roots={roots}
        scope={scope}
        summary={summary}
        summaryLoading={summaryLoading}
        visible={panelPreferences.navigation}
      />

      <LibraryPane
        activeRoot={activeRoot}
        addingRoot={addingRoot}
        issues={issues}
        hasMorePapers={hasMorePapers}
        listError={resourceErrors.list}
        listBusy={listBusy}
        loadMoreError={resourceErrors['load-more']}
        loadingMorePapers={loadingMorePapers}
        onAddRoot={() => void addRoot()}
        onQueryChange={(value) => {
          externallySelectedPaperId.current = null
          setQuery(value)
        }}
        onLoadMore={() => void loadMorePapers()}
        onRetryList={() => setRefreshVersion((value) => value + 1)}
        onSelectIssue={selectIssue}
        onSelectPaper={selectPaper}
        onSortChange={setSort}
        papers={papers}
        query={query}
        researchRadarActive={workspaceMode === 'radar'}
        scope={scope}
        selectedIssueId={selectedIssue?.id ?? null}
        selectedPaperId={selectedPaperId}
        sort={sort}
        summary={summary}
        title={workspaceMode === 'radar' ? 'Evidence papers' : activeTitle}
        visible={panelPreferences.library}
      />

      <main className="detail-pane">
        {(resourceErrors.summary || resourceErrors.detail) && (
          <div className="resource-error-stack">
            {resourceErrors.summary && (
              <ResourceErrorStrip
                label="Library status"
                message={resourceErrors.summary}
                onDismiss={() => setResourceError('summary', null)}
                onRetry={() => void refreshSummary(true)}
              />
            )}
            {resourceErrors.detail && (
              <ResourceErrorStrip
                label="Paper detail"
                message={resourceErrors.detail}
                onDismiss={() => setResourceError('detail', null)}
                onRetry={() => setDetailReloadVersion((value) => value + 1)}
              />
            )}
          </div>
        )}

        <DetailWorkspaceLayout
          primary={
            workspaceMode === 'radar' ? (
              <div className="reader-shell research-radar-shell">
                <div className="detail-topbar radar-detail-topbar">
                  <div className="detail-breadcrumbs">
                    <span>Library</span>
                    <span>/</span>
                    <strong>Research Radar</strong>
                  </div>
                  <div className="detail-topbar-actions">
                    <label className="radar-scope-control">
                      <span className="sr-only">Research Radar scope</span>
                      <Icon name="folder" size={13} />
                      <select
                        aria-label="Research Radar scope"
                        onChange={(event) => chooseRadarRoot(event.target.value || null)}
                        value={activeRoot?.id ?? ''}
                      >
                        <option value="">All connected folders</option>
                        {roots.map((root) => (
                          <option key={root.id} value={root.id}>{root.label}</option>
                        ))}
                      </select>
                      <Icon name="chevron-down" size={12} />
                    </label>
                    <button
                      className="secondary-button compact-button"
                      disabled={!selectedPaperId}
                      onClick={openSelectedPaperDigest}
                      type="button"
                    >
                      <Icon name="book-open" size={14} />
                      Open selected digest
                    </button>
                  </div>
                </div>
                <ResearchRadarWorkspace
                  error={researchLandscapeError}
                  landscape={researchLandscape}
                  loading={researchLandscapeBusy}
                  onRefresh={() => setResearchLandscapeReloadVersion((value) => value + 1)}
                  onRetry={() => setResearchLandscapeReloadVersion((value) => value + 1)}
                  onOpenPaper={openResearchPaper}
                  onSelectEvidence={openResearchEvidence}
                  onSelectPaper={commitPaperSelection}
                  scopeLabel={activeRoot?.label ?? 'All connected folders'}
                  selectedPaperId={selectedPaperId}
                />
              </div>
            ) : selectedIssue ? (
              <IssueDetail
                issue={selectedIssue}
                onBack={() => {
                  setSelectedIssue(null)
                  setSelectedPaperId(papers[0]?.id ?? null)
                }}
                onRescan={(rootId) => {
                  const root = roots.find((candidate) => candidate.id === rootId)
                  if (root) void rescanRoot(root)
                }}
                rescanning={busyRootIds.has(selectedIssue.rootId)}
              />
            ) : detailBusy && !paper ? (
              <ReaderSkeleton />
            ) : paper ? (
              <PaperReader
                activeRootId={activeRoot?.id ?? null}
                copyingAgentReference={relayCopyAction === 'paper'}
                digest={paperDigest?.paperId === paper.id ? paperDigest : null}
                digestError={paperDigestError}
                digestLoading={paperDigestBusy}
                draftError={paperDraft.error}
                draftPersistenceStatus={paperDraft.status}
                draftRecoveredAt={paperDraft.recoveredAt}
                hasUnsavedDraft={paperDraft.dirty}
                key={paper.id}
                noteDraft={paperDraft.note}
                onCopyAgentReference={() => copyPaperReference(paper.id, activeRoot?.id ?? null)}
                onNoteDraftChange={paperDraft.setNote}
                onReload={() => requestWorkspaceIntent({ kind: 'reload-paper' })}
                onRetryDigest={() => setPaperDigestReloadVersion((value) => value + 1)}
                onReveal={(location) => void revealLocation(location)}
                onNotesOpenChange={setNotesOpen}
                onSaveNotes={() => void commitCurrentDraft()}
                onTagDraftChange={paperDraft.setTagInput}
                onTabChange={setReaderTab}
                onUpdateUserState={(patch, action) =>
                  updatePaperUserState(paper.id, patch, action)
                }
                paper={paper}
                notesOpen={notesOpen}
                readerTab={readerTab}
                reloading={detailBusy}
                revealLocationId={revealLocationId}
                sourceChanged={sourceChanged}
                tagDraft={paperDraft.tagInput}
                userStateAction={
                  userStateBusy?.paperId === paper.id ? userStateBusy.action : null
                }
              />
            ) : (
              <WorkspaceEmpty
                addingRoot={addingRoot}
                hasRoots={(summary?.rootCount ?? 0) > 0}
                onAddRoot={() => void addRoot()}
              />
            )
          }
          terminal={
            <AgentTerminalPanel
              bridge={bridge.agentTerminal}
              onHide={hideTerminal}
              onRunningChange={setTerminalRunning}
              roots={roots}
              suggestedRootId={activeRoot?.id ?? paper?.locations[0]?.rootId ?? null}
              visible={panelPreferences.terminal}
            />
          }
          terminalOpen={panelPreferences.terminal}
        />
      </main>

      {pendingWorkspaceIntent && (
        <DraftTransitionDialog
          busyAction={transitionBusy}
          currentPaperTitle={paper?.title ?? 'this paper'}
          destination={intentLabel(pendingWorkspaceIntent, {
            paperTitle: (paperId) =>
              papers.find((candidate) => candidate.id === paperId)?.title ?? null,
            rootLabel: (rootId) =>
              roots.find((candidate) => candidate.id === rootId)?.label ?? null
          })}
          error={
            transitionError ??
            (recoveringLifecycleDraft ? null : parsedPaperDraftTags.error)
          }
          lifecycleRecovery={recoveringLifecycleDraft}
          onCancel={cancelWorkspaceIntent}
          onDiscard={() => void resolveDraftAndContinue('discard')}
          onSave={() => void resolveDraftAndContinue('save')}
          saveDisabled={Boolean(!recoveringLifecycleDraft && parsedPaperDraftTags.error)}
        />
      )}

      {confirmRoot && (
        <RemoveRootDialog
          busy={confirmRootBusy}
          onCancel={() => setConfirmRoot(null)}
          onConfirm={() => void removeRoot()}
          root={confirmRoot}
        />
      )}

      </div>

      {agentRelayOpen && (
        <AgentRelaySheet
          activeAction={
            relayCopyAction === 'config' || relayCopyAction === 'prompt' ? relayCopyAction : null
          }
          loading={agentRelayLoading}
          onClose={closeAgentRelay}
          onCopyConfig={copyCodexConfig}
          onCopyPrompt={copyTestPrompt}
          onRefresh={() => void refreshAgentRelay()}
          setup={agentRelaySetup}
        />
      )}

      {toast && <Toast key={toast.id} toast={toast} />}
    </>
  )
}

interface SidebarProps {
  agentRelayTriggerRef: RefObject<HTMLButtonElement | null>
  agentRelaySetup: AgentRelaySetup | null
  agentRelayLoading: boolean
  summary: LibrarySummary | null
  summaryLoading: boolean
  roots: RootSummary[]
  scope: Scope
  rootMenuId: string | null
  busyRootIds: Set<string>
  addingRoot: boolean
  relayCopyAction: RelayCopyAction
  researchRadarActive: boolean
  visible: boolean
  onChooseScope(scope: Scope): void
  onAddRoot(): void
  onOpenAgentRelay(): void
  onOpenResearchRadar(): void
  onCopyRootContext(rootId: string): void
  onOpenRootMenu(rootId: string): void
  onRescanRoot(root: RootSummary): void
  onRemoveRoot(root: RootSummary): void
}

function Sidebar({
  agentRelayTriggerRef,
  agentRelaySetup,
  agentRelayLoading,
  summary,
  summaryLoading,
  roots,
  scope,
  rootMenuId,
  busyRootIds,
  addingRoot,
  relayCopyAction,
  researchRadarActive,
  visible,
  onChooseScope,
  onAddRoot,
  onOpenAgentRelay,
  onOpenResearchRadar,
  onCopyRootContext,
  onOpenRootMenu,
  onRescanRoot,
  onRemoveRoot
}: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar" hidden={!visible} id={WORKSPACE_NAVIGATION_PANEL_ID}>
      <div className="drag-region" />
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          <img alt="" className="brand-mark-image" draggable="false" src={paperRelayLogo} />
        </div>
        <div>
          <div className="brand-name">PaperRelay</div>
          <div className="brand-caption">Local research library</div>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Library">
        <div className="nav-section-label">Library</div>
        <button
          aria-current={!researchRadarActive && scope.kind === 'all' ? 'page' : undefined}
          className={`nav-row ${!researchRadarActive && scope.kind === 'all' ? 'is-active' : ''}`}
          onClick={() => onChooseScope({ kind: 'all' })}
          type="button"
        >
          <Icon name="layers" size={17} />
          <span>All Papers</span>
          <span className="nav-count">{summaryLoading ? '·' : formatNumber(summary?.paperCount ?? 0)}</span>
        </button>
        <button
          aria-current={researchRadarActive ? 'page' : undefined}
          className={`nav-row nav-row-radar ${researchRadarActive ? 'is-active' : ''}`}
          onClick={onOpenResearchRadar}
          type="button"
        >
          <Icon name="sparkles" size={17} />
          <span>Research Radar</span>
          <span className="nav-count nav-count-new">New</span>
        </button>
        <button
          aria-current={scope.kind === 'attention' ? 'page' : undefined}
          className={`nav-row ${scope.kind === 'attention' ? 'is-active' : ''}`}
          onClick={() => onChooseScope({ kind: 'attention' })}
          type="button"
        >
          <Icon name="triangle-alert" size={17} />
          <span>Needs Attention</span>
          {(summary?.issueCount ?? 0) > 0 && (
            <span className="nav-count nav-count-warning">{summary?.issueCount}</span>
          )}
        </button>
      </nav>

      <nav className="sidebar-nav sidebar-my-library" aria-label="My library">
        <div className="nav-section-label">My library</div>
        <button
          aria-current={
            scope.kind === 'user' && scope.userView === 'favorites' ? 'page' : undefined
          }
          className={`nav-row ${
            scope.kind === 'user' && scope.userView === 'favorites' ? 'is-active' : ''
          }`}
          onClick={() => onChooseScope({ kind: 'user', userView: 'favorites' })}
          type="button"
        >
          <Icon name="star" size={17} />
          <span>Favorites</span>
          <span className="nav-count">
            {summaryLoading ? '·' : formatNumber(summary?.favoriteCount ?? 0)}
          </span>
        </button>
        <button
          aria-current={
            scope.kind === 'user' && scope.userView === 'reading_list' ? 'page' : undefined
          }
          className={`nav-row ${
            scope.kind === 'user' && scope.userView === 'reading_list' ? 'is-active' : ''
          }`}
          onClick={() => onChooseScope({ kind: 'user', userView: 'reading_list' })}
          type="button"
        >
          <Icon name="book-open" size={17} />
          <span>Reading list</span>
          <span className="nav-count">
            {summaryLoading ? '·' : formatNumber(summary?.readingListCount ?? 0)}
          </span>
        </button>
        <button
          aria-current={
            scope.kind === 'user' && scope.userView === 'reviewed' ? 'page' : undefined
          }
          className={`nav-row ${
            scope.kind === 'user' && scope.userView === 'reviewed' ? 'is-active' : ''
          }`}
          onClick={() => onChooseScope({ kind: 'user', userView: 'reviewed' })}
          type="button"
        >
          <Icon name="check" size={17} />
          <span>Reviewed</span>
          <span className="nav-count">
            {summaryLoading ? '·' : formatNumber(summary?.reviewedCount ?? 0)}
          </span>
        </button>
      </nav>

      <div className="roots-heading">
        <span className="nav-section-label">Research folders</span>
        <button
          aria-label="Connect research folder"
          className="icon-button icon-button-subtle"
          disabled={addingRoot}
          onClick={onAddRoot}
          title="Connect research folder"
          type="button"
        >
          <Icon name="folder-plus" size={17} />
        </button>
      </div>

      <div className="roots-list">
        {roots.length === 0 ? (
          <button className="connect-root-card" disabled={addingRoot} onClick={onAddRoot} type="button">
            <span className="connect-root-icon">
              <Icon name="folder-plus" size={19} />
            </span>
            <span>
              <strong>{addingRoot ? 'Opening…' : 'Connect a folder'}</strong>
              <small>Your files stay where they are</small>
            </span>
          </button>
        ) : (
          roots.map((root) => {
            const active = !researchRadarActive && scope.kind === 'root' && scope.rootId === root.id
            const busy = busyRootIds.has(root.id) || root.status === 'scanning'
            return (
              <div className={`root-row-wrap ${active ? 'is-active' : ''}`} key={root.id}>
                <button
                  aria-current={active ? 'page' : undefined}
                  className="root-row-main"
                  onClick={() => onChooseScope({ kind: 'root', rootId: root.id })}
                  title={root.path}
                  type="button"
                >
                  <span className={`root-status-dot status-${root.status}`} />
                  <span className="root-row-copy">
                    <span className="root-row-title">{root.label}</span>
                    <span className="root-row-meta">
                      {busy ? 'Scanning…' : `${formatNumber(root.paperCount)} papers`}
                    </span>
                  </span>
                  {root.issueCount > 0 && <span className="root-issue-count">{root.issueCount}</span>}
                </button>
                <button
                  aria-label={`More actions for ${root.label}`}
                  className="root-more-button"
                  onClick={() => onOpenRootMenu(root.id)}
                  type="button"
                >
                  <Icon name="more" size={17} />
                </button>
                {rootMenuId === root.id && (
                  <div className="root-popover">
                    <div className="popover-heading">
                      <strong>{root.label}</strong>
                      <span>{root.error || rootStatusLabel(root.status)}</span>
                    </div>
                    <button
                      disabled={relayCopyAction !== null}
                      onClick={() => onCopyRootContext(root.id)}
                      type="button"
                    >
                      <Icon
                        name={relayCopyAction === `root:${root.id}` ? 'check' : 'copy'}
                        size={16}
                      />
                      {relayCopyAction === `root:${root.id}` ? 'Context copied' : 'Copy agent context'}
                    </button>
                    <button disabled={busy} onClick={() => onRescanRoot(root)} type="button">
                      <Icon className={busy ? 'spin' : ''} name="refresh" size={16} />
                      {busy ? 'Scanning…' : 'Rescan folder'}
                    </button>
                    <button
                      className="danger-action"
                      disabled={busy}
                      onClick={() => onRemoveRoot(root)}
                      type="button"
                    >
                      <Icon name="trash" size={16} />
                      Remove from PaperRelay
                    </button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <div className="sidebar-footer">
        <button
          className="agent-relay-footer"
          onClick={onOpenAgentRelay}
          ref={agentRelayTriggerRef}
          type="button"
        >
          <span className="agent-relay-footer-icon">
            <Icon name="bot" size={18} />
            <span>✦</span>
          </span>
          <span className="agent-relay-footer-copy">
            <strong>Agent Relay</strong>
            <small>Read-only tools for Codex</small>
          </span>
          <span
            className={`agent-relay-footer-status ${agentRelaySetup?.available ? 'is-ready' : 'has-error'}`}
          >
            <span />
            {agentRelayLoading ? 'Checking' : agentRelaySetup?.available ? 'Ready' : 'Setup'}
          </span>
        </button>
        <div className="local-note">
          <span className="local-dot" />
          <span>
            <strong>Indexer · sources read-only</strong>
            <small>Library scans never change files</small>
          </span>
        </div>
      </div>
    </aside>
  )
}

interface LibraryPaneProps {
  title: string
  scope: Scope
  summary: LibrarySummary | null
  activeRoot: RootSummary | null
  papers: PaperListItem[]
  issues: IndexIssue[]
  hasMorePapers: boolean
  listError: string | null
  listBusy: boolean
  loadMoreError: string | null
  loadingMorePapers: boolean
  selectedPaperId: string | null
  selectedIssueId: string | null
  query: string
  sort: Sort
  addingRoot: boolean
  researchRadarActive: boolean
  visible: boolean
  onQueryChange(value: string): void
  onLoadMore(): void
  onRetryList(): void
  onSortChange(value: Sort): void
  onSelectPaper(id: string): void
  onSelectIssue(issue: IndexIssue): void
  onAddRoot(): void
}

function ResourceErrorStrip({
  label,
  message,
  onDismiss,
  onRetry
}: {
  label: string
  message: string
  onDismiss(): void
  onRetry(): void
}): React.JSX.Element {
  return (
    <div className="error-strip" role="alert">
      <Icon name="triangle-alert" size={16} />
      <span><strong>{label}:</strong> {message}</span>
      <span className="error-strip-actions">
        <button className="error-retry-button" onClick={onRetry} type="button">Retry</button>
        <button aria-label={`Dismiss ${label.toLowerCase()} error`} onClick={onDismiss} type="button">
          <Icon name="x" size={15} />
        </button>
      </span>
    </div>
  )
}

function LibraryPane({
  title,
  scope,
  summary,
  activeRoot,
  papers,
  issues,
  hasMorePapers,
  listError,
  listBusy,
  loadMoreError,
  loadingMorePapers,
  selectedPaperId,
  selectedIssueId,
  query,
  sort,
  addingRoot,
  researchRadarActive,
  visible,
  onQueryChange,
  onLoadMore,
  onRetryList,
  onSortChange,
  onSelectPaper,
  onSelectIssue,
  onAddRoot
}: LibraryPaneProps): React.JSX.Element {
  const count =
    scope.kind === 'all'
      ? summary?.paperCount ?? papers.length
      : scope.kind === 'root'
        ? activeRoot?.paperCount ?? papers.length
        : scope.kind === 'user'
          ? scope.userView === 'favorites'
            ? summary?.favoriteCount ?? papers.length
            : scope.userView === 'reading_list'
              ? summary?.readingListCount ?? papers.length
              : summary?.reviewedCount ?? papers.length
          : papers.length
  const hasRoots = (summary?.rootCount ?? 0) > 0
  const visibleIssues = query.trim()
    ? issues.filter((issue) => {
        const needle = query.trim().toLowerCase()
        return `${issue.message} ${issue.relativePath} ${issue.rootLabel}`.toLowerCase().includes(needle)
      })
    : issues
  const visibleItems = papers.length + visibleIssues.length
  const unavailableRootIds = new Set(
    (summary?.roots ?? [])
      .filter((root) => root.status === 'unavailable' || root.status === 'error')
      .map((root) => root.id)
  )

  return (
    <section
      aria-label={title}
      className="library-pane"
      hidden={!visible}
      id={WORKSPACE_LIBRARY_PANEL_ID}
    >
      <div className="library-header">
        <div className="library-title-line">
          <div>
            <h1>{title}</h1>
            <p>
              {researchRadarActive
                ? `${formatNumber(count)} paper${count === 1 ? '' : 's'} in this analysis scope`
                : scope.kind === 'attention'
                ? `${formatNumber(visibleItems)}${hasMorePapers ? '+' : ''} item${visibleItems === 1 ? '' : 's'} to review`
                : `${formatNumber(count)} paper${count === 1 ? '' : 's'}`}
            </p>
          </div>
          {summary?.scanning && (
            <span className="scanning-badge">
              <Icon className="spin" name="refresh" size={14} />
              Indexing
            </span>
          )}
        </div>

        {activeRoot && (
          <div className={`root-health-banner root-health-${activeRoot.status}`} title={activeRoot.path}>
            <span className={`root-status-dot status-${activeRoot.status}`} />
            <span>{activeRoot.error || rootStatusLabel(activeRoot.status)}</span>
            <span className="root-health-time">Scanned {formatDate(activeRoot.lastScannedAt)}</span>
          </div>
        )}

        <label className="search-control">
          <Icon name="search" size={17} />
          <input
            aria-label="Search papers"
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search papers and full text"
            spellCheck={false}
            type="search"
            value={query}
          />
          {query && (
            <button aria-label="Clear search" onClick={() => onQueryChange('')} type="button">
              <Icon name="x" size={14} />
            </button>
          )}
        </label>

        <div className="list-toolbar">
          <span>{query ? 'Search results' : researchRadarActive ? 'Radar evidence' : 'Library'}</span>
          <label className="sort-control">
            <span className="sr-only">Sort papers</span>
            <select onChange={(event) => onSortChange(event.target.value as Sort)} value={sort}>
              <option value="updated">Recently updated</option>
              <option value="title">Title</option>
              <option value="year">Year</option>
            </select>
            <Icon name="chevron-down" size={13} />
          </label>
        </div>
      </div>

      <div className={`paper-list ${listBusy && visibleItems === 0 ? 'is-busy' : ''}`}>
        {listError && (
          <div className="list-resource-error" role="alert">
            <Icon name="triangle-alert" size={15} />
            <span>{listError}</span>
            <button onClick={onRetryList} type="button">Try again</button>
          </div>
        )}
        {!listError && listBusy && papers.length === 0 && visibleIssues.length === 0 ? (
          <ListSkeleton />
        ) : listError && visibleItems === 0 ? null : visibleItems === 0 ? (
          <ListEmpty
            addingRoot={addingRoot}
            hasRoots={hasRoots}
            onAddRoot={onAddRoot}
            query={query}
            scope={scope}
          />
        ) : (
          <>
            {scope.kind === 'attention' && visibleIssues.length > 0 && (
              <div className="list-group">
                <div className="list-group-label">Indexing issues</div>
                {visibleIssues.map((issue) => (
                  <IssueRow
                    issue={issue}
                    key={issue.id}
                    onSelect={() => onSelectIssue(issue)}
                    selected={issue.id === selectedIssueId}
                  />
                ))}
              </div>
            )}
            {scope.kind === 'attention' && papers.length > 0 && (
              <div className="list-group-label">Paper warnings</div>
            )}
            {papers.map((paper) => (
              <PaperRow
                key={paper.id}
                onSelect={() => onSelectPaper(paper.id)}
                paper={paper}
                selected={paper.id === selectedPaperId}
                showSnippet={Boolean(query)}
                unavailable={
                  paper.rootIds.length > 0 &&
                  paper.rootIds.every((rootId) => unavailableRootIds.has(rootId))
                }
              />
            ))}
            {hasMorePapers && (
              <div className="list-pagination">
                <span>
                  {query
                    ? `Showing ${formatNumber(papers.length)} matches`
                    : scope.kind === 'attention'
                      ? `Showing ${formatNumber(papers.length)} paper warnings`
                      : `Showing ${formatNumber(papers.length)} of ${formatNumber(count)} papers`}
                </span>
                <button disabled={loadingMorePapers} onClick={onLoadMore} type="button">
                  {loadingMorePapers && <Icon className="spin" name="refresh" size={13} />}
                  {loadingMorePapers ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
            {loadMoreError && (
              <div className="list-resource-error is-pagination-error" role="alert">
                <Icon name="triangle-alert" size={15} />
                <span>{loadMoreError}</span>
                <button onClick={onLoadMore} type="button">Retry load more</button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function PaperRow({
  paper,
  selected,
  showSnippet,
  unavailable,
  onSelect
}: {
  paper: PaperListItem
  selected: boolean
  showSnippet: boolean
  unavailable: boolean
  onSelect(): void
}): React.JSX.Element {
  const needsAttention = unavailable || paper.warningCount > 0 || paper.contentKind !== 'fulltext'
  const rootLabel = paper.rootLabels[0] ?? 'Unknown folder'
  const healthLabel = unavailable ? 'Source unavailable' : contentLabel(paper)
  const hasUserCues =
    paper.userState.favorite ||
    paper.userState.readingStatus !== 'none' ||
    paper.userState.hasNote ||
    paper.userState.tags.length > 0

  return (
    <button
      aria-current={selected ? 'true' : undefined}
      className={`paper-row ${selected ? 'is-selected' : ''}`}
      onClick={onSelect}
      type="button"
    >
      <span className="paper-row-heading">
        <span className="paper-row-title">{paper.title || 'Untitled paper'}</span>
        <span
          aria-label={healthLabel}
          className={`content-dot ${needsAttention ? 'has-warning' : ''} ${unavailable ? 'is-offline' : ''}`}
          role="img"
          title={healthLabel}
        >
          {needsAttention ? <Icon name="triangle-alert" size={11} /> : <Icon name="check" size={11} />}
          <span>{unavailable ? 'Offline' : needsAttention ? 'Review' : 'Ready'}</span>
        </span>
      </span>
      <span className="paper-row-authors">
        {paperAuthors(paper.authors)}
        {paper.journal && <em> · {paper.journal}</em>}
      </span>
      {hasUserCues && (
        <span className="paper-user-cues">
          {paper.userState.favorite && (
            <span className="paper-user-cue is-favorite" title="Favorite">
              <Icon name="star" size={12} />
              <span>Favorite</span>
            </span>
          )}
          {paper.userState.readingStatus !== 'none' && (
            <span className={`paper-user-cue status-${paper.userState.readingStatus}`}>
              {readingStatusLabel(paper.userState.readingStatus)}
            </span>
          )}
          {paper.userState.hasNote && (
            <span className="paper-user-cue is-note" title="Has a private note">
              <Icon name="note" size={12} />
              <span>Note</span>
            </span>
          )}
          {paper.userState.tags.slice(0, 2).map((tag) => (
            <span className="paper-user-tag" key={tag}>
              {tag}
            </span>
          ))}
          {paper.userState.tags.length > 2 && (
            <span className="paper-user-tag">+{paper.userState.tags.length - 2}</span>
          )}
        </span>
      )}
      {showSnippet && paper.searchSnippet && (
        <span className="search-snippet">{paper.searchSnippet}</span>
      )}
      <span className="paper-row-footer">
        <span className="source-chip">
          <Icon name="folder" size={12} />
          {rootLabel}
          {paper.rootLabels.length > 1 && ` +${paper.rootLabels.length - 1}`}
        </span>
        <span className="paper-row-year">{paper.year ?? 'No year'}</span>
        <span className="paper-row-updated">{relativeTime(paper.updatedAt)}</span>
      </span>
    </button>
  )
}

function IssueRow({
  issue,
  selected,
  onSelect
}: {
  issue: IndexIssue
  selected: boolean
  onSelect(): void
}): React.JSX.Element {
  return (
    <button
      className={`issue-row ${selected ? 'is-selected' : ''}`}
      onClick={onSelect}
      type="button"
    >
      <span className="issue-row-icon">
        <Icon name="triangle-alert" size={16} />
      </span>
      <span className="issue-row-copy">
        <strong>{issue.message}</strong>
        <span>{issue.relativePath}</span>
        <small>{issue.rootLabel}</small>
      </span>
    </button>
  )
}

function ListEmpty({
  scope,
  query,
  hasRoots,
  addingRoot,
  onAddRoot
}: {
  scope: Scope
  query: string
  hasRoots: boolean
  addingRoot: boolean
  onAddRoot(): void
}): React.JSX.Element {
  if (query) {
    return (
      <div className="list-empty">
        <span className="list-empty-icon">
          <Icon name="search" size={21} />
        </span>
        <strong>No matching papers</strong>
        <p>Try a title, author, DOI, or phrase from the full text.</p>
      </div>
    )
  }

  if (scope.kind === 'user') {
    const emptyCopy =
      scope.userView === 'favorites'
        ? {
            icon: 'star' as const,
            title: 'No favorites yet',
            message: 'Use the star on a paper to keep it close at hand.'
          }
        : scope.userView === 'reading_list'
          ? {
              icon: 'book-open' as const,
              title: 'Your reading list is empty',
              message: 'Set a paper to To read or Reading to add it here.'
            }
          : {
              icon: 'check' as const,
              title: 'Nothing reviewed yet',
              message: 'Mark a paper Reviewed when you finish with it.'
            }
    return (
      <div className="list-empty positive-empty">
        <span className="list-empty-icon">
          <Icon name={emptyCopy.icon} size={21} />
        </span>
        <strong>{emptyCopy.title}</strong>
        <p>{emptyCopy.message}</p>
      </div>
    )
  }

  if (scope.kind === 'attention') {
    return (
      <div className="list-empty positive-empty">
        <span className="list-empty-icon">
          <Icon name="check" size={21} />
        </span>
        <strong>Everything looks good</strong>
        <p>There are no paper or indexing issues to review.</p>
      </div>
    )
  }

  if (!hasRoots) {
    return (
      <div className="list-empty">
        <span className="list-empty-icon">
          <Icon name="folder-plus" size={21} />
        </span>
        <strong>No folders connected</strong>
        <p>Connect the project folders where your agents save papers.</p>
        <button className="secondary-button compact-button" disabled={addingRoot} onClick={onAddRoot} type="button">
          {addingRoot ? 'Opening…' : 'Connect folder'}
        </button>
      </div>
    )
  }

  return (
    <div className="list-empty">
      <span className="list-empty-icon">
        <Icon name="inbox" size={21} />
      </span>
      <strong>No papers here yet</strong>
      <p>PaperRelay will notice supported artifacts as agents add them.</p>
    </div>
  )
}

function PaperReader({
  paper,
  activeRootId,
  copyingAgentReference,
  digest,
  digestError,
  digestLoading,
  draftError,
  draftPersistenceStatus,
  draftRecoveredAt,
  hasUnsavedDraft,
  noteDraft,
  notesOpen,
  readerTab,
  reloading,
  revealLocationId,
  sourceChanged,
  tagDraft,
  userStateAction,
  onCopyAgentReference,
  onNoteDraftChange,
  onNotesOpenChange,
  onReload,
  onRetryDigest,
  onSaveNotes,
  onTagDraftChange,
  onTabChange,
  onReveal,
  onUpdateUserState
}: {
  paper: PaperDetail
  activeRootId: string | null
  copyingAgentReference: boolean
  digest: PaperDigest | null
  digestError: string | null
  digestLoading: boolean
  draftError: string | null
  draftPersistenceStatus: DraftPersistenceStatus
  draftRecoveredAt: string | null
  hasUnsavedDraft: boolean
  noteDraft: string
  notesOpen: boolean
  readerTab: ReaderTab
  reloading: boolean
  revealLocationId: string | null
  sourceChanged: boolean
  tagDraft: string
  userStateAction: UserStateAction | null
  onCopyAgentReference(): void
  onNoteDraftChange(value: string): void
  onNotesOpenChange(open: boolean): void
  onReload(): void
  onRetryDigest(): void
  onSaveNotes(): void
  onTagDraftChange(value: string): void
  onTabChange(tab: ReaderTab): void
  onReveal(location: PaperLocation): void
  onUpdateUserState(
    patch: PaperUserStatePatch,
    action: UserStateAction
  ): Promise<PaperUserState | null>
}): React.JSX.Element {
  const primaryLocation =
    paper.locations.find((location) => location.rootId === activeRootId) ?? paper.locations[0]
  const sectionIds = useMemo(
    () => paper.sections.map((section, index) => `${slug(section.heading, 'section')}-${index}`),
    [paper.sections]
  )
  const notesToggleRef = useRef<HTMLButtonElement>(null)
  const parsedTagDraft = useMemo(() => normalizeTagDraft(tagDraft), [tagDraft])
  const notesDirty = hasUnsavedDraft

  const notesVisible = notesOpen && readerTab === 'reader'

  const closeNotes = (): void => {
    onNotesOpenChange(false)
    window.requestAnimationFrame(() => notesToggleRef.current?.focus())
  }

  const toggleNotes = (): void => {
    if (notesVisible) {
      onNotesOpenChange(false)
      return
    }
    onNotesOpenChange(true)
    if (readerTab !== 'reader') onTabChange('reader')
  }

  const selectDigestEvidence = (evidence: InsightEvidence): void => {
    onTabChange('reader')
    const targetId = evidenceTargetId(evidence, paper)
    window.requestAnimationFrame(() => {
      const target = document.getElementById(targetId)
      if (!target) return
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.tabIndex = -1
      target.focus({ preventScroll: true })
    })
  }

  return (
    <div className="reader-shell">
      <div className="detail-topbar">
        <div className="detail-breadcrumbs">
          <span>Library</span>
          <span>/</span>
          <strong>{primaryLocation?.rootLabel ?? paper.rootLabels[0] ?? 'Research folder'}</strong>
        </div>
        <div className="detail-topbar-actions">
          <button
            aria-label={paper.userState.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
            aria-pressed={paper.userState.favorite}
            className={`favorite-toggle compact-button ${
              paper.userState.favorite ? 'is-active' : ''
            }`}
            disabled={userStateAction !== null}
            onClick={() =>
              void onUpdateUserState(
                { favorite: !paper.userState.favorite },
                'favorite'
              )
            }
            title={paper.userState.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
            type="button"
          >
            <Icon
              className={userStateAction === 'favorite' ? 'spin' : ''}
              name={userStateAction === 'favorite' ? 'refresh' : 'star'}
              size={14}
            />
            <span>{paper.userState.favorite ? 'Favorited' : 'Favorite'}</span>
          </button>
          <label className="reading-status-control">
            <span className="sr-only">Reading status</span>
            <select
              aria-label="Reading status"
              disabled={userStateAction !== null}
              onChange={(event) =>
                void onUpdateUserState(
                  { readingStatus: event.target.value as ReadingStatus },
                  'reading-status'
                )
              }
              value={paper.userState.readingStatus}
            >
              <option value="none">No status</option>
              <option value="to_read">To read</option>
              <option value="reading">Reading</option>
              <option value="reviewed">Reviewed</option>
            </select>
            <Icon
              className={userStateAction === 'reading-status' ? 'spin' : ''}
              name={userStateAction === 'reading-status' ? 'refresh' : 'chevron-down'}
              size={12}
            />
          </label>
          <button
            aria-label="Copy a paper reference for Codex"
            className="agent-reference-button compact-button"
            disabled={copyingAgentReference}
            onClick={onCopyAgentReference}
            title="Use with Codex"
            type="button"
          >
            <Icon className={copyingAgentReference ? 'spin' : ''} name={copyingAgentReference ? 'refresh' : 'bot'} size={15} />
            <span>{copyingAgentReference ? 'Copying…' : 'Use with Codex'}</span>
          </button>
          {primaryLocation && (
            <button
              aria-label="Show this paper in its folder"
              className="secondary-button compact-button"
              disabled={revealLocationId === primaryLocation.id}
              onClick={() => onReveal(primaryLocation)}
              title="Show in folder"
              type="button"
            >
              <Icon name="external" size={15} />
              <span>{revealLocationId === primaryLocation.id ? 'Opening…' : 'Show in folder'}</span>
            </button>
          )}
        </div>
      </div>

      <div className="reader-tabs">
        <div
          aria-label="Paper views"
          className="reader-tablist"
          onKeyDown={(event) => {
            const tabs = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
            )
            const currentIndex = tabs.findIndex((tab) => tab === document.activeElement)
            let nextIndex: number | null = null
            if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length
            if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
            if (event.key === 'Home') nextIndex = 0
            if (event.key === 'End') nextIndex = tabs.length - 1
            if (nextIndex === null || tabs.length === 0) return
            event.preventDefault()
            tabs[nextIndex]?.focus()
            tabs[nextIndex]?.click()
          }}
          role="tablist"
        >
          <button
            aria-controls="paper-reader-panel"
            aria-selected={readerTab === 'reader'}
            className={readerTab === 'reader' ? 'is-active' : ''}
            id="paper-reader-tab"
            onClick={() => onTabChange('reader')}
            role="tab"
            tabIndex={readerTab === 'reader' ? 0 : -1}
            type="button"
          >
            <Icon name="book-open" size={16} />
            Reader
          </button>
          <button
            aria-controls="paper-digest-panel"
            aria-selected={readerTab === 'digest'}
            className={readerTab === 'digest' ? 'is-active' : ''}
            id="paper-digest-tab"
            onClick={() => onTabChange('digest')}
            role="tab"
            tabIndex={readerTab === 'digest' ? 0 : -1}
            type="button"
          >
            <Icon name="sparkles" size={16} />
            Digest
            {digest && <span className="tab-count">{digest.items.length}</span>}
          </button>
          <button
            aria-controls="paper-sources-panel"
            aria-selected={readerTab === 'locations'}
            className={readerTab === 'locations' ? 'is-active' : ''}
            id="paper-sources-tab"
            onClick={() => onTabChange('locations')}
            role="tab"
            tabIndex={readerTab === 'locations' ? 0 : -1}
            type="button"
          >
            <Icon name="map-pin" size={16} />
            Sources
            <span className="tab-count">{paper.locations.length}</span>
          </button>
        </div>
        <button
          aria-controls={READER_NOTES_PANEL_ID}
          aria-expanded={notesVisible}
          aria-label={`${notesVisible ? 'Hide' : 'Show'} notes beside the article${
            notesDirty ? ', unsaved changes' : ''
          }`}
          className={`notes-pane-toggle ${notesVisible ? 'is-open' : ''} ${
            notesDirty ? 'has-unsaved-changes' : ''
          }`}
          onClick={toggleNotes}
          ref={notesToggleRef}
          title={notesVisible ? 'Hide notes panel' : 'Show notes beside the article'}
          type="button"
        >
          <Icon name="note" size={16} />
          <span>Notes</span>
          {(notesDirty || paper.userState.hasNote) && (
            <span
              aria-hidden="true"
              className={`tab-note-dot ${notesDirty ? 'is-unsaved' : ''}`}
            />
          )}
        </button>
      </div>

      {sourceChanged && (
        <div className="source-change-banner" role="status">
          <Icon name="refresh" size={15} />
          <span>The source changed on disk.</span>
          <button disabled={reloading} onClick={onReload} type="button">
            {reloading ? 'Reloading…' : 'Reload paper'}
          </button>
        </div>
      )}

      <div
        aria-labelledby="paper-reader-tab"
        className="reader-tab-panel"
        hidden={readerTab !== 'reader'}
        id="paper-reader-panel"
        role="tabpanel"
      >
        <ReaderWorkspaceLayout
          notes={
            <MyNotesContent
              hasUnsavedChanges={notesDirty}
              draftError={draftError}
              draftPersistenceStatus={draftPersistenceStatus}
              draftRecoveredAt={draftRecoveredAt}
              noteDraft={noteDraft}
              onClose={closeNotes}
              onNoteChange={onNoteDraftChange}
              onSave={onSaveNotes}
              onTagChange={onTagDraftChange}
              saveBusy={userStateAction === 'notes'}
              saveDisabled={!notesDirty || Boolean(parsedTagDraft.error)}
              tagDraft={tagDraft}
              tagError={parsedTagDraft.error}
            />
          }
          notesOpen={notesOpen}
          reader={<ReaderContent paper={paper} sectionIds={sectionIds} />}
        />
      </div>
      <div
        aria-labelledby="paper-digest-tab"
        className="reader-tab-panel"
        hidden={readerTab !== 'digest'}
        id="paper-digest-panel"
        role="tabpanel"
      >
        <PaperDigestContent
          digest={digest}
          error={digestError}
          loading={digestLoading}
          onRetry={onRetryDigest}
          onSelectEvidence={selectDigestEvidence}
        />
      </div>
      <div
        aria-labelledby="paper-sources-tab"
        className="reader-tab-panel"
        hidden={readerTab !== 'locations'}
        id="paper-sources-panel"
        role="tabpanel"
      >
        <LocationsContent
          onReveal={onReveal}
          paper={paper}
          revealLocationId={revealLocationId}
        />
      </div>
    </div>
  )
}

export function MyNotesContent({
  hasUnsavedChanges,
  draftError = null,
  draftPersistenceStatus = 'idle',
  draftRecoveredAt = null,
  initialNoteMode = 'write',
  noteDraft,
  tagDraft,
  tagError,
  saveBusy,
  saveDisabled,
  onClose,
  onNoteChange,
  onTagChange,
  onSave
}: {
  hasUnsavedChanges: boolean
  draftError?: string | null
  draftPersistenceStatus?: DraftPersistenceStatus
  draftRecoveredAt?: string | null
  initialNoteMode?: NoteMode
  noteDraft: string
  tagDraft: string
  tagError: string | null
  saveBusy: boolean
  saveDisabled: boolean
  onClose(): void
  onNoteChange(value: string): void
  onTagChange(value: string): void
  onSave(): void
}): React.JSX.Element {
  const [noteMode, setNoteMode] = useState<NoteMode>(initialNoteMode)

  return (
    <div className="notes-workspace">
      <div className="notes-scroll">
        <div className="notes-content">
          <header className="notes-header">
            <span className="notes-header-icon">
              <Icon name="note" size={22} />
            </span>
            <div>
              <h2 id={READER_NOTES_HEADING_ID}>My Notes</h2>
              <p>
                Private to this PaperRelay library. Your paper and source files are never changed.
              </p>
            </div>
            <button
              aria-label="Close notes panel"
              onClick={onClose}
              title="Close notes"
              type="button"
            >
              <Icon name="x" size={15} />
            </button>
          </header>

          {draftRecoveredAt && (
            <div className="recovered-draft-banner" role="status">
              <Icon name="archive" size={15} />
              <span>
                <strong>Recovered unsaved draft</strong>
                <small>Saved locally {formatDate(draftRecoveredAt)}</small>
              </span>
            </div>
          )}

          <section aria-labelledby="paper-private-note-label" className="notes-editor-card">
            <div className="note-editor-heading">
              <span className="note-editor-label" id="paper-private-note-label">
                Private note
              </span>
              <div
                aria-label="Note view"
                className="note-mode-tabs"
                onKeyDown={(event) => {
                  const tabs = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  )
                  const currentIndex = tabs.findIndex((tab) => tab === document.activeElement)
                  let nextIndex: number | null = null
                  if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length
                  if (event.key === 'ArrowLeft') {
                    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
                  }
                  if (event.key === 'Home') nextIndex = 0
                  if (event.key === 'End') nextIndex = tabs.length - 1
                  if (nextIndex === null || tabs.length === 0) return
                  event.preventDefault()
                  tabs[nextIndex]?.focus()
                  tabs[nextIndex]?.click()
                }}
                role="tablist"
              >
                <button
                  aria-controls="paper-note-write-panel"
                  aria-selected={noteMode === 'write'}
                  className={noteMode === 'write' ? 'is-active' : ''}
                  id="paper-note-write-tab"
                  onClick={() => setNoteMode('write')}
                  role="tab"
                  tabIndex={noteMode === 'write' ? 0 : -1}
                  type="button"
                >
                  Write
                </button>
                <button
                  aria-controls="paper-note-preview-panel"
                  aria-selected={noteMode === 'preview'}
                  className={noteMode === 'preview' ? 'is-active' : ''}
                  id="paper-note-preview-tab"
                  onClick={() => setNoteMode('preview')}
                  role="tab"
                  tabIndex={noteMode === 'preview' ? 0 : -1}
                  type="button"
                >
                  Preview
                </button>
              </div>
            </div>
            <p className="note-format-help" id="paper-note-format-help">
              Markdown, safe HTML, TeX, and web links are supported. Use $…$ for inline math
              and $$…$$ for display math.
            </p>
            <div className="note-markdown-surface">
              <div
                aria-labelledby="paper-note-write-tab"
                className="note-mode-panel"
                hidden={noteMode !== 'write'}
                id="paper-note-write-panel"
                role="tabpanel"
              >
                <textarea
                  aria-describedby="paper-note-format-help"
                  aria-labelledby="paper-private-note-label"
                  id="paper-private-note"
                  maxLength={MAX_NOTE_CHARACTERS}
                  onChange={(event) => onNoteChange(event.target.value)}
                  placeholder="Write in Markdown, add a safe HTML snippet, or include TeX like $E = mc^2$…"
                  value={noteDraft}
                />
              </div>
              <div
                aria-labelledby="paper-note-preview-tab"
                className="note-mode-panel note-preview-panel"
                hidden={noteMode !== 'preview'}
                id="paper-note-preview-panel"
                role="tabpanel"
                tabIndex={noteMode === 'preview' ? 0 : -1}
              >
                {noteMode === 'preview' && <NotePreview markdown={noteDraft} />}
              </div>
            </div>
            <div className="notes-field-meta">
              <span>Drafts recover locally. Save notes commits them to your library.</span>
              <span>
                {formatNumber(noteDraft.length)} / {formatNumber(MAX_NOTE_CHARACTERS)}
              </span>
            </div>
          </section>

          <section className="tag-editor-card">
            <label htmlFor="paper-private-tags">Tags</label>
            <input
              aria-describedby="paper-tags-help"
              aria-invalid={Boolean(tagError)}
              id="paper-private-tags"
              maxLength={MAX_TAG_INPUT_CHARACTERS}
              onChange={(event) => onTagChange(event.target.value)}
              placeholder="permafrost, methods, to cite"
              type="text"
              value={tagDraft}
            />
            <p className={tagError ? 'notes-validation-error' : undefined} id="paper-tags-help">
              {tagError ?? `Separate tags with commas. Up to ${MAX_TAGS} tags.`}
            </p>
          </section>
        </div>
      </div>
      <div className="notes-save-row">
        <span aria-live="polite">
          {saveBusy
            ? 'Saving your private notes…'
            : tagError
              ? 'Fix the tags before saving'
              : draftError
                ? `Draft save failed: ${draftError}`
                : draftPersistenceStatus === 'saving'
                  ? 'Saving draft locally…'
                  : hasUnsavedChanges && draftPersistenceStatus === 'saved'
                    ? 'Draft saved locally · choose Save notes to commit'
                    : hasUnsavedChanges
                      ? 'Unsaved changes'
                      : 'All saved'}
        </span>
        <button
          className="primary-button"
          disabled={saveBusy || saveDisabled}
          onClick={onSave}
          type="button"
        >
          <Icon className={saveBusy ? 'spin' : ''} name={saveBusy ? 'refresh' : 'check'} size={15} />
          {saveBusy ? 'Saving…' : 'Save notes'}
        </button>
      </div>
    </div>
  )
}

function ReaderContent({
  paper,
  sectionIds
}: {
  paper: PaperDetail
  sectionIds: string[]
}): React.JSX.Element {
  const displayedSections = visibleReaderSections(paper.sections, paper.abstract)
  const sectionReferences = paper.sections.flatMap((section) =>
    isReferenceSection(section) ? parseNumberedReferences(section.text) : []
  )
  const structuredReferences = numberStructuredReferences(paper.references)
  const usesReferenceFallback = sectionReferences.length === 0 && structuredReferences.length > 0
  const references = usesReferenceFallback ? structuredReferences : sectionReferences
  const readerSections = usesReferenceFallback
    ? displayedSections.filter(({ section }) => !isReferenceSection(section))
    : displayedSections
  const referenceNumbers = [...new Set(references.map((reference) => reference.number))]
  const referenceAliases = extractAuthorYearAliases(
    structuredReferences.length > 0 ? structuredReferences : references
  )
  const visibleAssets = readerAssets(paper.assets)
  const unmatchedAssets = visibleAssets.filter(
    (asset) => !readerSections.some(({ section }) => asset.section === section.heading)
  )

  return (
    <div className="reader-scroll">
      <article className="paper-article">
        <header className="article-header" id="paper-article-header">
          <div className="article-kicker">
            <span className={`kind-pill kind-${paper.contentKind}`}>{contentLabel(paper)}</span>
            {paper.journal && <span>{paper.journal}</span>}
            {paper.year && <span>{paper.year}</span>}
          </div>
          <h1>{paper.title || 'Untitled paper'}</h1>
          <p className="article-authors">{paperAuthors(paper.authors)}</p>
          <div className="article-identifiers">
            {paper.doi && (
              <span>
                <Icon name="link" size={13} /> DOI {paper.doi}
              </span>
            )}
            {paper.published && (
              <span>
                <Icon name="clock" size={13} /> Published {formatDate(paper.published)}
              </span>
            )}
            {paper.source && <span>{paper.source}</span>}
          </div>
        </header>

        {paper.warnings.length > 0 && (
          <div className="reader-warning">
            <Icon name="triangle-alert" size={17} />
            <div>
              <strong>{paper.warnings.length === 1 ? 'One item needs attention' : `${paper.warnings.length} items need attention`}</strong>
              <span>{paper.warnings[0]}</span>
            </div>
          </div>
        )}

        {paper.abstract && (
          <section className="abstract-block" id="paper-abstract">
            <div className="section-label">Abstract</div>
            <TextBlocks
              referenceAliases={referenceAliases}
              referenceNumbers={referenceNumbers}
              text={paper.abstract}
            />
          </section>
        )}

        {readerSections.length > 0 && (
          <nav className="table-of-contents" aria-label="On this paper">
            <span>On this paper</span>
            <div>
              {readerSections
                .filter(({ section }) => section.level <= 2)
                .slice(0, 10)
                .map(({ section, index }) => (
                  <a href={`#${sectionIds[index]}`} key={`${section.heading}-${index}`}>
                    {section.heading}
                  </a>
                ))}
            </div>
          </nav>
        )}

        <div className="article-body">
          {readerSections.map(({ section, index }) => {
            const matchingAssets = visibleAssets.filter((asset) => asset.section === section.heading)
            return (
              <PaperSectionView
                assets={matchingAssets}
                id={sectionIds[index] ?? `section-${index}`}
                key={`${section.heading}-${index}`}
                referenceAliases={referenceAliases}
                referenceNumbers={referenceNumbers}
                section={section}
              />
            )
          })}
          {usesReferenceFallback && (
            <section className="paper-section section-level-1" id="paper-references">
              <h2>References</h2>
              <ReferenceList references={references} />
            </section>
          )}
        </div>

        {unmatchedAssets.length > 0 && (
          <section className="asset-gallery">
            <div className="section-label">Figures &amp; tables</div>
            {unmatchedAssets.map((asset, index) => (
              <AssetFigure asset={asset} key={`${asset.heading}-${index}`} />
            ))}
          </section>
        )}

        {paper.sections.length === 0 && !paper.abstract && (
          <div className="no-readable-content">
            <Icon name="file" size={25} />
            <strong>No readable text was extracted</strong>
            <p>Open Sources to inspect the source artifact and its reading status.</p>
          </div>
        )}

        <footer className="article-footer">
          <span>Indexed locally by PaperRelay</span>
          <span>Source files are read-only</span>
        </footer>
      </article>
    </div>
  )
}

function PaperSectionView({
  section,
  assets,
  id,
  referenceNumbers,
  referenceAliases
}: {
  section: PaperSection
  assets: PaperAsset[]
  id: string
  referenceNumbers: readonly number[]
  referenceAliases: readonly AuthorYearReferenceAlias[]
}): React.JSX.Element {
  const Heading = section.level <= 1 ? 'h2' : section.level === 2 ? 'h3' : 'h4'
  const numberedReferences = isReferenceSection(section)
    ? parseNumberedReferences(section.text)
    : []
  return (
    <section className={`paper-section section-level-${section.level}`} id={id}>
      <Heading>{section.heading}</Heading>
      {numberedReferences.length > 0 ? (
        <ReferenceList references={numberedReferences} />
      ) : (
        <TextBlocks
          referenceAliases={referenceAliases}
          referenceNumbers={referenceNumbers}
          text={section.text}
        />
      )}
      {assets.map((asset, index) => (
        <AssetFigure asset={asset} key={`${asset.heading}-${index}`} />
      ))}
    </section>
  )
}

function ReferenceList({
  references
}: {
  references: readonly NumberedReference[]
}): React.JSX.Element {
  const anchoredReferences = new Set<number>()
  return (
    <ol className="paper-reference-list">
      {references.map((reference, index) => {
        const exposeAnchor = !anchoredReferences.has(reference.number)
        anchoredReferences.add(reference.number)
        return (
          <li
            id={exposeAnchor ? referenceAnchorId(reference.number) : undefined}
            key={`${reference.number}-${index}`}
            value={reference.number}
          >
            <MathText text={reference.text} />
          </li>
        )
      })}
    </ol>
  )
}

export function TextBlocks({
  text,
  referenceNumbers = [],
  referenceAliases = []
}: {
  text: string
  referenceNumbers?: readonly number[]
  referenceAliases?: readonly AuthorYearReferenceAlias[]
}): React.JSX.Element {
  const blocks = splitMathTextBlocks(text)

  return (
    <>
      {blocks.map((block, index) => {
        const lines = block.split('\n').map((line) => line.trim())
        const table = parseMarkdownTable(block)
        const bulletList = lines.length > 1 && lines.every((line) => /^[-*•]\s+/.test(line))
        const numberedList = lines.length > 1 && lines.every((line) => /^\d+[.)]\s+/.test(line))

        if (table) {
          return (
            <div className="paper-table-scroll" key={index}>
              <table className="paper-table">
                <thead>
                  <tr>
                    {table.headers.map((header, columnIndex) => (
                      <th
                        key={columnIndex}
                        scope="col"
                        style={{ textAlign: table.alignments[columnIndex] ?? 'left' }}
                      >
                        <MathText
                          linkNumericCitations={false}
                          referenceAliases={referenceAliases}
                          referenceNumbers={referenceNumbers}
                          text={header}
                        />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, columnIndex) => (
                        <td
                          key={columnIndex}
                          style={{ textAlign: table.alignments[columnIndex] ?? 'left' }}
                        >
                          <MathText
                            linkNumericCitations={false}
                            referenceAliases={referenceAliases}
                            referenceNumbers={referenceNumbers}
                            text={cell}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }

        if (bulletList) {
          return (
            <ul key={index}>
              {lines.map((line, lineIndex) => (
                <li key={lineIndex}>
                  <MathText
                    referenceAliases={referenceAliases}
                    referenceNumbers={referenceNumbers}
                    text={line.replace(/^[-*•]\s+/, '')}
                  />
                </li>
              ))}
            </ul>
          )
        }

        if (numberedList) {
          return (
            <ol key={index}>
              {lines.map((line, lineIndex) => (
                <li key={lineIndex}>
                  <MathText
                    referenceAliases={referenceAliases}
                    referenceNumbers={referenceNumbers}
                    text={line.replace(/^\d+[.)]\s+/, '')}
                  />
                </li>
              ))}
            </ol>
          )
        }

        const paragraph = lines.join(' ')
        if (isDisplayMathText(paragraph)) {
          return (
            <div className="paper-math-block" key={index}>
              <MathText
                referenceAliases={referenceAliases}
                referenceNumbers={referenceNumbers}
                text={paragraph}
              />
            </div>
          )
        }

        return (
          <p key={index}>
            <MathText
              referenceAliases={referenceAliases}
              referenceNumbers={referenceNumbers}
              text={paragraph}
            />
          </p>
        )
      })}
    </>
  )
}

function assetSource(asset: PaperAsset): string | null {
  return asset.previewUrl ?? null
}

function AssetFigure({ asset }: { asset: PaperAsset }): React.JSX.Element {
  const [previewFailed, setPreviewFailed] = useState(false)
  const source = asset.available && !previewFailed ? assetSource(asset) : null

  useEffect(() => {
    setPreviewFailed(false)
  }, [asset.previewUrl])

  return (
    <figure className="paper-asset">
      {source ? (
        <img
          alt={asset.caption ?? asset.heading}
          loading="lazy"
          onError={() => setPreviewFailed(true)}
          src={source}
        />
      ) : (
        <div className="asset-placeholder">
          <Icon name="file" size={22} />
          <span>{asset.available ? 'Preview unavailable' : 'Asset not found'}</span>
        </div>
      )}
      <figcaption>
        <strong>{asset.heading || asset.kind}</strong>
        {asset.caption && <span>{asset.caption}</span>}
      </figcaption>
    </figure>
  )
}

function LocationsContent({
  paper,
  revealLocationId,
  onReveal
}: {
  paper: PaperDetail
  revealLocationId: string | null
  onReveal(location: PaperLocation): void
}): React.JSX.Element {
  return (
    <div className="locations-scroll">
      <div className="locations-content">
        <header className="locations-header">
          <span className="locations-icon">
            <Icon name="map-pin" size={22} />
          </span>
          <div>
            <h2>Source locations</h2>
            <p>PaperRelay indexes these files in place. It never moves or edits them.</p>
          </div>
        </header>

        <div className="paper-stat-grid">
          <StatCard label="Sections" value={paper.sectionCount} />
          <StatCard label="Assets" value={paper.assetCount} />
          <StatCard label="References" value={paper.referenceCount} />
          <StatCard label="Est. tokens" value={paper.tokenEstimate} />
        </div>

        <div className="locations-list">
          {paper.locations.map((location) => (
            <div className="location-card" key={location.id}>
              <div className="location-card-top">
                <span className="location-folder-icon">
                  <Icon name="folder" size={18} />
                </span>
                <div>
                  <strong>{location.rootLabel}</strong>
                  <span>{location.relativePath || 'Project root'}</span>
                </div>
                <span className={`parse-pill parse-${location.parseStatus}`}>
                  {location.parseStatus === 'ready'
                    ? 'Ready'
                    : location.parseStatus === 'incomplete'
                      ? 'Incomplete'
                      : 'Unreadable'}
                </span>
              </div>
              <div className="path-box" title={location.artifactPath}>
                {location.artifactPath}
              </div>
              <div className="location-card-footer">
                <span>
                  Detected by {location.detector} · Updated {formatDate(location.modifiedAt)}
                </span>
                <button
                  className="secondary-button compact-button"
                  disabled={revealLocationId === location.id}
                  onClick={() => onReveal(location)}
                  type="button"
                >
                  <Icon name="external" size={14} />
                  {revealLocationId === location.id ? 'Opening…' : 'Reveal'}
                </button>
              </div>
            </div>
          ))}
        </div>

        {paper.sourceTrail.length > 0 && (
          <section className="provenance-panel">
            <div className="section-label">Provenance</div>
            <div className="provenance-trail">
              {paper.sourceTrail.map((entry, index) => (
                <span key={`${entry}-${index}`}>
                  <span className="trail-number">{index + 1}</span>
                  {entry}
                </span>
              ))}
            </div>
          </section>
        )}

        {paper.warnings.length > 0 && (
          <section className="warnings-panel">
            <div className="section-label">Indexing notes</div>
            {paper.warnings.map((warning, index) => (
              <div className="warning-row" key={`${warning}-${index}`}>
                <Icon name="triangle-alert" size={15} />
                <span>{warning}</span>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="stat-card">
      <strong>{formatNumber(value)}</strong>
      <span>{label}</span>
    </div>
  )
}

function IssueDetail({
  issue,
  rescanning,
  onBack,
  onRescan
}: {
  issue: IndexIssue
  rescanning: boolean
  onBack(): void
  onRescan(rootId: string): void
}): React.JSX.Element {
  return (
    <div className="issue-detail">
      <div className="detail-topbar">
        <button className="tertiary-button" onClick={onBack} type="button">
          <Icon name="arrow-left" size={16} />
          Back to papers
        </button>
      </div>
      <div className="issue-detail-body">
        <span className="large-warning-icon">
          <Icon name="triangle-alert" size={28} />
        </span>
        <div className="issue-eyebrow">Indexing issue</div>
        <h1>{issue.message}</h1>
        <p>
          PaperRelay left the source untouched. Review the artifact or rescan after an external agent
          updates it.
        </p>

        <dl className="issue-facts">
          <div>
            <dt>Research folder</dt>
            <dd>{issue.rootLabel}</dd>
          </div>
          <div>
            <dt>Artifact</dt>
            <dd>{issue.relativePath}</dd>
          </div>
          <div>
            <dt>Full path</dt>
            <dd className="mono-value">{issue.path}</dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>{formatDate(issue.updatedAt)}</dd>
          </div>
        </dl>

        <button
          className="primary-button"
          disabled={rescanning}
          onClick={() => onRescan(issue.rootId)}
          type="button"
        >
          <Icon className={rescanning ? 'spin' : ''} name="refresh" size={16} />
          {rescanning ? 'Rescanning…' : 'Rescan research folder'}
        </button>
      </div>
    </div>
  )
}

function WorkspaceEmpty({
  hasRoots,
  addingRoot,
  onAddRoot
}: {
  hasRoots: boolean
  addingRoot: boolean
  onAddRoot(): void
}): React.JSX.Element {
  return (
    <div className="workspace-empty">
      <div className="empty-illustration" aria-hidden="true">
        <div className="empty-paper paper-one">
          <span />
          <span />
          <span />
        </div>
        <div className="empty-paper paper-two">
          <span />
          <span />
          <span />
        </div>
        <div className="relay-line" />
        <div className="relay-node node-one" />
        <div className="relay-node node-two" />
        <div className="empty-spark">✦</div>
      </div>
      <div className="empty-eyebrow">
        <Icon name="sparkles" size={14} />
        One library, every project
      </div>
      <h1>{hasRoots ? 'Waiting for your first paper' : 'Your research, wherever it lives'}</h1>
      <p>
        {hasRoots
          ? 'Keep using your agent-based paper workflow. New structured artifacts will appear here automatically.'
          : 'Connect the project folders where Codex and paper-fetch save structured articles. PaperRelay indexes them in place—nothing is moved or rewritten.'}
      </p>
      {!hasRoots && (
        <button className="primary-button hero-button" disabled={addingRoot} onClick={onAddRoot} type="button">
          <Icon name="folder-plus" size={18} />
          {addingRoot ? 'Opening folder picker…' : 'Connect research folder'}
        </button>
      )}
      <div className="empty-trust-row">
        <span>
          <Icon name="check" size={14} /> Local index
        </span>
        <span>
          <Icon name="check" size={14} /> Read-only sources
        </span>
        <span>
          <Icon name="check" size={14} /> Agent-ready
        </span>
      </div>
    </div>
  )
}

export function DraftTransitionDialog({
  busyAction,
  currentPaperTitle,
  destination,
  error,
  lifecycleRecovery = false,
  onCancel,
  onDiscard,
  onSave,
  saveDisabled
}: {
  busyAction: 'save' | 'discard' | null
  currentPaperTitle: string
  destination: string
  error: string | null
  lifecycleRecovery?: boolean
  onCancel(): void
  onDiscard(): void
  onSave(): void
  saveDisabled: boolean
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        aria-describedby="draft-transition-description"
        aria-labelledby="draft-transition-title"
        aria-modal="true"
        className="modal-card"
        role="dialog"
      >
        <span className="modal-icon">
          <Icon name="note" size={21} />
        </span>
        <h2 id="draft-transition-title">
          {lifecycleRecovery
            ? 'Draft could not be saved locally'
            : 'Save changes before continuing?'}
        </h2>
        <p id="draft-transition-description">
          {lifecycleRecovery
            ? `PaperRelay could not finish storing the draft for “${currentPaperTitle}” before ${destination}. Retry, discard the draft and continue, or keep editing.`
            : `Your draft for “${currentPaperTitle}” is recoverable on this device. Before ${destination}, save it to your private library, discard it, or keep editing.`}
        </p>
        {error && <p className="modal-validation-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button autoFocus className="secondary-button" disabled={busyAction !== null} onClick={onCancel} type="button">
            Keep editing
          </button>
          <button className="danger-button" disabled={busyAction !== null} onClick={onDiscard} type="button">
            {busyAction === 'discard'
              ? 'Discarding…'
              : lifecycleRecovery
                ? 'Discard draft and continue'
                : 'Discard and continue'}
          </button>
          <button className="primary-button" disabled={busyAction !== null || saveDisabled} onClick={onSave} type="button">
            {busyAction === 'save'
              ? 'Saving…'
              : lifecycleRecovery
                ? 'Retry and continue'
                : 'Save and continue'}
          </button>
        </div>
      </div>
    </div>
  )
}

function RemoveRootDialog({
  root,
  busy,
  onCancel,
  onConfirm
}: {
  root: RootSummary
  busy: boolean
  onCancel(): void
  onConfirm(): void
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation">
      <div aria-labelledby="remove-root-title" aria-modal="true" className="modal-card" role="dialog">
        <span className="modal-icon danger-icon">
          <Icon name="trash" size={21} />
        </span>
        <h2 id="remove-root-title">Remove “{root.label}”?</h2>
        <p>
          PaperRelay will remove this folder and its records from the local index. Your original
          papers and project files will remain exactly where they are.
        </p>
        <div className="modal-path" title={root.path}>
          {root.path}
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="danger-button" disabled={busy} onClick={onConfirm} type="button">
            {busy ? 'Please wait…' : 'Remove from PaperRelay'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Toast({ toast }: { toast: ToastState }): React.JSX.Element {
  return (
    <div aria-live="polite" className={`toast toast-${toast.tone}`} role="status">
      <span className="toast-icon">
        <Icon
          name={toast.tone === 'error' ? 'triangle-alert' : toast.tone === 'success' ? 'check' : 'inbox'}
          size={15}
        />
      </span>
      {toast.message}
    </div>
  )
}

function ListSkeleton(): React.JSX.Element {
  return (
    <div className="list-skeleton" aria-label="Loading papers">
      {[0, 1, 2, 3, 4].map((item) => (
        <div className="skeleton-row" key={item}>
          <span className="skeleton-line skeleton-title" />
          <span className="skeleton-line skeleton-author" />
          <span className="skeleton-line skeleton-meta" />
        </div>
      ))}
    </div>
  )
}

function ReaderSkeleton(): React.JSX.Element {
  return (
    <div className="reader-skeleton" aria-label="Loading paper">
      <div className="detail-topbar" />
      <div className="skeleton-article">
        <span className="skeleton-line skeleton-kicker" />
        <span className="skeleton-line skeleton-heading-large" />
        <span className="skeleton-line skeleton-heading-medium" />
        <span className="skeleton-line skeleton-author" />
        <div className="skeleton-paragraph">
          <span className="skeleton-line" />
          <span className="skeleton-line" />
          <span className="skeleton-line short" />
        </div>
      </div>
    </div>
  )
}

function BridgeUnavailable(): React.JSX.Element {
  return (
    <div className="bridge-unavailable">
      <span>
        <Icon name="triangle-alert" size={24} />
      </span>
      <h1>PaperRelay could not start</h1>
      <p>The secure desktop bridge is unavailable. Close and reopen the application.</p>
    </div>
  )
}

export default App
