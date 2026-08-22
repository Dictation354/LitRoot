import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LibraryDatabase } from '../../src/main/db/library-database.js'
import { RootScanner } from '../../src/main/ingest/scanner.js'
import { validateRootPath } from '../../src/main/ingest/walk.js'

const databasePath = process.env.PAPERRELAY_CORPUS_DATABASE
const rootPaths = JSON.parse(process.env.PAPERRELAY_CORPUS_ROOTS ?? '[]') as string[]
const run = databasePath && rootPaths.length > 0 ? describe : describe.skip

run('authorized real-corpus smoke test', () => {
  it('indexes and queries the configured roots', async () => {
    const database = new LibraryDatabase(resolve(databasePath ?? 'paperrelay-corpus.sqlite3'))
    const scanner = new RootScanner(database)
    const metrics: Array<Record<string, unknown>> = []
    const rootIds: string[] = []

    try {
      for (const rootPath of rootPaths) {
        const canonicalPath = await validateRootPath(rootPath)
        const root = database.registerRoot(canonicalPath, canonicalPath.split('/').pop() ?? canonicalPath)
        rootIds.push(root.id)
        const startedAt = performance.now()
        const scan = await scanner.scan(root.id)
        metrics.push({ root: root.label, durationMs: Math.round(performance.now() - startedAt), ...scan })
      }

      const searchStartedAt = performance.now()
      const papers = database.searchPapers({ limit: 500 })
      const searchDurationMs = Math.round(performance.now() - searchStartedAt)
      const summary = database.summary()
      const paginationStartedAt = performance.now()
      const pagedPaperIds: string[] = []
      for (let offset = 0; offset < summary.paperCount; offset += 200) {
        const page = database.searchPapers({ sort: 'title', limit: 200, offset })
        pagedPaperIds.push(...page.map((paper) => paper.id))
      }
      const paginationDurationMs = Math.round(performance.now() - paginationStartedAt)
      const rootSearches = rootIds.flatMap((rootId) =>
        ['InSAR', 'phase linking', 'full resolution', 'permafrost'].map((query) => {
          const startedAt = performance.now()
          const results = database.searchPapers({ rootId, query, limit: 20 })
          return {
            rootId,
            query,
            durationMs: Math.round(performance.now() - startedAt),
            returned: results.length
          }
        })
      )
      const inspection = new DatabaseSync(resolve(databasePath ?? 'paperrelay-corpus.sqlite3'), {
        readOnly: true
      })
      const counts = inspection
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM documents) AS documents,
             (SELECT COUNT(*) FROM ignored_files) AS ignored,
             (SELECT COUNT(*) FROM paper_fts) AS indexed_papers,
             (SELECT COUNT(*) FROM document_fts) AS indexed_documents`
        )
        .get()
      inspection.close()

      console.log(
        JSON.stringify({
          metrics,
          searchDurationMs,
          returned: papers.length,
          paginationDurationMs,
          pagedPapers: pagedPaperIds.length,
          rootSearches,
          summary,
          counts
        })
      )
      expect(summary.rootCount).toBe(rootPaths.length)
      expect(summary.paperCount).toBeGreaterThan(0)
      expect(papers.length).toBeGreaterThan(0)
      expect(pagedPaperIds).toHaveLength(summary.paperCount)
      expect(new Set(pagedPaperIds).size).toBe(summary.paperCount)
    } finally {
      database.close()
    }
  }, 180_000)
})
