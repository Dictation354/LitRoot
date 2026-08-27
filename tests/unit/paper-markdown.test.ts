import { describe, expect, it } from 'vitest'
import { parsePaperMarkdown } from '../../src/service/paper-markdown.js'
import { paperMarkdown } from '../helpers.js'

describe('trusted paper-fetch Markdown', () => {
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
