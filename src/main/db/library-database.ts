import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ContentKind,
  IndexIssue,
  LibrarySummary,
  PaperAsset,
  PaperDetail,
  PaperListItem,
  PaperLocation,
  PaperReference,
  PaperSearchRequest,
  PaperSection,
  PaperUserState,
  PaperUserSummary,
  ParseStatus,
  RootStatus,
  RootSummary
} from '../../shared/contracts.js'
import type { AnalysisPaperSnapshot, CandidateFile, NormalizedDocument } from '../domain.js'
import { canonicalAssetPathSync } from '../ingest/asset-path.js'
import { normalizeDoi, normalizeSearchQuery, paperIdentityKey, stableId } from '../ingest/identity.js'

type Row = Record<string, unknown>

interface PaperListContext {
  locationCount: number
  rootIds: string[]
  rootLabels: string[]
}

export interface CatalogPaperIdentity {
  paperId: string
  canonicalKey: string
  preferredDocumentId: string | null
}

const MAX_PAPER_REFERENCES = 2_000
const MAX_REFERENCE_INPUTS = 4_000
const MAX_REFERENCE_RAW_LENGTH = 8_192
const MAX_REFERENCE_DOI_LENGTH = 2_048
const MAX_REFERENCE_TITLE_LENGTH = 4_096
const MAX_REFERENCE_YEAR_LENGTH = 64
const MAX_ANALYSIS_REFERENCES_PER_PAPER = 100
const MAX_ANALYSIS_SECTIONS_PER_PAPER = 300
const MAX_ANALYSIS_KEYWORDS_PER_PAPER = 50
const MAX_ANALYSIS_LABEL_LENGTH = 500
const MAX_ANALYSIS_KEYWORD_LENGTH = 200

function boundedReferenceText(value: unknown, maximumLength: number): string | null {
  const scalar =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : null
  if (scalar === null) return null
  const normalized = scalar.slice(0, maximumLength).replace(/\s+/gu, ' ').trim()
  return normalized || null
}

function paperReferences(value: unknown): PaperReference[] {
  if (!Array.isArray(value)) return []

  const references: PaperReference[] = []
  for (const entry of value.slice(0, MAX_REFERENCE_INPUTS)) {
    if (references.length >= MAX_PAPER_REFERENCES) break

    const record =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : null
    const title = boundedReferenceText(record?.title, MAX_REFERENCE_TITLE_LENGTH)
    const doiInput = boundedReferenceText(
      record?.doi ?? (typeof entry === 'string' ? entry : null),
      MAX_REFERENCE_DOI_LENGTH
    )
    const doi = normalizeDoi(doiInput)
    const raw = boundedReferenceText(
      record?.raw ?? (typeof entry === 'string' ? entry : null),
      MAX_REFERENCE_RAW_LENGTH
    ) ?? title ?? doi
    if (!raw) continue

    references.push({
      raw,
      doi,
      title,
      year: boundedReferenceText(record?.year, MAX_REFERENCE_YEAR_LENGTH)
    })
  }
  return references
}

function assetPathWithinRoots(assetPath: string | null, rootPaths: string[]): string | null {
  if (!assetPath) return null
  for (const rootPath of rootPaths) {
    const canonicalPath = canonicalAssetPathSync(rootPath, assetPath)
    if (canonicalPath) return canonicalPath
  }
  return null
}

const GLOBAL_PAPER_LIST_COLUMNS = `
  p.id AS paper_id,
  p.updated_at AS paper_updated_at,
  d.title,
  d.authors_json,
  d.year,
  d.journal,
  d.doi,
  d.source,
  d.content_kind,
  d.confidence,
  json_array_length(d.warnings_json) AS warning_count,
  json_array_length(d.sections_json) AS section_count,
  json_array_length(d.assets_json) AS asset_count,
  d.updated_at`

