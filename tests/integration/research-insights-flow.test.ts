import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { LibraryService } from '../../src/main/application/library-service.js'
import { LibraryDatabase } from '../../src/main/db/library-database.js'
import { RootScanner } from '../../src/main/ingest/scanner.js'

interface Harness {
  sandboxPath: string
  databasePath: string
  database: LibraryDatabase
  scanner: RootScanner
  service: LibraryService
  close(): Promise<void>
}

const harnesses: Harness[] = []

function article(options: {
  doi: string
  title: string
  keyword: string
  result: string
  opportunity: string
  opportunityHeading: 'Limitations' | 'Future work'
  extractionRevision: number
}): string {
  return JSON.stringify({
    doi: options.doi,
    source: 'test',
    metadata: {
      title: options.title,
      authors: ['A Researcher'],
      abstract: `This study investigates ${options.keyword}.`,
      published: '2026-08-20',
      keywords: [options.keyword]
    },
    sections: [
      {
        heading: 'Abstract',
        level: 1,
        kind: 'abstract',
        text: `This study investigates ${options.keyword}.`
      },
      { heading: 'Results', level: 1, kind: 'results', text: options.result },
      {
        heading: options.opportunityHeading,
        level: 1,
        kind: 'body',
        text: options.opportunity
      }
    ],
    references: [],
    assets: [],
    quality: {
      has_fulltext: true,
      has_abstract: true,
      content_kind: 'fulltext',
      warnings: [],
      flags: [],
      source_trail: [],
      token_estimate: 200,
      extraction_revision: options.extractionRevision
    }
  })
}

async function createHarness(): Promise<Harness> {
  const sandboxPath = await mkdtemp(join(tmpdir(), 'paperrelay-insights-'))
  const databasePath = join(sandboxPath, 'state', 'paperrelay.sqlite3')
  const database = new LibraryDatabase(databasePath)
  const scanner = new RootScanner(database)
  const service = new LibraryService(database)
  let closed = false
  const harness: Harness = {
    sandboxPath,
    databasePath,
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

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) {
    await harness.close()
    await rm(harness.sandboxPath, { recursive: true, force: true })
  }
})

