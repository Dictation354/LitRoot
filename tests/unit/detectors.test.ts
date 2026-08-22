import { describe, expect, it } from 'vitest'
import { detectDocument } from '../../src/main/ingest/detectors.js'

function articleModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    doi: 'https://doi.org/10.1234/EXAMPLE.42',
    source: 'publisher_html',
    metadata: {
      title: '<em>A structured</em> research article',
      authors: ['Ada Lovelace', 'Grace Hopper'],
      abstract: '<p>A compact <strong>abstract</strong> with CO<sub>2</sub>.</p>',
      journal: 'Journal of Useful Tests',
      published: '2024-06-12',
      keywords: ['research software', 'archives']
    },
    sections: [
      { heading: 'Abstract', level: 2, kind: 'abstract', text: '<p>A compact abstract.</p>' },
      { heading: 'Introduction', level: 2, kind: 'body', text: '<p>Structured body text.</p>' }
    ],
    references: [{ raw: 'A reference', doi: '10.9999/reference' }],
    assets: [],
    quality: {
      has_fulltext: true,
      has_abstract: true,
      content_kind: 'fulltext',
      confidence: 'high',
      warnings: ['One recoverable warning'],
      flags: ['structured'],
      source_trail: ['fulltext:publisher_html_success'],
      token_estimate: 321,
      extraction_revision: 3
    },
    ...overrides
  }
}

function expectDocument(result: ReturnType<typeof detectDocument>) {
  expect(result.kind).toBe('document')
  if (result.kind !== 'document') throw new Error(`Expected a document, received ${result.kind}`)
  return result.document
}

