import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { normalizeDoi } from '../ingest/identity.js'
import type {
  AgentAssetDescriptor,
  AgentContentKind,
  AgentPaperLocation,
  AgentPaperOutline,
  AgentPaperSelector,
  AgentRoot,
  AgentRootListResult,
  AgentRootStatus,
  AgentSearchHit,
  AgentSearchRequest,
  AgentSearchResult,
  AgentSectionDescriptor
} from './contracts.js'
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from './contracts.js'
import { AgentRelayError } from './errors.js'

type Row = Record<string, unknown>

interface StoredSection {
  heading: string
  level: number
  kind: string
  text: string
}

interface StoredAsset {
  kind?: unknown
  heading?: unknown
  caption?: unknown
  path?: unknown
  url?: unknown
  section?: unknown
  available?: unknown
}

export interface PaperSnapshot {
  row: Row
  paperId: string
  rootId: string | null
  revision: string
  sections: StoredSection[]
  locations: AgentPaperLocation[]
  omittedLocationCount: number
  truncatedFields: string[]
}

const SUPPORTED_SCHEMA_VERSION = 2
const MAX_OUTLINE_ABSTRACT_CHARACTERS = 4_000
const MAX_OUTLINE_SECTIONS = 300
const MAX_OUTLINE_ASSETS = 50
const MAX_ROOTS = 100
const MAX_ROOTS_PER_PAPER = 25
const MAX_LOCATIONS = 25
const MAX_TITLE_CHARACTERS = 500
const MAX_PERSON_CHARACTERS = 200
const MAX_LABEL_CHARACTERS = 300
const MAX_PATH_CHARACTERS = 2_048
const MAX_METADATA_CHARACTERS = 1_000
const MAX_URL_CHARACTERS = 2_048
const MAX_AUTHORS = 20
const MAX_KEYWORDS = 30
const MAX_WARNINGS = 25
const MAX_FLAGS = 50
const MAX_SOURCE_TRAIL = 50
const MAX_ROOT_LIST_METADATA_CHARACTERS = 50_000
const MAX_SEARCH_METADATA_CHARACTERS = 80_000
const MAX_LOCATION_METADATA_CHARACTERS = 15_000
const MAX_OUTLINE_METADATA_CHARACTERS = 50_000

interface TruncationTracker {
  fields: Set<string>
  remainingCharacters?: number
}

function boundedText(
  value: string | null,
  limit: number,
  tracker: TruncationTracker,
  field: string
): string | null {
  if (!value) return value
  const remaining = tracker.remainingCharacters ?? Number.POSITIVE_INFINITY
  const allowed = Math.max(0, Math.min(limit, remaining))
  const result = value.slice(0, allowed)
  if (result.length < value.length) tracker.fields.add(field)
  if (tracker.remainingCharacters !== undefined) tracker.remainingCharacters -= result.length
  return result
}

