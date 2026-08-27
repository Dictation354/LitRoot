import { describe, expect, it } from 'vitest'
import { ProjectDatabase } from '../../src/service/project-database.js'
import { parsePaperMarkdown } from '../../src/service/paper-markdown.js'
import { paperMarkdown } from '../helpers.js'

function add(
  database: ProjectDatabase,
  id: string,
  path: string,
  markdown: string,
  modifiedAt = '2026-08-24T00:00:00.000Z'
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
    modifiedAt
  })
}

describe('project FTS index', () => {
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
})
