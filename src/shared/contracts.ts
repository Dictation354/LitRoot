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
  'acceptance',
  'terminal'
])

export const fetchItemStateSchema = z.enum([
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

export const fetchItemSchema = z.object({
  index: z.number().int().positive(),
  query: z.string(),
  stage: fetchItemStageSchema,
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
  refreshPaperId: z.string().optional()
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

export const serviceEventSchema = z.discriminatedUnion('type', [
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
    resume(projectId: string, runId: string): Promise<FetchRun>
  }
  events: {
    subscribe(listener: (event: ServiceEvent) => void): () => void
  }
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
  notesRead: 'litroot:notes:read',
  notesWrite: 'litroot:notes:write',
  fetchCreate: 'litroot:fetch:create',
  fetchGet: 'litroot:fetch:get',
  fetchList: 'litroot:fetch:list',
  fetchCancel: 'litroot:fetch:cancel',
  fetchResume: 'litroot:fetch:resume',
  eventsPush: 'litroot:events:push'
} as const
