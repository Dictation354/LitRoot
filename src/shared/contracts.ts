import { z } from 'zod'

export const API_VERSION = 1 as const
export const PROJECT_SCHEMA_VERSION = 1 as const
export const NOTE_SCHEMA_VERSION = 1 as const
export const ACCEPTANCE_SCHEMA_VERSION = 2 as const

export const contentKindSchema = z.enum(['fulltext', 'abstract_only', 'metadata_only'])
export type ContentKind = z.infer<typeof contentKindSchema>

export const acceptanceOverallSchema = z.enum([
  'complete',
  'degraded',
  'limited',
  'failed',
  'action_required'
])
export type AcceptanceOverall = z.infer<typeof acceptanceOverallSchema>

export const metadataFieldSchema = z.enum([
  'title',
  'authors',
  'journal',
  'year',
  'doi',
  'url',
  'abstract',
  'keywords'
])
export type MetadataField = z.infer<typeof metadataFieldSchema>

export const paperMetadataSchema = z.object({
  title: z.string(),
  authors: z.array(z.string()),
  journal: z.string(),
  year: z.number().int().min(1000).max(9999).nullable(),
  doi: z.string(),
  url: z.string(),
  abstract: z.string(),
  keywords: z.array(z.string())
})
export type PaperMetadata = z.infer<typeof paperMetadataSchema>

export const metadataOverridesSchema = z.object({
  title: z.string().optional(),
  authors: z.array(z.string()).optional(),
  journal: z.string().optional(),
  year: z.union([z.number().int().min(1000).max(9999), z.literal('')]).optional(),
  doi: z.string().optional(),
  url: z.string().optional(),
  abstract: z.string().optional(),
  keywords: z.array(z.string()).optional()
})
export type MetadataOverrides = z.infer<typeof metadataOverridesSchema>

export const runtimeTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }),
  z.object({
    kind: z.literal('wsl'),
    distribution: z.string().trim().min(1).max(200).refine((value) => !/[\0\r\n]/.test(value))
  })
])
export type RuntimeTarget = z.infer<typeof runtimeTargetSchema>

export const runtimeOptionSchema = z.object({
  key: z.string(),
  label: z.string(),
  target: runtimeTargetSchema
})
export type RuntimeOption = z.infer<typeof runtimeOptionSchema>

export function runtimeTargetKey(target: RuntimeTarget): string {
  return target.kind === 'local' ? 'local' : `wsl:${target.distribution}`
}

export const projectStatusSchema = z.enum(['connecting', 'scanning', 'ready', 'empty', 'error'])
export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  runtime: runtimeTargetSchema.optional(),
  status: projectStatusSchema,
  error: z.string().nullable(),
  paperCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  years: z.array(z.number().int()),
  lastScannedAt: z.string().nullable()
})
export type ProjectSummary = z.infer<typeof projectSummarySchema>

export const scanResultSchema = z.object({
  projectId: z.string(),
  discovered: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  issues: z.number().int().nonnegative(),
  startedAt: z.string(),
  finishedAt: z.string()
})
export type ScanResult = z.infer<typeof scanResultSchema>

export const paperListItemSchema = z.object({
  id: z.string(),
  relativePath: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  journal: z.string(),
  year: z.number().int().nullable(),
  doi: z.string(),
  url: z.string(),
  abstract: z.string(),
  keywords: z.array(z.string()),
  source: z.string(),
  contentKind: contentKindSchema,
  hasFulltext: z.boolean(),
  addedAt: z.string().nullable(),
  lastOpenedAt: z.string().nullable(),
  modifiedAt: z.string(),
  searchSnippet: z.string().nullable(),
  hasOverrides: z.boolean()
})
export type PaperListItem = z.infer<typeof paperListItemSchema>

export const paperDetailSchema = paperListItemSchema.extend({
  fetchedMetadata: paperMetadataSchema,
  overrides: metadataOverridesSchema,
  markdown: z.string(),
  markdownRevision: z.string(),
  assetPaths: z.array(z.string())
})
export type PaperDetail = z.infer<typeof paperDetailSchema>

