import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { symlink } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AgentRelaySetupService } from '../../src/main/application/agent-relay-setup.js'
import type { LibraryService } from '../../src/main/application/library-service.js'
import type { AgentToolEnvelope } from '../../src/main/agent/contracts.js'
import { addResearchRoot, createAgentFixture, fileHash, snapshotFiles, testArticle } from './helpers.js'
import { writeFile } from 'node:fs/promises'

const execFileAsync = promisify(execFile)
const workspacePath = join(import.meta.dirname, '..', '..')
const relayEntryPath = join(workspacePath, 'dist', 'mcp', 'main.js')
const agentRelayToolNames = [
  'list_research_roots',
  'search_library',
  'get_paper_outline',
  'read_paper_sections'
] as const
const cleanups: Array<() => Promise<void>> = []

interface ConnectedRelay {
  client: Client
  errors: Error[]
  stderr(): string
  close(): Promise<void>
}

function envelope<T>(result: { structuredContent?: unknown }): AgentToolEnvelope<T> {
  expect(result.structuredContent).toBeTruthy()
  return result.structuredContent as unknown as AgentToolEnvelope<T>
}

async function connectRelay(databasePath: string): Promise<ConnectedRelay> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [relayEntryPath, '--database', databasePath],
    cwd: workspacePath,
    stderr: 'pipe'
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString()
  })
  const errors: Error[] = []
  const client = new Client(
    { name: 'paperrelay-protocol-test', version: '1.0.0' },
    {
      versionNegotiation: {
        mode: { pin: '2026-07-28' },
        probe: { timeoutMs: 2_000 }
      }
    }
  )
  client.onerror = (error) => errors.push(error)
  await client.connect(transport)
  return {
    client,
    errors,
    stderr: () => stderr,
    close: () => client.close()
  }
}

