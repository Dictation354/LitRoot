import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  PaperReadingStatus,
  PaperUserDraft,
  PaperUserDraftInput,
  PaperUserState,
  PaperUserStatePatch,
  PaperUserSummary,
  PaperUserView
} from '../../shared/contracts.js'

type Row = Record<string, unknown>

export const MAX_PAPER_USER_TAGS = 24
export const MAX_PAPER_USER_TAG_LENGTH = 64
export const MAX_PAPER_USER_TAG_INPUT_LENGTH = 2_000
export const MAX_PAPER_USER_NOTE_LENGTH = 20_000

export interface PaperUserCounts {
  favoriteCount: number
  readingListCount: number
  reviewedCount: number
}

export interface PaperUserIdentity {
  paperId: string
  canonicalKey: string
  preferredDocumentId: string | null
}

const MAX_IDENTITY_RELINK_ROWS = 5_000

const EMPTY_COUNTS: PaperUserCounts = {
  favoriteCount: 0,
  readingListCount: 0,
  reviewedCount: 0
}

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = OFF;

  CREATE TABLE IF NOT EXISTS paper_user_state (
    paper_id TEXT PRIMARY KEY,
    canonical_key TEXT,
    preferred_document_id TEXT,
    favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    reading_status TEXT NOT NULL DEFAULT 'none'
      CHECK (reading_status IN ('none', 'to_read', 'reading', 'reviewed')),
    tags_json TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    last_opened_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_paper_user_state_favorite
    ON paper_user_state(favorite, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_paper_user_state_reading
    ON paper_user_state(reading_status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_paper_user_state_canonical_key
    ON paper_user_state(canonical_key);
  CREATE INDEX IF NOT EXISTS idx_paper_user_state_preferred_document
    ON paper_user_state(preferred_document_id);

  CREATE TABLE IF NOT EXISTS paper_user_drafts (
    paper_id TEXT PRIMARY KEY,
    canonical_key TEXT,
    preferred_document_id TEXT,
    note TEXT NOT NULL DEFAULT '',
    tag_input TEXT NOT NULL DEFAULT '',
    base_state_updated_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_paper_user_drafts_canonical_key
    ON paper_user_drafts(canonical_key);
  CREATE INDEX IF NOT EXISTS idx_paper_user_drafts_preferred_document
    ON paper_user_drafts(preferred_document_id);

  PRAGMA user_version = 2;
`

function integer(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0)
}

function readingStatus(value: unknown): PaperReadingStatus {
  if (value === 'to_read' || value === 'reading' || value === 'reviewed') return value
  return 'none'
}

function requiredPaperId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Paper is required.')
  const paperId = value.trim()
  if (paperId.length > 200) throw new Error('Paper identifier is too long.')
  return paperId
}

function parseTags(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    const tags: string[] = []
    const seen = new Set<string>()
    for (const entry of parsed.slice(0, MAX_PAPER_USER_TAGS)) {
      if (typeof entry !== 'string') continue
      const tag = entry.trim()
      if (!tag || tag.length > MAX_PAPER_USER_TAG_LENGTH) continue
      const key = tag.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      tags.push(tag)
    }
    return tags
  } catch {
    return []
  }
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Tags must be an array.')
  if (value.length > MAX_PAPER_USER_TAGS) {
    throw new Error(`A paper can have at most ${MAX_PAPER_USER_TAGS} tags.`)
  }

  const tags: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('Every tag must be text.')
    const tag = entry.trim()
    if (!tag) continue
    if (tag.length > MAX_PAPER_USER_TAG_LENGTH) {
      throw new Error(`Each tag can be at most ${MAX_PAPER_USER_TAG_LENGTH} characters.`)
    }
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return tags
}

function normalizeDraftInput(value: PaperUserDraftInput): PaperUserDraftInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Draft changes must be an object.')
  }

  const record = value as unknown as Record<string, unknown>
  if (typeof record.note !== 'string') throw new Error('Draft note must be text.')
  if (record.note.length > MAX_PAPER_USER_NOTE_LENGTH) {
    throw new Error(`Draft note can be at most ${MAX_PAPER_USER_NOTE_LENGTH} characters.`)
  }
  if (typeof record.tagInput !== 'string') throw new Error('Draft tags must be text.')
  if (record.tagInput.length > MAX_PAPER_USER_TAG_INPUT_LENGTH) {
    throw new Error(
      `Draft tags can be at most ${MAX_PAPER_USER_TAG_INPUT_LENGTH} characters.`
    )
  }
  return { note: record.note, tagInput: record.tagInput }
}

function committedDraftTags(tagInput: string): string[] {
  return normalizeTags(
    tagInput
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
  )
}

function normalizePatch(value: PaperUserStatePatch): PaperUserStatePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('User state changes must be an object.')
  }

  const record = value as Record<string, unknown>
  const patch: PaperUserStatePatch = {}
  if (Object.hasOwn(record, 'favorite')) {
    if (typeof record.favorite !== 'boolean') throw new Error('Favorite must be true or false.')
    patch.favorite = record.favorite
  }
  if (Object.hasOwn(record, 'readingStatus')) {
    if (
      record.readingStatus !== 'none' &&
      record.readingStatus !== 'to_read' &&
      record.readingStatus !== 'reading' &&
      record.readingStatus !== 'reviewed'
    ) {
      throw new Error('Reading status is invalid.')
    }
    patch.readingStatus = record.readingStatus
  }
  if (Object.hasOwn(record, 'tags')) patch.tags = normalizeTags(record.tags)
  if (Object.hasOwn(record, 'note')) {
    if (typeof record.note !== 'string') throw new Error('Private note must be text.')
    if (record.note.length > MAX_PAPER_USER_NOTE_LENGTH) {
      throw new Error(`Private note can be at most ${MAX_PAPER_USER_NOTE_LENGTH} characters.`)
    }
    patch.note = record.note.trim() ? record.note : ''
  }
  return patch
}

function emptyState(): PaperUserState {
  return {
    favorite: false,
    readingStatus: 'none',
    tags: [],
    hasNote: false,
    note: '',
    lastOpenedAt: null,
    updatedAt: null
  }
}

function stateFromRow(row: Row | undefined): PaperUserState {
  if (!row) return emptyState()
  const note = typeof row.note === 'string' ? row.note : ''
  return {
    favorite: integer(row.favorite) === 1,
    readingStatus: readingStatus(row.reading_status),
    tags: parseTags(row.tags_json),
    hasNote: Boolean(note.trim()),
    note,
    lastOpenedAt: typeof row.last_opened_at === 'string' ? row.last_opened_at : null,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null
  }
}

function draftFromRow(row: Row | undefined): PaperUserDraft | null {
  if (!row || typeof row.paper_id !== 'string' || typeof row.updated_at !== 'string') return null
  return {
    paperId: row.paper_id,
    note: typeof row.note === 'string' ? row.note : '',
    tagInput: typeof row.tag_input === 'string' ? row.tag_input : '',
    baseStateUpdatedAt:
      typeof row.base_state_updated_at === 'string' ? row.base_state_updated_at : null,
    updatedAt: row.updated_at
  }
}

function summaryFromState(state: PaperUserState): PaperUserSummary {
  return {
    favorite: state.favorite,
    readingStatus: state.readingStatus,
    tags: [...state.tags],
    hasNote: state.hasNote,
    lastOpenedAt: state.lastOpenedAt,
    updatedAt: state.updatedAt
  }
}

function normalizedPaperIds(values: readonly string[]): string[] {
  return [...new Set(values.map(requiredPaperId))]
}

function ensureIdentityColumns(database: DatabaseSync): void {
  const columns = new Set(
    (database.prepare("PRAGMA table_info('paper_user_state')").all() as Row[]).flatMap((row) =>
      typeof row.name === 'string' ? [row.name] : []
    )
  )
  if (!columns.has('canonical_key')) {
    database.exec('ALTER TABLE paper_user_state ADD COLUMN canonical_key TEXT;')
  }
  if (!columns.has('preferred_document_id')) {
    database.exec('ALTER TABLE paper_user_state ADD COLUMN preferred_document_id TEXT;')
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_paper_user_state_canonical_key
      ON paper_user_state(canonical_key);
    CREATE INDEX IF NOT EXISTS idx_paper_user_state_preferred_document
      ON paper_user_state(preferred_document_id);
  `)
}

function ensureDraftSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS paper_user_drafts (
      paper_id TEXT PRIMARY KEY,
      canonical_key TEXT,
      preferred_document_id TEXT,
      note TEXT NOT NULL DEFAULT '',
      tag_input TEXT NOT NULL DEFAULT '',
      base_state_updated_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_paper_user_drafts_canonical_key
      ON paper_user_drafts(canonical_key);
    CREATE INDEX IF NOT EXISTS idx_paper_user_drafts_preferred_document
      ON paper_user_drafts(preferred_document_id);
  `)
}

function reconcileIdentityRows(
  database: DatabaseSync,
  table: 'paper_user_state' | 'paper_user_drafts',
  rows: readonly Row[],
  byPaperId: ReadonlyMap<string, PaperUserIdentity>,
  byCanonicalKey: ReadonlyMap<string, PaperUserIdentity>,
  byDocumentId: ReadonlyMap<string, PaperUserIdentity>
): void {
  const targetExists = database.prepare(`SELECT 1 FROM ${table} WHERE paper_id = ?`)
  const updateIdentity = database.prepare(
    `UPDATE ${table}
     SET paper_id = ?, canonical_key = ?, preferred_document_id = ?
     WHERE paper_id = ?`
  )
  for (const row of rows) {
    if (typeof row.paper_id !== 'string') continue
    const oldPaperId = row.paper_id
    const oldCanonicalKey = typeof row.canonical_key === 'string' ? row.canonical_key : null
    const oldDocumentId =
      typeof row.preferred_document_id === 'string' ? row.preferred_document_id : null
    let identity = byPaperId.get(oldPaperId)
    identity ??= oldCanonicalKey ? byCanonicalKey.get(oldCanonicalKey) : undefined
    if (
      !identity &&
      oldDocumentId &&
      (!oldCanonicalKey || oldCanonicalKey.startsWith('location:'))
    ) {
      identity = byDocumentId.get(oldDocumentId)
    }
    if (!identity) continue
    if (
      identity.paperId === oldPaperId &&
      identity.canonicalKey === oldCanonicalKey &&
      identity.preferredDocumentId === oldDocumentId
    ) {
      continue
    }
    if (identity.paperId !== oldPaperId && targetExists.get(identity.paperId)) continue
    updateIdentity.run(
      identity.paperId,
      identity.canonicalKey,
      identity.preferredDocumentId,
      oldPaperId
    )
  }
}

export class PaperUserDatabase {
  private readonly db: DatabaseSync
  private closed = false

  constructor(databasePath = ':memory:') {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    try {
      const versionRow = this.db.prepare('PRAGMA user_version').get() as Row
      const version = integer(versionRow.user_version)
      if (version === 0) {
        this.db.exec(SCHEMA)
      } else if (version === 1) {
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;')
        this.db.exec('BEGIN IMMEDIATE')
        try {
          ensureIdentityColumns(this.db)
          ensureDraftSchema(this.db)
          this.db.exec('PRAGMA user_version = 2; COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
      } else if (version === 2) {
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;')
      } else {
        throw new Error(`PaperRelay user database version ${version} is newer than this app supports.`)
      }
    } catch (error) {
      this.db.close()
      this.closed = true
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  getPaperState(paperIdValue: string): PaperUserState {
    const paperId = requiredPaperId(paperIdValue)
    const row = this.db.prepare('SELECT * FROM paper_user_state WHERE paper_id = ?').get(paperId) as
      | Row
      | undefined
    return stateFromRow(row)
  }

  getPaperDraft(paperIdValue: string): PaperUserDraft | null {
    const paperId = requiredPaperId(paperIdValue)
    const row = this.db
      .prepare('SELECT * FROM paper_user_drafts WHERE paper_id = ?')
      .get(paperId) as Row | undefined
    return draftFromRow(row)
  }

  savePaperDraft(
    paperIdValue: string,
    value: PaperUserDraftInput,
    identity?: PaperUserIdentity
  ): PaperUserDraft {
    const paperId = requiredPaperId(paperIdValue)
    const draft = normalizeDraftInput(value)
    const currentState = this.getPaperState(paperId)
    const timestamp = new Date().toISOString()
    const canonicalKey = identity?.paperId === paperId ? identity.canonicalKey : null
    const preferredDocumentId = identity?.paperId === paperId ? identity.preferredDocumentId : null
    this.db
      .prepare(
        `INSERT INTO paper_user_drafts(
           paper_id, canonical_key, preferred_document_id, note, tag_input,
           base_state_updated_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(paper_id) DO UPDATE SET
           canonical_key = COALESCE(excluded.canonical_key, paper_user_drafts.canonical_key),
           preferred_document_id = COALESCE(
             excluded.preferred_document_id,
             paper_user_drafts.preferred_document_id
           ),
           note = excluded.note,
           tag_input = excluded.tag_input,
           updated_at = excluded.updated_at`
      )
      .run(
        paperId,
        canonicalKey,
        preferredDocumentId,
        draft.note,
        draft.tagInput,
        currentState.updatedAt,
        timestamp
      )
    const saved = this.getPaperDraft(paperId)
    if (!saved) throw new Error('The draft could not be saved.')
    return saved
  }

  discardPaperDraft(paperIdValue: string): void {
    const paperId = requiredPaperId(paperIdValue)
    this.db.prepare('DELETE FROM paper_user_drafts WHERE paper_id = ?').run(paperId)
  }

  commitPaperDraft(
    paperIdValue: string,
    identity?: PaperUserIdentity
  ): PaperUserState {
    const paperId = requiredPaperId(paperIdValue)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const draftRow = this.db
        .prepare('SELECT * FROM paper_user_drafts WHERE paper_id = ?')
        .get(paperId) as Row | undefined
      const draft = draftFromRow(draftRow)
      if (!draft) {
        const current = this.getPaperState(paperId)
        this.db.exec('COMMIT')
        return current
      }

      const tags = committedDraftTags(draft.tagInput)
      const current = this.getPaperState(paperId)
      const committed = this.writeState(
        paperId,
        {
          ...current,
          tags,
          note: draft.note,
          hasNote: Boolean(draft.note.trim()),
          updatedAt: null
        },
        identity
      )
      this.db.prepare('DELETE FROM paper_user_drafts WHERE paper_id = ?').run(paperId)
      this.db.exec('COMMIT')
      return committed
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getPaperSummaries(paperIdValues: readonly string[]): Map<string, PaperUserSummary> {
    const paperIds = normalizedPaperIds(paperIdValues)
    const summaries = new Map<string, PaperUserSummary>()
    for (const paperId of paperIds) summaries.set(paperId, summaryFromState(emptyState()))
    if (paperIds.length === 0) return summaries

    const rows = this.db
      .prepare(
        `SELECT * FROM paper_user_state
         WHERE paper_id IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(paperIds)) as Row[]
    for (const row of rows) {
      const paperId = typeof row.paper_id === 'string' ? row.paper_id : null
      if (paperId) summaries.set(paperId, summaryFromState(stateFromRow(row)))
    }
    return summaries
  }

  reconcilePaperIdentities(identityValues: readonly PaperUserIdentity[]): void {
    const identities: PaperUserIdentity[] = []
    const seenPaperIds = new Set<string>()
    for (const value of identityValues) {
      const paperId = requiredPaperId(value.paperId)
      if (seenPaperIds.has(paperId)) continue
      if (typeof value.canonicalKey !== 'string' || !value.canonicalKey || value.canonicalKey.length > 10_000) {
        continue
      }
      const preferredDocumentId =
        typeof value.preferredDocumentId === 'string' && value.preferredDocumentId.length <= 200
          ? value.preferredDocumentId
          : null
      seenPaperIds.add(paperId)
      identities.push({ paperId, canonicalKey: value.canonicalKey, preferredDocumentId })
    }
    if (identities.length === 0) return

    const byPaperId = new Map(identities.map((identity) => [identity.paperId, identity]))
    const byCanonicalKey = new Map(identities.map((identity) => [identity.canonicalKey, identity]))
    const byDocumentId = new Map(
      identities.flatMap((identity) =>
        identity.preferredDocumentId ? ([[identity.preferredDocumentId, identity]] as const) : []
      )
    )
    const stateRows = this.db
      .prepare(
        `SELECT paper_id, canonical_key, preferred_document_id
         FROM paper_user_state
         ORDER BY updated_at DESC, paper_id
         LIMIT ?`
      )
      .all(MAX_IDENTITY_RELINK_ROWS) as Row[]
    const draftRows = this.db
      .prepare(
        `SELECT paper_id, canonical_key, preferred_document_id
         FROM paper_user_drafts
         ORDER BY updated_at DESC, paper_id
         LIMIT ?`
      )
      .all(MAX_IDENTITY_RELINK_ROWS) as Row[]
    if (stateRows.length === 0 && draftRows.length === 0) return

    this.db.exec('BEGIN IMMEDIATE')
    try {
      reconcileIdentityRows(
        this.db,
        'paper_user_state',
        stateRows,
        byPaperId,
        byCanonicalKey,
        byDocumentId
      )
      reconcileIdentityRows(
        this.db,
        'paper_user_drafts',
        draftRows,
        byPaperId,
        byCanonicalKey,
        byDocumentId
      )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  updatePaperState(
    paperIdValue: string,
    value: PaperUserStatePatch,
    identity?: PaperUserIdentity
  ): PaperUserState {
    const paperId = requiredPaperId(paperIdValue)
    const patch = normalizePatch(value)
    if (Object.keys(patch).length === 0) return this.getPaperState(paperId)

    const current = this.getPaperState(paperId)
    return this.writeState(paperId, {
      ...current,
      favorite: patch.favorite ?? current.favorite,
      readingStatus: patch.readingStatus ?? current.readingStatus,
      tags: patch.tags ?? current.tags,
      note: patch.note ?? current.note,
      hasNote: Boolean((patch.note ?? current.note).trim()),
      updatedAt: null
    }, identity)
  }

  markPaperOpened(paperIdValue: string, identity?: PaperUserIdentity): PaperUserState {
    const paperId = requiredPaperId(paperIdValue)
    const current = this.getPaperState(paperId)
    const timestamp = new Date().toISOString()
    return this.writeState(paperId, {
      ...current,
      lastOpenedAt: timestamp,
      updatedAt: timestamp
    }, identity)
  }

  listPaperIds(view: PaperUserView): string[] {
    const where =
      view === 'favorites'
        ? 'favorite = 1'
        : view === 'reading_list'
          ? "reading_status IN ('to_read', 'reading')"
          : view === 'reviewed'
            ? "reading_status = 'reviewed'"
            : null
    if (!where) throw new Error('Paper user view is invalid.')
    const rows = this.db
      .prepare(`SELECT paper_id FROM paper_user_state WHERE ${where} ORDER BY updated_at DESC, paper_id`)
      .all() as Row[]
    return rows.flatMap((row) => (typeof row.paper_id === 'string' ? [row.paper_id] : []))
  }

  counts(paperIdValues: readonly string[]): PaperUserCounts {
    const paperIds = normalizedPaperIds(paperIdValues)
    if (paperIds.length === 0) return { ...EMPTY_COUNTS }
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END), 0) AS favorite_count,
           COALESCE(SUM(CASE WHEN reading_status IN ('to_read', 'reading') THEN 1 ELSE 0 END), 0)
             AS reading_list_count,
           COALESCE(SUM(CASE WHEN reading_status = 'reviewed' THEN 1 ELSE 0 END), 0) AS reviewed_count
         FROM paper_user_state
         WHERE paper_id IN (SELECT value FROM json_each(?))`
      )
      .get(JSON.stringify(paperIds)) as Row
    return {
      favoriteCount: integer(row.favorite_count),
      readingListCount: integer(row.reading_list_count),
      reviewedCount: integer(row.reviewed_count)
    }
  }

  private writeState(
    paperId: string,
    state: PaperUserState,
    identity?: PaperUserIdentity
  ): PaperUserState {
    const timestamp = state.updatedAt ?? new Date().toISOString()
    const canonicalKey = identity?.paperId === paperId ? identity.canonicalKey : null
    const preferredDocumentId = identity?.paperId === paperId ? identity.preferredDocumentId : null
    this.db
      .prepare(
        `INSERT INTO paper_user_state(
           paper_id, canonical_key, preferred_document_id, favorite, reading_status,
           tags_json, note, last_opened_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(paper_id) DO UPDATE SET
           canonical_key = COALESCE(excluded.canonical_key, paper_user_state.canonical_key),
           preferred_document_id = COALESCE(
             excluded.preferred_document_id,
             paper_user_state.preferred_document_id
           ),
           favorite = excluded.favorite,
           reading_status = excluded.reading_status,
           tags_json = excluded.tags_json,
           note = excluded.note,
           last_opened_at = excluded.last_opened_at,
           updated_at = excluded.updated_at`
      )
      .run(
        paperId,
        canonicalKey,
        preferredDocumentId,
        state.favorite ? 1 : 0,
        state.readingStatus,
        JSON.stringify(state.tags),
        state.note,
        state.lastOpenedAt,
        timestamp
      )
    return this.getPaperState(paperId)
  }
}