export const paperSortFieldSchema = z.enum([
  'title',
  'authors',
  'year',
  'journal',
  'contentKind',
  'source',
  'addedAt',
  'lastOpenedAt',
  'modifiedAt'
])
export type PaperSortField = z.infer<typeof paperSortFieldSchema>

export const sortDirectionSchema = z.enum(['asc', 'desc'])
export type SortDirection = z.infer<typeof sortDirectionSchema>

export const paperSearchRequestSchema = z.object({
  projectId: z.string(),
  query: z.string().max(500).default(''),
  year: z.number().int().min(1000).max(9999).nullable().default(null),
  sortBy: paperSortFieldSchema.default('title'),
  sortDirection: sortDirectionSchema.default('asc'),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().nonnegative().default(0)
})
export type PaperSearchRequest = z.input<typeof paperSearchRequestSchema>

export const paperSearchResultSchema = z.object({
  items: z.array(paperListItemSchema),
  total: z.number().int().nonnegative(),
  years: z.array(z.number().int())
})
export type PaperSearchResult = z.infer<typeof paperSearchResultSchema>

export const paperExportRequestSchema = z.object({
  projectId: z.string(),
  paperIds: z.array(z.string()).min(1).max(50),
  destination: z.string().min(1).max(8_000),
  includeImages: z.boolean()
})
export type PaperExportRequest = z.infer<typeof paperExportRequestSchema>

export const paperExportPlanSchema = z.object({
  files: z.array(z.string()),
  conflicts: z.array(z.string())
})
export type PaperExportPlan = z.infer<typeof paperExportPlanSchema>

export const paperExportExecuteRequestSchema = paperExportRequestSchema.extend({
  approvedConflicts: z.array(z.string()).max(10_000)
})
export type PaperExportExecuteRequest = z.infer<typeof paperExportExecuteRequestSchema>

export const paperExportResultSchema = z.object({
  papers: z.number().int().nonnegative(),
  images: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  failures: z.array(z.object({ relativePath: z.string(), message: z.string() }))
})
export type PaperExportResult = z.infer<typeof paperExportResultSchema>

export const metadataUpdateRequestSchema = z.object({
  projectId: z.string(),
  paperId: z.string(),
  patch: metadataOverridesSchema.default({}),
  restore: z.array(metadataFieldSchema).default([])
})
export type MetadataUpdateRequest = z.input<typeof metadataUpdateRequestSchema>

export const noteKindSchema = z.enum(['project', 'paper'])
export type NoteKind = z.infer<typeof noteKindSchema>

export const noteDocumentSchema = z.object({
  projectId: z.string(),
  kind: noteKindSchema,
  paperId: z.string().nullable(),
  content: z.string(),
  revision: z.string(),
  modifiedAt: z.string(),
  path: z.string()
})
export type NoteDocument = z.infer<typeof noteDocumentSchema>

export const noteReadRequestSchema = z.object({
  projectId: z.string(),
  kind: noteKindSchema,
  paperId: z.string().optional()
})
export type NoteReadRequest = z.input<typeof noteReadRequestSchema>

export const noteWriteRequestSchema = noteReadRequestSchema.extend({
  content: z.string().max(2_000_000),
  expectedRevision: z.string()
})
export type NoteWriteRequest = z.input<typeof noteWriteRequestSchema>

export const fetchItemStageSchema = z.enum([
  'queued',
  'identity',
  'fetching',
  'assets',
  'validating',
  'writing',
  'acceptance',
  'terminal'
])

export const fetchItemStateSchema = z.enum([
  'cancelling',
  'pending',
  'running',
  'complete',
  'degraded',
  'limited',
  'failed',
  'action_required',
  'cancelled'
])

export const identityCandidateSchema = z.object({
  doi: z.string().nullable(),
  title: z.string(),
  url: z.string().nullable()
})
export type IdentityCandidate = z.infer<typeof identityCandidateSchema>

export const fetchAssetProgressSchema = z.object({
  scope: z.string().max(2_000),
  counts: z.array(z.object({
    kind: z.enum(['figure', 'formula', 'table', 'supplementary']),
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().nullable(),
    failed: z.number().int().nonnegative()
  }).refine((count) => count.failed <= count.completed && (count.total === null || count.completed <= count.total))).max(4)
})

