import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentRelaySetupService,
  probeAgentRelay,
  type AgentRelayProbe,
  type AgentRelaySetupOptions,
  type AgentRelayRuntime
} from '../../src/main/application/agent-relay-setup.js'
import type { LibraryService } from '../../src/main/application/library-service.js'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

async function fixture(
  probe: AgentRelayProbe = async () => {},
  options: AgentRelaySetupOptions = {}
): Promise<{
  service: AgentRelaySetupService
  appPath: string
  databasePath: string
}> {
  const appPath = await mkdtemp(join(tmpdir(), 'paperrelay-relay-setup-'))
  temporaryPaths.push(appPath)
  const serverPath = options.runtime?.serverPath ?? join(appPath, 'dist', 'mcp', 'main.js')
  await mkdir(dirname(serverPath), { recursive: true })
  await writeFile(serverPath, '// test relay entry\n')
  const databasePath = join(appPath, "catalog's paperrelay.sqlite3")
  const library = {
    getPaper: (paperId: string, rootId?: string) =>
      paperId === 'paper_123'
        ? {
            id: paperId,
            title: rootId ? 'The project-scoped representation' : 'The global representation',
            doi: rootId ? '10.1234/scoped-example' : '10.1234/global-example',
            rootIds: ['root_123']
          }
        : null,
    listRoots: () => [
      {
        id: 'root_123',
        label: 'Cancer Aging'
      }
    ]
  } as unknown as LibraryService
  return {
    service: new AgentRelaySetupService(library, databasePath, appPath, probe, options),
    appPath,
    databasePath
  }
}

