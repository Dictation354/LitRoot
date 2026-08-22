export const DEFAULT_SECTION_CHARACTER_BUDGET = 20_000
export const MAX_SECTION_CHARACTER_BUDGET = 60_000
export const DEFAULT_SEARCH_LIMIT = 8
export const MAX_SEARCH_LIMIT = 25

export type AgentRootStatus = 'pending' | 'scanning' | 'ready' | 'empty' | 'unavailable' | 'error'
export type AgentContentKind = 'fulltext' | 'abstract_only' | 'metadata_only'

export interface AgentRoot {
  id: string
  label: string
  path: string
  status: AgentRootStatus
  error: string | null
  paperCount: number
  issueCount: number
  lastScannedAt: string | null
}

export interface AgentRootListResult {
  totalCount: number
  returnedCount: number
  omittedCount: number
  metadataTruncated: boolean
  roots: AgentRoot[]
}

export interface AgentPaperSelector {
  paperId?: string | undefined
  doi?: string | undefined
  rootId?: string | undefined
}

export interface AgentSearchRequest {
  query: string
  rootId?: string | undefined
  attention?: boolean | undefined
  limit?: number | undefined
}

export interface AgentSearchRoot {
  id: string
  label: string
  status: AgentRootStatus
}

export interface AgentSearchHit {
  paperId: string
  doi: string | null
  title: string
  authors: string[]
  year: string | null
  journal: string | null
  source: string | null
  contentKind: AgentContentKind
  confidence: string | null
  warningCount: number
  sectionCount: number
  locationCount: number
  roots: AgentSearchRoot[]
  omittedRootCount: number
  snippet: string | null
  updatedAt: string
}

export interface AgentSearchResult {
  query: string
  rootId: string | null
  count: number
  hasMore: boolean
  metadataTruncated: boolean
  results: AgentSearchHit[]
}

export interface AgentSectionDescriptor {
  index: number
  heading: string
  level: number
  kind: string
  estimatedTokens: number
  characterCount: number
}

export interface AgentAssetDescriptor {
  index: number
  kind: string
  heading: string
  caption: string | null
  section: string | null
  url: string | null
  available: boolean
}

export interface AgentPaperLocation {
  rootId: string
  rootLabel: string
  rootPath: string
  rootStatus: AgentRootStatus
  artifactPath: string
  relativePath: string
  detector: string
  modifiedAt: string
  parseStatus: string
}

export interface AgentPaperOutline {
  paperId: string
  rootId: string | null
  revision: string
  doi: string | null
  title: string
  authors: string[]
  abstract: string | null
  abstractTruncated: boolean
  journal: string | null
  published: string | null
  year: string | null
  keywords: string[]
  contentKind: AgentContentKind
  confidence: string | null
  tokenEstimate: number
  referenceCount: number
  quality: {
    warningCount: number
    warnings: string[]
    flags: string[]
  }
  provenance: {
    source: string | null
    detector: string
    extractionRevision: number
    sourceTrail: string[]
  }
  sections: AgentSectionDescriptor[]
  assets: AgentAssetDescriptor[]
  locations: AgentPaperLocation[]
  truncation: {
    truncated: boolean
    fields: string[]
    omittedAuthors: number
    omittedKeywords: number
    omittedWarnings: number
    omittedSourceTrail: number
    omittedSections: number
    omittedAssets: number
    omittedLocations: number
  }
}

export interface AgentReadSectionsRequest extends AgentPaperSelector {
  revision?: string | undefined
  sectionIndexes?: number[] | undefined
  query?: string | undefined
  maxCharacters?: number | undefined
}

export interface AgentSectionContent {
  index: number
  heading: string
  level: number
  kind: string
  text: string
  characterCount: number
  truncated: boolean
}

export interface AgentSectionReadResult {
  paper: {
    paperId: string
    rootId: string | null
    revision: string
    doi: string | null
    title: string
    source: string | null
    contentKind: AgentContentKind
  }
  provenance: {
    sourceTrail: string[]
    locations: AgentPaperLocation[]
    omittedSourceTrailCount: number
    omittedLocationCount: number
  }
  selection: {
    query: string | null
    requestedIndexes: number[] | null
    selectedSectionCount: number
    returnedSectionCount: number
    omittedSectionCount: number
  }
  budget: {
    maxCharacters: number
    returnedCharacters: number
    truncated: boolean
    metadataTruncated: boolean
  }
  sections: AgentSectionContent[]
}

export type AgentRelayErrorCode =
  | 'DATABASE_NOT_FOUND'
  | 'DATABASE_NOT_READABLE'
  | 'UNSUPPORTED_SCHEMA'
  | 'INVALID_DATABASE'
  | 'FTS_UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'ROOT_NOT_FOUND'
  | 'PAPER_NOT_FOUND'
  | 'IDENTIFIER_MISMATCH'
  | 'STALE_REVISION'
  | 'SECTION_NOT_FOUND'
  | 'INTERNAL_ERROR'

export interface AgentRelayErrorPayload {
  code: AgentRelayErrorCode
  message: string
  details: Record<string, unknown> | null
}

export type AgentToolEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: AgentRelayErrorPayload }