export const fetchItemSchema = z.object({
  index: z.number().int().positive(),
  query: z.string(),
  stage: fetchItemStageSchema,
  stageStartedAt: z.string().datetime().nullable().default(null),
  assetProgress: fetchAssetProgressSchema.nullable().default(null),
  state: fetchItemStateSchema,
  attempt: z.number().int().positive(),
  canonicalDoi: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  title: z.string().nullable(),
  provider: z.string().nullable(),
  reason: z.string().nullable(),
  errorCode: z.string().nullable(),
  candidates: z.array(identityCandidateSchema),
  acceptance: acceptanceOverallSchema.nullable(),
  contentKind: contentKindSchema.nullable(),
  outputPath: z.string().nullable(),
  outputSha256: z.string().nullable(),
  existingPaperId: z.string().nullable(),
  completionOrder: z.number().int().positive().nullable()
})
export type FetchItem = z.infer<typeof fetchItemSchema>

export const fetchRunStateSchema = z.enum([
  'queued',
  'running',
  'cancelling',
  'completed',
  'cancelled',
  'interrupted'
])

export const fetchRunSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  projectId: z.string(),
  state: fetchRunStateSchema,
  concurrency: z.number().int().min(1).max(8),
  refreshPaperId: z.string().nullable(),
  refreshPaperIds: z.array(z.string()).min(1).max(50).nullable().default(null),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  manifestPath: z.string(),
  executionIndexes: z.array(z.number().int().positive()).max(50),
  items: z.array(fetchItemSchema).max(50)
})
export type FetchRun = z.infer<typeof fetchRunSchema>

export const createFetchRunRequestSchema = z.object({
  projectId: z.string(),
  inputs: z.array(z.string().trim().min(1).max(4_000)).min(1).max(50),
  concurrency: z.number().int().min(1).max(8).default(4),
  refreshPaperId: z.string().optional(),
  refreshPaperIds: z.array(z.string()).min(1).max(50).optional()
}).superRefine((request, context) => {
  if (request.refreshPaperId && request.refreshPaperIds) {
    context.addIssue({
      code: 'custom',
      message: '不能同时提交单篇和批量刷新目标。',
      path: ['refreshPaperIds']
    })
  }
  if (request.refreshPaperIds && request.refreshPaperIds.length !== request.inputs.length) {
    context.addIssue({
      code: 'custom',
      message: '批量刷新目标必须与输入逐项对应。',
      path: ['refreshPaperIds']
    })
  }
  if (request.refreshPaperIds && new Set(request.refreshPaperIds).size !== request.refreshPaperIds.length) {
    context.addIssue({
      code: 'custom',
      message: '批量刷新目标不能重复。',
      path: ['refreshPaperIds']
    })
  }
})
export type CreateFetchRunRequest = z.input<typeof createFetchRunRequestSchema>

export const dependencyCheckSchema = z.object({
  name: z.enum(['node', 'paper-fetch']),
  ok: z.boolean(),
  version: z.string().nullable(),
  required: z.string(),
  repairCommand: z.string(),
  reason: z.string().nullable()
})

export const dependencyReportSchema = z.object({
  runtimeLabel: z.string(),
  ready: z.boolean(),
  checks: z.array(dependencyCheckSchema)
})
export type DependencyReport = z.infer<typeof dependencyReportSchema>

export const feedSubscriptionSchema = z.object({
  id: z.string(),
  issn: z.string(),
  title: z.string(),
  unreadCount: z.number().int().nonnegative(),
  lastCheckedAt: z.string().nullable(),
  lastSuccessfulAt: z.string().nullable(),
  error: z.string().nullable()
})
export type FeedSubscription = z.infer<typeof feedSubscriptionSchema>

export const feedItemSchema = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  sourceTitle: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  summary: z.string(),
  doi: z.string(),
  url: z.string(),
  publishedAt: z.string().nullable(),
  discoveredAt: z.string(),
  readAt: z.string().nullable()
})
export type FeedItem = z.infer<typeof feedItemSchema>