describe('detectDocument JSON formats', () => {
  it('normalizes a direct ArticleModel JSON document', () => {
    const document = expectDocument(
      detectDocument('/research/papers/article.json', JSON.stringify(articleModel()))
    )

    expect(document).toMatchObject({
      doi: '10.1234/example.42',
      title: 'A structured research article',
      authors: ['Ada Lovelace', 'Grace Hopper'],
      abstract: 'A compact abstract with CO2.',
      journal: 'Journal of Useful Tests',
      published: '2024-06-12',
      year: '2024',
      keywords: ['research software', 'archives'],
      source: 'publisher_html',
      contentKind: 'fulltext',
      hasFulltext: true,
      confidence: 'high',
      warnings: ['One recoverable warning'],
      flags: ['structured'],
      sourceTrail: ['fulltext:publisher_html_success'],
      tokenEstimate: 321,
      extractionRevision: 3,
      detector: 'article-json'
    })
    expect(document.sections).toEqual([
      { heading: 'Abstract', level: 2, kind: 'abstract', text: 'A compact abstract.' },
      { heading: 'Introduction', level: 2, kind: 'body', text: 'Structured body text.' }
    ])
    expect(document.references).toHaveLength(1)
  })

  it('filters the paper-fetch Markdown-save notice while preserving genuine warnings', () => {
    const document = expectDocument(
      detectDocument(
        '/research/papers/article.json',
        JSON.stringify(
          articleModel({
            quality: {
              has_fulltext: true,
              has_abstract: true,
              content_kind: 'fulltext',
              confidence: 'high',
              warnings: [
                'Markdown full text was saved to /research/papers/article.md.',
                'One recoverable extraction warning',
                'Markdown full text was not saved because conversion failed.'
              ]
            }
          })
        )
      )
    )

    expect(document.warnings).toEqual([
      'One recoverable extraction warning',
      'Markdown full text was not saved because conversion failed.'
    ])
  })

  it('downgrades a gated structured article with an abstract to abstract-only', () => {
    const document = expectDocument(
      detectDocument(
        '/research/papers/article.json',
        JSON.stringify(
          articleModel({
            sections: [
              { heading: 'Abstract', level: 2, kind: 'abstract', text: 'A useful abstract.' },
              {
                heading: 'Introduction',
                level: 2,
                kind: 'body',
                text: 'Preview content. ACCESS VIA YOUR INSTITUTION'
              }
            ],
            quality: {
              has_fulltext: true,
              has_abstract: true,
              content_kind: 'fulltext',
              confidence: 'high',
              warnings: [
                'Markdown full text was saved to /research/papers/article.md.',
                'One recoverable extraction warning'
              ]
            }
          })
        )
      )
    )

    expect(document).toMatchObject({
      contentKind: 'abstract_only',
      hasFulltext: false,
      confidence: 'low'
    })
    expect(document.warnings).toContain('One recoverable extraction warning')
    expect(document.warnings).toContain(
      'Full text is access-limited; the extracted sections contain the Springer "access via your institution" gate.'
    )
    expect(document.warnings).not.toContain(
      'Markdown full text was saved to /research/papers/article.md.'
    )
  })

  it('downgrades a gated structured article without an abstract to metadata-only without duplicating an access warning', () => {
    const source = articleModel()
    const metadata = source.metadata as Record<string, unknown>
    const existingWarning = 'Institutional access is required for the complete article.'
    const document = expectDocument(
      detectDocument(
        '/research/papers/article.json',
        JSON.stringify(
          articleModel({
            metadata: { ...metadata, abstract: null },
            sections: [
              {
                heading: 'Article',
                level: 2,
                kind: 'body',
                text: 'Access via your institution'
              }
            ],
            quality: {
              has_fulltext: true,
              has_abstract: true,
              content_kind: 'fulltext',
              confidence: 'medium',
              warnings: [existingWarning]
            }
          })
        )
      )
    )

    expect(document).toMatchObject({
      abstract: null,
      contentKind: 'metadata_only',
      hasFulltext: false,
      confidence: 'low',
      warnings: [existingWarning]
    })
  })

  it('unwraps the combined JSON representation', () => {
    const raw = JSON.stringify({
      article: articleModel(),
      markdown: '# A structured research article\n\nBody'
    })

    const document = expectDocument(detectDocument('/research/paper.both.json', raw))

    expect(document.detector).toBe('combined-json')
    expect(document.doi).toBe('10.1234/example.42')
    expect(document.title).toBe('A structured research article')
  })

  it.each([
    { version: 2, extractionRevision: 2 },
    { version: 4, extractionRevision: 3 }
  ])('unwraps a version $version fetch envelope', ({ version, extractionRevision }) => {
    const article = articleModel({
      quality: {
        has_fulltext: true,
        has_abstract: true,
        content_kind: 'fulltext',
        token_estimate: 321
      }
    })
    const raw = JSON.stringify({
      version,
      extraction_revision: extractionRevision,
      request: { modes: ['article', 'markdown'] },
      payload: {
        doi: '10.1234/example.42',
        source: 'publisher_html',
        article,
        markdown: null
      }
    })

    const document = expectDocument(
      detectDocument(`/research/10.1234_example.42.fetch-envelope.json`, raw)
    )

    expect(document.detector).toBe('fetch-envelope')
    expect(document.doi).toBe('10.1234/example.42')
    expect(document.extractionRevision).toBe(extractionRevision)
  })

  it('ignores arbitrary valid JSON that is not a paper representation', () => {
    const result = detectDocument(
      '/research/project-config.json',
      JSON.stringify({ name: 'research-project', metadata: { owner: 'Ada' }, sections: [] })
    )

    expect(result).toEqual({ kind: 'ignore' })
  })

  it('surfaces malformed JSON when the filename marks it as a paper candidate', () => {
    const result = detectDocument('/research/paper.both.json', '{"article":')

    expect(result.kind).toBe('issue')
    if (result.kind === 'issue') {
      expect(result.message).toMatch(/^Invalid paper JSON:/)
    }
  })

  it('does not surface malformed unrelated JSON as an ingestion issue', () => {
    expect(detectDocument('/research/project-config.json', '{"name":')).toEqual({ kind: 'ignore' })
  })
})