const SCOPED_PAPER_LIST_COLUMNS = `
  scoped.paper_id AS paper_id,
  scoped.updated_at AS paper_updated_at,
  scoped.title,
  scoped.authors_json,
  scoped.year,
  scoped.journal,
  scoped.doi,
  scoped.source,
  scoped.content_kind,
  scoped.confidence,
  json_array_length(scoped.warnings_json) AS warning_count,
  json_array_length(scoped.sections_json) AS section_count,
  json_array_length(scoped.assets_json) AS asset_count,
  scoped.updated_at`

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS roots (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at TEXT NOT NULL,
    last_scanned_at TEXT
  );

  CREATE TABLE IF NOT EXISTS scan_runs (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    discovered INTEGER NOT NULL DEFAULT 0,
    indexed INTEGER NOT NULL DEFAULT 0,
    unchanged INTEGER NOT NULL DEFAULT 0,
    issues INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS papers (
    id TEXT PRIMARY KEY,
    canonical_key TEXT NOT NULL UNIQUE,
    preferred_document_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    canonical_path TEXT NOT NULL UNIQUE,
    paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
    detector TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    modified_at TEXT NOT NULL,
    parse_status TEXT NOT NULL,
    parse_error TEXT,
    doi TEXT,
    title TEXT,
    authors_json TEXT NOT NULL DEFAULT '[]',
    abstract TEXT,
    journal TEXT,
    published TEXT,
    year TEXT,
    keywords_json TEXT NOT NULL DEFAULT '[]',
    source TEXT,
    content_kind TEXT NOT NULL DEFAULT 'metadata_only',
    has_fulltext INTEGER NOT NULL DEFAULT 0,
    confidence TEXT,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    flags_json TEXT NOT NULL DEFAULT '[]',
    source_trail_json TEXT NOT NULL DEFAULT '[]',
    token_estimate INTEGER NOT NULL DEFAULT 0,
    extraction_revision INTEGER NOT NULL DEFAULT 0,
    sections_json TEXT NOT NULL DEFAULT '[]',
    assets_json TEXT NOT NULL DEFAULT '[]',
    references_json TEXT NOT NULL DEFAULT '[]',
    reference_count INTEGER NOT NULL DEFAULT 0,
    body_text TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS document_roots (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    last_seen_scan_id TEXT NOT NULL,
    PRIMARY KEY (document_id, root_id)
  );

  CREATE TABLE IF NOT EXISTS ignored_files (
    canonical_path TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_documents_paper ON documents(paper_id);
  CREATE INDEX IF NOT EXISTS idx_document_roots_root ON document_roots(root_id);
  CREATE INDEX IF NOT EXISTS idx_scan_runs_root ON scan_runs(root_id, started_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS paper_fts USING fts5(
    paper_id UNINDEXED,
    title,
    authors,
    abstract,
    body,
    doi,
    journal,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
    document_id UNINDEXED,
    paper_id UNINDEXED,
    title,
    authors,
    abstract,
    body,
    doi,
    journal,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`

const MIGRATION_2 = `
  CREATE TABLE IF NOT EXISTS ignored_files (
    canonical_path TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL
  );
  PRAGMA user_version = 2;
`

function now(): string {
  return new Date().toISOString()
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function integer(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0)
}

function contentKind(value: unknown): ContentKind {
  return value === 'fulltext' || value === 'abstract_only' ? value : 'metadata_only'
}

function parseStatus(value: unknown): ParseStatus {
  return value === 'ready' || value === 'incomplete' ? value : 'unreadable'
}

function emptyPaperUserSummary(): PaperUserSummary {
  return {
    favorite: false,
    readingStatus: 'none',
    tags: [],
    hasNote: false,
    lastOpenedAt: null,
    updatedAt: null
  }
}

function emptyPaperUserState(): PaperUserState {
  return { ...emptyPaperUserSummary(), note: '' }
}

export class LibraryDatabase {
  private readonly db: DatabaseSync
  private transactionDepth = 0
  private readonly pendingPaperUpdatesByRoot = new Map<string, Set<string>>()

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    const versionRow = this.db.prepare('PRAGMA user_version').get() as Row
    const version = integer(versionRow.user_version)
    if (version === 0) {
      this.db.exec(SCHEMA)
      this.db.exec('PRAGMA user_version = 2')
    } else if (version === 1) {
      this.db.exec(MIGRATION_2)
    } else if (version !== 2) {
      throw new Error(`PaperRelay database version ${version} is newer than this app supports.`)
    } else {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    }
    this.ensureDocumentSearchIndex()
    this.assertFtsSupport()
    this.recoverInterruptedScans()
  }

  close(): void {
    this.db.close()
  }

  private assertFtsSupport(): void {
    try {
      this.db.prepare("SELECT count(*) AS count FROM paper_fts WHERE paper_fts MATCH 'paperrelay'").get()
      this.db.prepare("SELECT count(*) AS count FROM document_fts WHERE document_fts MATCH 'paperrelay'").get()
    } catch (error) {
      throw new Error(`This PaperRelay build requires SQLite FTS5 support: ${errorMessage(error)}`)
    }
  }

  private ensureDocumentSearchIndex(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
        document_id UNINDEXED,
        paper_id UNINDEXED,
        title,
        authors,
        abstract,
        body,
        doi,
        journal,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      DELETE FROM document_fts
      WHERE document_id IS NULL
         OR document_id NOT IN (
           SELECT id FROM (
             SELECT d.id,
                    ROW_NUMBER() OVER (
                      PARTITION BY d.paper_id, dr.root_id
                      ORDER BY
                        CASE d.content_kind WHEN 'fulltext' THEN 3 WHEN 'abstract_only' THEN 2 ELSE 1 END DESC,
                        d.extraction_revision DESC,
                        d.modified_at DESC,
                        d.canonical_path ASC
                    ) AS representation_rank
             FROM documents d
             JOIN document_roots dr ON dr.document_id = d.id
             WHERE d.paper_id IS NOT NULL
           )
           WHERE representation_rank = 1
         );

      WITH ranked_documents AS (
        SELECT d.id, d.paper_id, d.title, d.authors_json, d.abstract, d.body_text, d.doi, d.journal,
               ROW_NUMBER() OVER (
                 PARTITION BY d.paper_id, dr.root_id
                 ORDER BY
                   CASE d.content_kind WHEN 'fulltext' THEN 3 WHEN 'abstract_only' THEN 2 ELSE 1 END DESC,
                   d.extraction_revision DESC,
                   d.modified_at DESC,
                   d.canonical_path ASC
               ) AS representation_rank
        FROM documents d
        JOIN document_roots dr ON dr.document_id = d.id
        WHERE d.paper_id IS NOT NULL
      ),
      selected_documents AS (
        SELECT DISTINCT id, paper_id, title, authors_json, abstract, body_text, doi, journal
        FROM ranked_documents
        WHERE representation_rank = 1
      )
      INSERT INTO document_fts(document_id, paper_id, title, authors, abstract, body, doi, journal)
      SELECT d.id, d.paper_id, COALESCE(d.title, ''), COALESCE(d.authors_json, ''),
             COALESCE(d.abstract, ''), COALESCE(d.body_text, ''),
             COALESCE(d.doi, ''), COALESCE(d.journal, '')
      FROM selected_documents d
      WHERE d.id NOT IN (SELECT document_id FROM document_fts WHERE document_id IS NOT NULL);
    `)
  }

  private reindexPaperDocuments(paperId: string): void {
    this.db.prepare('DELETE FROM document_fts WHERE paper_id = ?').run(paperId)
    this.db
      .prepare(
        `INSERT INTO document_fts(document_id, paper_id, title, authors, abstract, body, doi, journal)
         WITH ranked_documents AS (
           SELECT d.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY dr.root_id
                    ORDER BY
                      CASE d.content_kind WHEN 'fulltext' THEN 3 WHEN 'abstract_only' THEN 2 ELSE 1 END DESC,
                      d.extraction_revision DESC,
                      d.modified_at DESC,
                      d.canonical_path ASC
                  ) AS representation_rank
           FROM documents d
           JOIN document_roots dr ON dr.document_id = d.id
           WHERE d.paper_id = ?
         )
         SELECT DISTINCT id, paper_id, COALESCE(title, ''), COALESCE(authors_json, ''),
                COALESCE(abstract, ''), COALESCE(body_text, ''), COALESCE(doi, ''), COALESCE(journal, '')
         FROM ranked_documents
         WHERE representation_rank = 1`
      )
      .run(paperId)
  }

  private pruneDocumentSearchIndex(): void {
    this.db
      .prepare(
        `DELETE FROM document_fts
         WHERE document_id IS NULL
            OR document_id NOT IN (SELECT id FROM documents WHERE paper_id IS NOT NULL)`
      )
      .run()
  }

  private recoverInterruptedScans(): void {
    const timestamp = now()
    this.db
      .prepare(
        `UPDATE scan_runs SET status = 'interrupted', finished_at = ?,
         error = 'PaperRelay closed before this scan completed.' WHERE status = 'running'`
      )
      .run(timestamp)
    this.db.exec(`
      UPDATE roots
      SET status = CASE
        WHEN EXISTS (
          SELECT 1 FROM document_roots dr JOIN documents d ON d.id = dr.document_id
          WHERE dr.root_id = roots.id AND d.paper_id IS NOT NULL
        ) THEN 'ready'
        ELSE 'pending'
      END,
      error = NULL
      WHERE status = 'scanning';
    `)
  }

  private transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation()

    this.db.exec('BEGIN IMMEDIATE')
    this.transactionDepth += 1
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.transactionDepth -= 1
    }
  }

  writeBatch<T>(operation: () => T): T {
    return this.transaction(operation)
  }

  private beginPaperUpdateBatch(rootId: string): void {
    if (!this.pendingPaperUpdatesByRoot.has(rootId)) {
      this.pendingPaperUpdatesByRoot.set(rootId, new Set())
    }
  }

  private finishPaperUpdateBatch(rootId: string): void {
    const pending = this.pendingPaperUpdatesByRoot.get(rootId)
    if (!pending) return
    if (pending.size > 0) {
      this.transaction(() => {
        for (const paperId of pending) this.recomputePaper(paperId)
      })
    }
    this.pendingPaperUpdatesByRoot.delete(rootId)
  }

  private schedulePaperUpdate(paperId: string, rootId?: string): void {
    const pending = rootId ? this.pendingPaperUpdatesByRoot.get(rootId) : undefined
    if (pending) {
      pending.add(paperId)
      return
    }
    this.recomputePaper(paperId)
  }

  registerRoot(canonicalPath: string, label: string): RootSummary {
    const rootId = stableId('root', canonicalPath)
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO roots(id, path, label, status, created_at)
         VALUES (?, ?, ?, 'pending', ?)
         ON CONFLICT(path) DO UPDATE SET label = excluded.label`
      )
      .run(rootId, canonicalPath, label.trim() || canonicalPath, timestamp)
    const root = this.getRootByPath(canonicalPath)
    if (!root) throw new Error('Could not register the research folder.')
    return root
  }

  getRoot(rootId: string): RootSummary | null {
    const row = this.db.prepare('SELECT * FROM roots WHERE id = ?').get(rootId) as Row | undefined
    return row ? this.mapRoot(row) : null
  }

  private getRootByPath(path: string): RootSummary | null {
    const row = this.db.prepare('SELECT * FROM roots WHERE path = ?').get(path) as Row | undefined
    return row ? this.mapRoot(row) : null
  }

  listRoots(): RootSummary[] {
    const rows = this.db.prepare('SELECT * FROM roots ORDER BY lower(label), created_at').all() as Row[]
    return rows.map((row) => this.mapRoot(row))
  }

  private mapRoot(row: Row): RootSummary {
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
        `SELECT COUNT(*) AS count
         FROM document_roots dr JOIN documents d ON d.id = dr.document_id
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
                  ) AS representation_rank
           FROM documents d JOIN document_roots dr ON dr.document_id = d.id
           WHERE dr.root_id = ? AND d.paper_id IS NOT NULL
         )
         SELECT COUNT(*) AS count FROM scoped_documents
         WHERE representation_rank = 1
           AND (parse_status <> 'ready' OR json_array_length(warnings_json) > 0)`
      )
      .get(rootId) as Row
    return {
      id: rootId,
      path: String(row.path),
      label: String(row.label),
      status: String(row.status) as RootStatus,
      error: text(row.error),
      paperCount: integer(paperCount.count),
      issueCount: integer(unreadableCount.count) + integer(incompleteCount.count),
      lastScannedAt: text(row.last_scanned_at),
      createdAt: String(row.created_at)
    }
  }

  updateRootStatus(rootId: string, status: RootStatus, error: string | null = null): void {
    this.db.prepare('UPDATE roots SET status = ?, error = ? WHERE id = ?').run(status, error, rootId)
  }

  beginScan(rootId: string): { id: string; startedAt: string } {
    const startedAt = now()
    const scanId = stableId('scan', `${rootId}:${startedAt}:${Math.random()}`)
    this.transaction(() => {
      this.db.prepare("UPDATE roots SET status = 'scanning', error = NULL WHERE id = ?").run(rootId)
      this.db
        .prepare("INSERT INTO scan_runs(id, root_id, status, started_at) VALUES (?, ?, 'running', ?)")
        .run(scanId, rootId, startedAt)
    })
    this.beginPaperUpdateBatch(rootId)
    return { id: scanId, startedAt }
  }

  finishScan(
    scanId: string,
    counts: { discovered: number; indexed: number; unchanged: number; issues: number; removed: number }
  ): string {
    const run = this.db.prepare('SELECT root_id FROM scan_runs WHERE id = ?').get(scanId) as Row | undefined
    if (!run) throw new Error('Unknown scan run.')
    const rootId = String(run.root_id)
    this.finishPaperUpdateBatch(rootId)
    const finishedAt = now()
    const status: RootStatus = counts.indexed + counts.unchanged === 0 && counts.issues === 0 ? 'empty' : 'ready'
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE scan_runs SET status = 'completed', finished_at = ?, discovered = ?, indexed = ?,
           unchanged = ?, issues = ?, removed = ? WHERE id = ?`
        )
        .run(
          finishedAt,
          counts.discovered,
          counts.indexed,
          counts.unchanged,
          counts.issues,
          counts.removed,
          scanId
        )
      this.db
        .prepare('UPDATE roots SET status = ?, error = NULL, last_scanned_at = ? WHERE id = ?')
        .run(status, finishedAt, rootId)
    })
    return finishedAt
  }

  failScan(scanId: string, message: string, unavailable = false): void {
    const run = this.db.prepare('SELECT root_id FROM scan_runs WHERE id = ?').get(scanId) as Row | undefined
    if (!run) return
    const rootId = String(run.root_id)
    this.finishPaperUpdateBatch(rootId)
    const finishedAt = now()
    this.transaction(() => {
      this.db
        .prepare("UPDATE scan_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?")
        .run(finishedAt, message, scanId)
      this.db
        .prepare('UPDATE roots SET status = ?, error = ? WHERE id = ?')
        .run(unavailable ? 'unavailable' : 'error', message, rootId)
    })
  }

  cancelScan(scanId: string): void {
    const run = this.db.prepare('SELECT root_id FROM scan_runs WHERE id = ?').get(scanId) as Row | undefined
    if (!run) return
    const rootId = String(run.root_id)
    this.finishPaperUpdateBatch(rootId)
    const finishedAt = now()
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE scan_runs SET status = 'interrupted', finished_at = ?,
           error = 'Scan cancelled before completion.' WHERE id = ?`
        )
        .run(finishedAt, scanId)
      this.db
        .prepare(
          `UPDATE roots SET status = CASE
             WHEN EXISTS (
               SELECT 1 FROM document_roots dr JOIN documents d ON d.id = dr.document_id
               WHERE dr.root_id = roots.id AND d.paper_id IS NOT NULL
             ) THEN 'ready' ELSE 'pending' END,
           error = NULL WHERE id = ?`
        )
        .run(rootId)
    })
  }

  documentFingerprint(canonicalPath: string): { fingerprint: string; parseStatus: ParseStatus } | null {
    const row = this.db
      .prepare('SELECT fingerprint, parse_status FROM documents WHERE canonical_path = ?')
      .get(canonicalPath) as Row | undefined
    return row
      ? { fingerprint: String(row.fingerprint), parseStatus: parseStatus(row.parse_status) }
      : null
  }

  ignoredFingerprint(canonicalPath: string): string | null {
    const row = this.db
      .prepare('SELECT fingerprint FROM ignored_files WHERE canonical_path = ?')
      .get(canonicalPath) as Row | undefined
    return text(row?.fingerprint)
  }

  rememberIgnored(canonicalPath: string, fingerprint: string): void {
    this.db
      .prepare(
        `INSERT INTO ignored_files(canonical_path, fingerprint) VALUES (?, ?)
         ON CONFLICT(canonical_path) DO UPDATE SET fingerprint = excluded.fingerprint`
      )
      .run(canonicalPath, fingerprint)
  }

  private forgetIgnored(canonicalPath: string): void {
    this.db.prepare('DELETE FROM ignored_files WHERE canonical_path = ?').run(canonicalPath)
  }

  touchDocumentRoot(canonicalPath: string, rootId: string, relativePath: string, scanId: string): void {
    const row = this.db.prepare('SELECT id, paper_id, doi FROM documents WHERE canonical_path = ?').get(canonicalPath) as
      | Row
      | undefined
    if (!row) return
    const priorPaperId = text(row.paper_id)
    const identityKey = paperIdentityKey(text(row.doi), canonicalPath)
    const paperId = stableId('paper', identityKey)

    if (priorPaperId && priorPaperId !== paperId) {
      const timestamp = now()
      this.db
        .prepare(
          `INSERT INTO papers(id, canonical_key, created_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(canonical_key) DO UPDATE SET updated_at = excluded.updated_at`
        )
        .run(paperId, identityKey, timestamp, timestamp)
      this.db.prepare('UPDATE documents SET paper_id = ?, updated_at = ? WHERE id = ?').run(paperId, timestamp, String(row.id))
      this.schedulePaperUpdate(priorPaperId, rootId)
      this.schedulePaperUpdate(paperId, rootId)
    }
    this.db
      .prepare(
        `INSERT INTO document_roots(document_id, root_id, relative_path, last_seen_scan_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(document_id, root_id) DO UPDATE SET
           relative_path = excluded.relative_path,
           last_seen_scan_id = excluded.last_seen_scan_id`
      )
      .run(String(row.id), rootId, relativePath, scanId)
  }

  upsertDocument(rootId: string, scanId: string, candidate: CandidateFile, document: NormalizedDocument): void {
    const timestamp = now()
    const documentId = stableId('doc', candidate.canonicalPath)
    const identityKey = paperIdentityKey(document.doi, candidate.canonicalPath)
    const paperId = stableId('paper', identityKey)
    const prior = this.db.prepare('SELECT paper_id FROM documents WHERE id = ?').get(documentId) as Row | undefined
    const priorPaperId = text(prior?.paper_id)
    const status: ParseStatus =
      document.contentKind === 'fulltext' && document.warnings.length === 0 ? 'ready' : 'incomplete'

    this.transaction(() => {
      this.forgetIgnored(candidate.canonicalPath)
      this.db
        .prepare(
          `INSERT INTO papers(id, canonical_key, created_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(canonical_key) DO UPDATE SET updated_at = excluded.updated_at`
        )
        .run(paperId, identityKey, timestamp, timestamp)

      this.db
        .prepare(
          `INSERT INTO documents(
             id, canonical_path, paper_id, detector, fingerprint, file_size, modified_at,
             parse_status, parse_error, doi, title, authors_json, abstract, journal, published,
             year, keywords_json, source, content_kind, has_fulltext, confidence, warnings_json,
             flags_json, source_trail_json, token_estimate, extraction_revision, sections_json,
             assets_json, references_json, reference_count, body_text, updated_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           )
           ON CONFLICT(canonical_path) DO UPDATE SET
             paper_id = excluded.paper_id, detector = excluded.detector, fingerprint = excluded.fingerprint,
             file_size = excluded.file_size, modified_at = excluded.modified_at,
             parse_status = excluded.parse_status, parse_error = NULL, doi = excluded.doi,
             title = excluded.title, authors_json = excluded.authors_json, abstract = excluded.abstract,
             journal = excluded.journal, published = excluded.published, year = excluded.year,
             keywords_json = excluded.keywords_json, source = excluded.source,
             content_kind = excluded.content_kind, has_fulltext = excluded.has_fulltext,
             confidence = excluded.confidence, warnings_json = excluded.warnings_json,
             flags_json = excluded.flags_json, source_trail_json = excluded.source_trail_json,
             token_estimate = excluded.token_estimate, extraction_revision = excluded.extraction_revision,
             sections_json = excluded.sections_json, assets_json = excluded.assets_json,
             references_json = excluded.references_json, reference_count = excluded.reference_count,
             body_text = excluded.body_text, updated_at = excluded.updated_at`
        )
        .run(
          documentId,
          candidate.canonicalPath,
          paperId,
          document.detector,
          candidate.fingerprint,
          candidate.size,
          candidate.modifiedAt,
          status,
          document.doi,
          document.title,
          JSON.stringify(document.authors),
          document.abstract,
          document.journal,
          document.published,
          document.year,
          JSON.stringify(document.keywords),
          document.source,
          document.contentKind,
          document.hasFulltext ? 1 : 0,
          document.confidence,
          JSON.stringify(document.warnings),
          JSON.stringify(document.flags),
          JSON.stringify(document.sourceTrail),
          document.tokenEstimate,
          document.extractionRevision,
          JSON.stringify(document.sections),
          JSON.stringify(document.assets),
          JSON.stringify(document.references),
          document.references.length,
          document.bodyText,
          timestamp
        )

      this.db
        .prepare(
          `INSERT INTO document_roots(document_id, root_id, relative_path, last_seen_scan_id)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(document_id, root_id) DO UPDATE SET
             relative_path = excluded.relative_path,
             last_seen_scan_id = excluded.last_seen_scan_id`
        )
        .run(documentId, rootId, candidate.relativePath, scanId)

      if (priorPaperId && priorPaperId !== paperId) this.schedulePaperUpdate(priorPaperId, rootId)
      this.schedulePaperUpdate(paperId, rootId)
    })
  }

  upsertIssue(rootId: string, scanId: string, candidate: CandidateFile, message: string): void {
    const timestamp = now()
    const documentId = stableId('doc', candidate.canonicalPath)
    const prior = this.db.prepare('SELECT paper_id FROM documents WHERE id = ?').get(documentId) as Row | undefined
    const priorPaperId = text(prior?.paper_id)

    this.transaction(() => {
      this.forgetIgnored(candidate.canonicalPath)
      this.db
        .prepare(
          `INSERT INTO documents(
             id, canonical_path, paper_id, detector, fingerprint, file_size, modified_at,
             parse_status, parse_error, updated_at
           ) VALUES (?, ?, NULL, 'unreadable', ?, ?, ?, 'unreadable', ?, ?)
           ON CONFLICT(canonical_path) DO UPDATE SET
             paper_id = NULL, detector = 'unreadable', fingerprint = excluded.fingerprint,
             file_size = excluded.file_size, modified_at = excluded.modified_at,
             parse_status = 'unreadable', parse_error = excluded.parse_error, updated_at = excluded.updated_at`
        )
        .run(
          documentId,
          candidate.canonicalPath,
          candidate.fingerprint,
          candidate.size,
          candidate.modifiedAt,
          message,
          timestamp
        )
      this.db
        .prepare(
          `INSERT INTO document_roots(document_id, root_id, relative_path, last_seen_scan_id)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(document_id, root_id) DO UPDATE SET
             relative_path = excluded.relative_path,
             last_seen_scan_id = excluded.last_seen_scan_id`
        )
        .run(documentId, rootId, candidate.relativePath, scanId)
      this.db.prepare('DELETE FROM document_fts WHERE document_id = ?').run(documentId)
      if (priorPaperId) this.schedulePaperUpdate(priorPaperId, rootId)
    })
  }

  reconcileRoot(rootId: string, scanId: string): number {
    const stale = this.db
      .prepare(
        `SELECT dr.document_id, d.paper_id
         FROM document_roots dr JOIN documents d ON d.id = dr.document_id
         WHERE dr.root_id = ? AND dr.last_seen_scan_id <> ?`
      )
      .all(rootId, scanId) as Row[]
    if (stale.length === 0) return 0

    this.transaction(() => {
      this.db
        .prepare('DELETE FROM document_roots WHERE root_id = ? AND last_seen_scan_id <> ?')
        .run(rootId, scanId)
      this.db.prepare('DELETE FROM documents WHERE NOT EXISTS (SELECT 1 FROM document_roots dr WHERE dr.document_id = documents.id)').run()
      this.pruneDocumentSearchIndex()
      const paperIds = new Set(stale.map((row) => text(row.paper_id)).filter((id): id is string => Boolean(id)))
      for (const paperId of paperIds) this.schedulePaperUpdate(paperId, rootId)
    })
    return stale.length
  }

  private recomputePaper(paperId: string): void {
    const preferred = this.db
      .prepare(
        `SELECT d.* FROM documents d
         WHERE d.paper_id = ? AND EXISTS (SELECT 1 FROM document_roots dr WHERE dr.document_id = d.id)
         ORDER BY
           CASE d.content_kind WHEN 'fulltext' THEN 3 WHEN 'abstract_only' THEN 2 ELSE 1 END DESC,
           d.extraction_revision DESC,
           d.modified_at DESC,
           d.canonical_path ASC
         LIMIT 1`
      )
      .get(paperId) as Row | undefined

    this.db.prepare('DELETE FROM paper_fts WHERE paper_id = ?').run(paperId)
    if (!preferred) {
      this.db.prepare('DELETE FROM document_fts WHERE paper_id = ?').run(paperId)
      this.db.prepare('DELETE FROM papers WHERE id = ?').run(paperId)
      return
    }

    this.db
      .prepare('UPDATE papers SET preferred_document_id = ?, updated_at = ? WHERE id = ?')
      .run(String(preferred.id), now(), paperId)
    this.db
      .prepare(
        `INSERT INTO paper_fts(paper_id, title, authors, abstract, body, doi, journal)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        paperId,
        text(preferred.title) ?? '',
        json<string[]>(preferred.authors_json, []).join(' '),
        text(preferred.abstract) ?? '',
        text(preferred.body_text) ?? '',
        text(preferred.doi) ?? '',
        text(preferred.journal) ?? ''
      )
    this.reindexPaperDocuments(paperId)
  }

  removeRoot(rootId: string): void {
    const affected = this.db
      .prepare(
        `SELECT DISTINCT d.paper_id FROM document_roots dr JOIN documents d ON d.id = dr.document_id
         WHERE dr.root_id = ? AND d.paper_id IS NOT NULL`
      )
      .all(rootId) as Row[]
    this.transaction(() => {
      this.db.prepare('DELETE FROM roots WHERE id = ?').run(rootId)
      this.db.prepare('DELETE FROM documents WHERE NOT EXISTS (SELECT 1 FROM document_roots dr WHERE dr.document_id = documents.id)').run()
      this.pruneDocumentSearchIndex()
      for (const row of affected) {
        const paperId = text(row.paper_id)
        if (paperId) this.schedulePaperUpdate(paperId)
      }
    })
  }

  summary(): LibrarySummary {
    const paperCount = this.db.prepare('SELECT COUNT(*) AS count FROM papers').get() as Row
    const fullTextCount = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM papers p JOIN documents d ON d.id = p.preferred_document_id
         WHERE d.content_kind = 'fulltext'`
      )
      .get() as Row
    const unreadable = this.db.prepare("SELECT COUNT(*) AS count FROM documents WHERE parse_status = 'unreadable'").get() as Row
    const incomplete = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM papers p JOIN documents d ON d.id = p.preferred_document_id
         WHERE d.parse_status <> 'ready' OR json_array_length(d.warnings_json) > 0`
      )
      .get() as Row
    const roots = this.listRoots()
    return {
      paperCount: integer(paperCount.count),
      fullTextCount: integer(fullTextCount.count),
      issueCount: integer(unreadable.count) + integer(incomplete.count),
      favoriteCount: 0,
      readingListCount: 0,
      reviewedCount: 0,
      rootCount: roots.length,
      scanning: roots.some((root) => root.status === 'scanning'),
      roots
    }
  }

  listPaperIds(): string[] {
    const rows = this.db.prepare('SELECT id FROM papers ORDER BY id').all() as Row[]
    return rows.map((row) => String(row.id))
  }

  hasPaper(paperId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM papers WHERE id = ?').get(paperId))
  }

  getPaperIdentity(paperId: string): CatalogPaperIdentity | null {
    const row = this.db
      .prepare('SELECT id, canonical_key, preferred_document_id FROM papers WHERE id = ?')
      .get(paperId) as Row | undefined
    return row ? this.mapPaperIdentity(row) : null
  }

  listPaperIdentities(): CatalogPaperIdentity[] {
    const rows = this.db
      .prepare('SELECT id, canonical_key, preferred_document_id FROM papers ORDER BY id')
      .all() as Row[]
    return rows.map((row) => this.mapPaperIdentity(row))
  }

  countAnalysisPapers(rootId?: string): number {
    const row = rootId
      ? (this.db
          .prepare(
            `SELECT COUNT(DISTINCT d.paper_id) AS count
             FROM documents d JOIN document_roots dr ON dr.document_id = d.id
             WHERE dr.root_id = ? AND d.paper_id IS NOT NULL`
          )
          .get(rootId) as Row)
      : (this.db.prepare('SELECT COUNT(*) AS count FROM papers').get() as Row)
    return integer(row.count)
  }

  getAnalysisPaper(paperId: string, rootId?: string): AnalysisPaperSnapshot | null {
    const row = rootId
      ? (this.db
          .prepare(
            `SELECT d.paper_id, d.id AS document_id, d.fingerprint, d.title, d.doi, d.year,
                    d.content_kind, d.abstract, d.keywords_json, d.sections_json,
                    d.references_json, d.reference_count
             FROM documents d JOIN document_roots dr ON dr.document_id = d.id
             WHERE d.paper_id = ? AND dr.root_id = ?
             ORDER BY
               CASE d.content_kind WHEN 'fulltext' THEN 3 WHEN 'abstract_only' THEN 2 ELSE 1 END DESC,
               d.extraction_revision DESC,
               d.modified_at DESC,
               d.canonical_path ASC
             LIMIT 1`
          )
          .get(paperId, rootId) as Row | undefined)
      : (this.db
          .prepare(
            `SELECT p.id AS paper_id, d.id AS document_id, d.fingerprint, d.title, d.doi, d.year,
                    d.content_kind, d.abstract, d.keywords_json, d.sections_json,
                    d.references_json, d.reference_count
             FROM papers p JOIN documents d ON d.id = p.preferred_document_id
             WHERE p.id = ?`
          )
          .get(paperId) as Row | undefined)
    return row ? this.mapAnalysisPaper(row, rootId ?? null) : null
  }

  listAnalysisPapers(rootId?: string, limit = 200): AnalysisPaperSnapshot[] {
    const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 200
    const boundedLimit = Math.min(200, Math.max(1, requestedLimit))
    const rows = rootId
      ? (this.db
          .prepare(
            `WITH ranked_documents AS (
               SELECT d.paper_id, d.id AS document_id, d.fingerprint, d.title, d.doi, d.year,
                      d.content_kind, d.abstract, d.keywords_json, d.sections_json,
                      d.references_json, d.reference_count,
                      ROW_NUMBER() OVER (
                        PARTITION BY d.paper_id
                        ORDER BY
                          CASE d.content_kind WHEN 'fulltext' THEN 3 WHEN 'abstract_only' THEN 2 ELSE 1 END DESC,
                          d.extraction_revision DESC,
                          d.modified_at DESC,
                          d.canonical_path ASC
                      ) AS representation_rank
               FROM documents d JOIN document_roots dr ON dr.document_id = d.id
               WHERE dr.root_id = ? AND d.paper_id IS NOT NULL
             )
             SELECT paper_id, document_id, fingerprint, title, doi, year, content_kind, abstract,
                    keywords_json, sections_json, references_json, reference_count
             FROM ranked_documents
             WHERE representation_rank = 1
             ORDER BY lower(COALESCE(title, '')), paper_id
             LIMIT ?`
          )
          .all(rootId, boundedLimit) as Row[])
      : (this.db
          .prepare(
            `SELECT p.id AS paper_id, d.id AS document_id, d.fingerprint, d.title, d.doi, d.year,
                    d.content_kind, d.abstract, d.keywords_json, d.sections_json,
                    d.references_json, d.reference_count
             FROM papers p JOIN documents d ON d.id = p.preferred_document_id
             ORDER BY lower(COALESCE(d.title, '')), p.id
             LIMIT ?`
          )
          .all(boundedLimit) as Row[])
    return rows.map((row) => this.mapAnalysisPaper(row, rootId ?? null))
  }

  private mapPaperIdentity(row: Row): CatalogPaperIdentity {
    return {
      paperId: String(row.id),
      canonicalKey: String(row.canonical_key),
      preferredDocumentId: text(row.preferred_document_id)
    }
  }

  private mapAnalysisPaper(row: Row, rootId: string | null): AnalysisPaperSnapshot {
    const references = paperReferences(json<unknown>(row.references_json, []))
    const referenceCount = integer(row.reference_count)
    return {
      paperId: String(row.paper_id),
      documentId: String(row.document_id),
      fingerprint: String(row.fingerprint),
      rootId,
      title: (text(row.title) ?? 'Untitled paper').slice(0, MAX_ANALYSIS_LABEL_LENGTH),
      doi: text(row.doi),
      year: text(row.year),
      contentKind: contentKind(row.content_kind),
      abstract: text(row.abstract),
      keywords: json<unknown[]>(row.keywords_json, [])
        .filter((keyword): keyword is string => typeof keyword === 'string')
        .slice(0, MAX_ANALYSIS_KEYWORDS_PER_PAPER)
        .map((keyword) => keyword.slice(0, MAX_ANALYSIS_KEYWORD_LENGTH)),
      sections: json<unknown[]>(row.sections_json, [])
        .slice(0, MAX_ANALYSIS_SECTIONS_PER_PAPER)
        .flatMap((section): PaperSection[] => {
          if (!section || typeof section !== 'object' || Array.isArray(section)) return []
          const value = section as Record<string, unknown>
          if (typeof value.text !== 'string' || !value.text) return []
          return [{
            heading: (typeof value.heading === 'string' && value.heading
              ? value.heading
              : 'Untitled section').slice(0, MAX_ANALYSIS_LABEL_LENGTH),
            level: Math.min(6, Math.max(1, integer(value.level) || 1)),
            kind: (typeof value.kind === 'string' && value.kind ? value.kind : 'body').slice(
              0,
              MAX_ANALYSIS_LABEL_LENGTH
            ),
            text: value.text
          }]
        }),
      references: references.slice(0, MAX_ANALYSIS_REFERENCES_PER_PAPER),
      referenceCount,
      referencesTruncated:
        references.length > MAX_ANALYSIS_REFERENCES_PER_PAPER || referenceCount > references.length
    }
  }

  searchPapers(request: PaperSearchRequest = {}, paperIdFilter?: readonly string[]): PaperListItem[] {
    const paperIds = paperIdFilter ? [...new Set(paperIdFilter)] : undefined
    if (paperIds?.length === 0) return []
    if (request.rootId) return this.searchRootPapers(request.rootId, request, paperIds)

    const conditions: string[] = []
    const parameters: (string | number)[] = []
    const ftsQuery = request.query ? normalizeSearchQuery(request.query) : null
    const from = ftsQuery
      ? 'paper_fts f JOIN papers p ON p.id = f.paper_id JOIN documents d ON d.id = p.preferred_document_id'
      : 'papers p JOIN documents d ON d.id = p.preferred_document_id'
    if (ftsQuery) {
      conditions.push('paper_fts MATCH ?')
      parameters.push(ftsQuery)
    }
    if (request.attention) {
      conditions.push("(d.parse_status <> 'ready' OR json_array_length(d.warnings_json) > 0)")
    }
    if (paperIds) {
      conditions.push('p.id IN (SELECT value FROM json_each(?))')
      parameters.push(JSON.stringify(paperIds))
    }

    const order =
      ftsQuery && request.sort === 'updated'
        ? 'bm25(paper_fts, 0.0, 12.0, 8.0, 5.0, 1.0, 10.0, 6.0) ASC, p.updated_at DESC, p.id ASC'
        : request.sort === 'title'
        ? 'lower(d.title) ASC, p.id ASC'
        : request.sort === 'year'
          ? "COALESCE(d.year, '') DESC, lower(d.title) ASC, p.id ASC"
          : 'p.updated_at DESC, p.id ASC'
    const limit = Math.min(500, Math.max(1, request.limit ?? 200))
    const offset = Math.min(1_000_000, Math.max(0, request.offset ?? 0))
    parameters.push(limit, offset)
    const snippet = ftsQuery ? "snippet(paper_fts, 4, '‹', '›', ' … ', 22)" : 'NULL'
    const rows = this.db
      .prepare(
        `SELECT ${GLOBAL_PAPER_LIST_COLUMNS}, ${snippet} AS search_snippet
         FROM ${from}
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY ${order}
         LIMIT ? OFFSET ?`
      )
      .all(...parameters) as Row[]
    return this.mapPaperListItems(rows)
  }

  private searchRootPapers(
    rootId: string,
    request: PaperSearchRequest,
    paperIds?: readonly string[]
  ): PaperListItem[] {
    const ftsQuery = request.query ? normalizeSearchQuery(request.query) : null
    const limit = Math.min(500, Math.max(1, request.limit ?? 200))
    const offset = Math.min(1_000_000, Math.max(0, request.offset ?? 0))
    const attention = request.attention
      ? "AND (scoped.parse_status <> 'ready' OR json_array_length(scoped.warnings_json) > 0)"
      : ''
    const paperFilter = paperIds
      ? 'AND scoped.paper_id IN (SELECT value FROM json_each(?))'
      : ''
    const paperFilterParameters = paperIds ? [JSON.stringify(paperIds)] : []
    const order =
      ftsQuery && request.sort === 'updated'
        ? 'search_rank ASC, scoped.updated_at DESC, scoped.paper_id ASC'
        : request.sort === 'title'
          ? 'lower(scoped.title) ASC, scoped.paper_id ASC'
          : request.sort === 'year'
            ? "COALESCE(scoped.year, '') DESC, lower(scoped.title) ASC, scoped.paper_id ASC"
            : 'scoped.updated_at DESC, scoped.paper_id ASC'

    const rows = ftsQuery
      ? (this.db
          .prepare(
            `WITH ranked_document_ids AS MATERIALIZED (
               SELECT d.id, d.paper_id,
                      ROW_NUMBER() OVER (
                        PARTITION BY d.paper_id
                        ORDER BY
                          CASE d.content_kind WHEN 'fulltext' THEN 3 WHEN 'abstract_only' THEN 2 ELSE 1 END DESC,
                          d.extraction_revision DESC,
                          d.modified_at DESC,
                          d.canonical_path ASC
                      ) AS representation_rank
               FROM documents d
               JOIN document_roots dr ON dr.document_id = d.id
               WHERE dr.root_id = ? AND d.paper_id IS NOT NULL
             )
             SELECT ${SCOPED_PAPER_LIST_COLUMNS},
                    bm25(document_fts, 0.0, 0.0, 12.0, 8.0, 5.0, 1.0, 10.0, 6.0) AS search_rank,
                    snippet(document_fts, 5, '‹', '›', ' … ', 22) AS search_snippet
             FROM ranked_document_ids ranked
             JOIN documents scoped ON scoped.id = ranked.id
             JOIN document_fts ON document_fts.document_id = scoped.id
             WHERE ranked.representation_rank = 1 AND document_fts MATCH ? ${attention} ${paperFilter}
             ORDER BY ${order}
             LIMIT ? OFFSET ?`
          )
          .all(rootId, ftsQuery, ...paperFilterParameters, limit, offset) as Row[])
      : (this.db
          .prepare(
            `WITH ranked_document_ids AS MATERIALIZED (
               SELECT d.id, d.paper_id,
                      ROW_NUMBER() OVER (
                        PARTITION BY d.paper_id
                        ORDER BY
                          CASE d.content_kind WHEN 'fulltext' THEN 3 WHEN 'abstract_only' THEN 2 ELSE 1 END DESC,
                          d.extraction_revision DESC,
                          d.modified_at DESC,
                          d.canonical_path ASC
                      ) AS representation_rank
               FROM documents d
               JOIN document_roots dr ON dr.document_id = d.id
               WHERE dr.root_id = ? AND d.paper_id IS NOT NULL
             )
             SELECT ${SCOPED_PAPER_LIST_COLUMNS}, NULL AS search_snippet
             FROM ranked_document_ids ranked
             JOIN documents scoped ON scoped.id = ranked.id
             WHERE ranked.representation_rank = 1 ${attention} ${paperFilter}
             ORDER BY ${order}
             LIMIT ? OFFSET ?`
          )
          .all(rootId, ...paperFilterParameters, limit, offset) as Row[])

    return this.mapPaperListItems(rows, rootId)
  }

  private mapPaperListItems(rows: Row[], rootId?: string): PaperListItem[] {
    if (rows.length === 0) return []
    const paperIds = rows.map((row) => String(row.paper_id))
    const placeholders = paperIds.map(() => '?').join(', ')
    const contextRows = this.db
      .prepare(
        `SELECT d.paper_id, r.id AS root_id, r.label AS root_label, COUNT(*) AS location_count
         FROM documents d
         JOIN document_roots dr ON dr.document_id = d.id
         JOIN roots r ON r.id = dr.root_id
         WHERE d.paper_id IN (${placeholders}) ${rootId ? 'AND r.id = ?' : ''}
         GROUP BY d.paper_id, r.id, r.label
         ORDER BY d.paper_id, lower(r.label)`
      )
      .all(...paperIds, ...(rootId ? [rootId] : [])) as Row[]
    const contexts = new Map<string, PaperListContext>()
    for (const contextRow of contextRows) {
      const paperId = String(contextRow.paper_id)
      const context = contexts.get(paperId) ?? { locationCount: 0, rootIds: [], rootLabels: [] }
      context.locationCount += integer(contextRow.location_count)
      context.rootIds.push(String(contextRow.root_id))
      context.rootLabels.push(String(contextRow.root_label))
      contexts.set(paperId, context)
    }
    return rows.map((row) => this.mapPaperListItem(row, rootId, contexts.get(String(row.paper_id))))
  }

  private mapPaperListItem(row: Row, rootId?: string, suppliedContext?: PaperListContext): PaperListItem {
    const paperId = String(row.paper_id)
    let context = suppliedContext
    if (!context) {
      const roots = this.db
        .prepare(
          `SELECT r.id, r.label, COUNT(*) AS location_count
           FROM documents d JOIN document_roots dr ON dr.document_id = d.id
           JOIN roots r ON r.id = dr.root_id
           WHERE d.paper_id = ? ${rootId ? 'AND r.id = ?' : ''}
           GROUP BY r.id, r.label ORDER BY lower(r.label)`
        )
        .all(...(rootId ? [paperId, rootId] : [paperId])) as Row[]
      context = {
        locationCount: roots.reduce((sum, root) => sum + integer(root.location_count), 0),
        rootIds: roots.map((root) => String(root.id)),
        rootLabels: roots.map((root) => String(root.label))
      }
    }
    return {
      id: paperId,
      title: text(row.title) ?? 'Untitled paper',
      authors: json<string[]>(row.authors_json, []),
      year: text(row.year),
      journal: text(row.journal),
      doi: text(row.doi),
      source: text(row.source),
      contentKind: contentKind(row.content_kind),
      confidence: text(row.confidence),
      warningCount:
        row.warning_count === undefined
          ? json<unknown[]>(row.warnings_json, []).length
          : integer(row.warning_count),
      sectionCount:
        row.section_count === undefined
          ? json<unknown[]>(row.sections_json, []).length
          : integer(row.section_count),
      assetCount:
        row.asset_count === undefined ? json<unknown[]>(row.assets_json, []).length : integer(row.asset_count),
      locationCount: context.locationCount,
      rootIds: context.rootIds,
      rootLabels: context.rootLabels,
      updatedAt: text(row.paper_updated_at) ?? String(row.updated_at),
      searchSnippet: text(row.search_snippet),
      userState: emptyPaperUserSummary()
    }
  }

  getPaper(paperId: string, rootId?: string): PaperDetail | null {
    const row = rootId
      ? (this.db
          .prepare(
            `SELECT d.paper_id AS paper_id, d.updated_at AS paper_updated_at, d.*
             FROM documents d JOIN document_roots dr ON dr.document_id = d.id
             WHERE d.paper_id = ? AND dr.root_id = ?
             ORDER BY
               CASE d.content_kind WHEN 'fulltext' THEN 3 WHEN 'abstract_only' THEN 2 ELSE 1 END DESC,
               d.extraction_revision DESC,
               d.modified_at DESC,
               d.canonical_path ASC
             LIMIT 1`
          )
          .get(paperId, rootId) as Row | undefined)
      : (this.db
          .prepare(
            `SELECT p.id AS paper_id, p.updated_at AS paper_updated_at, d.*
             FROM papers p JOIN documents d ON d.id = p.preferred_document_id
             WHERE p.id = ?`
          )
          .get(paperId) as Row | undefined)
    if (!row) return null
    const listItem = this.mapPaperListItem(row, rootId)
    const locationRows = this.db
      .prepare(
        `SELECT d.id, d.canonical_path, d.detector, d.modified_at, d.parse_status,
                dr.relative_path, r.id AS root_id, r.label AS root_label, r.path AS root_path
         FROM documents d JOIN document_roots dr ON dr.document_id = d.id
         JOIN roots r ON r.id = dr.root_id
         WHERE d.paper_id = ? ${rootId ? 'AND r.id = ?' : ''}
         ORDER BY lower(r.label), d.modified_at DESC`
      )
      .all(...(rootId ? [paperId, rootId] : [paperId])) as Row[]
    const locations: PaperLocation[] = locationRows.map((location) => ({
      id: `${String(location.id)}:${String(location.root_id)}`,
      rootId: String(location.root_id),
      rootLabel: String(location.root_label),
      rootPath: String(location.root_path),
      artifactPath: String(location.canonical_path),
      relativePath: String(location.relative_path),
      detector: String(location.detector),
      modifiedAt: String(location.modified_at),
      parseStatus: parseStatus(location.parse_status)
    }))
    const selectedDocumentId = String(row.id)
    const assetRootPaths = locationRows
      .filter((location) => String(location.id) === selectedDocumentId)
      .map((location) => String(location.root_path))
    const assets = json<PaperAsset[]>(row.assets_json, []).map((asset, index) => {
      const path = assetPathWithinRoots(asset.path, assetRootPaths)
      return {
        ...asset,
        path,
        available: Boolean(path),
        previewUrl: path
          ? `paperrelay-asset://preview/${encodeURIComponent(paperId)}/${index}${
              rootId ? `?rootId=${encodeURIComponent(rootId)}` : ''
            }`
          : null
      }
    })

    return {
      ...listItem,
      userState: emptyPaperUserState(),
      userDraft: null,
      abstract: text(row.abstract),
      published: text(row.published),
      keywords: json<string[]>(row.keywords_json, []),
      warnings: json<string[]>(row.warnings_json, []),
      flags: json<string[]>(row.flags_json, []),
      sourceTrail: json<string[]>(row.source_trail_json, []),
      tokenEstimate: integer(row.token_estimate),
      referenceCount: integer(row.reference_count),
      references: paperReferences(json<unknown>(row.references_json, [])),
      sections: json<PaperSection[]>(row.sections_json, []),
      assets,
      locations
    }
  }

  listIssues(rootId?: string): IndexIssue[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.canonical_path, d.parse_error, d.updated_at, dr.relative_path,
                r.id AS root_id, r.label AS root_label
         FROM documents d JOIN document_roots dr ON dr.document_id = d.id
         JOIN roots r ON r.id = dr.root_id
         WHERE d.parse_status = 'unreadable' ${rootId ? 'AND r.id = ?' : ''}
         ORDER BY d.updated_at DESC`
      )
      .all(...(rootId ? [rootId] : [])) as Row[]
    return rows.map((row) => ({
      id: `${String(row.id)}:${String(row.root_id)}`,
      rootId: String(row.root_id),
      rootLabel: String(row.root_label),
      path: String(row.canonical_path),
      relativePath: String(row.relative_path),
      message: text(row.parse_error) ?? 'This artifact could not be read.',
      updatedAt: String(row.updated_at)
    }))
  }

  resolveLocationPath(locationId: string): string | null {
    const separator = locationId.lastIndexOf(':')
    if (separator < 1) return null
    const documentId = locationId.slice(0, separator)
    const rootId = locationId.slice(separator + 1)
    const row = this.db
      .prepare(
        `SELECT d.canonical_path FROM documents d JOIN document_roots dr ON dr.document_id = d.id
         WHERE d.id = ? AND dr.root_id = ?`
      )
      .get(documentId, rootId) as Row | undefined
    return text(row?.canonical_path)
  }

  resolveAssetPath(paperId: string, assetIndex: number, rootId?: string): string | null {
    if (!Number.isInteger(assetIndex) || assetIndex < 0) return null
    const row = rootId
      ? (this.db
          .prepare(
            `SELECT d.id, d.assets_json
             FROM documents d JOIN document_roots dr ON dr.document_id = d.id
             WHERE d.paper_id = ? AND dr.root_id = ?
             ORDER BY
               CASE d.content_kind WHEN 'fulltext' THEN 3 WHEN 'abstract_only' THEN 2 ELSE 1 END DESC,
               d.extraction_revision DESC,
               d.modified_at DESC,
               d.canonical_path ASC
             LIMIT 1`
          )
          .get(paperId, rootId) as Row | undefined)
      : (this.db
          .prepare(
            `SELECT d.id, d.assets_json FROM papers p JOIN documents d ON d.id = p.preferred_document_id
             WHERE p.id = ?`
          )
          .get(paperId) as Row | undefined)
    if (!row) return null
    const asset = json<PaperAsset[]>(row.assets_json, [])[assetIndex]
    if (!asset?.path) return null
    const roots = this.db
      .prepare(
        `SELECT r.path FROM document_roots dr JOIN roots r ON r.id = dr.root_id
         WHERE dr.document_id = ? ${rootId ? 'AND r.id = ?' : ''}`
      )
      .all(...(rootId ? [String(row.id), rootId] : [String(row.id)])) as Row[]
    return assetPathWithinRoots(
      asset.path,
      roots.map((root) => String(root.path))
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
