export type RootStatus = 'pending' | 'scanning' | 'ready' | 'empty' | 'unavailable' | 'error'
export type ContentKind = 'fulltext' | 'abstract_only' | 'metadata_only'
export type ParseStatus = 'ready' | 'incomplete' | 'unreadable'
export type PaperReadingStatus = 'none' | 'to_read' | 'reading' | 'reviewed'
export type PaperUserView = 'favorites' | 'reading_list' | 'reviewed'
export type InsightKind = 'purpose' | 'method' | 'finding' | 'limitation' | 'future_work'
export type InsightEvidenceSource = 'section' | 'abstract' | 'keyword' | 'reference'
export type ResearchGraphNodeKind =
  | 'paper'
  | 'topic'
  | 'finding'
  | 'limitation'
  | 'future_work'
  | 'external_reference'
export type ResearchGraphEdgeKind =
  | 'has_topic'
  | 'reports_finding'
  | 'states_limitation'
  | 'proposes_future_work'
  | 'cites'
export type ResearchSignalBasis =
  | 'author_stated'
  | 'local_corpus_hypothesis'
  | 'local_coverage_gap'

export interface PaperUserSummary {
  favorite: boolean
  readingStatus: PaperReadingStatus
  tags: string[]
  hasNote: boolean
  lastOpenedAt: string | null
  updatedAt: string | null
}

export interface PaperUserState extends PaperUserSummary {
  note: string
}

export interface PaperUserStatePatch {
  favorite?: boolean
  readingStatus?: PaperReadingStatus
  tags?: string[]
  note?: string
}

export interface PaperUserDraftInput {
  note: string
  tagInput: string
}

export interface PaperUserDraft extends PaperUserDraftInput {
  paperId: string
  baseStateUpdatedAt: string | null
  updatedAt: string
}

export type AppCloseKind = 'window' | 'quit'

export interface AppCloseRequest {
  id: string
  kind: AppCloseKind
}

export interface RootSummary {
  id: string
  path: string
  label: string
  status: RootStatus
  error: string | null
  paperCount: number
  issueCount: number
  lastScannedAt: string | null
  createdAt: string
}

export interface LibrarySummary {
  paperCount: number
  fullTextCount: number
  issueCount: number
  favoriteCount: number
  readingListCount: number
  reviewedCount: number
  rootCount: number
  scanning: boolean
  roots: RootSummary[]
}

export interface PaperListItem {
  id: string
  title: string
  authors: string[]
  year: string | null
  journal: string | null
  doi: string | null
  source: string | null
  contentKind: ContentKind
  confidence: string | null
  warningCount: number
  sectionCount: number
  assetCount: number
  locationCount: number
  rootIds: string[]
  rootLabels: string[]
  updatedAt: string
  searchSnippet: string | null
  userState: PaperUserSummary
}

export interface PaperSearchRequest {
  query?: string
  rootId?: string
  attention?: boolean
  sort?: 'updated' | 'title' | 'year'
  limit?: number
  offset?: number
  userView?: PaperUserView
}

export interface PaperSection {
  heading: string
  level: number
  kind: string
  text: string
}

export interface PaperAsset {
  kind: string
  heading: string
  caption: string | null
  path: string | null
  url: string | null
  section: string | null
  available: boolean
  previewUrl?: string | null
}

export interface PaperReference {
  raw: string
  doi: string | null
  title: string | null
  year: string | null
}

export interface PaperLocation {
  id: string
  rootId: string
  rootLabel: string
  rootPath: string
  artifactPath: string
  relativePath: string
  detector: string
  modifiedAt: string
  parseStatus: ParseStatus
}

export interface PaperDetail extends PaperListItem {
  userState: PaperUserState
  userDraft: PaperUserDraft | null
  abstract: string | null
  published: string | null
  keywords: string[]
  warnings: string[]
  flags: string[]
  sourceTrail: string[]
  tokenEstimate: number
  referenceCount: number
  references: PaperReference[]
  sections: PaperSection[]
  assets: PaperAsset[]
  locations: PaperLocation[]
}

export interface InsightEvidence {
  id: string
  source: InsightEvidenceSource
  paperId: string
  rootId: string | null
  revision: string
  sectionIndex: number | null
  sectionHeading: string | null
  sectionKind: string | null
  sourceIndex: number | null
  startOffset: number
  endOffset: number
  quote: string
  truncated: boolean
}

export interface DigestItem {
  id: string
  kind: InsightKind
  text: string
  evidenceId: string
}

export interface PaperDigestCoverage {
  contentKind: ContentKind
  availableKinds: InsightKind[]
  missingKinds: InsightKind[]
  limited: boolean
  message: string | null
}

export interface PaperDigest {
  paperId: string
  rootId: string | null
  revision: string
  title: string
  items: DigestItem[]
  evidence: InsightEvidence[]
  coverage: PaperDigestCoverage
  disclaimer: string
}

export interface ResearchGraphNode {
  id: string
  kind: ResearchGraphNodeKind
  label: string
  paperId: string | null
  doi: string | null
  year: string | null
  evidenceIds: string[]
}

export interface ResearchGraphEdge {
  id: string
  kind: ResearchGraphEdgeKind
  sourceId: string
  targetId: string
  evidenceIds: string[]
}

export interface ResearchSignal {
  id: string
  basis: ResearchSignalBasis
  title: string
  statement: string
  rationale: string
  paperIds: string[]
  evidenceIds: string[]
  noveltyRequiresExternalChecking: boolean
}

export interface ResearchLandscapeRequest {
  rootId?: string
  limit?: number
}