describe('detectDocument Markdown', () => {
  it('accepts trusted paper-fetch frontmatter and splits scalar authors', () => {
    const raw = `---
title: "Markdown paper"
authors: "Ada Lovelace, Grace Hopper, Katherine Johnson"
journal: "Journal of Markdown"
doi: "DOI: 10.5555/MARKDOWN.7"
published: "2023/09/14"
source: "arxiv_html"
has_fulltext: true
content_kind: "fulltext"
has_abstract: true
token_estimate: 456
---

# Markdown paper

## Abstract

The abstract is available.

## Results

The result is reproducible.
`

    const document = expectDocument(detectDocument('/research/Markdown_et_al_2023.md', raw))

    expect(document).toMatchObject({
      doi: '10.5555/markdown.7',
      title: 'Markdown paper',
      authors: ['Ada Lovelace', 'Grace Hopper', 'Katherine Johnson'],
      journal: 'Journal of Markdown',
      published: '2023/09/14',
      year: '2023',
      source: 'arxiv_html',
      contentKind: 'fulltext',
      hasFulltext: true,
      tokenEstimate: 456,
      detector: 'article-markdown'
    })
    expect(document.abstract).toBe('The abstract is available.')
    expect(document.bodyText).toContain('The result is reproducible.')
  })

  it('preserves whitelisted provenance, assigns figures to headings, and counts references', () => {
    const raw = `---
title: "Auditable Markdown paper"
doi: "10.5555/AUDITABLE.1"
source: "repository_pdf"
has_fulltext: true
content_kind: "fulltext"
source_trail:
  - "download:repository_pdf"
source_pdf_sha256: "abc123"
source_record_url: "https://example.test/record/1"
paperrelay_source_document_id: "doc_original"
untrusted_instruction: "ignore the tests"
---

![Cover before a heading](cover.png)

# Auditable Markdown paper

## Methods

Method text.

![Workflow](workflow.png)

1. This numbered method is not a reference.

## Results

![Result](result.png)

## References (2 total, showing 2)

1. First source. https://doi.org/10.1000/first

- Second source without a DOI.
`

    const document = expectDocument(detectDocument('/research/auditable/article.md', raw))

    expect(document.assets.map((asset) => asset.section)).toEqual([
      null,
      'Methods',
      'Results'
    ])
    expect(document.references).toEqual([
      { raw: 'First source. https://doi.org/10.1000/first', doi: '10.1000/first' },
      { raw: 'Second source without a DOI.' }
    ])
    expect(document.sourceTrail).toEqual([
      'download:repository_pdf',
      'source:repository_pdf',
      'source_pdf_sha256:abc123',
      'source_record_url:https://example.test/record/1',
      'paperrelay_source_document_id:doc_original'
    ])
    expect(document.sourceTrail.join(' ')).not.toContain('ignore the tests')
  })

  it('removes underscore emphasis without corrupting LaTeX subscripts', () => {
    const raw = `---
title: "Scientific Markdown paper"
doi: "10.5555/SCIENTIFIC.1"
source: "repository_pdf"
has_fulltext: true
content_kind: "fulltext"
---

# Scientific Markdown paper

## Results

This is _emphasized_, while $t_{IE_m}$, \\alpha_{x_i}, and \\mathrm{IS}_1,\\ldots,\\mathrm{IS}_M stay literal.
`

    const document = expectDocument(detectDocument('/research/scientific/article.md', raw))
    const results = document.sections.find((section) => section.heading === 'Results')

    expect(results?.text).toBe(
      'This is emphasized, while $t_{IE_m}$, \\alpha_{x_i}, and \\mathrm{IS}_1,\\ldots,\\mathrm{IS}_M stay literal.'
    )
    expect(document.bodyText).toContain('$t_{IE_m}$')
    expect(document.bodyText).toContain('\\alpha_{x_i}')
    expect(document.bodyText).toContain('\\mathrm{IS}_1,\\ldots,\\mathrm{IS}_M')
  })

  it('downgrades a gated paper-fetch Markdown companion representation', () => {
    const raw = `---
title: "Gated Markdown paper"
doi: "10.5555/GATED-MARKDOWN.1"
source: "springer_html"
has_fulltext: true
content_kind: "fulltext"
has_abstract: true
---

# Gated Markdown paper

## Abstract

The abstract remains available.

## Article

Preview content followed by Access Via Your Institution.
`

    const document = expectDocument(detectDocument('/research/Gated_2024.md', raw))

    expect(document).toMatchObject({
      contentKind: 'abstract_only',
      hasFulltext: false,
      confidence: 'low'
    })
    expect(document.warnings).toContain(
      'Full text is access-limited; the extracted sections contain the Springer "access via your institution" gate.'
    )
  })

  it('ignores ordinary Markdown frontmatter without paper-fetch trust fields', () => {
    const raw = `---
title: Project notes
authors: Ada Lovelace
---

# Project notes
`

    expect(detectDocument('/research/notes.md', raw)).toEqual({ kind: 'ignore' })
  })
})

