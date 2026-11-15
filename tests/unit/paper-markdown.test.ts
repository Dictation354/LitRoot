import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { parsePaperMarkdown } from '../../src/service/paper-markdown.js'
import { paperMarkdown } from '../helpers.js'

describe('trusted paper-fetch Markdown', () => {
  it('reads the publication year from the unchanged paper-fetch 7.6.2 golden', () => {
    const raw = readFileSync(new URL('../fixtures/paper-fetch-7.6.2/extracted.md', import.meta.url), 'utf8')
    const result = parsePaperMarkdown(raw)
    expect(result.kind).toBe('paper')
    if (result.kind !== 'paper') throw new Error('Expected trusted golden Markdown.')
    expect(result.paper.frontmatter).not.toHaveProperty('year')
    expect(result.paper.metadata.year).toBe(2022)
  })

  it.each([
    { name: 'explicit year before publication dates', metadata: { year: 2024, publication_dates: [{ kind: 'print', value: '2022' }] }, year: 2024 },
    { name: 'explicit string year', metadata: { year: '2023' }, year: 2023 },
    { name: 'print before online across years', metadata: { publication_dates: [{ kind: 'online', value: '2021-12-31' }, { kind: 'print', value: '2022-01-01' }] }, year: 2022 },
    { name: 'online before issued', metadata: { publication_dates: [{ kind: 'issued', value: '2023' }, { kind: 'online', value: '2022' }] }, year: 2022 },
    { name: 'issued before unspecified', metadata: { publication_dates: [{ kind: 'unspecified', value: '2023' }, { kind: 'issued', value: '2022' }] }, year: 2022 },
    { name: 'original order within a kind', metadata: { publication_dates: [{ kind: 'print', value: '2023' }, { kind: 'print', value: '2022' }] }, year: 2023 },
    { name: 'year only', metadata: { publication_dates: [{ kind: 'unspecified', value: '2022' }] }, year: 2022 },
    { name: 'year and month', metadata: { publication_dates: [{ kind: 'online', value: '2022-07' }] }, year: 2022 },
    { name: 'slash year and month', metadata: { publication_dates: [{ kind: 'online', value: '2022/07' }] }, year: 2022 },
    { name: 'slash full date', metadata: { publication_dates: [{ kind: 'online', value: '2022/07/07' }] }, year: 2022 },
    { name: 'numeric year', metadata: { publication_dates: [{ kind: 'issued', value: 2022 }] }, year: 2022 },
    { name: 'skip malformed entries and invalid values', metadata: { publication_dates: [null, '2020', {}, { kind: 'print', value: {} }, { kind: 'print', value: 'unknown' }, { kind: 'print', value: '2022' }] }, year: 2022 },
    { name: 'invalid print falls back to online', metadata: { publication_dates: [{ kind: 'print', value: 'unknown' }, { kind: 'online', value: '2022' }] }, year: 2022 },
    { name: 'invalid explicit year falls back to dates', metadata: { year: 'unknown', publication_dates: [{ kind: 'online', value: '2022' }] }, year: 2022 },
    { name: 'fractional numeric year falls back', metadata: { year: 2022.5, date: '2021' }, year: 2021 },
    { name: 'publication dates before legacy fields', metadata: { publication_dates: [{ kind: 'unspecified', value: '2022' }], published: '2020', date: '2019' }, year: 2022 },
    { name: 'legacy published before date', metadata: { published: '2021-05-01', date: '2020' }, year: 2021 },
    { name: 'invalid published falls back to date', metadata: { published: 'unknown', date: '2022/07' }, year: 2022 },
    { name: 'malformed publication dates fall back', metadata: { publication_dates: { kind: 'print', value: '2020' }, published: '2022' }, year: 2022 },
    { name: 'created is not a publication date', metadata: { publication_dates: [{ kind: 'created', value: '2022' }] }, year: null },
    { name: 'unknown and missing kinds are ignored', metadata: { publication_dates: [{ kind: 'accepted', value: '2021' }, { value: '2022' }] }, year: null },
    { name: 'excluded kinds still allow legacy fallback', metadata: { publication_dates: [{ kind: 'created', value: '2020' }], date: '2022' }, year: 2022 },
    { name: 'missing dates', metadata: {}, year: null },
    { name: 'empty dates', metadata: { publication_dates: [] }, year: null },
    { name: 'lower contract boundary', metadata: { year: '1000/01' }, year: 1000 },
    { name: 'upper contract boundary', metadata: { year: '9999-12-31' }, year: 9999 },
    { name: 'non-digit boundaries', metadata: { published: 'Published (1899)' }, year: 1899 },
    { name: 'out of range and embedded digits', metadata: { year: 999, publication_dates: [{ kind: 'print', value: '12022' }, { kind: 'online', value: '20220' }], published: '0999', date: '10000' }, year: null }
  ])('infers the year: $name', ({ metadata, year }) => {
    // Omit the helper's default year so these cases exercise date inference.
    const raw = paperMarkdown().replace('year: 2025\n', Object.keys(metadata).length ? YAML.stringify(metadata) : '')
    const result = parsePaperMarkdown(raw)
    expect(result.kind).toBe('paper')
    if (result.kind !== 'paper') throw new Error('Expected trusted Markdown fixture.')
    expect(result.paper.metadata.year).toBe(year)
  })

  it('parses the editable metadata, searchable body, assets and content level', () => {
    const result = parsePaperMarkdown(paperMarkdown({ body: 'Result text.\n\n![Figure](assets/figure.png)' }))
    expect(result.kind).toBe('paper')
    if (result.kind !== 'paper') return
    expect(result.paper.metadata).toMatchObject({
      title: 'A LitRoot test paper',
      doi: '10.4242/litroot.test',
      year: 2025
    })
    expect(result.paper.assetSources).toEqual(['assets/figure.png'])
    expect(result.paper.searchableBody).toContain('Result text')
    expect(result.paper.hasFulltext).toBe(true)
  })

  it('ignores ordinary project notes and incomplete provenance', () => {
    expect(parsePaperMarkdown('# A note').kind).toBe('ignore')
    expect(parsePaperMarkdown('---\ntitle: note\ndoi: 10.1/no\n---\ntext').kind).toBe('ignore')
  })

  it('reports malformed YAML without treating it as a paper', () => {
    expect(parsePaperMarkdown('---\ndoi: [\n---\nbody').kind).toBe('issue')
  })

  it('does not include script contents in the search body', () => {
    const result = parsePaperMarkdown(paperMarkdown({ body: '<script>stolenSecret()</script> visible result' }))
    expect(result.kind).toBe('paper')
    if (result.kind === 'paper') {
      expect(result.paper.searchableBody).not.toContain('stolenSecret')
      expect(result.paper.searchableBody).toContain('visible result')
    }
  })
})