function boundedStrings(
  values: string[],
  itemLimit: number,
  characterLimit: number,
  tracker: TruncationTracker,
  field: string
): { values: string[]; omitted: number } {
  const selected = values.slice(0, itemLimit)
  if (values.length > selected.length) tracker.fields.add(field)
  return {
    values: selected.map((value) => boundedText(value, characterLimit, tracker, field) ?? ''),
    omitted: Math.max(0, values.length - selected.length)
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function integer(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0)
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function stringArray(value: unknown): string[] {
  const parsed = json<unknown>(value, [])
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
}

function unknownArray(value: unknown): unknown[] {
  const parsed = json<unknown>(value, [])
  return Array.isArray(parsed) ? parsed : []
}

function searchTerms(value: string): string[] {
  return value
    .trim()
    .split(/[\s"'*:^(){}\[\]<>~+\-]+/u)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 12)
}

function ftsQuery(terms: string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' AND ')
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`
}

function queryCenteredSnippet(row: Row, terms: string[]): string | null {
  const body = text(row.body_text) ?? ''
  const metadata = [
    text(row.title),
    text(row.authors_json),
    text(row.abstract),
    text(row.doi),
    text(row.journal)
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ')
  const bodyLower = body.toLocaleLowerCase()
  const bodyOffsets = terms.map((term) => bodyLower.indexOf(term.toLocaleLowerCase())).filter((offset) => offset >= 0)
  const source = bodyOffsets.length > 0 ? body : metadata
  if (!source) return null
  const sourceLower = source.toLocaleLowerCase()
  const offsets = terms.map((term) => sourceLower.indexOf(term.toLocaleLowerCase())).filter((offset) => offset >= 0)
  // Center on the latest first match so a common leading term cannot hide the
  // rarer term that made the scoped result relevant.
  const anchor = offsets.length > 0 ? Math.max(...offsets) : 0
  const start = Math.max(0, anchor - 400)
  const end = Math.min(source.length, start + 1_600)
  return `${start > 0 ? '… ' : ''}${source.slice(start, end)}${end < source.length ? ' …' : ''}`
}

function contentKind(value: unknown): AgentContentKind {
  return value === 'fulltext' || value === 'abstract_only' ? value : 'metadata_only'
}

function rootStatus(value: unknown): AgentRootStatus {
  if (
    value === 'pending' ||
    value === 'scanning' ||
    value === 'ready' ||
    value === 'empty' ||
    value === 'unavailable' ||
    value === 'error'
  ) {
    return value
  }
  return 'error'
}

function parseSections(value: unknown): StoredSection[] {
  const raw = unknownArray(value)
  return raw.flatMap((item): StoredSection[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const section = item as Row
    const sectionText = text(section.text)
    if (!sectionText) return []
    return [
      {
        heading: text(section.heading) ?? 'Untitled section',
        level: Math.min(6, Math.max(1, integer(section.level) || 1)),
        kind: text(section.kind) ?? 'body',
        text: sectionText
      }
    ]
  })
}

function revisionFor(row: Row, rootId: string | null): string {
  const digest = createHash('sha256')
    .update(`${String(row.paper_id)}\0${String(row.id)}\0${String(row.fingerprint)}\0${rootId ?? 'global'}`)
    .digest('hex')
    .slice(0, 24)
  return `revision_${digest}`
}

function truncate(value: string | null, limit: number): { value: string | null; truncated: boolean } {
  if (!value || value.length <= limit) return { value, truncated: false }
  return { value: value.slice(0, limit), truncated: true }
}

export class LibraryReader {
  private readonly db: DatabaseSync
  private readonly hasDocumentFts: boolean
  private closed = false

  constructor(readonly databasePath: string) {
    if (!isAbsolute(databasePath)) {
      throw new AgentRelayError('INVALID_ARGUMENT', 'PaperRelay requires an absolute database path.', {
        databasePath
      })
    }
    if (!existsSync(databasePath)) {
      throw new AgentRelayError('DATABASE_NOT_FOUND', 'The PaperRelay database does not exist.', {
        databasePath
      })
    }
    try {
      if (!statSync(databasePath).isFile()) {
        throw new AgentRelayError('DATABASE_NOT_READABLE', 'The PaperRelay database path is not a file.', {
          databasePath
        })
      }
    } catch (error) {
      if (error instanceof AgentRelayError) throw error
      throw new AgentRelayError('DATABASE_NOT_READABLE', 'The PaperRelay database cannot be inspected.', {
        databasePath,
        reason: error instanceof Error ? error.message : String(error)
      })
    }

    try {
      this.db = new DatabaseSync(databasePath, { readOnly: true })
      this.db.exec('PRAGMA query_only = ON')
    } catch (error) {
      throw new AgentRelayError('DATABASE_NOT_READABLE', 'The PaperRelay database could not be opened read-only.', {
        databasePath,
        reason: error instanceof Error ? error.message : String(error)
      })
    }

    try {
      this.hasDocumentFts = this.validateDatabase()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private validateDatabase(): boolean {
    let version: number
    try {
      version = integer((this.db.prepare('PRAGMA user_version').get() as Row).user_version)
    } catch (error) {
      throw new AgentRelayError('INVALID_DATABASE', 'This file is not a readable PaperRelay database.', {
        reason: error instanceof Error ? error.message : String(error)
      })
    }
    if (version !== SUPPORTED_SCHEMA_VERSION) {
      throw new AgentRelayError(
        'UNSUPPORTED_SCHEMA',
        `PaperRelay Agent Relay supports database schema ${SUPPORTED_SCHEMA_VERSION}, but found ${version}.`,
        { supportedVersion: SUPPORTED_SCHEMA_VERSION, databaseVersion: version }
      )
    }

    const requiredTables = ['roots', 'papers', 'documents', 'document_roots', 'paper_fts']
    const rows = this.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE name IN ('roots', 'papers', 'documents', 'document_roots', 'paper_fts')`
      )
      .all() as Row[]
    const existing = new Set(rows.map((row) => String(row.name)))
    const missing = requiredTables.filter((table) => !existing.has(table))
    if (missing.length > 0) {
      throw new AgentRelayError('INVALID_DATABASE', 'The PaperRelay database is missing required index tables.', {
        missing
      })
    }
    try {
      this.db.prepare("SELECT count(*) AS count FROM paper_fts WHERE paper_fts MATCH 'paperrelay'").get()
    } catch (error) {
      throw new AgentRelayError('FTS_UNAVAILABLE', 'The PaperRelay full-text index is unavailable.', {
        reason: error instanceof Error ? error.message : String(error)
      })
    }

    const hasDocumentFts = Boolean(
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_fts'")
        .get()
    )
    if (hasDocumentFts) {
      try {
        this.db.prepare("SELECT count(*) AS count FROM document_fts WHERE document_fts MATCH 'paperrelay'").get()
      } catch (error) {
        throw new AgentRelayError('FTS_UNAVAILABLE', 'The PaperRelay per-document full-text index is unavailable.', {
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return hasDocumentFts
  }

  private snapshot<T>(operation: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listRoots(): AgentRootListResult {
    return this.snapshot(() => {
      const rows = this.db.prepare('SELECT * FROM roots ORDER BY lower(label), created_at').all() as Row[]
      const tracker: TruncationTracker = {
        fields: new Set(),
        remainingCharacters: MAX_ROOT_LIST_METADATA_CHARACTERS
      }
      const roots = rows.slice(0, MAX_ROOTS).map((row) => this.mapRoot(row, tracker))
      if (rows.length > roots.length) tracker.fields.add('roots')
      return {
        totalCount: rows.length,
        returnedCount: roots.length,
        omittedCount: rows.length - roots.length,
        metadataTruncated: tracker.fields.size > 0,
        roots
      }
    })
  }

  private mapRoot(row: Row, tracker: TruncationTracker): AgentRoot {
    const rootId = String(row.id)
    const paperCount = this.db
      .prepare(
        `SELECT COUNT(DISTINCT d.paper_id) AS count
         FROM document_roots dr JOIN documents d ON d.id = dr.document_id
         WHERE dr.root_id = ? AND d.paper_id IS NOT NULL`
      )
      .get(rootId) as Row
    const unreadableCount = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM document_roots dr JOIN documents d ON d.id = dr.document_id
         WHERE dr.root_id = ? AND d.parse_status = 'unreadable'`
      )
      .get(rootId) as Row
    const incompleteCount = this.db
      .prepare(
        `WITH scoped_documents AS (
           SELECT d.parse_status, d.warnings_json,
                  ROW_NUMBER() OVER (
                    PARTITION BY d.paper_id
                    ORDER BY
                      CASE d.content_kind WHEN 'fulltext' THEN 3 WHEN 'abstract_only' THEN 2 ELSE 1 END DESC,
                      d.extraction_revision DESC,
                      d.modified_at DESC,
                      d.canonical_path ASC
                  ) AS scope_rank
           FROM documents d
           JOIN document_roots dr ON dr.document_id = d.id
           WHERE dr.root_id = ? AND d.paper_id IS NOT NULL
         )
         SELECT COUNT(*) AS count
         FROM scoped_documents
         WHERE scope_rank = 1
           AND (parse_status <> 'ready' OR json_array_length(warnings_json) > 0)`
      )
      .get(rootId) as Row
    return {
      id: boundedText(rootId, 200, tracker, 'root.id') ?? '',
      label: boundedText(String(row.label), MAX_LABEL_CHARACTERS, tracker, 'root.label') ?? '',
      path: boundedText(String(row.path), MAX_PATH_CHARACTERS, tracker, 'root.path') ?? '',
      status: rootStatus(row.status),
      error: boundedText(text(row.error), MAX_METADATA_CHARACTERS, tracker, 'root.error'),
      paperCount: integer(paperCount.count),
      issueCount: integer(unreadableCount.count) + integer(incompleteCount.count),
      lastScannedAt: boundedText(text(row.last_scanned_at), 100, tracker, 'root.lastScannedAt')
    }
  }

  private requireRoot(rootId: string): void {
    const row = this.db.prepare('SELECT id FROM roots WHERE id = ?').get(rootId)
    if (!row) {
      throw new AgentRelayError('ROOT_NOT_FOUND', 'The requested research root is not registered.', { rootId })
    }
  }

  search(request: AgentSearchRequest): AgentSearchResult {
    const query = request.query.trim()
    if (query.length > 500) {
      throw new AgentRelayError('INVALID_ARGUMENT', 'Search query must be 500 characters or fewer.', null)
    }
    const terms = searchTerms(query)
    if (terms.length === 0) {
      throw new AgentRelayError('INVALID_ARGUMENT', 'Search must contain at least one searchable term.', null)
    }
    const requestedLimit = request.limit ?? DEFAULT_SEARCH_LIMIT
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new AgentRelayError('INVALID_ARGUMENT', 'Search limit must be a positive integer.', {
        limit: requestedLimit
      })
    }
    const limit = Math.min(MAX_SEARCH_LIMIT, requestedLimit)

    return this.snapshot(() => {
      if (request.rootId) this.requireRoot(request.rootId)
      const rows = request.rootId
        ? this.searchRootRows(request.rootId, terms, Boolean(request.attention), limit + 1)
        : this.searchGlobalRows(terms, Boolean(request.attention), limit + 1)
      const hasMore = rows.length > limit
      const tracker: TruncationTracker = {
        fields: new Set(),
        remainingCharacters: MAX_SEARCH_METADATA_CHARACTERS
      }
      const results = rows.slice(0, limit).map((row) => this.mapSearchHit(row, tracker, request.rootId ?? null))
      return {
        query: boundedText(query, 500, tracker, 'query') ?? '',
        rootId: boundedText(request.rootId ?? null, 200, tracker, 'rootId'),
        count: results.length,
        hasMore,
        metadataTruncated: tracker.fields.size > 0,
        results
      }
    })
  }

  private searchGlobalRows(terms: string[], attention: boolean, limit: number): Row[] {
    const conditions = ['paper_fts MATCH ?']
    const parameters: (string | number)[] = [ftsQuery(terms)]
    if (attention) {
      conditions.push("(d.parse_status <> 'ready' OR json_array_length(d.warnings_json) > 0)")
    }
    parameters.push(limit)
    return this.db
      .prepare(
        `SELECT p.id AS paper_id, p.updated_at AS paper_updated_at, d.*,
                snippet(paper_fts, 4, '‹', '›', ' … ', 22) AS search_snippet
         FROM paper_fts
         JOIN papers p ON p.id = paper_fts.paper_id
         JOIN documents d ON d.id = p.preferred_document_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY bm25(paper_fts, 0.0, 12.0, 8.0, 5.0, 1.0, 10.0, 6.0) ASC,
                  p.updated_at DESC
         LIMIT ?`
      )
      .all(...parameters) as Row[]
  }

  private searchRootRows(rootId: string, terms: string[], attention: boolean, limit: number): Row[] {
    if (this.hasDocumentFts) return this.searchRootFtsRows(rootId, terms, attention, limit)
    return this.searchRootLegacyRows(rootId, terms, attention, limit)
  }

  private searchRootFtsRows(rootId: string, terms: string[], attention: boolean, limit: number): Row[] {
    const conditions = ['scoped.scope_rank = 1', 'document_fts MATCH ?']
    const parameters: (string | number)[] = [rootId, ftsQuery(terms)]
    if (attention) {
      conditions.push('scoped.needs_attention = 1')
    }
    parameters.push(limit)
    return this.db
      .prepare(
        `WITH scoped_document_ids AS MATERIALIZED (
           SELECT d.id AS document_id, d.paper_id, d.updated_at AS paper_updated_at,
                  CASE
                    WHEN d.parse_status <> 'ready' OR json_array_length(d.warnings_json) > 0 THEN 1
                    ELSE 0
                  END AS needs_attention,
                  ROW_NUMBER() OVER (
                    PARTITION BY d.paper_id
                    ORDER BY
                      CASE d.content_kind WHEN 'fulltext' THEN 3 WHEN 'abstract_only' THEN 2 ELSE 1 END DESC,
                      d.extraction_revision DESC,
                      d.modified_at DESC,
                      d.canonical_path ASC
                  ) AS scope_rank
           FROM documents d
           JOIN document_roots dr ON dr.document_id = d.id
           WHERE dr.root_id = ? AND d.paper_id IS NOT NULL
         ),
         matched_documents AS MATERIALIZED (
           SELECT scoped.document_id, scoped.paper_id, scoped.paper_updated_at,
                  bm25(document_fts, 0.0, 0.0, 12.0, 8.0, 5.0, 1.0, 10.0, 6.0) AS relevance_score,
                  snippet(document_fts, 5, '‹', '›', ' … ', 22) AS search_snippet
           FROM document_fts
           JOIN scoped_document_ids scoped ON scoped.document_id = document_fts.document_id
           WHERE ${conditions.join(' AND ')}
           ORDER BY relevance_score ASC, scoped.paper_updated_at DESC, scoped.paper_id ASC
           LIMIT ?
         )
         SELECT d.*, matched.paper_updated_at, matched.relevance_score, matched.search_snippet
         FROM matched_documents matched
         JOIN documents d ON d.id = matched.document_id
         ORDER BY matched.relevance_score ASC, matched.paper_updated_at DESC, matched.paper_id ASC`
      )
      .all(...parameters) as Row[]
  }

  private searchRootLegacyRows(rootId: string, terms: string[], attention: boolean, limit: number): Row[] {
    const searchableText = `lower(
      coalesce(title, '') || ' ' || authors_json || ' ' || coalesce(abstract, '') || ' ' ||
      body_text || ' ' || coalesce(doi, '') || ' ' || coalesce(journal, '')
    )`
    const conditions = terms.map(() => `${searchableText} LIKE ? ESCAPE '\\'`)
    const patterns = terms.map((term) => likePattern(term.toLocaleLowerCase()))
    const scoreParts = terms.map(
      () => `(CASE WHEN lower(coalesce(title, '')) LIKE ? ESCAPE '\\' THEN 1000 ELSE 0 END +
              CASE WHEN lower(authors_json) LIKE ? ESCAPE '\\' THEN 800 ELSE 0 END +
              CASE WHEN lower(coalesce(doi, '')) LIKE ? ESCAPE '\\' THEN 1200 ELSE 0 END +
              CASE WHEN lower(coalesce(journal, '')) LIKE ? ESCAPE '\\' THEN 700 ELSE 0 END +
              CASE WHEN lower(coalesce(abstract, '')) LIKE ? ESCAPE '\\' THEN 300 ELSE 0 END +
              CASE WHEN lower(body_text) LIKE ? ESCAPE '\\' THEN 10 ELSE 0 END)`
    )
    const scoreParameters = patterns.flatMap((pattern) => [pattern, pattern, pattern, pattern, pattern, pattern])
    const parameters: (string | number)[] = [rootId, ...scoreParameters, ...patterns]
    if (attention) {
      conditions.push("(parse_status <> 'ready' OR json_array_length(warnings_json) > 0)")
    }
    parameters.push(limit)
    const rows = this.db
      .prepare(
        `WITH scoped_documents AS (
           SELECT p.id AS paper_id, d.updated_at AS paper_updated_at, d.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY p.id
                    ORDER BY
                      CASE d.content_kind WHEN 'fulltext' THEN 3 WHEN 'abstract_only' THEN 2 ELSE 1 END DESC,
                      d.extraction_revision DESC,
                      d.modified_at DESC,
                      d.canonical_path ASC
                  ) AS scope_rank
           FROM papers p
           JOIN documents d ON d.paper_id = p.id
           JOIN document_roots dr ON dr.document_id = d.id
           WHERE dr.root_id = ?
         )
         SELECT *, (${scoreParts.join(' + ')}) AS relevance_score
         FROM scoped_documents
         WHERE scope_rank = 1 AND ${conditions.join(' AND ')}
         ORDER BY relevance_score DESC, paper_updated_at DESC, paper_id ASC
         LIMIT ?`
      )
      .all(...parameters) as Row[]
    return rows.map((row) => ({ ...row, search_snippet: queryCenteredSnippet(row, terms) }))
  }

  private mapSearchHit(row: Row, tracker: TruncationTracker, rootId: string | null): AgentSearchHit {
    const paperId = String(row.paper_id)
    const rootCondition = rootId ? ' AND r.id = ?' : ''
    const rootParameters = rootId ? [paperId, rootId] : [paperId]
    const roots = this.db
      .prepare(
        `SELECT DISTINCT r.id, r.label, r.status
         FROM documents d JOIN document_roots dr ON dr.document_id = d.id
         JOIN roots r ON r.id = dr.root_id
         WHERE d.paper_id = ?${rootCondition} ORDER BY lower(r.label)`
      )
      .all(...rootParameters) as Row[]
    const locationCount = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM documents d JOIN document_roots dr ON dr.document_id = d.id
         WHERE d.paper_id = ?${rootId ? ' AND dr.root_id = ?' : ''}`
      )
      .get(...rootParameters) as Row
    const selectedRoots = roots.slice(0, MAX_ROOTS_PER_PAPER)
    if (roots.length > selectedRoots.length) tracker.fields.add('results.roots')
    const authors = boundedStrings(
      stringArray(row.authors_json),
      MAX_AUTHORS,
      MAX_PERSON_CHARACTERS,
      tracker,
      'results.authors'
    )
    return {
      paperId: boundedText(paperId, 200, tracker, 'results.paperId') ?? '',
      doi: boundedText(text(row.doi), 500, tracker, 'results.doi'),
      title: boundedText(text(row.title), MAX_TITLE_CHARACTERS, tracker, 'results.title') ?? 'Untitled paper',
      authors: authors.values,
      year: boundedText(text(row.year), 20, tracker, 'results.year'),
      journal: boundedText(text(row.journal), MAX_LABEL_CHARACTERS, tracker, 'results.journal'),
      source: boundedText(text(row.source), 200, tracker, 'results.source'),
      contentKind: contentKind(row.content_kind),
      confidence: boundedText(text(row.confidence), 100, tracker, 'results.confidence'),
      warningCount: unknownArray(row.warnings_json).length,
      sectionCount: unknownArray(row.sections_json).length,
      locationCount: integer(locationCount.count),
      roots: selectedRoots.map((root) => ({
        id: boundedText(String(root.id), 200, tracker, 'results.roots.id') ?? '',
        label: boundedText(String(root.label), MAX_LABEL_CHARACTERS, tracker, 'results.roots.label') ?? '',
        status: rootStatus(root.status)
      })),
      omittedRootCount: roots.length - selectedRoots.length,
      snippet: boundedText(text(row.search_snippet), 2_000, tracker, 'results.snippet'),
      updatedAt:
        boundedText(text(row.paper_updated_at) ?? String(row.updated_at), 100, tracker, 'results.updatedAt') ?? ''
    }
  }

  getSnapshot(selector: AgentPaperSelector): PaperSnapshot {
    return this.snapshot(() => this.getSnapshotWithinTransaction(selector))
  }

  private getSnapshotWithinTransaction(selector: AgentPaperSelector): PaperSnapshot {
    const paperId = selector.paperId?.trim() || null
    const rawDoi = selector.doi?.trim() || null
    const rootId = selector.rootId?.trim() || null
    if (selector.rootId !== undefined && !rootId) {
      throw new AgentRelayError('INVALID_ARGUMENT', 'rootId cannot be empty.', null)
    }
    if (!paperId && !rawDoi) {
      throw new AgentRelayError('INVALID_ARGUMENT', 'Provide a PaperRelay paper ID or DOI.', null)
    }
    if (rootId) this.requireRoot(rootId)
    const doi = rawDoi ? normalizeDoi(rawDoi) : null
    if (rawDoi && !doi) {
      throw new AgentRelayError('INVALID_ARGUMENT', 'The supplied DOI is not valid.', { doi: rawDoi })
    }

    let paper: Row | undefined
    if (paperId && doi) {
      paper = this.db
        .prepare('SELECT id FROM papers WHERE id = ? AND canonical_key = ?')
        .get(paperId, `doi:${doi}`) as Row | undefined
      if (!paper) {
        const idExists = this.db.prepare('SELECT id FROM papers WHERE id = ?').get(paperId)
        const doiExists = this.db.prepare('SELECT id FROM papers WHERE canonical_key = ?').get(`doi:${doi}`)
        if (idExists || doiExists) {
          throw new AgentRelayError('IDENTIFIER_MISMATCH', 'The PaperRelay ID and DOI identify different papers.', {
            paperId,
            doi
          })
        }
      }
    } else if (paperId) {
      paper = this.db.prepare('SELECT id FROM papers WHERE id = ?').get(paperId) as Row | undefined
    } else if (doi) {
      paper = this.db.prepare('SELECT id FROM papers WHERE canonical_key = ?').get(`doi:${doi}`) as Row | undefined
    }
    if (!paper) {
      throw new AgentRelayError('PAPER_NOT_FOUND', 'No indexed paper matches the supplied identifier.', {
        paperId,
        doi,
        rootId
      })
    }

    const resolvedPaperId = String(paper.id)
    const row = rootId
      ? (this.db
          .prepare(
            `SELECT p.id AS paper_id, d.*
             FROM papers p
             JOIN documents d ON d.paper_id = p.id
             JOIN document_roots dr ON dr.document_id = d.id
             WHERE p.id = ? AND dr.root_id = ?
             ORDER BY
               CASE d.content_kind WHEN 'fulltext' THEN 3 WHEN 'abstract_only' THEN 2 ELSE 1 END DESC,
               d.extraction_revision DESC,
               d.modified_at DESC,
               d.canonical_path ASC
             LIMIT 1`
          )
          .get(resolvedPaperId, rootId) as Row | undefined)
      : (this.db
          .prepare(
            `SELECT p.id AS paper_id, d.* FROM papers p JOIN documents d ON d.id = p.preferred_document_id
             WHERE p.id = ?`
          )
          .get(resolvedPaperId) as Row | undefined)
    if (!row) {
      throw new AgentRelayError('PAPER_NOT_FOUND', 'The paper is not indexed in the requested research root.', {
        paperId: resolvedPaperId,
        doi,
        rootId
      })
    }
    return {
      row,
      paperId: resolvedPaperId,
      rootId,
      revision: revisionFor(row, rootId),
      sections: parseSections(row.sections_json),
      ...this.paperLocations(resolvedPaperId, rootId)
    }
  }

  private paperLocations(
    paperId: string,
    rootId: string | null
  ): Pick<PaperSnapshot, 'locations' | 'omittedLocationCount' | 'truncatedFields'> {
    const rows = this.db
      .prepare(
        `SELECT d.canonical_path, d.detector, d.modified_at, d.parse_status,
                dr.relative_path, r.id AS root_id, r.label AS root_label,
                r.path AS root_path, r.status AS root_status
         FROM documents d JOIN document_roots dr ON dr.document_id = d.id
         JOIN roots r ON r.id = dr.root_id
         WHERE d.paper_id = ?${rootId ? ' AND dr.root_id = ?' : ''}
         ORDER BY lower(r.label), d.modified_at DESC`
      )
      .all(...(rootId ? [paperId, rootId] : [paperId])) as Row[]
    const tracker: TruncationTracker = {
      fields: new Set(),
      remainingCharacters: MAX_LOCATION_METADATA_CHARACTERS
    }
    const selected = rows.slice(0, MAX_LOCATIONS)
    if (rows.length > selected.length) tracker.fields.add('locations')
    const locations = selected.map((row) => ({
      rootId: boundedText(String(row.root_id), 200, tracker, 'locations.rootId') ?? '',
      rootLabel: boundedText(String(row.root_label), MAX_LABEL_CHARACTERS, tracker, 'locations.rootLabel') ?? '',
      rootPath: boundedText(String(row.root_path), MAX_PATH_CHARACTERS, tracker, 'locations.rootPath') ?? '',
      rootStatus: rootStatus(row.root_status),
      artifactPath:
        boundedText(String(row.canonical_path), MAX_PATH_CHARACTERS, tracker, 'locations.artifactPath') ?? '',
      relativePath:
        boundedText(String(row.relative_path), MAX_PATH_CHARACTERS, tracker, 'locations.relativePath') ?? '',
      detector: boundedText(String(row.detector), 200, tracker, 'locations.detector') ?? '',
      modifiedAt: boundedText(String(row.modified_at), 100, tracker, 'locations.modifiedAt') ?? '',
      parseStatus: boundedText(String(row.parse_status), 100, tracker, 'locations.parseStatus') ?? ''
    }))
    return {
      locations,
      omittedLocationCount: rows.length - selected.length,
      truncatedFields: [...tracker.fields]
    }
  }

  getOutline(selector: AgentPaperSelector): AgentPaperOutline {
    const snapshot = this.getSnapshot(selector)
    const { row, sections } = snapshot
    const tracker: TruncationTracker = {
      fields: new Set(snapshot.truncatedFields),
      remainingCharacters: MAX_OUTLINE_METADATA_CHARACTERS
    }
    const abstract = truncate(text(row.abstract), MAX_OUTLINE_ABSTRACT_CHARACTERS)
    if (abstract.truncated) tracker.fields.add('abstract')
    const rawAuthors = stringArray(row.authors_json)
    const authors = boundedStrings(rawAuthors, MAX_AUTHORS, MAX_PERSON_CHARACTERS, tracker, 'authors')
    const rawKeywords = stringArray(row.keywords_json)
    const keywords = boundedStrings(rawKeywords, MAX_KEYWORDS, MAX_PERSON_CHARACTERS, tracker, 'keywords')
    const rawWarnings = stringArray(row.warnings_json)
    const warnings = boundedStrings(rawWarnings, MAX_WARNINGS, MAX_METADATA_CHARACTERS, tracker, 'warnings')
    const rawFlags = stringArray(row.flags_json)
    const flags = boundedStrings(rawFlags, MAX_FLAGS, MAX_PERSON_CHARACTERS, tracker, 'flags')
    const rawSourceTrail = stringArray(row.source_trail_json)
    const sourceTrail = boundedStrings(
      rawSourceTrail,
      MAX_SOURCE_TRAIL,
      MAX_METADATA_CHARACTERS,
      tracker,
      'sourceTrail'
    )
    if (sections.length > MAX_OUTLINE_SECTIONS) tracker.fields.add('sections')
    const sectionDescriptors: AgentSectionDescriptor[] = sections
      .slice(0, MAX_OUTLINE_SECTIONS)
      .map((section, index) => ({
        index,
        heading: boundedText(section.heading, MAX_LABEL_CHARACTERS, tracker, 'sections.heading') ?? '',
        level: section.level,
        kind: boundedText(section.kind, 100, tracker, 'sections.kind') ?? 'body',
        estimatedTokens: Math.ceil(section.text.length / 4),
        characterCount: section.text.length
      }))
    const rawAssets = unknownArray(row.assets_json).filter(
      (asset): asset is StoredAsset => Boolean(asset) && typeof asset === 'object' && !Array.isArray(asset)
    )
    if (rawAssets.length > MAX_OUTLINE_ASSETS) tracker.fields.add('assets')
    const assets = rawAssets
      .slice(0, MAX_OUTLINE_ASSETS)
      .map((asset, index): AgentAssetDescriptor => ({
        index,
        kind: boundedText(text(asset.kind), 100, tracker, 'assets.kind') ?? 'asset',
        heading:
          boundedText(text(asset.heading) ?? text(asset.caption), MAX_LABEL_CHARACTERS, tracker, 'assets.heading') ??
          'Untitled asset',
        caption: boundedText(text(asset.caption), MAX_METADATA_CHARACTERS, tracker, 'assets.caption'),
        section: boundedText(text(asset.section), MAX_LABEL_CHARACTERS, tracker, 'assets.section'),
        url: boundedText(text(asset.url), MAX_URL_CHARACTERS, tracker, 'assets.url'),
        available: asset.available === true
      }))

    return {
      paperId: snapshot.paperId,
      rootId: snapshot.rootId,
      revision: snapshot.revision,
      doi: boundedText(text(row.doi), 500, tracker, 'doi'),
      title: boundedText(text(row.title), MAX_TITLE_CHARACTERS, tracker, 'title') ?? 'Untitled paper',
      authors: authors.values,
      abstract: abstract.value,
      abstractTruncated: abstract.truncated,
      journal: boundedText(text(row.journal), MAX_LABEL_CHARACTERS, tracker, 'journal'),
      published: boundedText(text(row.published), 100, tracker, 'published'),
      year: boundedText(text(row.year), 20, tracker, 'year'),
      keywords: keywords.values,
      contentKind: contentKind(row.content_kind),
      confidence: boundedText(text(row.confidence), 100, tracker, 'confidence'),
      tokenEstimate: integer(row.token_estimate),
      referenceCount: integer(row.reference_count),
      quality: {
        warningCount: rawWarnings.length,
        warnings: warnings.values,
        flags: flags.values
      },
      provenance: {
        source: boundedText(text(row.source), 200, tracker, 'provenance.source'),
        detector: boundedText(String(row.detector), 200, tracker, 'provenance.detector') ?? '',
        extractionRevision: integer(row.extraction_revision),
        sourceTrail: sourceTrail.values
      },
      sections: sectionDescriptors,
      assets,
      locations: snapshot.locations,
      truncation: {
        truncated: tracker.fields.size > 0,
        fields: [...tracker.fields].sort(),
        omittedAuthors: authors.omitted,
        omittedKeywords: keywords.omitted,
        omittedWarnings: warnings.omitted,
        omittedSourceTrail: sourceTrail.omitted,
        omittedSections: Math.max(0, sections.length - sectionDescriptors.length),
        omittedAssets: Math.max(0, rawAssets.length - assets.length),
        omittedLocations: snapshot.omittedLocationCount
      }
    }
  }
}