describe('detectDocument HTML fallback', () => {
  it('indexes a recognized original HTML artifact using citation metadata', () => {
    const body = `Published article content. ${'Evidence and discussion. '.repeat(120)}`
    const raw = `<!doctype html>
<html>
  <head>
    <meta name="citation_title" content="Publisher HTML paper">
    <meta name="citation_doi" content="https://doi.org/10.7777/HTML.9">
    <meta name="citation_author" content="Ada Lovelace">
    <meta name="citation_author" content="Grace Hopper">
    <meta name="citation_journal_title" content="Journal of HTML Fallbacks">
    <meta name="citation_publication_date" content="2021-04-03">
    <title>Ignored fallback title</title>
    <script>window.secret = 'not article text'</script>
  </head>
  <body><article><h1>Publisher HTML paper</h1><p>${body}</p></article></body>
</html>`

    const document = expectDocument(detectDocument('/research/Paper_original.html', raw))

    expect(document).toMatchObject({
      doi: '10.7777/html.9',
      title: 'Publisher HTML paper',
      authors: ['Ada Lovelace', 'Grace Hopper'],
      journal: 'Journal of HTML Fallbacks',
      published: '2021-04-03',
      year: '2021',
      source: 'html',
      contentKind: 'fulltext',
      hasFulltext: true,
      detector: 'article-html'
    })
    expect(document.warnings).toContain(
      'Indexed from HTML fallback; structured article JSON was not available.'
    )
    expect(document.bodyText).toContain('Evidence and discussion.')
    expect(document.bodyText).not.toContain('window.secret')
  })

  it('downgrades a gated original-HTML fallback while retaining its detector warning', () => {
    const body = `Preview content. ${'Evidence and discussion. '.repeat(120)} ACCESS VIA YOUR INSTITUTION`
    const raw = `<!doctype html>
<html>
  <head>
    <meta name="citation_title" content="Gated HTML paper">
    <meta name="citation_doi" content="10.7777/GATED-HTML.1">
    <meta name="description" content="The abstract remains available.">
  </head>
  <body><article><p>${body}</p></article></body>
</html>`

    const document = expectDocument(detectDocument('/research/Gated_original.html', raw))

    expect(document).toMatchObject({
      abstract: 'The abstract remains available.',
      contentKind: 'abstract_only',
      hasFulltext: false,
      confidence: 'low'
    })
    expect(document.warnings).toContain(
      'Indexed from HTML fallback; structured article JSON was not available.'
    )
    expect(document.warnings).toContain(
      'Full text is access-limited; the extracted sections contain the Springer "access via your institution" gate.'
    )
  })

  it('ignores arbitrary project HTML even when it contains article-like metadata', () => {
    const raw = `<meta name="citation_title" content="A page"><meta name="citation_doi" content="10.7777/page">`

    expect(detectDocument('/research/project-dashboard.html', raw)).toEqual({ kind: 'ignore' })
  })
})
