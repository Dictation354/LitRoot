import { describe, expect, it } from 'vitest'
import { LibraryDatabase } from '../../src/main/db/library-database.js'
import type { CandidateFile, NormalizedDocument } from '../../src/main/domain.js'

function candidate(path: string): CandidateFile {
  return {
    path,
    canonicalPath: path,
    relativePath: path.split('/').pop() ?? path,
    size: 100,
    modifiedAt: '2026-08-19T00:00:00.000Z',
    fingerprint: 'v3:100:1'
  }
}

function document(doi: string, title: string, bodyText: string): NormalizedDocument {
  return {
    doi,
    title,
    authors: ['Ada Researcher'],
    abstract: `${title} abstract`,
    journal: 'Journal of Batched Indexing',
    published: '2026-08-19',
    year: '2026',
    keywords: [],
    source: 'test',
    contentKind: 'fulltext',
    hasFulltext: true,
    confidence: 'high',
    warnings: [],
    flags: [],
    sourceTrail: [],
    tokenEstimate: 100,
    extractionRevision: 1,
    sections: [{ heading: 'Results', level: 1, kind: 'results', text: bodyText }],
    assets: [],
    references: [],
    bodyText,
    detector: 'article-json'
  }
}

describe('LibraryDatabase scan batching', () => {
  it('publishes each completed root without waiting for another root scan', () => {
    const database = new LibraryDatabase(':memory:')
    try {
      const rootOne = database.registerRoot('/tmp/paperrelay-root-one', 'Root One')
      const rootTwo = database.registerRoot('/tmp/paperrelay-root-two', 'Root Two')
      const firstRun = database.beginScan(rootOne.id)
      const secondRun = database.beginScan(rootTwo.id)
      database.upsertDocument(
        rootOne.id,
        firstRun.id,
        candidate('/tmp/paperrelay-root-one/article.json'),
        document('10.5555/root-one', 'Root One Paper', 'RootOneSearchOnly')
      )
      database.upsertDocument(
        rootTwo.id,
        secondRun.id,
        candidate('/tmp/paperrelay-root-two/article.json'),
        document('10.5555/root-two', 'Root Two Paper', 'RootTwoSearchOnly')
      )

      database.finishScan(firstRun.id, {
        discovered: 1,
        indexed: 1,
        unchanged: 0,
        issues: 0,
        removed: 0
      })

      expect(database.searchPapers({ query: 'RootOneSearchOnly' })).toHaveLength(1)
      expect(database.searchPapers({ query: 'RootTwoSearchOnly' })).toEqual([])

      database.finishScan(secondRun.id, {
        discovered: 1,
        indexed: 1,
        unchanged: 0,
        issues: 0,
        removed: 0
      })
      expect(database.searchPapers({ query: 'RootTwoSearchOnly' })).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it('rolls back a grouped write when one action fails', () => {
    const database = new LibraryDatabase(':memory:')
    try {
      expect(() =>
        database.writeBatch(() => {
          database.rememberIgnored('/tmp/paperrelay-ignored.json', 'v3:1:1')
          throw new Error('stop the batch')
        })
      ).toThrow('stop the batch')
      expect(database.ignoredFingerprint('/tmp/paperrelay-ignored.json')).toBeNull()
    } finally {
      database.close()
    }
  })

  it('publishes consistent partial work when a scan is cancelled', () => {
    const database = new LibraryDatabase(':memory:')
    try {
      const root = database.registerRoot('/tmp/paperrelay-cancelled-root', 'Cancelled Root')
      const run = database.beginScan(root.id)
      database.upsertDocument(
        root.id,
        run.id,
        candidate('/tmp/paperrelay-cancelled-root/article.json'),
        document('10.5555/cancelled-scan', 'Retained Partial Paper', 'CancelledScanSearchOnly')
      )

      expect(database.searchPapers({ query: 'CancelledScanSearchOnly' })).toEqual([])
      database.cancelScan(run.id)

      expect(database.searchPapers({ query: 'CancelledScanSearchOnly' })).toHaveLength(1)
      expect(database.listRoots()[0]).toMatchObject({ id: root.id, status: 'ready', error: null })
    } finally {
      database.close()
    }
  })
})
