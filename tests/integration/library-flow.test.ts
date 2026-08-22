import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { LibraryService } from '../../src/main/application/library-service.js'
import { LibraryDatabase } from '../../src/main/db/library-database.js'
import { RootScanner } from '../../src/main/ingest/scanner.js'
import type { RootSummary, ScanResult } from '../../src/shared/contracts.js'

interface ArticleOptions {
  doi?: string
  title?: string
  authors?: string[]
  abstract?: string
  body?: string
  journal?: string
  published?: string
  assetPath?: string | null
  extractionRevision?: number
  warnings?: string[]
  references?: unknown[]
}

interface Harness {
  sandboxPath: string
  database: LibraryDatabase
  scanner: RootScanner
  service: LibraryService
  close(): Promise<void>
}

interface TreeEntry {
  kind: 'directory' | 'file' | 'symlink'
  contentHash?: string
  mode?: number
  modifiedAtMs?: number
}

const harnesses: Harness[] = []

function articleJson(options: ArticleOptions = {}): string {
  const doi = options.doi ?? '10.1234/paperrelay.integration'
  const title = options.title ?? 'Mitochondrial Signaling in Aging Cells'
  const authors = options.authors ?? ['Ada Researcher', 'Lin Scientist']
  const abstract = options.abstract ?? 'Mitochondria coordinate the cellular response to metabolic stress.'
  const body =
    options.body ??
    'Mitochondrial signaling changes autophagy and preserves proteostasis during cellular aging.'
  const assets =
    options.assetPath === undefined || options.assetPath === null
      ? []
      : [
          {
            kind: 'figure',
            heading: 'Figure 1',
            caption: 'The mitochondrial signaling model.',
            path: options.assetPath,
            section: 'results'
          }
        ]

  return JSON.stringify(
    {
      doi,
      source: 'elsevier_xml',
      metadata: {
        title,
        authors,
        abstract,
        journal: options.journal ?? 'Journal of Reliable Integration Tests',
        published: options.published ?? '2026-08-19',
        keywords: ['mitochondria', 'aging']
      },
      sections: [
        { heading: 'Abstract', level: 1, kind: 'abstract', text: abstract },
        { heading: 'Results', level: 1, kind: 'results', text: body }
      ],
      references: options.references ?? [
        {
          raw: 'Researcher A. A reproducible reference. 2025.',
          doi: '10.1234/reference.1',
          title: 'A reproducible reference',
          year: '2025'
        }
      ],
      assets,
      quality: {
        has_fulltext: true,
        content_kind: 'fulltext',
        has_abstract: true,
        confidence: 'high',
        warnings: options.warnings ?? [],
        flags: ['structured-fulltext'],
        source_trail: ['provider:elsevier_xml'],
        token_estimate: 1_250,
        extraction_revision: options.extractionRevision ?? 2
      }
    },
    null,
    2
  )
}

async function createHarness(): Promise<Harness> {
  const sandboxPath = await mkdtemp(join(tmpdir(), 'paperrelay-integration-'))
  const database = new LibraryDatabase(join(sandboxPath, 'state', 'library.sqlite'))
  const scanner = new RootScanner(database)
  const service = new LibraryService(database)
  let closed = false
  const harness: Harness = {
    sandboxPath,
    database,
    scanner,
    service,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await service.close()
    }
  }
  harnesses.push(harness)
  return harness
}

async function createResearchRoot(harness: Harness, name: string): Promise<string> {
  const rootPath = join(harness.sandboxPath, name)
  await mkdir(rootPath, { recursive: true })
  return rootPath
}

async function writeArticle(rootPath: string, relativePath: string, options: ArticleOptions = {}): Promise<string> {
  const targetPath = join(rootPath, relativePath)
  await mkdir(join(targetPath, '..'), { recursive: true })
  await writeFile(targetPath, articleJson(options), 'utf8')
  return targetPath
}

async function registerAndScan(
  harness: Harness,
  rootPath: string,
  label = basename(rootPath)
): Promise<{ root: RootSummary; scan: ScanResult }> {
  const root = harness.database.registerRoot(await realpath(rootPath), label)
  const scan = await harness.scanner.scan(root.id)
  return { root, scan }
}

