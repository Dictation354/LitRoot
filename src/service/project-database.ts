import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ContentKind,
  MetadataOverrides,
  PaperDetail,
  PaperListItem,
  PaperMetadata,
  PaperSearchRequest,
  PaperSearchResult,
  PaperSortField,
  SortDirection
} from '../shared/contracts.js'
import type { ParsedPaperMarkdown } from './paper-markdown.js'
import { safeFtsQuery } from './identity.js'
import { sha256 } from './identity.js'
import { mergeMetadata } from './metadata.js'

type Row = Record<string, unknown>

export interface IndexedPaperInput {
  id: string
  relativePath: string
  filePath: string
  fingerprint: string
  rawMarkdown: string
  parsed: ParsedPaperMarkdown
  overrides: MetadataOverrides
  addedAt: string | null
  modifiedAt: string
}

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS papers (
    id TEXT PRIMARY KEY,
    relative_path TEXT NOT NULL UNIQUE,
    file_path TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    raw_markdown TEXT NOT NULL,
    body_markdown TEXT NOT NULL,
    body_text TEXT NOT NULL,
    fetched_metadata_json TEXT NOT NULL,
    overrides_json TEXT NOT NULL,
    title TEXT NOT NULL,
    authors_json TEXT NOT NULL,
    journal TEXT NOT NULL,
    year INTEGER,
    doi TEXT NOT NULL,
    url TEXT NOT NULL,
    abstract TEXT NOT NULL,
    keywords_json TEXT NOT NULL,
    source TEXT NOT NULL,
    content_kind TEXT NOT NULL,
    has_fulltext INTEGER NOT NULL,
    asset_sources_json TEXT NOT NULL,
    added_at TEXT,
    last_opened_at TEXT,
    modified_at TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_doi
    ON papers(doi) WHERE doi <> '';
  CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(year);

  CREATE TABLE IF NOT EXISTS issues (
    relative_path TEXT PRIMARY KEY,
    message TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS paper_fts USING fts5(
    paper_id UNINDEXED,
    title,
    authors,
    journal,
    year,
    doi,
    url,
    abstract,
    keywords,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`

function now(): string {
  return new Date().toISOString()
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
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

function contentKind(value: unknown): ContentKind {
  return value === 'fulltext' || value === 'abstract_only' ? value : 'metadata_only'
}

function listItem(row: Row): PaperListItem {
  return {
    id: asString(row.id),
    relativePath: asString(row.relative_path),
    title: asString(row.title),
    authors: json<string[]>(row.authors_json, []),
    journal: asString(row.journal),
    year: row.year === null || row.year === undefined ? null : asNumber(row.year),
    doi: asString(row.doi),
    url: asString(row.url),
    abstract: asString(row.abstract),
    keywords: json<string[]>(row.keywords_json, []),
    source: asString(row.source),
    contentKind: contentKind(row.content_kind),
    hasFulltext: asNumber(row.has_fulltext) === 1,
    addedAt: asString(row.added_at) || null,
    lastOpenedAt: asString(row.last_opened_at) || null,
    modifiedAt: asString(row.modified_at),
    searchSnippet: typeof row.search_snippet === 'string' ? row.search_snippet : null,
    hasOverrides: Object.keys(json<MetadataOverrides>(row.overrides_json, {})).length > 0
  }
}

const SORT_EXPRESSIONS: Record<PaperSortField, string> = {
  title: 'nullif(p.title, \'\') COLLATE NOCASE',
  authors: 'nullif(json_extract(p.authors_json, \'$[0]\'), \'\') COLLATE NOCASE',
  year: 'p.year',
  journal: 'nullif(p.journal, \'\') COLLATE NOCASE',
  contentKind: 'nullif(p.content_kind, \'\') COLLATE NOCASE',
  source: 'nullif(p.source, \'\') COLLATE NOCASE',
  addedAt: 'nullif(p.added_at, \'\')',
  lastOpenedAt: 'nullif(p.last_opened_at, \'\')',
  modifiedAt: 'nullif(p.modified_at, \'\')'
}

function orderBy(sortBy: PaperSortField, direction: SortDirection): string {
  const expression = SORT_EXPRESSIONS[sortBy]
  const sqlDirection = direction === 'desc' ? 'DESC' : 'ASC'
  return `${expression} IS NULL ASC, ${expression} ${sqlDirection}, ` +
    'p.title COLLATE NOCASE ASC, p.id ASC'
}

export class ProjectDatabase {
  private readonly database: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    const version = asNumber((this.database.prepare('PRAGMA user_version').get() as Row).user_version)
    if (version === 0) {
      this.database.exec(SCHEMA)
      this.database.exec('PRAGMA user_version = 2')
    } else if (version === 1) {
      this.database.exec(`
        ALTER TABLE papers ADD COLUMN added_at TEXT;
        ALTER TABLE papers ADD COLUMN last_opened_at TEXT;
        PRAGMA user_version = 2;
      `)
      this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    } else if (version !== 2) {
      throw new Error(`LitRoot 索引版本 ${version} 高于当前支持的版本。请删除可重建的 cache。`)
    } else {
      this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    }
    this.database.prepare("SELECT count(*) FROM paper_fts WHERE paper_fts MATCH 'litroot'").get()
  }

  close(): void {
    this.database.close()
  }

  transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  fingerprint(relativePath: string): string | null {
    const row = this.database.prepare('SELECT fingerprint FROM papers WHERE relative_path = ?').get(relativePath) as Row | undefined
    return row ? asString(row.fingerprint) : null
  }

  idAtPath(relativePath: string): string | null {
    const row = this.database.prepare('SELECT id FROM papers WHERE relative_path = ?').get(relativePath) as Row | undefined
    return row ? asString(row.id) : null
  }

  upsert(input: IndexedPaperInput): void {
    const effective = mergeMetadata(input.parsed.metadata, input.overrides)
    this.transaction(() => {
      const previous = this.database.prepare('SELECT id FROM papers WHERE relative_path = ?').get(input.relativePath) as Row | undefined
      if (previous && asString(previous.id) !== input.id) {
        this.database.prepare('DELETE FROM paper_fts WHERE paper_id = ?').run(asString(previous.id))
        this.database.prepare('DELETE FROM papers WHERE id = ?').run(asString(previous.id))
      }
      this.database.prepare(`
        INSERT INTO papers (
          id, relative_path, file_path, fingerprint, raw_markdown, body_markdown, body_text,
          fetched_metadata_json, overrides_json, title, authors_json, journal, year, doi, url,
          abstract, keywords_json, source, content_kind, has_fulltext, asset_sources_json,
          added_at, modified_at, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          relative_path = excluded.relative_path,
          file_path = excluded.file_path,
          fingerprint = excluded.fingerprint,
          raw_markdown = excluded.raw_markdown,
          body_markdown = excluded.body_markdown,
          body_text = excluded.body_text,
          fetched_metadata_json = excluded.fetched_metadata_json,
          overrides_json = excluded.overrides_json,
          title = excluded.title,
          authors_json = excluded.authors_json,
          journal = excluded.journal,
          year = excluded.year,
          doi = excluded.doi,
          url = excluded.url,
          abstract = excluded.abstract,
          keywords_json = excluded.keywords_json,
          source = excluded.source,
          content_kind = excluded.content_kind,
          has_fulltext = excluded.has_fulltext,
          asset_sources_json = excluded.asset_sources_json,
          added_at = excluded.added_at,
          modified_at = excluded.modified_at,
          indexed_at = excluded.indexed_at
      `).run(
        input.id,
        input.relativePath,
        input.filePath,
        input.fingerprint,
        input.rawMarkdown,
        input.parsed.body,
        input.parsed.searchableBody,
        JSON.stringify(input.parsed.metadata),
        JSON.stringify(input.overrides),
        effective.title,
        JSON.stringify(effective.authors),
        effective.journal,
        effective.year,
        effective.doi,
        effective.url,
        effective.abstract,
        JSON.stringify(effective.keywords),
        input.parsed.source,
        input.parsed.contentKind,
        input.parsed.hasFulltext ? 1 : 0,
        JSON.stringify(input.parsed.assetSources),
        input.addedAt,
        input.modifiedAt,
        now()
      )
      this.reindexPaper(input.id)
      this.database.prepare('DELETE FROM issues WHERE relative_path = ?').run(input.relativePath)
    })
  }

  private reindexPaper(paperId: string): void {
    this.database.prepare('DELETE FROM paper_fts WHERE paper_id = ?').run(paperId)
    this.database.prepare(`
      INSERT INTO paper_fts (
        paper_id, title, authors, journal, year, doi, url, abstract, keywords, body
      )
      SELECT id, title, authors_json, journal, coalesce(year, ''), doi, url,
             abstract, keywords_json, body_text
      FROM papers WHERE id = ?
    `).run(paperId)
  }

  setIssue(relativePath: string, message: string): void {
    this.database.prepare(`
      INSERT INTO issues(relative_path, message, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(relative_path) DO UPDATE SET message = excluded.message, updated_at = excluded.updated_at
    `).run(relativePath, message, now())
  }

  removeMissing(seenPaths: Set<string>, seenCandidatePaths = seenPaths): number {
    const existing = this.database.prepare('SELECT id, relative_path FROM papers').all() as Row[]
    const removed = existing.filter((row) => !seenPaths.has(asString(row.relative_path)))
    this.transaction(() => {
      for (const row of removed) {
        this.database.prepare('DELETE FROM paper_fts WHERE paper_id = ?').run(asString(row.id))
        this.database.prepare('DELETE FROM papers WHERE id = ?').run(asString(row.id))
      }
      const issues = this.database.prepare('SELECT relative_path FROM issues').all() as Row[]
      for (const row of issues) {
        if (!seenCandidatePaths.has(asString(row.relative_path))) {
          this.database.prepare('DELETE FROM issues WHERE relative_path = ?').run(asString(row.relative_path))
        }
      }
    })
    return removed.length
  }

  search(request: PaperSearchRequest): PaperSearchResult {
    const parsed = {
      query: request.query?.trim() ?? '',
      year: request.year ?? null,
      sortBy: request.sortBy ?? 'title',
      sortDirection: request.sortDirection ?? 'asc',
      limit: request.limit ?? 50,
      offset: request.offset ?? 0
    }
    const match = safeFtsQuery(parsed.query)
    const conditions: string[] = []
    const values: Array<string | number> = []
    if (match) {
      conditions.push('paper_fts MATCH ?')
      values.push(match)
    }
    if (parsed.year !== null) {
      conditions.push('p.year = ?')
      values.push(parsed.year)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const from = match ? 'FROM paper_fts JOIN papers p ON p.id = paper_fts.paper_id' : 'FROM papers p'
    const snippet = match
      ? "snippet(paper_fts, 9, '<mark>', '</mark>', '…', 24)"
      : 'NULL'
    const rows = this.database.prepare(`
      SELECT p.*, ${snippet} AS search_snippet
      ${from} ${where}
      ORDER BY ${orderBy(parsed.sortBy, parsed.sortDirection)}
      LIMIT ? OFFSET ?
    `).all(...values, parsed.limit, parsed.offset) as Row[]
    const totalRow = this.database.prepare(`SELECT count(*) AS count ${from} ${where}`).get(...values) as Row
    return {
      items: rows.map(listItem),
      total: asNumber(totalRow.count),
      years: this.years()
    }
  }

  get(paperId: string): PaperDetail | null {
    const row = this.database.prepare('SELECT *, NULL AS search_snippet FROM papers WHERE id = ?').get(paperId) as Row | undefined
    if (!row) return null
    return {
      ...listItem(row),
      fetchedMetadata: json<PaperMetadata>(row.fetched_metadata_json, {
        title: '', authors: [], journal: '', year: null, doi: '', url: '', abstract: '', keywords: []
      }),
      overrides: json<MetadataOverrides>(row.overrides_json, {}),
      markdown: asString(row.body_markdown),
      markdownRevision: sha256(asString(row.raw_markdown)),
      assetPaths: json<string[]>(row.asset_sources_json, [])
    }
  }

  markOpened(paperId: string, at = now()): string | null {
    const result = this.database.prepare('UPDATE papers SET last_opened_at = ? WHERE id = ?').run(at, paperId)
    return asNumber(result.changes) === 1 ? at : null
  }

  updateOverrides(paperId: string, overrides: MetadataOverrides): PaperDetail | null {
    const row = this.database.prepare('SELECT fetched_metadata_json FROM papers WHERE id = ?').get(paperId) as Row | undefined
    if (!row) return null
    const fetched = json<PaperMetadata>(row.fetched_metadata_json, {
      title: '', authors: [], journal: '', year: null, doi: '', url: '', abstract: '', keywords: []
    })
    const effective = mergeMetadata(fetched, overrides)
    this.transaction(() => {
      this.database.prepare(`
        UPDATE papers SET overrides_json = ?, title = ?, authors_json = ?, journal = ?, year = ?,
          doi = ?, url = ?, abstract = ?, keywords_json = ?, indexed_at = ? WHERE id = ?
      `).run(
        JSON.stringify(overrides), effective.title, JSON.stringify(effective.authors), effective.journal,
        effective.year, effective.doi, effective.url, effective.abstract,
        JSON.stringify(effective.keywords), now(), paperId
      )
      this.reindexPaper(paperId)
    })
    return this.get(paperId)
  }

  findByDoi(doi: string, excludingPaperId?: string): PaperListItem | null {
    const row = this.database.prepare(`
      SELECT *, NULL AS search_snippet FROM papers WHERE doi = ? AND (? IS NULL OR id <> ?) LIMIT 1
    `).get(doi, excludingPaperId ?? null, excludingPaperId ?? null) as Row | undefined
    return row ? listItem(row) : null
  }

  filePath(paperId: string): string | null {
    const row = this.database.prepare('SELECT file_path FROM papers WHERE id = ?').get(paperId) as Row | undefined
    return row ? asString(row.file_path) : null
  }

  years(): number[] {
    return (this.database.prepare('SELECT DISTINCT year FROM papers WHERE year IS NOT NULL ORDER BY year DESC').all() as Row[])
      .map((row) => asNumber(row.year))
  }

  summary(): { paperCount: number; issueCount: number; years: number[]; lastScannedAt: string | null } {
    const paper = this.database.prepare('SELECT count(*) AS count FROM papers').get() as Row
    const issue = this.database.prepare('SELECT count(*) AS count FROM issues').get() as Row
    const scan = this.database.prepare("SELECT value FROM state WHERE key = 'last_scanned_at'").get() as Row | undefined
    return {
      paperCount: asNumber(paper.count),
      issueCount: asNumber(issue.count),
      years: this.years(),
      lastScannedAt: scan ? asString(scan.value) : null
    }
  }

  markScanned(at: string): void {
    this.database.prepare(`
      INSERT INTO state(key, value) VALUES ('last_scanned_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(at)
  }
}
