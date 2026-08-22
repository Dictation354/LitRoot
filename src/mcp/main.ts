#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'
import { AgentLibraryService } from '../main/agent/agent-library-service.js'
import { AgentRelayError } from '../main/agent/errors.js'
import { LibraryReader } from '../main/agent/library-reader.js'
import { createPaperRelayMcpServer } from './server.js'

const USAGE = 'Usage: paperrelay-mcp --database /absolute/path/to/paperrelay.sqlite3'

export function resolveDatabaseArgument(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env
): string {
  let databasePath: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--database') {
      const value = args[index + 1]
      if (!value) throw new AgentRelayError('INVALID_ARGUMENT', `${USAGE}\n--database requires a path.`)
      databasePath = value
      index += 1
      continue
    }
    if (argument?.startsWith('--database=')) {
      databasePath = argument.slice('--database='.length)
      continue
    }
    throw new AgentRelayError('INVALID_ARGUMENT', `${USAGE}\nUnknown argument: ${argument ?? ''}`)
  }
  databasePath ??= environment.PAPERRELAY_DATABASE?.trim() || null
  if (!databasePath) {
    throw new AgentRelayError(
      'INVALID_ARGUMENT',
      `${USAGE}\nSet --database or PAPERRELAY_DATABASE; PaperRelay will not guess or create a database.`
    )
  }
  if (!isAbsolute(databasePath)) {
    throw new AgentRelayError('INVALID_ARGUMENT', `${USAGE}\nThe database path must be absolute.`, {
      databasePath
    })
  }
  return databasePath
}

export function startAgentRelay(databasePath: string): {
  service: AgentLibraryService
  handle: StdioServerHandle
} {
  const service = new AgentLibraryService(new LibraryReader(databasePath))
  const handle = serveStdio(() => createPaperRelayMcpServer(service), {
    legacy: 'serve',
    onerror: (error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`)
    }
  })
  return { service, handle }
}

export async function runAgentRelay(args: string[] = process.argv.slice(2)): Promise<void> {
  const databasePath = resolveDatabaseArgument(args)
  const { service, handle } = startAgentRelay(databasePath)
  let stopping: Promise<void> | null = null
  const stop = (exitCode = 0): Promise<void> => {
    stopping ??= (async () => {
      try {
        await handle.close()
      } finally {
        service.close()
        process.exitCode = exitCode
      }
    })()
    return stopping
  }

  process.stdin.once('end', () => void stop())
  process.once('SIGINT', () => void stop(130))
  process.once('SIGTERM', () => void stop(143))
}

function isDirectEntry(): boolean {
  if (!process.argv[1]) return false
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectEntry()) {
  void runAgentRelay().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`PaperRelay Agent Relay could not start: ${message}\n`)
    process.exitCode = 1
  })
}