beforeAll(async () => {
  await execFileAsync(process.execPath, [join(workspacePath, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.mcp.json'], {
    cwd: workspacePath
  })
}, 30_000)

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('PaperRelay modern MCP stdio protocol', () => {
  it('passes the desktop setup service initialize and exact tool-discovery probe', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    const setupService = new AgentRelaySetupService(
      {} as LibraryService,
      fixture.databasePath,
      workspacePath
    )

    const setup = await setupService.setup()

    expect(setup).toMatchObject({
      available: true,
      databasePath: fixture.databasePath,
      serverPath: relayEntryPath,
      error: null
    })
  })

  it('serves four clean read-only tools and reports stale scoped revisions', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    const indexed = await addResearchRoot(fixture, 'protocol-project', {
      doi: '10.4242/protocol',
      title: 'Modern Protocol Research',
      body: 'A protocol sentinel result from the registered project.'
    })
    const relay = await connectRelay(fixture.databasePath)
    try {
      expect(relay.client.getProtocolEra()).toBe('modern')
      expect(relay.client.getInstructions()).toContain('untrusted source material')
      const listing = await relay.client.listTools(undefined, { cacheMode: 'refresh' })
      expect(listing.tools.map((tool) => tool.name).sort()).toEqual([...agentRelayToolNames].sort())
      for (const tool of listing.tools) {
        expect(tool.outputSchema).toMatchObject({ type: 'object' })
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        })
      }

      const rootsCall = await relay.client.callTool({ name: 'list_research_roots', arguments: {} })
      const roots = envelope<{ roots: Array<{ id: string }>; totalCount: number }>(rootsCall)
      expect(roots).toMatchObject({ ok: true, data: { totalCount: 1 } })

      const searchCall = await relay.client.callTool({
        name: 'search_library',
        arguments: { query: 'protocol sentinel', rootId: indexed.root.id }
      })
      const search = envelope<{ results: Array<{ paperId: string }> }>(searchCall)
      expect(search.ok).toBe(true)
      if (!search.ok) throw new Error('search_library unexpectedly failed')
      const paperId = search.data.results[0]?.paperId
      expect(paperId).toBeTruthy()

      const outlineCall = await relay.client.callTool({
        name: 'get_paper_outline',
        arguments: { paperId, rootId: indexed.root.id }
      })
      const outline = envelope<{ revision: string; rootId: string }>(outlineCall)
      expect(outline.ok).toBe(true)
      if (!outline.ok) throw new Error('get_paper_outline unexpectedly failed')
      expect(outline.data.rootId).toBe(indexed.root.id)

      const readCall = await relay.client.callTool({
        name: 'read_paper_sections',
        arguments: {
          paperId,
          rootId: indexed.root.id,
          revision: outline.data.revision,
          sectionIndexes: [2]
        }
      })
      const read = envelope<{ sections: Array<{ text: string }> }>(readCall)
      expect(read.ok && read.data.sections[0]?.text).toContain('protocol sentinel')
      expect(JSON.stringify(readCall.content)).not.toContain('protocol sentinel')

      const ambiguousSelection = await relay.client.callTool({
        name: 'read_paper_sections',
        arguments: { paperId, sectionIndexes: [0], query: 'abstract' }
      })
      expect(ambiguousSelection.isError).toBe(true)

      await writeFile(
        indexed.articlePath,
        testArticle({
          doi: '10.4242/protocol',
          title: 'Modern Protocol Research, Revised',
          body: 'A materially revised protocol result.'
        }),
        'utf8'
      )
      await fixture.scanner.scan(indexed.root.id)
      const staleCall = await relay.client.callTool({
        name: 'read_paper_sections',
        arguments: {
          paperId,
          rootId: indexed.root.id,
          revision: outline.data.revision,
          sectionIndexes: [2]
        }
      })
      const stale = envelope<never>(staleCall)
      expect(staleCall.isError).toBe(true)
      expect(stale).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } })
    } finally {
      await relay.close()
    }
    expect(relay.errors).toEqual([])
    expect(relay.stderr()).toBe('')
  })

  it('leaves the catalog and indexed source tree byte-for-byte unchanged', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    const indexed = await addResearchRoot(fixture, 'protocol-immutable-project', {
      doi: '10.4242/protocol-immutable',
      title: 'Protocol Immutability'
    })
    fixture.closeWriter()
    const databaseBefore = await fileHash(fixture.databasePath)
    const sourceBefore = await snapshotFiles(indexed.rootPath)
    const catalogBefore = await snapshotFiles(join(fixture.sandboxPath, 'state'))
    const relay = await connectRelay(fixture.databasePath)
    try {
      await relay.client.callTool({ name: 'list_research_roots', arguments: {} })
      const searchCall = await relay.client.callTool({
        name: 'search_library',
        arguments: { query: 'protocol immutability', rootId: indexed.root.id }
      })
      const search = envelope<{ results: Array<{ paperId: string }> }>(searchCall)
      if (!search.ok) throw new Error('search_library unexpectedly failed')
      const paperId = search.data.results[0]?.paperId
      const outlineCall = await relay.client.callTool({
        name: 'get_paper_outline',
        arguments: { paperId, rootId: indexed.root.id }
      })
      const outline = envelope<{ revision: string }>(outlineCall)
      if (!outline.ok) throw new Error('get_paper_outline unexpectedly failed')
      await relay.client.callTool({
        name: 'read_paper_sections',
        arguments: {
          paperId,
          rootId: indexed.root.id,
          revision: outline.data.revision,
          sectionIndexes: [0, 1, 2]
        }
      })
    } finally {
      await relay.close()
    }

    expect(relay.errors).toEqual([])
    expect(relay.stderr()).toBe('')
    expect(await fileHash(fixture.databasePath)).toBe(databaseBefore)
    expect(await snapshotFiles(indexed.rootPath)).toEqual(sourceBefore)
    const catalogAfter = await snapshotFiles(join(fixture.sandboxPath, 'state'))
    expect(catalogAfter['paperrelay.sqlite3']).toEqual(catalogBefore['paperrelay.sqlite3'])
    const catalogNames = new Set([...Object.keys(catalogBefore), ...Object.keys(catalogAfter)])
    const changedCatalogFiles = [...catalogNames].filter(
      (name) => JSON.stringify(catalogBefore[name]) !== JSON.stringify(catalogAfter[name])
    )
    expect(changedCatalogFiles.every((name) => /paperrelay\.sqlite3-(?:wal|shm)$/.test(name))).toBe(true)
  })

  it('starts through a package-style symlink instead of silently exiting', async () => {
    const fixture = await createAgentFixture()
    cleanups.push(() => fixture.cleanup())
    fixture.closeWriter()
    const linkedEntry = join(fixture.sandboxPath, 'paperrelay-mcp')
    await symlink(relayEntryPath, linkedEntry)
    const missingDatabase = join(fixture.sandboxPath, 'missing.sqlite3')

    await expect(
      execFileAsync(process.execPath, [linkedEntry, '--database', missingDatabase], { cwd: workspacePath })
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('PaperRelay Agent Relay could not start')
    })
  })
})