describe('AgentRelaySetupService', () => {
  it('builds an exact read-only stdio setup for Codex', async () => {
    const { service, appPath, databasePath } = await fixture()
    const setup = await service.setup()

    expect(setup.available).toBe(true)
    expect(setup.serverPath).toBe(join(appPath, 'dist', 'mcp', 'main.js'))
    expect(setup.databasePath).toBe(databasePath)
    expect(setup.codexConfig).toContain('[mcp_servers.paperrelay]')
    expect(setup.codexConfig).toContain('command = "node"')
    expect(setup.codexConfig).toContain(
      'enabled_tools = ["get_paper_outline", "list_research_roots", "read_paper_sections", "search_library"]'
    )
    expect(setup.codexConfig).toContain('default_tools_approval_mode = "auto"')
    expect(setup.cliCommand).toContain("codex mcp add paperrelay -- 'node'")
    expect(setup.error).toBeNull()
  })

  it('builds a PowerShell-safe packaged setup around Electron-as-Node', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'paperrelay-packaged-relay-'))
    temporaryPaths.push(appPath)
    const serverPath = join(appPath, 'resources', 'relay', 'paperrelay-relay.cjs')
    const runtime: AgentRelayRuntime = {
      command: "C:\\Program Files\\PaperRelay\\PaperRelay.exe",
      prefixArguments: [serverPath],
      serverPath,
      environment: { ELECTRON_RUN_AS_NODE: '1' },
      platform: 'win32'
    }
    let probedRuntime: AgentRelayRuntime | undefined
    const { service, databasePath } = await fixture(
      async (_serverPath, _databasePath, observedRuntime) => {
        probedRuntime = observedRuntime
      },
      { runtime }
    )

    const setup = await service.setup()

    expect(setup.available).toBe(true)
    expect(setup.serverPath).toBe(serverPath)
    expect(setup.codexConfig).toContain(
      'command = "C:\\\\Program Files\\\\PaperRelay\\\\PaperRelay.exe"'
    )
    expect(setup.codexConfig).toContain('env = { "ELECTRON_RUN_AS_NODE" = "1" }')
    expect(setup.codexConfig).toContain(JSON.stringify(databasePath))
    expect(setup.cliCommand).toContain("--env 'ELECTRON_RUN_AS_NODE=1' --")
    expect(setup.cliCommand).toContain("'C:\\Program Files\\PaperRelay\\PaperRelay.exe'")
    expect(probedRuntime).toEqual(runtime)
  })

  it('reports unavailable when the executable cannot complete its startup handshake', async () => {
    const { service } = await fixture(async () => {
      throw new Error('Node.js 24.15 or newer is required.')
    })

    const setup = await service.setup()

    expect(setup.available).toBe(false)
    expect(setup.error).toContain('startup check')
    expect(setup.error).toContain('Node.js 24.15 or newer')
  })

  it('invalidates a ready cache when the relay entry disappears', async () => {
    let probeCalls = 0
    const { service, appPath } = await fixture(async () => {
      probeCalls += 1
    })
    expect((await service.setup()).available).toBe(true)
    await unlink(join(appPath, 'dist', 'mcp', 'main.js'))

    const unavailable = await service.setup()

    expect(unavailable.available).toBe(false)
    expect(unavailable.error).toMatch(/not built yet/i)
    expect(probeCalls).toBe(1)
  })

  it('re-probes when the relay executable is replaced at the same path', async () => {
    let probeCalls = 0
    const { service, appPath } = await fixture(async () => {
      probeCalls += 1
    })
    expect((await service.setup()).available).toBe(true)
    const serverPath = join(appPath, 'dist', 'mcp', 'main.js')
    await unlink(serverPath)
    await writeFile(serverPath, '// replaced relay entry with a new file identity\n')

    expect((await service.setup()).available).toBe(true)
    expect(probeCalls).toBe(2)
  })

  it('coalesces concurrent setup calls into one relay process probe', async () => {
    let probeCalls = 0
    let releaseProbe!: () => void
    const blockedProbe = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const { service } = await fixture(async () => {
      probeCalls += 1
      await blockedProbe
    })

    const first = service.setup()
    const second = service.setup()
    await Promise.resolve()
    expect(probeCalls).toBe(1)
    releaseProbe()

    const [firstSetup, secondSetup] = await Promise.all([first, second])
    expect(firstSetup.available).toBe(true)
    expect(secondSetup).toEqual(firstSetup)
    expect(probeCalls).toBe(1)
  })

  it('rejects non-protocol stdout even if a matching initialize result follows', async () => {
    const { appPath, databasePath } = await fixture()
    const serverPath = join(appPath, 'dist', 'mcp', 'main.js')
    await writeFile(
      serverPath,
      `process.stdin.once('data', () => {
        process.stdout.write('debug output\\n')
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'paperrelay-agent-relay', version: '0.2.0' }
          }
        }) + '\\n')
      })
      process.stdin.resume()
      `,
      'utf8'
    )

    await expect(probeAgentRelay(serverPath, databasePath)).rejects.toThrow(/invalid JSON|non-protocol/i)
  })

  it('rejects a relay whose discovered tools are not the exact read-only surface', async () => {
    const { appPath, databasePath } = await fixture()
    const serverPath = join(appPath, 'dist', 'mcp', 'main.js')
    await writeFile(
      serverPath,
      `let buffered = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => {
        buffered += chunk
        const lines = buffered.split(/\\r?\\n/)
        buffered = lines.pop() || ''
        for (const line of lines) {
          if (!line) continue
          const message = JSON.parse(line)
          if (message.method === 'initialize') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'paperrelay-agent-relay', version: '0.2.0' }
              }
            }) + '\\n')
          } else if (message.method === 'tools/list') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                tools: [{
                  name: 'search_library',
                  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
                }]
              }
            }) + '\\n')
          }
        }
      })
      `,
      'utf8'
    )

    await expect(probeAgentRelay(serverPath, databasePath)).rejects.toThrow(/expected four read-only/i)
  })

  it('rejects the expected tools when any tool is not explicitly idempotent', async () => {
    const { appPath, databasePath } = await fixture()
    const serverPath = join(appPath, 'dist', 'mcp', 'main.js')
    await writeFile(
      serverPath,
      `const toolNames = ${JSON.stringify([
        'get_paper_outline',
        'list_research_roots',
        'read_paper_sections',
        'search_library'
      ])}
      let buffered = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => {
        buffered += chunk
        const lines = buffered.split(/\\r?\\n/)
        buffered = lines.pop() || ''
        for (const line of lines) {
          if (!line) continue
          const message = JSON.parse(line)
          if (message.method === 'initialize') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'paperrelay-agent-relay', version: '0.2.0' }
              }
            }) + '\\n')
          } else if (message.method === 'tools/list') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                tools: toolNames.map((name) => ({
                  name,
                  annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: name !== 'search_library',
                    openWorldHint: false
                  }
                }))
              }
            }) + '\\n')
          }
        }
      })
      `,
      'utf8'
    )

    await expect(probeAgentRelay(serverPath, databasePath)).rejects.toThrow(/expected four read-only/i)
  })

  it('accepts a valid protocol-clean relay that writes diagnostics only to stderr', async () => {
    const { appPath, databasePath } = await fixture()
    const serverPath = join(appPath, 'dist', 'mcp', 'main.js')
    await writeFile(
      serverPath,
      `const toolNames = ${JSON.stringify([
        'get_paper_outline',
        'list_research_roots',
        'read_paper_sections',
        'search_library'
      ])}
      let buffered = ''
      process.stderr.write('relay diagnostic\\n')
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => {
        buffered += chunk
        const lines = buffered.split(/\\r?\\n/)
        buffered = lines.pop() || ''
        for (const line of lines) {
          if (!line) continue
          const message = JSON.parse(line)
          if (message.method === 'initialize') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'paperrelay-agent-relay', version: '0.2.0' }
              }
            }) + '\\n')
          } else if (message.method === 'tools/list') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                tools: toolNames.map((name) => ({
                  name,
                  annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false
                  }
                }))
              }
            }) + '\\n')
          }
        }
      })
      `,
      'utf8'
    )

    await expect(probeAgentRelay(serverPath, databasePath)).resolves.toBeUndefined()
  })

  it('escalates to SIGKILL and waits for a TERM-ignoring timed-out relay to exit', async () => {
    const { appPath, databasePath } = await fixture()
    const serverPath = join(appPath, 'dist', 'mcp', 'main.js')
    await writeFile(
      serverPath,
      `const { writeFileSync } = require('node:fs')
      const databaseIndex = process.argv.indexOf('--database')
      writeFileSync(process.argv[databaseIndex + 1], String(process.pid))
      process.on('SIGTERM', () => {})
      process.stdin.resume()
      setInterval(() => {}, 1000)
      `,
      'utf8'
    )

    await expect(probeAgentRelay(serverPath, databasePath)).rejects.toThrow(/within 3 seconds/i)
    const childPid = Number(await readFile(databasePath, 'utf8'))
    expect(Number.isInteger(childPid)).toBe(true)
    expect(() => process.kill(childPid, 0)).toThrow()
  })

  it('creates stable paper and research-root references without source paths', async () => {
    const { service } = await fixture()

    const paperReference = service.paperReference('paper_123', 'root_123')
    expect(paperReference).toContain('paper_id paper_123')
    expect(paperReference).toContain('Title: "The project-scoped representation"')
    expect(paperReference).toContain('DOI: 10.1234/scoped-example')
    expect(paperReference).not.toContain('global-example')
    expect(paperReference).toContain('root_id: root_123')
    expect(paperReference).toContain(
      'Pass this same root_id to search_library, get_paper_outline, and read_paper_sections.'
    )
    expect(paperReference).toContain('untrusted research data')

    const rootContext = service.rootContext('root_123')
    expect(rootContext).toContain('"Cancer Aging"')
    expect(rootContext).toContain('root_id: root_123')
    expect(rootContext).toContain(
      'Pass this same root_id to search_library, get_paper_outline, and read_paper_sections.'
    )
    expect(rootContext).not.toContain('/Users/')
  })

  it('rejects stale paper and root identifiers', async () => {
    const { service } = await fixture()

    expect(() => service.paperReference('paper_missing')).toThrow(/no longer available/i)
    expect(() => service.rootContext('root_missing')).toThrow(/no longer registered/i)
  })
})
