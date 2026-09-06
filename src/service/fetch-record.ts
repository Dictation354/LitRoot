import YAML from 'yaml'
import type {
  AcceptanceOverall,
  ContentKind,
  FetchItem,
  IdentityCandidate
} from '../shared/contracts.js'
import { doiFromInput, normalizeDoi } from './identity.js'

type UnknownRecord = Record<string, unknown>

export interface ParsedTerminalRecord {
  index: number
  attempt: number
  status: string
  canonicalDoi: string | null
  canonicalUrl: string | null
  title: string | null
  provider: string | null
  reason: string | null
  errorCode: string | null
  candidates: IdentityCandidate[]
  acceptance: AcceptanceOverall | null
  contentKind: ContentKind | null
  outputPath: string | null
  outputSha256: string | null
  completionOrder: number | null
  raw: UnknownRecord
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function integer(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function nested(record: UnknownRecord, key: string): UnknownRecord {
  return isRecord(record[key]) ? record[key] as UnknownRecord : {}
}

function acceptance(value: unknown): AcceptanceOverall | null {
  return ['complete', 'degraded', 'limited', 'failed', 'action_required'].includes(String(value))
    ? value as AcceptanceOverall
    : null
}

function contentKind(value: unknown): ContentKind | null {
  return ['fulltext', 'abstract_only', 'metadata_only'].includes(String(value))
    ? value as ContentKind
    : null
}

function candidates(value: unknown): IdentityCandidate[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate): IdentityCandidate[] => {
    if (!isRecord(candidate)) return []
    const title = text(candidate.title)
    if (!title) return []
    return [{
      doi: normalizeDoi(candidate.doi),
      title,
      url: text(candidate.url ?? candidate.landing_url)
    }]
  }).slice(0, 20)
}

export function parseTerminalRecord(
  value: unknown,
  fallbackIndex = 1
): ParsedTerminalRecord | null {
  if (!isRecord(value)) return null
  const acceptanceRecord = nested(value, 'acceptance')
  const identityRecord = nested(acceptanceRecord, 'identity')
  const contentRecord = nested(acceptanceRecord, 'content')
  const errorRecord = nested(value, 'error')
  const outputRecord = nested(value, 'output')
  const outputArtifacts = Array.isArray(value.output_artifacts) ? value.output_artifacts : []
  const markdownArtifact = outputArtifacts.find(
    (item) => isRecord(item) && /markdown/i.test(String(item.kind))
  )
  const artifact = isRecord(markdownArtifact) ? markdownArtifact : {}
  return {
    index: integer(value.index, fallbackIndex),
    attempt: integer(value.attempt, 1),
    status: text(value.status) ?? 'unknown',
    canonicalDoi: normalizeDoi(
      value.doi ?? value.canonical_doi ?? identityRecord.doi ?? identityRecord.canonical_doi
    ),
    canonicalUrl: text(
      value.canonical_url ?? value.url ?? identityRecord.url ?? identityRecord.canonical_url
    ),
    title: text(value.title ?? identityRecord.title),
    provider: text(value.provider ?? value.source ?? nested(value, 'metadata').provider),
    reason: text(errorRecord.reason ?? value.reason ?? value.message),
    errorCode: text(errorRecord.code ?? errorRecord.error_category ?? value.code ?? value.error_category),
    candidates: candidates(value.candidates ?? errorRecord.candidates),
    acceptance: acceptance(acceptanceRecord.overall ?? value.overall),
    contentKind: contentKind(
      contentRecord.kind ?? contentRecord.content_kind ?? value.content_kind
    ),
    outputPath: text(
      value.output_path ?? value.saved_markdown_path ?? outputRecord.path ?? artifact.path
    ),
    outputSha256: text(
      value.output_sha256 ?? value.sha256 ?? outputRecord.sha256 ?? artifact.sha256
    ),
    completionOrder: value.completion_order === undefined
      ? null
      : integer(value.completion_order, fallbackIndex),
    raw: value
  }
}

export function parseJsonLines(raw: string): unknown[] {
  return raw.split(/\r?\n/).flatMap((line): unknown[] => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

export function parseManifestDocument(raw: string): unknown[] {
  try {
    const value: unknown = JSON.parse(raw)
    if (Array.isArray(value)) return value
    if (isRecord(value) && Array.isArray(value.results)) return value.results
    return [value]
  } catch {
    const value: unknown = YAML.parse(raw)
    return Array.isArray(value) ? value : [value]
  }
}

export function itemFor(index: number, query: string): FetchItem {
  return {
    index,
    query,
    stage: 'queued',
    state: 'pending',
    attempt: 1,
    canonicalDoi: doiFromInput(query),
    canonicalUrl: null,
    title: null,
    provider: null,
    reason: null,
    errorCode: null,
    candidates: [],
    acceptance: null,
    contentKind: null,
    outputPath: null,
    outputSha256: null,
    existingPaperId: null,
    completionOrder: null
  }
}

export function actionRequired(record: ParsedTerminalRecord): boolean {
  return (
    record.acceptance === 'action_required' ||
    ['ambiguous', 'no_access', 'auth_required', 'challenge', 'multiple_candidates'].includes(record.status) ||
    ['manual_auth', 'lawful_access_boundary'].includes(record.errorCode ?? '')
  )
}

export function projectRecord(item: FetchItem, record: ParsedTerminalRecord): void {
  item.attempt = Math.max(item.attempt, record.attempt)
  item.canonicalDoi = record.canonicalDoi
  item.canonicalUrl = record.canonicalUrl
  item.title = record.title
  item.provider = record.provider
  item.reason = record.reason
  item.errorCode = record.errorCode
  item.candidates = record.candidates
  item.acceptance = record.acceptance
  item.contentKind = record.contentKind
  item.completionOrder = record.completionOrder
}
