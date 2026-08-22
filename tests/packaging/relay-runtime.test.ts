import { isAbsolute, join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { describe, expect, it } from 'vitest'
import { addResearchRoot, createAgentFixture } from '../agent/helpers.js'

const workspacePath = join(import.meta.dirname, '..', '..')
const relayCommand = process.env.PAPERRELAY_RELAY_COMMAND?.trim() || null
const relayPrefixArguments = JSON.parse(process.env.PAPERRELAY_RELAY_PREFIX_ARGS ?? '[]') as unknown

function validatedArguments(): string[] {
  if (!Array.isArray(relayPrefixArguments) || relayPrefixArguments.some((value) => typeof value !== 'string')) {
    throw new Error('PAPERRELAY_RELAY_PREFIX_ARGS must be a JSON array of strings.')
  }
  return relayPrefixArguments
}

const packagedRelay = describe.runIf(relayCommand !== null)

packagedRelay('packaged Agent Relay runtime', () => {
  it('starts without PATH Node and exposes the exact read-only protocol', async () => {
    if (!relayCommand || !isAbsolute(relayCommand)) {
      throw new Error('PAPERRELAY_RELAY_COMMAND must be an absolute executable path.')
    }
    const fixture = await createAgentFixture()
    const indexed = await addResearchRoot(fixture, 'packaged-relay-project', {
      doi: '10.4242/packaged-relay',
      title: 'Packaged Relay Runtime',
      body: 'A packaged relay sentinel proves that the selected runtime can read the catalog.'
    })
    const environment = getDefaultEnvironment()
    environment.PATH = ''
    if (process.env.PAPERRELAY_RELAY_ELECTRON_RUN_AS_NODE === '1') {
      environment.ELECTRON_RUN_AS_NODE = '1'
    }
    const transport = new StdioClientTransport({
      command: relayCommand,
      args: [...validatedArguments(), '--database', fixture.databasePath],
      cwd: workspacePath,
      env: environment,
      stderr: 'pipe'
    })
    const client = new Client(
      { name: 'paperrelay-packaged-runtime-test', version: '1.0.0' },
      {
        versionNegotiation: {
          mode: { pin: '2026-07-28' },
          probe: { timeoutMs: 2_000 }
        }
      }
    )

    try {
      await client.connect(transport)
      const tools = await client.listTools(undefined, { cacheMode: 'refresh' })
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'get_paper_outline',
        'list_research_roots',
        'read_paper_sections',
        'search_library'
      ])
      expect(
        tools.tools.every(
          (tool) =>
            tool.annotations?.readOnlyHint === true &&
            tool.annotations.destructiveHint === false &&
            tool.annotations.idempotentHint === true &&
            tool.annotations.openWorldHint === false
        )
      ).toBe(true)
      const result = await client.callTool({
        name: 'search_library',
        arguments: { query: 'packaged relay sentinel', rootId: indexed.root.id }
      })
      expect(JSON.stringify(result.structuredContent)).toContain('Packaged Relay Runtime')
    } finally {
      await client.close().catch(() => undefined)
      await fixture.cleanup()
    }
  }, 20_000)
})