async function snapshotTree(rootPath: string): Promise<Record<string, TreeEntry>> {
  const entries: Record<string, TreeEntry> = {}

  const visit = async (directory: string): Promise<void> => {
    const directoryEntries = await opendir(directory)
    for await (const entry of directoryEntries) {
      const path = join(directory, entry.name)
      const relativePath = relative(rootPath, path)
      if (entry.isDirectory()) {
        entries[relativePath] = { kind: 'directory' }
        await visit(path)
      } else if (entry.isSymbolicLink()) {
        entries[relativePath] = { kind: 'symlink' }
      } else if (entry.isFile()) {
        const [content, fileStat] = await Promise.all([readFile(path), stat(path)])
        entries[relativePath] = {
          kind: 'file',
          contentHash: createHash('sha256').update(content).digest('hex'),
          mode: fileStat.mode,
          modifiedAtMs: fileStat.mtimeMs
        }
      }
    }
  }

  await visit(rootPath)
  return entries
}

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) {
    await harness.close()
    await rm(harness.sandboxPath, { recursive: true, force: true })
  }
})

describe('PaperRelay library integration', () => {
  it('registers and scans a root, then serves searchable paper details', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'project-alpha')
    const articlePath = await writeArticle(rootPath, 'papers/aging/article.json')

    const root = await harness.service.addRoot(rootPath, 'Project Alpha')
    const scan = await harness.service.rescan(root.id)

    expect(scan.discovered).toBe(1)
    expect(scan.indexed + scan.unchanged).toBe(1)
    expect(scan.issues).toBe(0)

    const searchResults = harness.service.searchPapers({ query: 'proteostasis' })
    expect(searchResults).toHaveLength(1)
    expect(searchResults[0]).toMatchObject({
      title: 'Mitochondrial Signaling in Aging Cells',
      authors: ['Ada Researcher', 'Lin Scientist'],
      year: '2026',
      doi: '10.1234/paperrelay.integration',
      contentKind: 'fulltext',
      locationCount: 1,
      rootLabels: ['Project Alpha']
    })

    const paperId = searchResults[0]?.id
    expect(paperId).toBeTruthy()
    const detail = harness.service.getPaper(paperId ?? '')
    expect(detail).not.toBeNull()
    expect(detail?.abstract).toContain('metabolic stress')
    expect(detail?.keywords).toEqual(['mitochondria', 'aging'])
    expect(detail?.referenceCount).toBe(1)
    expect(detail?.references).toEqual([
      {
        raw: 'Researcher A. A reproducible reference. 2025.',
        doi: '10.1234/reference.1',
        title: 'A reproducible reference',
        year: '2025'
      }
    ])
    expect(detail?.sections.map((section) => section.heading)).toEqual(['Abstract', 'Results'])
    expect(detail?.locations).toHaveLength(1)
    expect(detail?.locations[0]).toMatchObject({
      rootId: root.id,
      rootLabel: 'Project Alpha',
      relativePath: 'papers/aging/article.json',
      detector: 'article-json',
      parseStatus: 'ready'
    })
    expect(harness.service.resolveLocationPath(detail?.locations[0]?.id ?? '')).toBe(await realpath(articlePath))

    expect(harness.service.summary()).toMatchObject({
      paperCount: 1,
      fullTextCount: 1,
      issueCount: 0,
      rootCount: 1
    })
  })

  it('returns, commits, and clears durable note drafts through the library service', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'draft-project')
    await writeArticle(rootPath, 'paper.json')
    await registerAndScan(harness, rootPath)
    const paperId = harness.service.searchPapers({})[0]?.id ?? ''

    expect(harness.service.getPaper(paperId)?.userDraft).toBeNull()
    const draft = harness.service.saveDraft(paperId, {
      note: 'Unsaved synthesis.',
      tagInput: ' methods, methods, evidence '
    })
    expect(draft).toMatchObject({
      paperId,
      note: 'Unsaved synthesis.',
      tagInput: ' methods, methods, evidence '
    })
    expect(harness.service.getPaper(paperId)?.userDraft).toEqual(draft)

    const committed = harness.service.commitDraft(paperId)
    expect(committed).toMatchObject({
      note: 'Unsaved synthesis.',
      tags: ['methods', 'evidence'],
      hasNote: true
    })
    expect(harness.service.getPaper(paperId)).toMatchObject({
      userState: committed,
      userDraft: null
    })
    expect(() =>
      harness.service.saveDraft('missing-paper', { note: 'No orphan.', tagInput: '' })
    ).toThrow('no longer available')
  })

  it('normalizes and bounds untrusted references returned with paper details', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'bounded-reference-project')
    const references: unknown[] = [
      {
        raw: 'R'.repeat(9_000),
        doi: 'https://doi.org/10.5555/BOUNDED-REFERENCE?tracking=1',
        title: 'T'.repeat(5_000),
        year: 'Y'.repeat(80)
      },
      null,
      42,
      {},
      '  A plain reference string.  ',
      { title: 'A title-only reference' }
    ]
    for (let index = 0; index < 2_100; index += 1) {
      references.push({ raw: `Bounded reference ${index}.` })
    }
    await writeArticle(rootPath, 'article.json', { references })
    await registerAndScan(harness, rootPath)

    const detail = harness.service.getPaper(harness.service.searchPapers({})[0]?.id ?? '')
    expect(detail?.referenceCount).toBe(references.length)
    expect(detail?.references).toHaveLength(2_000)
    expect(detail?.references[0]).toMatchObject({
      doi: '10.5555/bounded-reference',
      year: 'Y'.repeat(64)
    })
    expect(detail?.references[0]?.raw).toHaveLength(8_192)
    expect(detail?.references[0]?.title).toHaveLength(4_096)
    expect(detail?.references[1]).toEqual({
      raw: 'A plain reference string.',
      doi: null,
      title: null,
      year: null
    })
    expect(detail?.references[2]).toEqual({
      raw: 'A title-only reference',
      doi: null,
      title: 'A title-only reference',
      year: null
    })
  })

  it('rescans idempotently without duplicating papers or locations', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'idempotent-project')
    await writeArticle(rootPath, 'article.json')
    const { root, scan: firstScan } = await registerAndScan(harness, rootPath)

    expect(firstScan).toMatchObject({ indexed: 1, unchanged: 0, removed: 0 })

    const secondScan = await harness.scanner.scan(root.id)
    expect(secondScan).toMatchObject({ discovered: 1, indexed: 0, unchanged: 1, issues: 0, removed: 0 })

    const papers = harness.service.searchPapers({})
    expect(papers).toHaveLength(1)
    expect(papers[0]?.locationCount).toBe(1)
    expect(harness.service.getPaper(papers[0]?.id ?? '')?.locations).toHaveLength(1)
    expect(harness.service.listRoots()[0]).toMatchObject({ paperCount: 1, issueCount: 0, status: 'ready' })
  })

  it('coalesces DOI-less generated representations by their scoped corpus work path', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'generated-corpus')
    const title = 'A DOI-less Generated Research Work'
    const json = articleJson({ doi: '', title, body: 'Canonical structured evidence.' })
    const markdown = `---
title: "${title}"
source: "open_access_html"
has_fulltext: true
content_kind: "fulltext"
has_abstract: true
---

# ${title}

## Abstract

An abstract.

## Results

Peer Markdown evidence.
`

    for (const branch of ['fetch', 'library']) {
      const recordPath = join(rootPath, 'corpus', 'groups', branch, 'records', 'work-00014.both.json')
      const markdownPath = join(rootPath, 'corpus', 'groups', branch, 'papers', 'work-00014', 'fulltext.md')
      await mkdir(join(recordPath, '..'), { recursive: true })
      await mkdir(join(markdownPath, '..'), { recursive: true })
      await writeFile(recordPath, json, 'utf8')
      await writeFile(markdownPath, markdown, 'utf8')
    }

    await registerAndScan(harness, rootPath)

    const papers = harness.service.searchPapers({ query: 'Generated Research' })
    expect(papers).toHaveLength(1)
    expect(papers[0]).toMatchObject({ title, locationCount: 4 })
    expect(harness.service.getPaper(papers[0]?.id ?? '')?.locations).toHaveLength(4)
  })

  it('coalesces the same DOI from two roots into one paper with two locations', async () => {
    const harness = await createHarness()
    const firstRootPath = await createResearchRoot(harness, 'project-one')
    const secondRootPath = await createResearchRoot(harness, 'project-two')
    await writeArticle(firstRootPath, 'article.json', {
      doi: 'https://doi.org/10.5555/Shared.Paper',
      title: 'A Paper Shared Across Projects'
    })
    await writeArticle(secondRootPath, 'literature/article.json', {
      doi: 'DOI: 10.5555/shared.paper',
      title: 'A Paper Shared Across Projects'
    })

    const first = await registerAndScan(harness, firstRootPath, 'Project One')
    const second = await registerAndScan(harness, secondRootPath, 'Project Two')

    expect(harness.service.summary().paperCount).toBe(1)
    const papers = harness.service.searchPapers({ query: 'shared projects' })
    expect(papers).toHaveLength(1)
    expect(papers[0]).toMatchObject({
      doi: '10.5555/shared.paper',
      locationCount: 2,
      rootLabels: ['Project One', 'Project Two']
    })

    const detail = harness.service.getPaper(papers[0]?.id ?? '')
    expect(detail?.locations).toHaveLength(2)
    expect(new Set(detail?.locations.map((location) => location.rootId))).toEqual(
      new Set([first.root.id, second.root.id])
    )
    expect(harness.service.searchPapers({ rootId: first.root.id })).toHaveLength(1)
    expect(harness.service.searchPapers({ rootId: second.root.id })).toHaveLength(1)
  })

  it('indexes only the preferred searchable representation while preserving alternate locations', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'searchable-representation-project')
    await writeArticle(rootPath, 'older/article.json', {
      doi: '10.5555/searchable-representation',
      title: 'Older Search Representation',
      body: 'OlderRepresentationOnly should not remain in the derived search index.',
      extractionRevision: 1
    })
    await writeArticle(rootPath, 'newer/article.json', {
      doi: '10.5555/searchable-representation',
      title: 'Current Search Representation',
      body: 'CurrentRepresentationOnly is the root-preferred searchable body.',
      extractionRevision: 9
    })

    const { root } = await registerAndScan(harness, rootPath)
    const paper = harness.service.searchPapers({ rootId: root.id })[0]

    expect(paper).toMatchObject({ title: 'Current Search Representation', locationCount: 2 })
    expect(
      harness.service.searchPapers({ query: 'CurrentRepresentationOnly', rootId: root.id })
    ).toHaveLength(1)
    expect(
      harness.service.searchPapers({ query: 'OlderRepresentationOnly', rootId: root.id })
    ).toEqual([])
    expect(harness.service.getPaper(paper?.id ?? '', root.id)?.locations).toHaveLength(2)

    const databasePath = join(harness.sandboxPath, 'state', 'library.sqlite')
    const inspection = new DatabaseSync(databasePath, {
      readOnly: true
    })
    const indexed = inspection.prepare('SELECT COUNT(*) AS count FROM document_fts').get() as {
      count: number
    }
    inspection.close()
    expect(indexed.count).toBe(1)

    await harness.close()
    const legacyIndex = new DatabaseSync(databasePath)
    legacyIndex.exec(`
      DELETE FROM document_fts;
      INSERT INTO document_fts(document_id, paper_id, title, authors, abstract, body, doi, journal)
      SELECT id, paper_id, title, authors_json, abstract, body_text, doi, journal
      FROM documents WHERE paper_id IS NOT NULL;
    `)
    expect(
      (legacyIndex.prepare('SELECT COUNT(*) AS count FROM document_fts').get() as { count: number }).count
    ).toBe(2)
    legacyIndex.close()

    const reopened = new LibraryDatabase(databasePath)
    reopened.close()
    const prunedIndex = new DatabaseSync(databasePath, { readOnly: true })
    expect(
      (prunedIndex.prepare('SELECT COUNT(*) AS count FROM document_fts').get() as { count: number }).count
    ).toBe(1)
    prunedIndex.close()
  })

  it('keeps search, details, and assets on the representation attached to a scoped root', async () => {
    const harness = await createHarness()
    const firstRootPath = await createResearchRoot(harness, 'representation-one')
    const secondRootPath = await createResearchRoot(harness, 'representation-two')
    const firstAssetPath = join(firstRootPath, 'figure-one.png')
    const secondAssetPath = join(secondRootPath, 'figure-two.png')
    await writeFile(firstAssetPath, new Uint8Array([137, 80, 78, 71, 1]))
    await writeFile(secondAssetPath, new Uint8Array([137, 80, 78, 71, 2]))
    await writeArticle(firstRootPath, 'article.json', {
      doi: '10.5555/scoped-representation',
      title: 'Project One Representation',
      abstract: 'AlphaScopeOnly belongs to the first project copy.',
      body: 'The first project records AlphaScopeOnly evidence.',
      assetPath: 'figure-one.png',
      extractionRevision: 1,
      references: [
        {
          raw: 'First-root reference.',
          doi: 'https://doi.org/10.5555/FIRST-REFERENCE',
          title: 'First reference',
          year: 2020
        }
      ]
    })
    await writeArticle(secondRootPath, 'article.json', {
      doi: '10.5555/scoped-representation',
      title: 'Project Two Preferred Representation',
      abstract: 'BetaScopeOnly belongs to the second project copy.',
      body: 'The second project records BetaScopeOnly evidence.',
      assetPath: 'figure-two.png',
      extractionRevision: 9,
      warnings: ['The project-two extraction needs review.'],
      references: [{ raw: 'Second-root reference.', doi: '10.5555/second-reference' }]
    })

    const first = await registerAndScan(harness, firstRootPath, 'Project One')
    const second = await registerAndScan(harness, secondRootPath, 'Project Two')
    expect(harness.database.getRoot(first.root.id)?.issueCount).toBe(0)
    expect(harness.database.getRoot(second.root.id)?.issueCount).toBe(1)
    const globalPaper = harness.service.searchPapers({})[0]
    expect(globalPaper).toMatchObject({
      title: 'Project Two Preferred Representation',
      locationCount: 2,
      rootLabels: ['Project One', 'Project Two']
    })

    const firstMatches = harness.service.searchPapers({
      query: 'AlphaScopeOnly',
      rootId: first.root.id,
      sort: 'updated'
    })
    expect(firstMatches).toHaveLength(1)
    expect(firstMatches[0]).toMatchObject({
      id: globalPaper?.id,
      title: 'Project One Representation',
      locationCount: 1,
      rootIds: [first.root.id],
      rootLabels: ['Project One']
    })
    expect(
      harness.service.searchPapers({ query: 'BetaScopeOnly', rootId: first.root.id })
    ).toEqual([])
    expect(
      harness.service.searchPapers({ query: 'AlphaScopeOnly', rootId: second.root.id })
    ).toEqual([])
    expect(
      harness.service.searchPapers({ query: 'BetaScopeOnly', rootId: second.root.id })[0]?.title
    ).toBe('Project Two Preferred Representation')

    const firstDetail = harness.service.getPaper(globalPaper?.id ?? '', first.root.id)
    expect(firstDetail).toMatchObject({
      title: 'Project One Representation',
      abstract: 'AlphaScopeOnly belongs to the first project copy.',
      locationCount: 1,
      rootIds: [first.root.id]
    })
    expect(firstDetail?.locations).toHaveLength(1)
    expect(firstDetail?.references).toEqual([
      {
        raw: 'First-root reference.',
        doi: '10.5555/first-reference',
        title: 'First reference',
        year: '2020'
      }
    ])
    expect(firstDetail?.locations[0]?.rootId).toBe(first.root.id)
    expect(firstDetail?.assets[0]?.previewUrl).toContain(
      `rootId=${encodeURIComponent(first.root.id)}`
    )
    expect(harness.service.resolveAssetPath(globalPaper?.id ?? '', 0, first.root.id)).toBe(
      await realpath(firstAssetPath)
    )
    expect(harness.service.resolveAssetPath(globalPaper?.id ?? '', 0, second.root.id)).toBe(
      await realpath(secondAssetPath)
    )
    expect(harness.service.getPaper(globalPaper?.id ?? '')).toMatchObject({
      title: 'Project Two Preferred Representation',
      locationCount: 2,
      references: [
        {
          raw: 'Second-root reference.',
          doi: '10.5555/second-reference',
          title: null,
          year: null
        }
      ]
    })
  })

  it('backfills the derived document search index for an existing v2 catalog idempotently', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'v2-search-backfill')
    await writeArticle(rootPath, 'article.json', {
      title: 'A Legacy Phase One Catalog Paper',
      body: 'DerivedBackfillOnly is searchable after the desktop opens this catalog.'
    })
    const { root } = await registerAndScan(harness, rootPath)
    const databasePath = join(harness.sandboxPath, 'state', 'library.sqlite')
    await harness.close()

    const legacyCatalog = new DatabaseSync(databasePath)
    legacyCatalog.exec('DROP TABLE document_fts')
    legacyCatalog.close()

    const reopened = new LibraryDatabase(databasePath)
    expect(reopened.searchPapers({ query: 'DerivedBackfillOnly', rootId: root.id })).toHaveLength(1)
    reopened.close()

    const reopenedAgain = new LibraryDatabase(databasePath)
    expect(reopenedAgain.searchPapers({ query: 'DerivedBackfillOnly', rootId: root.id })).toHaveLength(1)
    reopenedAgain.close()

    const inspection = new DatabaseSync(databasePath, { readOnly: true })
    const documents = inspection.prepare('SELECT COUNT(*) AS count FROM documents').get() as {
      count: number
    }
    const indexedDocuments = inspection.prepare('SELECT COUNT(*) AS count FROM document_fts').get() as {
      count: number
    }
    expect(indexedDocuments.count).toBe(documents.count)
    inspection.close()
  })

  it('ranks metadata matches ahead of body-only matches during search', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'search-ranking-project')
    await writeArticle(rootPath, 'title-match/article.json', {
      doi: '10.1234/title-match',
      title: 'Sentinel Methods for Reproducible Research',
      body: 'This paper discusses ordinary indexing behavior.'
    })
    await writeArticle(rootPath, 'body-match/article.json', {
      doi: '10.1234/body-match',
      title: 'A General Research Note',
      body: 'The sentinel term appears only in this article body.'
    })
    await registerAndScan(harness, rootPath)

    const results = harness.service.searchPapers({ query: 'sentinel', sort: 'updated' })

    expect(results).toHaveLength(2)
    expect(results[0]?.title).toBe('Sentinel Methods for Reproducible Research')
  })

  it('pages global and root-scoped paper lists without gaps or duplicates', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'paginated-library')

    for (let index = 0; index < 7; index += 1) {
      await writeArticle(rootPath, `paper-${index}/article.json`, {
        doi: `10.4242/desktop-pagination-${index}`,
        title: index < 3 ? 'Shared Pagination Title' : `Pagination Title ${index}`,
        body: 'A desktop pagination sentinel appears in every paper.'
      })
    }

    const { root } = await registerAndScan(harness, rootPath)
    const expected = harness.service.searchPapers({ sort: 'title', limit: 20 }).map((paper) => paper.id)
    const paged = [0, 3, 6].flatMap((offset) =>
      harness.service.searchPapers({ sort: 'title', limit: 3, offset }).map((paper) => paper.id)
    )

    expect(expected).toHaveLength(7)
    expect(paged).toEqual(expected)
    expect(new Set(paged).size).toBe(7)

    const scopedExpected = harness.service
      .searchPapers({ query: 'desktop pagination sentinel', rootId: root.id, sort: 'updated', limit: 20 })
      .map((paper) => paper.id)
    const scopedPages = [0, 2, 4, 6].flatMap((offset) =>
      harness.service
        .searchPapers({
          query: 'desktop pagination sentinel',
          rootId: root.id,
          sort: 'updated',
          limit: 2,
          offset
        })
        .map((paper) => paper.id)
    )

    expect(scopedPages).toEqual(scopedExpected)
    expect(harness.service.searchPapers({ rootId: root.id, limit: 2, offset: 99 })).toEqual([])
  })

  it('records malformed article.json as an issue without aborting valid indexing', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'mixed-quality-project')
    await writeArticle(rootPath, 'valid/article.json', { title: 'The Valid Indexed Paper' })
    const malformedPath = join(rootPath, 'broken', 'article.json')
    await mkdir(join(malformedPath, '..'), { recursive: true })
    await writeFile(malformedPath, '{"doi": "10.1234/broken", invalid JSON', 'utf8')

    const { root, scan } = await registerAndScan(harness, rootPath, 'Mixed Quality')

    expect(scan).toMatchObject({ discovered: 2, indexed: 1, issues: 1, removed: 0 })
    expect(harness.service.searchPapers({ query: 'valid indexed' })).toHaveLength(1)
    const issues = harness.service.listIssues(root.id)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      rootId: root.id,
      relativePath: 'broken/article.json'
    })
    expect(issues[0]?.message).toContain('Invalid paper JSON')
    expect(harness.service.listRoots()[0]).toMatchObject({
      status: 'ready',
      paperCount: 1,
      issueCount: 1
    })
  })

  it('reconciles a deleted artifact and removes its orphaned paper', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'deletion-project')
    const articlePath = await writeArticle(rootPath, 'article.json')
    const { root } = await registerAndScan(harness, rootPath)
    const paperId = harness.service.searchPapers({})[0]?.id

    await unlink(articlePath)
    const scan = await harness.scanner.scan(root.id)

    expect(scan).toMatchObject({ discovered: 0, indexed: 0, unchanged: 0, issues: 0, removed: 1 })
    expect(harness.service.searchPapers({})).toEqual([])
    expect(harness.service.getPaper(paperId ?? '')).toBeNull()
    expect(harness.service.summary()).toMatchObject({ paperCount: 0, fullTextCount: 0 })
    expect(harness.service.listRoots()[0]).toMatchObject({ status: 'empty', paperCount: 0 })
  })

  it('marks an unavailable root while retaining its last successful index', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'portable-project')
    await writeArticle(rootPath, 'article.json', { title: 'Cached While the Drive Is Offline' })
    const { root } = await registerAndScan(harness, rootPath, 'Portable Drive')
    const originalResults = harness.service.searchPapers({ query: 'drive offline' })
    const relocatedPath = `${rootPath}-offline`

    await rename(rootPath, relocatedPath)
    await expect(harness.scanner.scan(root.id)).rejects.toMatchObject({ code: 'ENOENT' })

    const retainedResults = harness.service.searchPapers({ query: 'drive offline' })
    expect(retainedResults).toHaveLength(1)
    expect(retainedResults[0]?.id).toBe(originalResults[0]?.id)
    expect(harness.service.getPaper(retainedResults[0]?.id ?? '')?.locations).toHaveLength(1)
    expect(harness.service.listRoots()[0]).toMatchObject({
      status: 'unavailable',
      paperCount: 1
    })
    expect(harness.service.listRoots()[0]?.error).toBeTruthy()
  })

  it('does not traverse a symlinked directory', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'symlink-project')
    const outsidePath = await createResearchRoot(harness, 'outside-corpus')
    await writeArticle(rootPath, 'local/article.json', { title: 'A Local Paper' })
    await writeArticle(outsidePath, 'article.json', {
      doi: '10.1234/should-not-be-indexed',
      title: 'An External Symlinked Paper',
      body: 'This sentinel content must remain outside the registered research root.'
    })
    await symlink(outsidePath, join(rootPath, 'linked-corpus'), process.platform === 'win32' ? 'junction' : 'dir')

    const { scan } = await registerAndScan(harness, rootPath)

    expect(scan).toMatchObject({ discovered: 1, indexed: 1, issues: 0 })
    expect(harness.service.searchPapers({})).toHaveLength(1)
    expect(harness.service.searchPapers({ query: 'external symlinked' })).toEqual([])
    expect(harness.service.searchPapers({})[0]?.title).toBe('A Local Paper')
  })

  it('leaves every source file and directory entry unchanged while indexing', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'immutable-source-project')
    const assetRelativePath = 'figures/figure-1.png'
    await mkdir(join(rootPath, 'figures'), { recursive: true })
    await writeFile(join(rootPath, assetRelativePath), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
    await writeArticle(rootPath, 'papers/article.json', {
      title: 'An Immutable Source Artifact',
      assetPath: `../${assetRelativePath}`
    })
    await writeFile(join(rootPath, 'project-notes.txt'), 'Human-authored project notes must not change.\n', 'utf8')
    const before = await snapshotTree(rootPath)

    const { scan } = await registerAndScan(harness, rootPath)

    expect(scan.indexed).toBe(1)
    expect(await snapshotTree(rootPath)).toEqual(before)
  })

  it('does not preview an asset path that escapes the registered root', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'asset-security-project')
    const outsidePath = join(harness.sandboxPath, 'outside.png')
    await writeFile(outsidePath, new Uint8Array([137, 80, 78, 71]))
    await writeArticle(rootPath, 'article.json', { assetPath: outsidePath })
    await registerAndScan(harness, rootPath)

    const paper = harness.service.getPaper(harness.service.searchPapers({})[0]?.id ?? '')

    expect(paper?.assets[0]).toMatchObject({ path: null, available: false, previewUrl: null })
  })

  it('merges personal state, filters user views, and preserves orphan state across root re-addition', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'personal-library-project')
    await writeArticle(rootPath, 'article.json', {
      doi: '10.1234/persistent-personal-state',
      title: 'Persistent Personal State'
    })
    const { root } = await registerAndScan(harness, rootPath)
    const indexed = harness.service.searchPapers({})[0]
    expect(indexed?.userState).toEqual({
      favorite: false,
      readingStatus: 'none',
      tags: [],
      hasNote: false,
      lastOpenedAt: null,
      updatedAt: null
    })

    const paperId = indexed?.id ?? ''
    const state = harness.service.updateUserState(paperId, {
      favorite: true,
      readingStatus: 'reading',
      tags: ['  InSAR ', 'insar', 'Permafrost'],
      note: 'Compare the full-resolution workflow.'
    })
    expect(state).toMatchObject({
      favorite: true,
      readingStatus: 'reading',
      tags: ['InSAR', 'Permafrost'],
      hasNote: true,
      note: 'Compare the full-resolution workflow.'
    })
    expect(harness.service.summary()).toMatchObject({
      favoriteCount: 1,
      readingListCount: 1,
      reviewedCount: 0
    })
    expect(harness.service.searchPapers({ userView: 'favorites' }).map((paper) => paper.id)).toEqual([
      paperId
    ])
    expect(harness.service.searchPapers({ userView: 'reading_list' }).map((paper) => paper.id)).toEqual([
      paperId
    ])
    expect(
      harness.service
        .searchPapers({
          userView: 'favorites',
          rootId: root.id,
          query: 'persistent personal',
          limit: 1
        })
        .map((paper) => paper.id)
    ).toEqual([paperId])
    expect(harness.service.searchPapers({ userView: 'reviewed' })).toEqual([])
    expect(harness.service.getPaper(paperId)?.userState.note).toBe(
      'Compare the full-resolution workflow.'
    )
    expect(harness.service.markOpened(paperId).lastOpenedAt).not.toBeNull()
    expect(() => harness.service.updateUserState('paper_missing', { favorite: true })).toThrow(
      'no longer available'
    )

    await harness.service.removeRoot(root.id)
    expect(harness.service.searchPapers({})).toEqual([])
    expect(harness.service.summary()).toMatchObject({
      favoriteCount: 0,
      readingListCount: 0,
      reviewedCount: 0
    })
    expect(harness.service.userDatabase.getPaperState(paperId)).toMatchObject({
      favorite: true,
      readingStatus: 'reading',
      tags: ['InSAR', 'Permafrost'],
      note: 'Compare the full-resolution workflow.'
    })

    await registerAndScan(harness, rootPath)
    const restored = harness.service.searchPapers({ userView: 'reading_list' })[0]
    expect(restored?.id).toBe(paperId)
    expect(restored?.userState).toMatchObject({
      favorite: true,
      readingStatus: 'reading',
      tags: ['InSAR', 'Permafrost'],
      hasNote: true
    })
  })

  it('relinks personal state when the same source gains a DOI identity', async () => {
    const harness = await createHarness()
    const rootPath = await createResearchRoot(harness, 'identity-upgrade-project')
    await writeArticle(rootPath, 'article.json', {
      doi: '',
      title: 'A Paper Awaiting Its DOI'
    })
    const { root } = await registerAndScan(harness, rootPath)
    const originalId = harness.service.searchPapers({})[0]?.id ?? ''
    harness.service.updateUserState(originalId, {
      favorite: true,
      note: 'Keep this note through an exact source identity upgrade.'
    })

    await writeArticle(rootPath, 'article.json', {
      doi: '10.1234/newly-identified-paper',
      title: 'A Paper Awaiting Its DOI'
    })
    await harness.scanner.scan(root.id)

    const relinked = harness.service.searchPapers({ userView: 'favorites' })[0]
    expect(relinked?.id).not.toBe(originalId)
    expect(relinked?.doi).toBe('10.1234/newly-identified-paper')
    expect(harness.service.getPaper(relinked?.id ?? '')?.userState).toMatchObject({
      favorite: true,
      hasNote: true,
      note: 'Keep this note through an exact source identity upgrade.'
    })
  })
})
