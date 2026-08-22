import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_PAPER_USER_NOTE_LENGTH,
  MAX_PAPER_USER_TAG_INPUT_LENGTH,
  MAX_PAPER_USER_TAG_LENGTH,
  MAX_PAPER_USER_TAGS,
  PaperUserDatabase
} from '../../src/main/db/paper-user-database.js'

const sandboxes: string[] = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('PaperUserDatabase', () => {
  it('persists bounded personal state in its schema-v2 sidecar', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'paperrelay-user-state-'))
    sandboxes.push(sandbox)
    const path = join(sandbox, 'paperrelay-user.sqlite3')
    const database = new PaperUserDatabase(path)

    expect(database.getPaperState('paper-1')).toEqual({
      favorite: false,
      readingStatus: 'none',
      tags: [],
      hasNote: false,
      note: '',
      lastOpenedAt: null,
      updatedAt: null
    })

    const updated = database.updatePaperState('paper-1', {
      favorite: true,
      readingStatus: 'reading',
      tags: ['  Geodesy  ', 'geodesy', 'InSAR'],
      note: 'Private synthesis.'
    })
    expect(updated).toMatchObject({
      favorite: true,
      readingStatus: 'reading',
      tags: ['Geodesy', 'InSAR'],
      hasNote: true,
      note: 'Private synthesis.',
      lastOpenedAt: null
    })
    expect(updated.updatedAt).not.toBeNull()

    const opened = database.markPaperOpened('paper-1')
    expect(opened.lastOpenedAt).not.toBeNull()
    database.close()

    const schemaReader = new DatabaseSync(path, { readOnly: true })
    expect(Number((schemaReader.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(2)
    expect(schemaReader.prepare("PRAGMA foreign_key_list('paper_user_state')").all()).toEqual([])
    schemaReader.close()

    const reopened = new PaperUserDatabase(path)
    expect(reopened.getPaperState('paper-1')).toMatchObject({
      favorite: true,
      readingStatus: 'reading',
      tags: ['Geodesy', 'InSAR'],
      note: 'Private synthesis.',
      lastOpenedAt: opened.lastOpenedAt
    })
    reopened.close()
  })

  it('migrates schema v1 in place without losing saved personal state', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'paperrelay-user-state-'))
    sandboxes.push(sandbox)
    const path = join(sandbox, 'paperrelay-user.sqlite3')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE paper_user_state (
        paper_id TEXT PRIMARY KEY,
        favorite INTEGER NOT NULL DEFAULT 0,
        reading_status TEXT NOT NULL DEFAULT 'none',
        tags_json TEXT NOT NULL DEFAULT '[]',
        note TEXT NOT NULL DEFAULT '',
        last_opened_at TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO paper_user_state(
        paper_id, favorite, reading_status, tags_json, note, updated_at
      ) VALUES (
        'paper-1', 1, 'reading', '["legacy"]', 'Preserve me.', '2026-08-20T00:00:00.000Z'
      );
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const migrated = new PaperUserDatabase(path)
    expect(migrated.getPaperState('paper-1')).toMatchObject({
      favorite: true,
      readingStatus: 'reading',
      tags: ['legacy'],
      note: 'Preserve me.'
    })
    expect(migrated.getPaperDraft('paper-1')).toBeNull()
    migrated.close()

    const reader = new DatabaseSync(path, { readOnly: true })
    expect(Number((reader.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(2)
    expect(
      (reader.prepare("PRAGMA table_info('paper_user_drafts')").all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    ).toEqual(
      expect.arrayContaining([
        'paper_id',
        'canonical_key',
        'preferred_document_id',
        'note',
        'tag_input',
        'base_state_updated_at',
        'updated_at'
      ])
    )
    reader.close()
  })

  it('recovers exact draft editor input and commits valid note and tags atomically', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'paperrelay-user-state-'))
    sandboxes.push(sandbox)
    const path = join(sandbox, 'paperrelay-user.sqlite3')
    const database = new PaperUserDatabase(path)
    const baseline = database.updatePaperState('paper-1', {
      favorite: true,
      readingStatus: 'reading',
      tags: ['saved'],
      note: 'Saved note.'
    })
    const invalidTagInput = `${'x'.repeat(MAX_PAPER_USER_TAG_LENGTH + 1)}, methods, methods, `
    const savedDraft = database.savePaperDraft('paper-1', {
      note: '  Exact unsaved note.  ',
      tagInput: invalidTagInput
    })
    expect(savedDraft).toMatchObject({
      paperId: 'paper-1',
      note: '  Exact unsaved note.  ',
      tagInput: invalidTagInput,
      baseStateUpdatedAt: baseline.updatedAt
    })
    database.close()

    const reopened = new PaperUserDatabase(path)
    expect(reopened.getPaperDraft('paper-1')).toEqual(savedDraft)
    expect(() => reopened.commitPaperDraft('paper-1')).toThrow(
      `at most ${MAX_PAPER_USER_TAG_LENGTH} characters`
    )
    expect(reopened.getPaperDraft('paper-1')).toEqual(savedDraft)
    expect(reopened.getPaperState('paper-1')).toMatchObject({
      favorite: true,
      readingStatus: 'reading',
      tags: ['saved'],
      note: 'Saved note.'
    })

    reopened.savePaperDraft('paper-1', {
      note: '  Exact unsaved note.  ',
      tagInput: ' methods, Methods, evidence '
    })
    const committed = reopened.commitPaperDraft('paper-1')
    expect(committed).toMatchObject({
      favorite: true,
      readingStatus: 'reading',
      tags: ['methods', 'evidence'],
      note: '  Exact unsaved note.  ',
      hasNote: true
    })
    expect(reopened.getPaperDraft('paper-1')).toBeNull()
    reopened.close()
  })

  it('bounds draft storage without overwriting the last recoverable draft', () => {
    const database = new PaperUserDatabase()
    const baseline = database.savePaperDraft('paper-1', {
      note: 'recoverable',
      tagInput: 'one, two'
    })

    expect(() =>
      database.savePaperDraft('paper-1', {
        note: 'x'.repeat(MAX_PAPER_USER_NOTE_LENGTH + 1),
        tagInput: ''
      })
    ).toThrow(`at most ${MAX_PAPER_USER_NOTE_LENGTH} characters`)
    expect(() =>
      database.savePaperDraft('paper-1', {
        note: '',
        tagInput: 'x'.repeat(MAX_PAPER_USER_TAG_INPUT_LENGTH + 1)
      })
    ).toThrow(`at most ${MAX_PAPER_USER_TAG_INPUT_LENGTH} characters`)
    expect(database.getPaperDraft('paper-1')).toEqual(baseline)
    database.close()
  })

  it('relinks drafts through the same stable identity rules as saved state', () => {
    const database = new PaperUserDatabase()
    database.savePaperDraft(
      'old-paper-id',
      { note: 'Recovered after re-indexing.', tagInput: 'identity' },
      {
        paperId: 'old-paper-id',
        canonicalKey: 'doi:10.1234/stable',
        preferredDocumentId: 'old-document'
      }
    )

    database.reconcilePaperIdentities([
      {
        paperId: 'new-paper-id',
        canonicalKey: 'doi:10.1234/stable',
        preferredDocumentId: 'new-document'
      }
    ])

    expect(database.getPaperDraft('old-paper-id')).toBeNull()
    expect(database.getPaperDraft('new-paper-id')).toMatchObject({
      paperId: 'new-paper-id',
      note: 'Recovered after re-indexing.',
      tagInput: 'identity'
    })
    database.close()
  })

  it('enforces tag and private-note input bounds without partial writes', () => {
    const database = new PaperUserDatabase()
    const baseline = database.updatePaperState('paper-1', { favorite: true })

    expect(() =>
      database.updatePaperState('paper-1', {
        tags: Array.from({ length: MAX_PAPER_USER_TAGS + 1 }, (_, index) => `tag-${index}`)
      })
    ).toThrow(`at most ${MAX_PAPER_USER_TAGS} tags`)
    expect(() =>
      database.updatePaperState('paper-1', { tags: ['x'.repeat(MAX_PAPER_USER_TAG_LENGTH + 1)] })
    ).toThrow(`at most ${MAX_PAPER_USER_TAG_LENGTH} characters`)
    expect(() =>
      database.updatePaperState('paper-1', { note: 'x'.repeat(MAX_PAPER_USER_NOTE_LENGTH + 1) })
    ).toThrow(`at most ${MAX_PAPER_USER_NOTE_LENGTH} characters`)
    expect(() =>
      database.updatePaperState('paper-1', {
        readingStatus: 'not-a-status'
      } as never)
    ).toThrow('Reading status is invalid')

    expect(database.getPaperState('paper-1')).toEqual(baseline)
    database.close()
  })

  it('selects user views and counts only the requested active paper IDs', () => {
    const database = new PaperUserDatabase()
    database.updatePaperState('favorite', { favorite: true })
    database.updatePaperState('queued', { readingStatus: 'to_read' })
    database.updatePaperState('active', { readingStatus: 'reading' })
    database.updatePaperState('reviewed', { readingStatus: 'reviewed' })
    database.updatePaperState('orphan', { favorite: true, readingStatus: 'reviewed' })

    expect(database.listPaperIds('favorites')).toEqual(expect.arrayContaining(['favorite', 'orphan']))
    expect(database.listPaperIds('reading_list')).toEqual(expect.arrayContaining(['queued', 'active']))
    expect(database.listPaperIds('reviewed')).toEqual(expect.arrayContaining(['reviewed', 'orphan']))
    expect(database.counts(['favorite', 'queued', 'active', 'reviewed'])).toEqual({
      favoriteCount: 1,
      readingListCount: 2,
      reviewedCount: 1
    })
    database.close()
  })

  it('rejects a newer sidecar without replacing authoritative user data', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'paperrelay-user-state-'))
    sandboxes.push(sandbox)
    const path = join(sandbox, 'paperrelay-user.sqlite3')
    const newer = new DatabaseSync(path)
    newer.exec('CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES (\'keep-me\'); PRAGMA user_version = 99;')
    newer.close()

    expect(() => new PaperUserDatabase(path)).toThrow('version 99 is newer')

    const reader = new DatabaseSync(path, { readOnly: true })
    expect(reader.prepare('SELECT value FROM preserved').get()).toEqual({ value: 'keep-me' })
    expect(Number((reader.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(99)
    reader.close()
  })
})
