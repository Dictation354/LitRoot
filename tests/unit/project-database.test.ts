import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { ProjectDatabase } from '../../src/service/project-database.js'
import { parsePaperMarkdown } from '../../src/service/paper-markdown.js'
import { paperMarkdown } from '../helpers.js'

function add(
  database: ProjectDatabase,
  id: string,
  path: string,
  markdown: string,
  modifiedAt = '2026-08-24T00:00:00.000Z',
  addedAt = '2025-12-01T00:00:00.000Z'
): void {
  const result = parsePaperMarkdown(markdown)
  if (result.kind !== 'paper') throw new Error('Expected trusted Markdown fixture.')
  database.upsert({
    id,
    relativePath: path,
    filePath: `/project/${path}`,
    fingerprint: result.paper.revision,
    rawMarkdown: markdown,
    parsed: result.paper,
    overrides: {},
    addedAt,
    modifiedAt
  })
}

describe('project FTS index', () => {
  it('migrates an existing v1 cache to the date-aware schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'litroot-database-'))
    const path = join(directory, 'index.sqlite3')
    try {
      const legacy = new DatabaseSync(path)
      legacy.exec(`
        CREATE TABLE papers (id TEXT PRIMARY KEY);
        CREATE VIRTUAL TABLE paper_fts USING fts5(paper_id UNINDEXED, title);
        PRAGMA user_version = 1;
      `)
      legacy.close()

      new ProjectDatabase(path).close()
      const migrated = new DatabaseSync(path)
      const columns = migrated.prepare('PRAGMA table_info(papers)').all() as Array<{ name: string }>
      const version = migrated.prepare('PRAGMA user_version').get() as { user_version: number }
      expect(columns.map((column) => column.name)).toEqual([
        'id', 'added_at', 'last_opened_at'
      ])
      expect(version.user_version).toBe(2)
      migrated.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('searches every metadata/body field and applies a year filter with pagination', () => {
    const database = new ProjectDatabase(':memory:')
    add(database, 'paper_aaaaaaaaaaaaaaaaaaaaaaaa', 'papers/first.md', paperMarkdown({
      title: 'Geospatial roots', doi: '10.4242/first', year: 2024, body: 'A quasar appears in the body.'
    }))
    add(database, 'paper_bbbbbbbbbbbbbbbbbbbbbbbb', 'papers/second.md', paperMarkdown({
      title: 'Different paper', doi: '10.4242/second', year: 2025, body: 'No astronomy here.'
    }))

    expect(database.search({ projectId: 'project_test', query: 'quasar' }).items.map((item) => item.title)).toEqual(['Geospatial roots'])
    expect(database.search({ projectId: 'project_test', year: 2025 }).items.map((item) => item.title)).toEqual(['Different paper'])
    expect(database.search({ projectId: 'project_test', limit: 1, offset: 1 }).items).toHaveLength(1)
    database.close()
  })

  it('treats FTS operators as text instead of executable query syntax', () => {
    const database = new ProjectDatabase(':memory:')
    add(database, 'paper_cccccccccccccccccccccccc', 'papers/safe.md', paperMarkdown({ title: 'Safe title' }))
    expect(() => database.search({ projectId: 'project_test', query: '" OR * ) (^' })).not.toThrow()
    database.close()
  })

  it('sorts the complete result set with stable null-last ordering', () => {
    const database = new ProjectDatabase(':memory:')
    add(database, 'paper_aaaaaaaaaaaaaaaaaaaaaaaa', 'papers/zulu.md', paperMarkdown({
      title: 'Zulu', doi: '10.4242/zulu', year: 2022
    }), '2026-01-01T00:00:00.000Z')
    add(database, 'paper_bbbbbbbbbbbbbbbbbbbbbbbb', 'papers/alpha.md', paperMarkdown({
      title: 'Alpha', doi: '10.4242/alpha', year: 2025
    }), '2026-03-01T00:00:00.000Z')
    const noYear = paperMarkdown({ title: 'No year', doi: '10.4242/no-year' })
      .replace('year: 2025\n', '')
    add(
      database,
      'paper_cccccccccccccccccccccccc',
      'papers/no-year.md',
      noYear,
      '2026-02-01T00:00:00.000Z'
    )

    expect(database.search({
      projectId: 'project_test', sortBy: 'title', sortDirection: 'asc', limit: 2
    }).items.map((item) => item.title)).toEqual(['Alpha', 'No year'])
    expect(database.search({
      projectId: 'project_test', sortBy: 'year', sortDirection: 'desc'
    }).items.map((item) => item.title)).toEqual(['Alpha', 'Zulu', 'No year'])
    expect(database.search({
      projectId: 'project_test', sortBy: 'modifiedAt', sortDirection: 'asc'
    }).items.map((item) => item.title)).toEqual(['Zulu', 'No year', 'Alpha'])
    database.close()
  })

  it('records the file creation date and updates the last opened date independently', () => {
    const database = new ProjectDatabase(':memory:')
    const id = 'paper_dddddddddddddddddddddddd'
    add(
      database,
      id,
      'papers/dates.md',
      paperMarkdown({ title: 'Dated paper', doi: '10.4242/dates' }),
      '2026-08-24T00:00:00.000Z',
      '2026-01-02T03:04:05.000Z'
    )

    expect(database.get(id)).toMatchObject({
      addedAt: '2026-01-02T03:04:05.000Z',
      lastOpenedAt: null
    })
    expect(database.markOpened(id, '2026-08-29T07:00:00.000Z')).toBe('2026-08-29T07:00:00.000Z')
    expect(database.get(id)?.lastOpenedAt).toBe('2026-08-29T07:00:00.000Z')
    database.close()
  })
})