export const feedItemsRequestSchema = z.object({
  subscriptionId: z.string().regex(/^feed_[a-f0-9]{24}$/).nullable().default(null),
  days: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(14), z.literal(30)]).default(7),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().nonnegative().default(0)
})
export type FeedItemsRequest = z.input<typeof feedItemsRequestSchema>

export const feedItemsResultSchema = z.object({
  items: z.array(feedItemSchema),
  total: z.number().int().nonnegative()
})
export type FeedItemsResult = z.infer<typeof feedItemsResultSchema>

export const addFeedRequestSchema = z.object({
  issn: z.string().trim().regex(/^\d{4}-?\d{3}[\dXx]$/),
  title: z.string().trim().max(200).optional()
})
export type AddFeedRequest = z.input<typeof addFeedRequestSchema>

const issnSchema = z.string().regex(/^\d{4}-\d{3}[\dX]$/)

export const journalSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(500)
})
export type JournalSearchRequest = z.input<typeof journalSearchRequestSchema>

export const journalCandidateSchema = z.object({
  displayName: z.string(),
  publisher: z.string().nullable(),
  issn: issnSchema,
  issns: z.array(issnSchema)
})
export type JournalCandidate = z.infer<typeof journalCandidateSchema>

export const journalSearchResultSchema = z.object({
  candidates: z.array(journalCandidateSchema).max(10)
})
export type JournalSearchResult = z.infer<typeof journalSearchResultSchema>

export const markFeedReadRequestSchema = z.object({
  itemIds: z.array(z.string().regex(/^feeditem_[a-f0-9]{24}$/)).max(50).optional(),
  subscriptionId: z.string().regex(/^feed_[a-f0-9]{24}$/).nullable().optional(),
  allUnread: z.boolean().optional(),
  read: z.boolean()
}).refine((value) => Boolean(value.itemIds?.length || value.allUnread), {
  message: '必须指定条目或全部未读。'
})
export type MarkFeedReadRequest = z.infer<typeof markFeedReadRequestSchema>

export const serviceEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('feeds.changed'), at: z.string() }),
  z.object({ type: z.literal('scan.started'), projectId: z.string(), at: z.string() }),
  z.object({
    type: z.literal('scan.completed'),
    projectId: z.string(),
    at: z.string(),
    result: scanResultSchema
  }),
  z.object({ type: z.literal('papers.changed'), projectId: z.string(), at: z.string() }),
  z.object({
    type: z.literal('note.changed'),
    projectId: z.string(),
    at: z.string(),
    kind: noteKindSchema,
    paperId: z.string().nullable(),
    revision: z.string()
  }),
  z.object({
    type: z.literal('fetch.changed'),
    projectId: z.string(),
    at: z.string(),
    run: fetchRunSchema
  })
])
export type ServiceEvent = z.infer<typeof serviceEventSchema>

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional()
  })
})
export type ApiErrorBody = z.infer<typeof apiErrorSchema>

export interface BridgeErrorPayload {
  code: string
  message: string
  details?: unknown
}

export type BridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: BridgeErrorPayload }

