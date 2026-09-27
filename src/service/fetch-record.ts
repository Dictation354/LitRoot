import YAML from 'yaml'
import type {
  AcceptanceOverall,
  ContentKind,
  FetchItem,
  FetchDiagnostics,
  IdentityCandidate
} from '../shared/contracts.js'
import { supportedPaperFetchVersion } from './diagnostics.js'
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
  source: string | null
  diagnostics: FetchDiagnostics | null
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
  fallbackIndex = 1,
  batch = false
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
  let status = text(value.status) ?? text(errorRecord.status) ?? (
    value.record_status === 'completed' ? 'ok' : text(value.record_status) ?? 'unknown'
  )
  const errorStatus = text(errorRecord.status)
  const errorCode = text(errorRecord.code) ?? (
    errorStatus && !['ok', 'success', 'complete', 'completed', 'error', 'failed', 'aborted', 'unknown'].includes(errorStatus)
      ? errorStatus : null
  ) ?? text(errorRecord.error_category ?? value.code ?? value.error_category)
  if (value.record_status === 'aborted' || status === 'aborted') {
    status = errorCode === 'request_cancelled' ? 'cancelled' : (
      batch && value.schema_version === 2 && supportedPaperFetchVersion(`paper-fetch ${String(value.tool_version)}`) &&
      errorStatus === 'aborted' && text(errorRecord.code) && !['unknown', 'aborted'].includes(String(errorRecord.code)) && text(errorRecord.reason) &&
      text(value.started_at) !== null && value.started_at === value.completed_at
        ? 'not_scheduled' : 'failed'
    )
  }
  const provenance = nested(acceptanceRecord, 'provenance')
  const object = (entry: unknown): UnknownRecord | null => isRecord(entry) ? entry : null
  const codes = (...entries: unknown[]): string[] => [...new Set(entries.flatMap((entry) => (
    Array.isArray(entry) ? entry.flatMap((code) => text(code) ? [text(code)!] : []) : []
  )))]
  const diagnostics: FetchDiagnostics | null = [
    'acceptance', 'acquisition', 'trace', 'failure_codes', 'fallback_codes', 'warning_codes', 'error'
  ].some((key) => value[key] != null) ? {
    acquisition: object(value.acquisition) ?? object(provenance.acquisition),
    acceptance: {
      overall: acceptance(acceptanceRecord.overall),
      identity: object(acceptanceRecord.identity), fetch: object(acceptanceRecord.fetch),
      content: object(acceptanceRecord.content), asset: object(acceptanceRecord.asset),
      output: object(acceptanceRecord.output), provenance: object(acceptanceRecord.provenance)
    },
    failureCodes: codes(value.failure_codes, provenance.failure_codes),
    fallbackCodes: codes(value.fallback_codes, provenance.fallback_codes),
    warningCodes: codes(value.warning_codes, provenance.warning_codes),
    retryAfterSeconds: typeof errorRecord.retry_after_seconds === 'number' &&
      Number.isFinite(errorRecord.retry_after_seconds) && errorRecord.retry_after_seconds >= 0
      ? errorRecord.retry_after_seconds : null,
    semanticLosses: object(value.semantic_losses),
    assetSummary: object(value.asset_summary) ?? object(acceptanceRecord.asset),
    trace: Array.isArray(value.trace) ? value.trace.filter(isRecord).map((event) => ({
      stage: text(event.stage), code: text(event.code)
    })) : []
  } : null
  const diagnosticCodes = diagnostics ? codes(diagnostics.failureCodes, diagnostics.fallbackCodes, diagnostics.warningCodes) : []
  return {
    index: integer(value.index, fallbackIndex),
    attempt: integer(value.attempt, 1),
    status,
    canonicalDoi: normalizeDoi(
      value.doi ?? value.canonical_doi ?? identityRecord.doi ?? identityRecord.canonical_doi
    ),
    canonicalUrl: text(
      value.canonical_url ?? value.url ?? identityRecord.url ?? identityRecord.canonical_url ??
      identityRecord.canonical_landing_url
    ),
    title: text(value.title ?? identityRecord.title),
    provider: text(errorRecord.provider) ?? text(diagnostics?.acquisition?.provider) ??
      text(value.provider) ?? text(nested(value, 'metadata').provider),
    source: text(value.source) ?? text(provenance.source),
    diagnostics,
    reason: text(errorRecord.reason ?? value.reason ?? value.message) ?? (
      acceptanceRecord.overall === 'degraded' && diagnosticCodes.length > 0
        ? `上游降级原因：${diagnosticCodes.join('、')}` : null
    ),
    errorCode,
    candidates: candidates(value.candidates ?? errorRecord.candidates),
    acceptance: acceptance(acceptanceRecord.overall ?? value.overall),
    contentKind: contentKind(
      contentRecord.kind ?? contentRecord.content_kind ?? value.content_kind ?? contentRecord.status
    ),
    outputPath: text(
      value.output_path ?? value.saved_markdown_path ?? outputRecord.path ?? artifact.path
    ),
    outputSha256: text(
      value.output_sha256 ?? value.sha256 ?? outputRecord.sha256 ?? artifact.sha256
    ),
    completionOrder: null,
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
    stageStartedAt: new Date().toISOString(),
    assetProgress: null,
    state: 'pending',
    attempt: 1,
    canonicalDoi: doiFromInput(query),
    canonicalUrl: null,
    title: null,
    provider: null,
    source: null,
    diagnostics: null,
    authCommand: null,
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
  if (record.status === 'failed' && [
    record.raw.record_status, record.raw.status, nested(record.raw, 'error').status
  ].includes('aborted')) return false
  return (
    record.acceptance === 'action_required' ||
    ['ambiguous', 'no_access', 'auth_required', 'challenge', 'multiple_candidates', 'rate_limited'].includes(record.status) ||
    ['manual_auth', 'lawful_access_boundary', 'auth_required', 'no_access', 'challenge', 'rate_limited'].includes(record.errorCode ?? '')
  )
}

export function projectRecord(item: FetchItem, record: ParsedTerminalRecord): void {
  item.attempt = Math.max(item.attempt, record.attempt)
  item.canonicalDoi = record.canonicalDoi
  item.canonicalUrl = record.canonicalUrl
  item.title = record.title
  item.provider = record.provider
  item.source = record.source
  item.diagnostics = record.diagnostics
  item.authCommand = null
  item.reason = record.reason
  item.errorCode = record.errorCode
  item.candidates = record.candidates
  item.acceptance = record.acceptance
  item.contentKind = record.contentKind
}

export function authenticationRequired(record: ParsedTerminalRecord): boolean {
  return [record.status, record.errorCode].some((value) => (
    ['no_access', 'auth_required', 'challenge', 'manual_auth'].includes(value ?? '')
  ))
}