export interface ResearchLandscapeTruncation {
  truncated: boolean
  omittedPaperCount: number
  omittedNodeCount: number
  omittedEdgeCount: number
  omittedEvidenceCount: number
}

export interface ResearchLandscape {
  rootId: string | null
  paperCount: number
  analyzedPaperCount: number
  nodes: ResearchGraphNode[]
  edges: ResearchGraphEdge[]
  evidence: InsightEvidence[]
  signals: ResearchSignal[]
  truncation: ResearchLandscapeTruncation
  noveltyRequiresExternalChecking: true
  disclaimer: string
}

export interface IndexIssue {
  id: string
  rootId: string
  rootLabel: string
  path: string
  relativePath: string
  message: string
  updatedAt: string
}

export interface ScanResult {
  rootId: string
  discovered: number
  indexed: number
  unchanged: number
  issues: number
  removed: number
  startedAt: string
  finishedAt: string
}

export interface AgentRelaySetup {
  available: boolean
  databasePath: string
  serverPath: string
  codexConfig: string
  cliCommand: string
  testPrompt: string
  error: string | null
}

export type AgentTerminalAccess = 'read-only' | 'workspace-write'

export interface AgentTerminalStartRequest {
  rootId: string
  access?: AgentTerminalAccess
  cols?: number
  rows?: number
}

export interface AgentTerminalSession {
  id: string
  rootId: string
  rootLabel: string
  cwd: string
  access: AgentTerminalAccess
  state: 'running'
  startedAt: string
}

export interface AgentTerminalOutput {
  sessionId: string
  data: string
}

export type AgentTerminalExitReason = 'exited' | 'stopped' | 'error'

export interface AgentTerminalExit {
  sessionId: string
  exitCode: number | null
  signal: number | null
  reason: AgentTerminalExitReason
}

export interface PaperRelayBridge {
  library: {
    summary(): Promise<LibrarySummary>
  }
  roots: {
    list(): Promise<RootSummary[]>
    addWithPicker(): Promise<RootSummary | null>
    rescan(rootId: string): Promise<ScanResult>
    remove(rootId: string): Promise<void>
  }
  papers: {
    search(request: PaperSearchRequest): Promise<PaperListItem[]>
    get(paperId: string, rootId?: string): Promise<PaperDetail | null>
    issues(rootId?: string): Promise<IndexIssue[]>
    updateUserState(paperId: string, patch: PaperUserStatePatch): Promise<PaperUserState>
    saveDraft(paperId: string, draft: PaperUserDraftInput): Promise<PaperUserDraft>
    discardDraft(paperId: string): Promise<void>
    commitDraft(paperId: string): Promise<PaperUserState>
    markOpened(paperId: string): Promise<PaperUserState>
  }
  insights: {
    paper(paperId: string, rootId?: string): Promise<PaperDigest>
    landscape(request: ResearchLandscapeRequest): Promise<ResearchLandscape>
  }
  agentRelay: {
    setup(): Promise<AgentRelaySetup>
    copyCodexConfig(): Promise<void>
    copyTestPrompt(): Promise<void>
    copyPaperReference(paperId: string, rootId?: string): Promise<void>
    copyRootContext(rootId: string): Promise<void>
  }
  agentTerminal: {
    start(request: AgentTerminalStartRequest): Promise<AgentTerminalSession | null>
    write(sessionId: string, data: string): Promise<void>
    resize(sessionId: string, cols: number, rows: number): Promise<void>
    stop(sessionId: string): Promise<void>
    onOutput(listener: (event: AgentTerminalOutput) => void): () => void
    onExit(listener: (event: AgentTerminalExit) => void): () => void
  }
  lifecycle: {
    respondToClose(requestId: string, proceed: boolean): Promise<void>
    onCloseRequested(listener: (request: AppCloseRequest) => void): () => void
  }
  system: {
    revealLocation(locationId: string): Promise<void>
  }
}

export const IPC = {
  librarySummary: 'library:summary',
  rootsList: 'roots:list',
  rootsAddWithPicker: 'roots:add-with-picker',
  rootsRescan: 'roots:rescan',
  rootsRemove: 'roots:remove',
  papersSearch: 'papers:search',
  papersGet: 'papers:get',
  papersIssues: 'papers:issues',
  papersUpdateUserState: 'papers:update-user-state',
  papersSaveDraft: 'papers:save-draft',
  papersDiscardDraft: 'papers:discard-draft',
  papersCommitDraft: 'papers:commit-draft',
  papersMarkOpened: 'papers:mark-opened',
  insightsPaper: 'insights:paper',
  insightsLandscape: 'insights:landscape',
  agentRelaySetup: 'agent-relay:setup',
  agentRelayCopyCodexConfig: 'agent-relay:copy-codex-config',
  agentRelayCopyTestPrompt: 'agent-relay:copy-test-prompt',
  agentRelayCopyPaperReference: 'agent-relay:copy-paper-reference',
  agentRelayCopyRootContext: 'agent-relay:copy-root-context',
  agentTerminalStart: 'agent-terminal:start',
  agentTerminalWrite: 'agent-terminal:write',
  agentTerminalResize: 'agent-terminal:resize',
  agentTerminalStop: 'agent-terminal:stop',
  agentTerminalOutput: 'agent-terminal:output',
  agentTerminalExit: 'agent-terminal:exit',
  lifecycleCloseRequested: 'lifecycle:close-requested',
  lifecycleRespondToClose: 'lifecycle:respond-to-close',
  systemRevealLocation: 'system:reveal-location'
} as const
