import { spawn } from 'node:child_process'
import type { DependencyReport } from '../shared/contracts.js'
import { dependencyRepair } from '../shared/dependency-repair.js'
import { LitRootError } from './errors.js'
import { supportedNode } from '../shared/node-version.js'
import { paperFetchCommandFromEnvironment, paperFetchEnvironment, type PaperFetchCommand } from './paper-fetch-command.js'

interface CommandResult {
  ok: boolean
  output: string
  reason: string | null
}

function command(paperFetch: PaperFetchCommand, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(paperFetch.executable, [...paperFetch.prefixArgs, ...args], {
      env: paperFetchEnvironment(paperFetch), shell: false, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let error = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output = `${output}${chunk}`.slice(-40_000) })
    child.stderr.on('data', (chunk: string) => { error = `${error}${chunk}`.slice(-40_000) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    timer.unref()
    child.once('error', (spawnError) => {
      clearTimeout(timer)
      resolve({ ok: false, output: '', reason: spawnError.message })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: code === 0,
        output: (output || error).trim(),
        reason: code === 0 ? null : (error.trim() || `退出码 ${code}`)
      })
    })
  })
}

export const minimumPaperFetchVersion = '7.0.1'

export function supportedPaperFetchVersion(output: string): boolean {
  const match = /^paper-fetch (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(output.trim())
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number]
  if (![major, minor, patch].every(Number.isSafeInteger)) return false
  return major > 7 || (major === 7 && (minor > 0 || patch >= 1))
}

async function compatibility(paperFetch: PaperFetchCommand): Promise<{ version: string | null; reason: string | null }> {
  const version = await command(paperFetch, ['--version'])
  const required = `请升级 paper-fetch：LitRoot 要求 ${minimumPaperFetchVersion} 或更高正式版本，并支持 --progress jsonl 和 --control-stdin。`
  if (!version.ok || !supportedPaperFetchVersion(version.output)) {
    return { version: version.ok ? version.output : null, reason: `${required} 检测结果：${version.reason ?? version.output}` }
  }
  const help = await command(paperFetch, ['fetch', '--help'])
  const supported = help.ok && /--progress\b[\s\S]*?\bjsonl\b/.test(help.output) && /--control-stdin\b/.test(help.output)
  return { version: version.output, reason: supported ? null : `${required}${help.reason ? ` ${help.reason}` : ''}` }
}

export async function requirePaperFetchProgress(paperFetch: PaperFetchCommand): Promise<void> {
  const result = await compatibility(paperFetch)
  if (result.reason) throw new LitRootError('paper_fetch_upgrade_required', result.reason, 409)
}

/** Help lookup is advisory: a missing auth capability must never block archival. */
export async function paperFetchAuthCommand(paperFetch: PaperFetchCommand, provider: string): Promise<string | null> {
  if (!/^[a-z][a-z0-9_]*$/.test(provider)) return null
  try {
    const result = await command(paperFetch, ['auth', '--help'])
    if (!result.ok) return null
    const positional = result.output.split(/positional arguments:/i)[1]?.split(/options:|optional arguments:/i)[0]
    const choices = positional?.match(/\{([a-z0-9_,\s]+)\}/)?.[1]?.split(',').map((value) => value.trim()) ?? []
    return choices.includes(provider) ? `paper-fetch auth ${provider}` : null
  } catch {
    return null
  }
}

export async function diagnoseEnvironment(
  runtimeLabel = process.env.LITROOT_RUNTIME_LABEL || '本机'
): Promise<DependencyReport> {
  const paperFetch = paperFetchCommandFromEnvironment()
  const paperFetchResult = await compatibility(paperFetch)
  const nodeVersion = process.version
  const checks: DependencyReport['checks'] = [
    {
      name: 'node',
      ok: supportedNode(nodeVersion),
      version: nodeVersion,
      required: '24.15+',
      repairCommand: dependencyRepair.node,
      reason: supportedNode(nodeVersion) ? null : 'LitRoot 服务要求 Node.js 24.15 或更高的 24.x 版本。'
    },
    {
      name: 'paper-fetch',
      ok: paperFetchResult.reason === null,
      version: paperFetchResult.version,
      required: `${minimumPaperFetchVersion}+ 正式版本；--progress jsonl / --control-stdin`,
      repairCommand: dependencyRepair.paperFetch,
      reason: paperFetchResult.reason
    }
  ]
  return { runtimeLabel, ready: checks.every((check) => check.ok), checks }
}
