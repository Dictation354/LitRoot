import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentLibraryService } from '../../src/main/agent/agent-library-service.js'
import { AgentRelayError, relayErrorPayload } from '../../src/main/agent/errors.js'
import { LibraryReader } from '../../src/main/agent/library-reader.js'
import { addResearchRoot, createAgentFixture, fileHash, snapshotFiles, testArticle } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []

function errorCode(operation: () => unknown): string | null {
  try {
    operation()
    return null
  } catch (error) {
    return error instanceof AgentRelayError ? error.code : null
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('Agent Relay read-only library access', () => {
  it('lists roots and searches globally or within one project', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    const first = await addResearchRoot(fixture, 'project-alpha', {
      doi: 'https://doi.org/10.4242/SHARED',
      title: 'Shared Mitochondrial Study',
      body: 'Mitochondrial stress signaling is shared across these research projects.'
    })
    const second = await addResearchRoot(fixture, 'project-beta', {
      doi: 'DOI: 10.4242/shared',
      title: 'Shared Mitochondrial Study',
      body: 'Mitochondrial stress signaling is shared across these research projects.'
    })
    await addResearchRoot(fixture, 'project-gamma', {
      doi: '10.4242/other',
      title: 'An Unrelated Control Paper',
      body: 'This control discusses an unrelated biological process.'
    })

    const service = new AgentLibraryService(new LibraryReader(fixture.databasePath))
    const roots = service.listResearchRoots()
    expect(roots).toMatchObject({ totalCount: 3, returnedCount: 3, omittedCount: 0, metadataTruncated: false })
    expect(roots.roots.map((root) => root.paperCount)).toEqual([1, 1, 1])

    const global = service.searchLibrary({ query: 'mitochondrial stress' })
    expect(global.count).toBe(1)
    expect(global.results[0]).toMatchObject({
      doi: '10.4242/shared',
      title: 'Shared Mitochondrial Study',
      locationCount: 2
    })
    expect(global.results[0]?.roots.map((root) => root.id)).toEqual([first.root.id, second.root.id])

    const scoped = service.searchLibrary({ query: 'mitochondrial', rootId: second.root.id })
    expect(scoped.count).toBe(1)
    expect(scoped.rootId).toBe(second.root.id)
    expect(service.searchLibrary({ query: 'control', rootId: first.root.id }).results).toEqual([])
    expect(errorCode(() => service.searchLibrary({ query: 'mitochondrial', rootId: 'root_missing' }))).toBe(
      'ROOT_NOT_FOUND'
    )
    service.close()
  })

  it('resolves DOI and PaperRelay IDs into metadata-rich outlines', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    await addResearchRoot(fixture, 'outline-project', {
      doi: '10.4242/outline',
      title: 'Structured Outline Retrieval'
    })
    const service = new AgentLibraryService(new LibraryReader(fixture.databasePath))
    const hit = service.searchLibrary({ query: 'outline retrieval' }).results[0]
    expect(hit).toBeTruthy()

    const byDoi = service.getPaperOutline({ doi: 'https://doi.org/10.4242/OUTLINE' })
    const byId = service.getPaperOutline({ paperId: hit?.paperId })
    expect(byDoi.paperId).toBe(hit?.paperId)
    expect(byId.revision).toBe(byDoi.revision)
    expect(byDoi).toMatchObject({
      title: 'Structured Outline Retrieval',
      contentKind: 'fulltext',
      confidence: 'high',
      referenceCount: 1,
      quality: { warningCount: 0, flags: ['structured-fulltext'] },
      provenance: {
        source: 'elsevier_xml',
        detector: 'article-json',
        extractionRevision: 4,
        sourceTrail: ['provider:elsevier_xml', 'extract:structured']
      }
    })
    expect(byDoi.sections.map((section) => section.heading)).toEqual(['Abstract', 'Methods', 'Results'])
    expect(byDoi.assets[0]).toMatchObject({ heading: 'Figure 1', section: 'Results' })
    expect(byDoi.locations).toHaveLength(1)
    expect(errorCode(() => service.getPaperOutline({ paperId: 'paper_missing' }))).toBe('PAPER_NOT_FOUND')
    expect(
      errorCode(() => service.getPaperOutline({ paperId: hit?.paperId, doi: '10.4242/not-the-same-paper' }))
    ).toBe('IDENTIFIER_MISMATCH')
    service.close()
  })

  it('reports when a bounded search has more matches', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    for (let index = 0; index < 3; index += 1) {
      await addResearchRoot(fixture, `pagination-project-${index}`, {
        doi: `10.4242/pagination-${index}`,
        title: `Pagination Sentinel Study ${index}`,
        body: 'A shared pagination sentinel result.'
      })
    }
    const service = new AgentLibraryService(new LibraryReader(fixture.databasePath))
    expect(service.searchLibrary({ query: 'pagination sentinel', limit: 2 })).toMatchObject({
      count: 2,
      hasMore: true
    })
    expect(service.searchLibrary({ query: 'pagination sentinel', limit: 3 })).toMatchObject({
      count: 3,
      hasMore: false
    })
    service.close()
  })

  it('keeps differing copies of one DOI scoped through search, outline, and section reads', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    const alpha = await addResearchRoot(fixture, 'project-alpha-scope', {
      doi: '10.4242/scoped-copy',
      title: 'Alpha Project Single-Cell Map',
      body: `${'alpha preface '.repeat(220)}alpha-only T-cell signature appears near the end.`
    })
    const beta = await addResearchRoot(fixture, 'project-beta-scope', {
      doi: '10.4242/scoped-copy',
      title: 'Beta Project Tissue Atlas',
      body: `${'beta preface '.repeat(220)}beta-only organoid signature appears near the end.`,
      warning: 'Beta-only extraction warning.'
    })
    const service = new AgentLibraryService(new LibraryReader(fixture.databasePath))

    const scopedRoots = service.listResearchRoots().roots
    expect(scopedRoots.find((root) => root.id === alpha.root.id)?.issueCount).toBe(0)
    expect(scopedRoots.find((root) => root.id === beta.root.id)?.issueCount).toBe(1)

    const alphaSearch = service.searchLibrary({ query: 'alpha-only signature', rootId: alpha.root.id })
    expect(alphaSearch.count).toBe(1)
    expect(alphaSearch.results[0]).toMatchObject({
      title: 'Alpha Project Single-Cell Map',
      locationCount: 1,
      roots: [{ id: alpha.root.id }]
    })
    expect(alphaSearch.results[0]?.snippet).toContain('‹alpha›-‹only›')
    expect(alphaSearch.results[0]?.snippet).toContain('‹signature›')
    expect(service.searchLibrary({ query: 'beta-only organoid', rootId: alpha.root.id }).count).toBe(0)

    const betaSearch = service.searchLibrary({ query: 'beta-only organoid', rootId: beta.root.id })
    expect(betaSearch.results[0]).toMatchObject({
      title: 'Beta Project Tissue Atlas',
      locationCount: 1,
      roots: [{ id: beta.root.id }]
    })
    expect(betaSearch.results[0]?.snippet).toContain('‹beta›-‹only›')

    const paperId = alphaSearch.results[0]?.paperId
    const alphaOutline = service.getPaperOutline({ paperId, rootId: alpha.root.id })
    const betaOutline = service.getPaperOutline({ doi: '10.4242/scoped-copy', rootId: beta.root.id })
    expect(alphaOutline).toMatchObject({ rootId: alpha.root.id, title: 'Alpha Project Single-Cell Map' })
    expect(betaOutline).toMatchObject({ rootId: beta.root.id, title: 'Beta Project Tissue Atlas' })
    expect(alphaOutline.revision).not.toBe(betaOutline.revision)
    expect(alphaOutline.locations.map((location) => location.rootId)).toEqual([alpha.root.id])
    expect(betaOutline.locations.map((location) => location.rootId)).toEqual([beta.root.id])

    const alphaRead = service.readPaperSections({
      paperId,
      rootId: alpha.root.id,
      revision: alphaOutline.revision,
      query: 'alpha-only'
    })
    expect(alphaRead.paper.rootId).toBe(alpha.root.id)
    expect(alphaRead.sections[0]?.text).toContain('alpha-only')
    expect(alphaRead.sections[0]?.text).not.toContain('beta-only')
    expect(alphaRead.provenance.locations.map((location) => location.rootId)).toEqual([alpha.root.id])
    expect(
      errorCode(() =>
        service.readPaperSections({
          paperId,
          rootId: alpha.root.id,
          revision: betaOutline.revision,
          sectionIndexes: [2]
        })
      )
    ).toBe('STALE_REVISION')
    service.close()
  })

  it('uses per-document FTS ranking, prefix matching, snippets, limits, and attention filters', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    const indexed = await addResearchRoot(fixture, 'fts-search-project', {
      doi: '10.4242/fts-title',
      title: 'Xylophonium Ranking in the Title',
      body: 'This representation contains unrelated body evidence.'
    })
    const bodyMatchPath = join(indexed.rootPath, 'papers', 'body-match', 'article.json')
    await mkdir(join(bodyMatchPath, '..'), { recursive: true })
    await writeFile(
      bodyMatchPath,
      testArticle({
        doi: '10.4242/fts-body',
        title: 'A Body-Only Search Match',
        body: 'The xylophonium signal occurs in the body.',
        warning: 'Review this body match.'
      }),
      'utf8'
    )
    await fixture.scanner.scan(indexed.root.id)

    const service = new AgentLibraryService(new LibraryReader(fixture.databasePath))
    const ranked = service.searchLibrary({ query: 'xylophon', rootId: indexed.root.id, limit: 1 })
    expect(ranked).toMatchObject({ count: 1, hasMore: true, rootId: indexed.root.id })
    expect(ranked.results[0]).toMatchObject({ doi: '10.4242/fts-title' })

    const all = service.searchLibrary({ query: 'xylophon', rootId: indexed.root.id, limit: 2 })
    expect(all.results.map((result) => result.doi)).toEqual(['10.4242/fts-title', '10.4242/fts-body'])
    expect(all.results[1]?.snippet).toContain('‹xylophonium›')
    expect(service.searchLibrary({ query: 'ylophonium', rootId: indexed.root.id }).count).toBe(0)

    const attention = service.searchLibrary({
      query: 'xylophon',
      rootId: indexed.root.id,
      attention: true
    })
    expect(attention.results.map((result) => result.doi)).toEqual(['10.4242/fts-body'])
    service.close()
  })

  it('enforces strict section budgets, source order, selection, and typed errors', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    const longBody = `sentinel result ${'evidence '.repeat(9_000)}`
    await addResearchRoot(fixture, 'budget-project', {
      doi: '10.4242/budget',
      title: 'Bounded Section Reading',
      body: longBody
    })
    const service = new AgentLibraryService(new LibraryReader(fixture.databasePath))
    const outline = service.getPaperOutline({ doi: '10.4242/budget' })

    const defaultBudget = service.readPaperSections({
      paperId: outline.paperId,
      revision: outline.revision,
      sectionIndexes: [2]
    })
    expect(defaultBudget.budget).toEqual({
      maxCharacters: 20_000,
      returnedCharacters: 20_000,
      truncated: true,
      metadataTruncated: false
    })
    expect(defaultBudget.sections[0]).toMatchObject({ index: 2, characterCount: 20_000, truncated: true })

    const selected = service.readPaperSections({
      doi: '10.4242/budget',
      sectionIndexes: [2, 0],
      maxCharacters: 60_000
    })
    expect(selected.sections.map((section) => section.index)).toEqual([0, 2])
    expect(selected.budget.returnedCharacters).toBeLessThanOrEqual(60_000)

    const queried = service.readPaperSections({
      paperId: outline.paperId,
      query: 'deterministic identifiers',
      maxCharacters: 5_000
    })
    expect(queried.sections.map((section) => section.heading)).toEqual(['Methods'])
    expect(errorCode(() => service.readPaperSections({ paperId: outline.paperId, sectionIndexes: [99] }))).toBe(
      'SECTION_NOT_FOUND'
    )
    expect(
      errorCode(() =>
        service.readPaperSections({ paperId: outline.paperId, sectionIndexes: [0], maxCharacters: 60_001 })
      )
    ).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => service.readPaperSections({ paperId: outline.paperId, query: 'absent phrase' }))).toBe(
      'SECTION_NOT_FOUND'
    )
    expect(
      errorCode(() =>
        service.readPaperSections({
          paperId: outline.paperId,
          sectionIndexes: [0],
          query: 'abstract'
        })
      )
    ).toBe('INVALID_ARGUMENT')
    service.close()
  })

  it('rejects stale revisions after a rescan changes the preferred representation', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    const indexed = await addResearchRoot(fixture, 'revision-project', {
      doi: '10.4242/revision',
      title: 'Revision One',
      body: 'The first representation has a short result.'
    })
    const service = new AgentLibraryService(new LibraryReader(fixture.databasePath))
    const original = service.getPaperOutline({ doi: '10.4242/revision' })

    await writeFile(
      indexed.articlePath,
      testArticle({
        doi: '10.4242/revision',
        title: 'Revision Two',
        body: `The second representation is materially different. ${'new evidence '.repeat(50)}`
      }),
      'utf8'
    )
    await fixture.scanner.scan(indexed.root.id)
    const current = service.getPaperOutline({ paperId: original.paperId })

    expect(current.revision).not.toBe(original.revision)
    expect(current.title).toBe('Revision Two')
    expect(
      errorCode(() =>
        service.readPaperSections({
          paperId: original.paperId,
          revision: original.revision,
          sectionIndexes: [2]
        })
      )
    ).toBe('STALE_REVISION')
    expect(
      service.readPaperSections({
        paperId: original.paperId,
        revision: current.revision,
        sectionIndexes: [2]
      }).sections[0]?.text
    ).toContain('materially different')
    service.close()
  })

  it('remains queryable during WAL writes and retains cached data for unavailable roots', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    const indexed = await addResearchRoot(fixture, 'portable-project', {
      doi: '10.4242/portable',
      title: 'Portable Cached Research'
    })
    const service = new AgentLibraryService(new LibraryReader(fixture.databasePath))
    expect(service.searchLibrary({ query: 'portable cached' }).count).toBe(1)

    const concurrentWriter = new DatabaseSync(fixture.databasePath)
    concurrentWriter.exec('BEGIN IMMEDIATE')
    try {
      concurrentWriter.prepare('UPDATE roots SET label = label WHERE id = ?').run(indexed.root.id)
      expect(service.searchLibrary({ query: 'portable cached' }).count).toBe(1)
    } finally {
      concurrentWriter.exec('COMMIT')
      concurrentWriter.close()
    }

    const secondArticlePath = join(indexed.rootPath, 'papers', 'second', 'article.json')
    await mkdir(join(secondArticlePath, '..'), { recursive: true })
    await writeFile(
      secondArticlePath,
      testArticle({ doi: '10.4242/concurrent', title: 'Concurrent WAL Reader' }),
      'utf8'
    )
    await fixture.scanner.scan(indexed.root.id)
    expect(service.searchLibrary({ query: 'concurrent reader' }).count).toBe(1)

    const offlinePath = `${indexed.rootPath}-offline`
    await rename(indexed.rootPath, offlinePath)
    await expect(fixture.scanner.scan(indexed.root.id)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(service.listResearchRoots().roots[0]).toMatchObject({ status: 'unavailable', paperCount: 2 })
    const cached = service.searchLibrary({ query: 'portable cached' })
    expect(cached.count).toBe(1)
    expect(cached.results[0]?.roots[0]?.status).toBe('unavailable')
    service.close()
  })

  it('reconciles a deleted source into a typed paper-not-found result', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    const indexed = await addResearchRoot(fixture, 'deleted-project', {
      doi: '10.4242/deleted-relay',
      title: 'Deleted Relay Source'
    })
    const service = new AgentLibraryService(new LibraryReader(fixture.databasePath))
    const outline = service.getPaperOutline({ doi: '10.4242/deleted-relay', rootId: indexed.root.id })
    await unlink(indexed.articlePath)
    await fixture.scanner.scan(indexed.root.id)

    expect(errorCode(() => service.getPaperOutline({ paperId: outline.paperId, rootId: indexed.root.id }))).toBe(
      'PAPER_NOT_FOUND'
    )
    expect(
      errorCode(() =>
        service.readPaperSections({
          paperId: outline.paperId,
          rootId: indexed.root.id,
          revision: outline.revision,
          sectionIndexes: [0]
        })
      )
    ).toBe('PAPER_NOT_FOUND')
    service.close()
  })

  it('does not mutate the SQLite catalog or any indexed source file', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    const indexed = await addResearchRoot(fixture, 'immutable-project', {
      doi: '10.4242/immutable',
      title: 'Immutable Agent Access'
    })
    fixture.closeWriter()
    const sourceBefore = await snapshotFiles(indexed.rootPath)
    const databaseBefore = await fileHash(fixture.databasePath)

    const service = new AgentLibraryService(new LibraryReader(fixture.databasePath))
    const hit = service.searchLibrary({ query: 'immutable agent', rootId: indexed.root.id }).results[0]
    const outline = service.getPaperOutline({ paperId: hit?.paperId })
    service.readPaperSections({ paperId: outline.paperId, revision: outline.revision, sectionIndexes: [1, 2] })
    service.listResearchRoots()
    service.close()

    expect(await fileHash(fixture.databasePath)).toBe(databaseBefore)
    expect(await snapshotFiles(indexed.rootPath)).toEqual(sourceBefore)
  })

  it('requires an existing absolute database and never creates one', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    fixture.closeWriter()
    const missing = join(fixture.sandboxPath, 'missing', 'paperrelay.sqlite3')

    expect(errorCode(() => new LibraryReader('relative.sqlite3'))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => new LibraryReader(missing))).toBe('DATABASE_NOT_FOUND')
  })

  it('rejects newer schemas and arbitrary files without changing them', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    fixture.closeWriter()
    const newerPath = join(fixture.sandboxPath, 'newer.sqlite3')
    const newer = new DatabaseSync(newerPath)
    newer.exec('PRAGMA user_version = 99')
    newer.close()
    const newerBefore = await fileHash(newerPath)

    const arbitraryPath = join(fixture.sandboxPath, 'not-a-database.txt')
    await writeFile(arbitraryPath, 'This is research text, not SQLite.', 'utf8')
    const arbitraryBefore = await fileHash(arbitraryPath)

    expect(errorCode(() => new LibraryReader(newerPath))).toBe('UNSUPPORTED_SCHEMA')
    expect(errorCode(() => new LibraryReader(arbitraryPath))).toBe('INVALID_DATABASE')
    expect(await fileHash(newerPath)).toBe(newerBefore)
    expect(await fileHash(arbitraryPath)).toBe(arbitraryBefore)
  })

  it('opens an untouched schema-v2 catalog without the optional per-document FTS table', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    const indexed = await addResearchRoot(fixture, 'legacy-v2-project', {
      doi: '10.4242/legacy-v2',
      title: 'Legacy V2 Relay Compatibility'
    })
    fixture.closeWriter()
    const legacyWriter = new DatabaseSync(fixture.databasePath)
    legacyWriter.exec('DROP TABLE document_fts')
    legacyWriter.close()

    const service = new AgentLibraryService(new LibraryReader(fixture.databasePath))
    const legacySearch = service.searchLibrary({
      query: 'egacy relay compatibility',
      rootId: indexed.root.id
    })
    expect(legacySearch).toMatchObject({ count: 1, rootId: indexed.root.id })
    expect(legacySearch.results[0]?.snippet).toContain('Legacy V2 Relay Compatibility')
    expect(legacySearch.results[0]?.snippet).not.toContain('‹')
    service.close()

    const inspection = new DatabaseSync(fixture.databasePath, { readOnly: true })
    const table = inspection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_fts'")
      .get()
    inspection.close()
    expect(table).toBeUndefined()
  })

  it('caps metadata arrays and strings independently of section text budgets', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    const indexed = await addResearchRoot(fixture, 'bounded-metadata-project', {
      doi: '10.4242/bounded-metadata',
      title: 'Bounded metadata seed'
    })
    const article = JSON.parse(testArticle({ doi: '10.4242/bounded-metadata' }))
    article.metadata.title = `Bounded ${'title '.repeat(500)}`
    article.metadata.authors = Array.from({ length: 80 }, (_, index) => `Author ${index} ${'x'.repeat(400)}`)
    article.metadata.keywords = Array.from({ length: 80 }, (_, index) => `keyword-${index}-${'x'.repeat(400)}`)
    article.sections[1].heading = 'H'.repeat(2_000)
    article.quality.warnings = Array.from({ length: 80 }, (_, index) => `warning-${index}-${'x'.repeat(2_000)}`)
    article.quality.source_trail = Array.from({ length: 80 }, (_, index) => `source-${index}-${'x'.repeat(2_000)}`)
    article.assets = Array.from({ length: 80 }, (_, index) => ({
      kind: 'figure',
      heading: `Figure ${index}`,
      caption: 'C'.repeat(2_000),
      section: 'Results',
      available: false
    }))
    await writeFile(indexed.articlePath, JSON.stringify(article), 'utf8')
    await fixture.scanner.scan(indexed.root.id)

    const service = new AgentLibraryService(new LibraryReader(fixture.databasePath))
    const search = service.searchLibrary({ query: 'compact abstract' })
    expect(search.metadataTruncated).toBe(true)
    expect(search.results[0]?.title.length).toBeLessThanOrEqual(500)
    expect(search.results[0]?.authors).toHaveLength(20)

    const outline = service.getPaperOutline({ doi: '10.4242/bounded-metadata' })
    expect(outline.truncation).toMatchObject({
      truncated: true,
      omittedAuthors: 60,
      omittedKeywords: 50,
      omittedWarnings: 55,
      omittedSourceTrail: 30,
      omittedAssets: 30
    })
    expect(outline.title.length).toBeLessThanOrEqual(500)
    expect(outline.sections[1]?.heading.length).toBeLessThanOrEqual(300)
    expect(outline.assets.every((asset) => (asset.caption?.length ?? 0) <= 1_000)).toBe(true)

    const read = service.readPaperSections({ paperId: outline.paperId, sectionIndexes: [1], maxCharacters: 100 })
    expect(read.sections[0]?.heading.length).toBeLessThanOrEqual(300)
    expect(read.provenance.sourceTrail).toHaveLength(20)
    expect(read.provenance.omittedSourceTrailCount).toBe(60)
    expect(read.budget).toMatchObject({ returnedCharacters: 82, metadataTruncated: true })
    service.close()
  })

  it('maps unexpected exceptions to INTERNAL_ERROR without leaking internals', () => {
    expect(relayErrorPayload(new Error('private implementation detail'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'PaperRelay encountered an unexpected internal error while serving this read-only request.',
      details: null
    })
  })
})
