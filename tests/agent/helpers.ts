import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, opendir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { LibraryDatabase } from '../../src/main/db/library-database.js'
import { RootScanner } from '../../src/main/ingest/scanner.js'
import type { RootSummary } from '../../src/shared/contracts.js'

export interface AgentFixture {
  sandboxPath: string
  databasePath: string
  writer: LibraryDatabase
  scanner: RootScanner
  roots: RootSummary[]
  closeWriter(): void
  cleanup(): Promise<void>
}

export interface TestArticleOptions {
  doi?: string
  title?: string
  body?: string
  warning?: string | null
  published?: string
}

export interface FileSnapshot {
  contentHash: string
  size: number
  modifiedAtMs: number
}

export function testArticle(options: TestArticleOptions = {}): string {
  const body = options.body ?? 'Mitochondrial quality control preserves proteostasis in aging cells.'
  const warning = options.warning ?? null
  return JSON.stringify(
    {
      doi: options.doi ?? '10.4242/agent-relay',
      source: 'elsevier_xml',
      metadata: {
        title: options.title ?? 'Agent Relay for Structured Research',
        authors: ['Ada Researcher', 'Lin Scientist'],
        abstract: 'A compact abstract about local research infrastructure.',
        journal: 'Journal of Local Research Systems',
        published: options.published ?? '2026-08-19',
        keywords: ['agents', 'research infrastructure']
      },
      sections: [
        {
          heading: 'Abstract',
          level: 1,
          kind: 'abstract',
          text: 'A compact abstract about local research infrastructure.'
        },
        {
          heading: 'Methods',
          level: 1,
          kind: 'methods',
          text: 'We indexed structured papers with deterministic identifiers and read-only queries.'
        },
        { heading: 'Results', level: 1, kind: 'results', text: body }
      ],
      references: [{ raw: 'A Reference. 2025.', doi: '10.4242/reference', year: '2025' }],
      assets: [
        {
          kind: 'figure',
          heading: 'Figure 1',
          caption: 'The read-only Agent Relay flow.',
          section: 'Results',
          url: 'https://example.test/figure-1.png',
          available: false
        }
      ],
      quality: {
        has_fulltext: true,
        has_abstract: true,
        content_kind: 'fulltext',
        confidence: 'high',
        warnings: warning ? [warning] : [],
        flags: ['structured-fulltext'],
        source_trail: ['provider:elsevier_xml', 'extract:structured'],
        token_estimate: Math.ceil(body.length / 4) + 100,
        extraction_revision: 4
      }
    },
    null,
    2
  )
}

export async function createAgentFixture(): Promise<AgentFixture> {
  const sandboxPath = await mkdtemp(join(tmpdir(), 'paperrelay-agent-'))
  const databasePath = join(sandboxPath, 'state', 'paperrelay.sqlite3')
  const writer = new LibraryDatabase(databasePath)
  const scanner = new RootScanner(writer)
  const roots: RootSummary[] = []
  let writerClosed = false
  return {
    sandboxPath,
    databasePath,
    writer,
    scanner,
    roots,
    closeWriter(): void {
      if (writerClosed) return
      writerClosed = true
      writer.close()
    },
    async cleanup(): Promise<void> {
      if (!writerClosed) writer.close()
      writerClosed = true
      await rm(sandboxPath, { recursive: true, force: true })
    }
  }
}

export async function addResearchRoot(
  fixture: AgentFixture,
  name: string,
  articleOptions: TestArticleOptions,
  articleRelativePath = 'papers/article.json'
): Promise<{ root: RootSummary; rootPath: string; articlePath: string }> {
  const rootPath = join(fixture.sandboxPath, name)
  const articlePath = join(rootPath, articleRelativePath)
  await mkdir(join(articlePath, '..'), { recursive: true })
  await writeFile(articlePath, testArticle(articleOptions), 'utf8')
  const root = fixture.writer.registerRoot(await realpath(rootPath), basename(rootPath))
  fixture.roots.push(root)
  await fixture.scanner.scan(root.id)
  return { root, rootPath, articlePath }
}

export async function snapshotFiles(rootPath: string): Promise<Record<string, FileSnapshot>> {
  const result: Record<string, FileSnapshot> = {}
  const visit = async (directory: string): Promise<void> => {
    const entries = await opendir(directory)
    for await (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        const [content, info] = await Promise.all([readFile(path), stat(path)])
        result[relative(rootPath, path)] = {
          contentHash: createHash('sha256').update(content).digest('hex'),
          size: info.size,
          modifiedAtMs: info.mtimeMs
        }
      }
    }
  }
  await visit(rootPath)
  return result
}

export async function fileHash(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}