export interface LitRootBridge {
  system: {
    listRuntimes(): Promise<RuntimeOption[]>
    diagnose(target: RuntimeTarget): Promise<DependencyReport>
    pickProjectPath(target: RuntimeTarget): Promise<string | null>
    openExternal(url: string): Promise<void>
    copyText(text: string): Promise<void>
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    add(target: RuntimeTarget, path: string, name?: string): Promise<ProjectSummary>
    remove(projectId: string): Promise<void>
    scan(projectId: string): Promise<ScanResult>
  }
  papers: {
    search(request: PaperSearchRequest): Promise<PaperSearchResult>
    get(projectId: string, paperId: string): Promise<PaperDetail | null>
    updateMetadata(request: MetadataUpdateRequest): Promise<PaperDetail>
    markOpened(projectId: string, paperId: string): Promise<string>
    openWindow(projectId: string, paperId: string): Promise<void>
    reveal(projectId: string, paperId: string): Promise<void>
    export(projectId: string, paperIds: string[], includeImages: boolean): Promise<PaperExportResult | null>
    copyImage(projectId: string, paperId: string, source: string): Promise<void>
    openImage(projectId: string, paperId: string, source: string): Promise<void>
    assetUrl(projectId: string, paperId: string, source: string): string
  }
  notes: {
    read(request: NoteReadRequest): Promise<NoteDocument>
    write(request: NoteWriteRequest): Promise<NoteDocument>
  }
  fetch: {
    create(request: CreateFetchRunRequest): Promise<FetchRun>
    get(projectId: string, runId: string): Promise<FetchRun>
    list(projectId: string): Promise<FetchRun[]>
    cancel(projectId: string, runId: string): Promise<FetchRun>
    cancelItem(projectId: string, runId: string, index: number): Promise<FetchRun>
    resume(projectId: string, runId: string): Promise<FetchRun>
  }
  feeds: {
    list(): Promise<FeedSubscription[]>
    searchJournals(request: JournalSearchRequest): Promise<JournalSearchResult>
    add(request: AddFeedRequest): Promise<FeedSubscription>
    remove(subscriptionId: string): Promise<void>
    refresh(subscriptionId: string): Promise<FeedSubscription>
    items(request: FeedItemsRequest): Promise<FeedItemsResult>
    markRead(request: MarkFeedReadRequest): Promise<void>
  }
  events: {
    subscribe(listener: (event: ServiceEvent) => void): () => void
  }
}

type TransportMethod<T> = T extends (...args: infer Args) => Promise<infer Result>
  ? (...args: Args) => Promise<BridgeResult<Result extends void ? null : Result>>
  : T

type TransportSection<T> = {
  [Key in keyof T]: TransportMethod<T[Key]>
}

export interface LitRootTransportBridge {
  system: TransportSection<LitRootBridge['system']>
  projects: TransportSection<LitRootBridge['projects']>
  papers: TransportSection<LitRootBridge['papers']>
  notes: TransportSection<LitRootBridge['notes']>
  fetch: TransportSection<LitRootBridge['fetch']>
  feeds: TransportSection<LitRootBridge['feeds']>
  events: TransportSection<LitRootBridge['events']>
}

export const IPC = {
  systemListRuntimes: 'litroot:system:list-runtimes',
  systemDiagnose: 'litroot:system:diagnose',
  systemPickProjectPath: 'litroot:system:pick-project-path',
  systemOpenExternal: 'litroot:system:open-external',
  systemCopyText: 'litroot:system:copy-text',
  projectsList: 'litroot:projects:list',
  projectsAdd: 'litroot:projects:add',
  projectsRemove: 'litroot:projects:remove',
  projectsScan: 'litroot:projects:scan',
  papersSearch: 'litroot:papers:search',
  papersGet: 'litroot:papers:get',
  papersUpdateMetadata: 'litroot:papers:update-metadata',
  papersMarkOpened: 'litroot:papers:mark-opened',
  papersOpenWindow: 'litroot:papers:open-window',
  papersReveal: 'litroot:papers:reveal',
  papersExport: 'litroot:papers:export',
  papersCopyImage: 'litroot:papers:copy-image',
  papersOpenImage: 'litroot:papers:open-image',
  notesRead: 'litroot:notes:read',
  notesWrite: 'litroot:notes:write',
  fetchCreate: 'litroot:fetch:create',
  fetchGet: 'litroot:fetch:get',
  fetchList: 'litroot:fetch:list',
  fetchCancel: 'litroot:fetch:cancel',
  fetchCancelItem: 'litroot:fetch:cancel-item',
  fetchResume: 'litroot:fetch:resume',
  feedsList: 'litroot:feeds:list',
  feedsSearchJournals: 'litroot:feeds:search-journals',
  feedsAdd: 'litroot:feeds:add',
  feedsRemove: 'litroot:feeds:remove',
  feedsRefresh: 'litroot:feeds:refresh',
  feedsItems: 'litroot:feeds:items',
  feedsMarkRead: 'litroot:feeds:mark-read',
  eventsPush: 'litroot:events:push'
} as const