describe('research insights backend flow', () => {
  it('preserves root-preferred representations and refreshes revisions after source changes', async () => {
    const harness = await createHarness()
    const firstRootPath = join(harness.sandboxPath, 'project-alpha')
    const secondRootPath = join(harness.sandboxPath, 'project-beta')
    await Promise.all([mkdir(firstRootPath), mkdir(secondRootPath)])
    const firstArticlePath = join(firstRootPath, 'article.json')
    const secondArticlePath = join(secondRootPath, 'article.json')
    await writeFile(firstArticlePath, article({
      doi: '10.7777/scoped-insights',
      title: 'Alpha scoped representation',
      keyword: 'AlphaScopeOnly',
      result: 'We found that AlphaScopeOnly evidence remains inside the first project.',
      opportunity: 'A limitation is that AlphaScopeOnly was evaluated in one region.',
      opportunityHeading: 'Limitations',
      extractionRevision: 1
    }))
    await writeFile(secondArticlePath, article({
      doi: '10.7777/scoped-insights',
      title: 'Beta scoped representation',
      keyword: 'BetaScopeOnly',
      result: 'We found that BetaScopeOnly evidence remains inside the second project.',
      opportunity: 'Future research should validate BetaScopeOnly in additional regions.',
      opportunityHeading: 'Future work',
      extractionRevision: 9
    }))

    const firstRoot = harness.database.registerRoot(await realpath(firstRootPath), 'Alpha project')
    const secondRoot = harness.database.registerRoot(await realpath(secondRootPath), 'Beta project')
    await harness.scanner.scan(firstRoot.id)
    await harness.scanner.scan(secondRoot.id)
    const paperId = harness.service.searchPapers({})[0]?.id
    expect(paperId).toBeTruthy()

    const alphaDigest = harness.service.paperDigest(paperId ?? '', firstRoot.id)
    const betaDigest = harness.service.paperDigest(paperId ?? '', secondRoot.id)
    const globalDigest = harness.service.paperDigest(paperId ?? '')
    expect(alphaDigest.items.some((item) => item.text.includes('AlphaScopeOnly'))).toBe(true)
    expect(alphaDigest.items.some((item) => item.text.includes('BetaScopeOnly'))).toBe(false)
    expect(betaDigest.items.some((item) => item.text.includes('BetaScopeOnly'))).toBe(true)
    expect(betaDigest.items.some((item) => item.text.includes('AlphaScopeOnly'))).toBe(false)
    expect(globalDigest.title).toBe('Beta scoped representation')
    expect(alphaDigest.revision).not.toBe(betaDigest.revision)

    const alphaLandscape = harness.service.researchLandscape({ rootId: firstRoot.id })
    expect(alphaLandscape.rootId).toBe(firstRoot.id)
    expect(alphaLandscape.paperCount).toBe(1)
    expect(alphaLandscape.nodes.some((node) => node.label.includes('BetaScopeOnly'))).toBe(false)
    expect(alphaLandscape.signals.every((signal) => signal.paperIds.length === 1)).toBe(true)

    const unchanged = harness.service.paperDigest(paperId ?? '', firstRoot.id)
    await harness.scanner.scan(firstRoot.id)
    expect(harness.service.paperDigest(paperId ?? '', firstRoot.id)).toEqual(unchanged)

    await writeFile(firstArticlePath, article({
      doi: '10.7777/scoped-insights',
      title: 'Alpha scoped representation revised',
      keyword: 'AlphaScopeOnly',
      result: 'We found that RevisedAlphaOnly evidence changes after an authoritative rescan.',
      opportunity: 'A limitation is that RevisedAlphaOnly was evaluated in one region.',
      opportunityHeading: 'Limitations',
      extractionRevision: 2
    }))
    await harness.scanner.scan(firstRoot.id)
    const revised = harness.service.paperDigest(paperId ?? '', firstRoot.id)
    expect(revised.revision).not.toBe(alphaDigest.revision)
    expect(revised.items.some((item) => item.text.includes('RevisedAlphaOnly'))).toBe(true)
    expect(revised.items.some((item) => item.text.includes('BetaScopeOnly'))).toBe(false)

    const schema = new DatabaseSync(harness.databasePath, { readOnly: true })
    expect(Number((schema.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(2)
    expect(schema.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'insight%'").all()).toEqual([])
    schema.close()
  })

  it('bounds landscape paper selection and reports omitted scope members', async () => {
    const harness = await createHarness()
    const rootPath = join(harness.sandboxPath, 'bounded-project')
    await mkdir(rootPath)
    for (let index = 0; index < 3; index += 1) {
      const path = join(rootPath, `article-${index}.json`)
      await writeFile(path, article({
        doi: `10.8888/bounded-${index}`,
        title: `Bounded paper ${index}`,
        keyword: 'Bounded landscape',
        result: `We found that bounded result ${index} remains deterministic.`,
        opportunity: `Future research should validate bounded result ${index} in another corpus.`,
        opportunityHeading: 'Future work',
        extractionRevision: 1
      }))
    }
    const root = harness.database.registerRoot(await realpath(rootPath), 'Bounded project')
    await harness.scanner.scan(root.id)

    const landscape = harness.service.researchLandscape({ rootId: root.id, limit: 1 })
    expect(landscape).toMatchObject({
      rootId: root.id,
      paperCount: 3,
      analyzedPaperCount: 1,
      truncation: { truncated: true, omittedPaperCount: 2 }
    })
    expect(landscape.nodes.filter((node) => node.kind === 'paper')).toHaveLength(1)
    expect(() => harness.service.researchLandscape({ rootId: 'root-missing' })).toThrow(/no longer registered/i)
  })
})
