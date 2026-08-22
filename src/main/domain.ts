import type {
  ContentKind,
  PaperAsset,
  PaperReference,
  PaperSection
} from '../shared/contracts.js'

export interface NormalizedDocument {
  doi: string | null
  title: string
  authors: string[]
  abstract: string | null
  journal: string | null
  published: string | null
  year: string | null
  keywords: string[]
  source: string | null
  contentKind: ContentKind
  hasFulltext: boolean
  confidence: string | null
  warnings: string[]
  flags: string[]
  sourceTrail: string[]
  tokenEstimate: number
  extractionRevision: number
  sections: PaperSection[]
  assets: PaperAsset[]
  references: unknown[]
  bodyText: string
  detector: string
}

export interface AnalysisPaperSnapshot {
  paperId: string
  documentId: string
  fingerprint: string
  rootId: string | null
  title: string
  doi: string | null
  year: string | null
  contentKind: ContentKind
  abstract: string | null
  keywords: string[]
  sections: PaperSection[]
  references: PaperReference[]
  referenceCount: number
  referencesTruncated: boolean
}

export type DetectionResult =
  | { kind: 'document'; document: NormalizedDocument }
  | { kind: 'issue'; message: string }
  | { kind: 'ignore' }

export interface CandidateFile {
  path: string
  canonicalPath: string
  relativePath: string
  size: number
  modifiedAt: string
  fingerprint: string
}
