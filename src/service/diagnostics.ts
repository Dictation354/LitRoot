import { spawn } from 'node:child_process'
import type { DependencyReport } from '../shared/contracts.js'
import { dependencyRepair } from '../shared/dependency-repair.js'
import { LitRootError } from './errors.js'
import { supportedNode } from '../shared/node-version.js'
import { paperFetchCommandFromEnvironment, type PaperFetchCommand } from './paper-fetch-command.js'

interface CommandResult {
  ok: boolean
  output: string
  reason: string | null
}

function command(executable: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
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

export async function requirePaperFetchProgress(paperFetch: PaperFetchCommand): Promise<void> {
  const result = await command(paperFetch.executable, [...paperFetch.prefixArgs, 'fetch', '--help'])
  if (!result.ok || !/--progress\b/.test(result.output) || !/--control-stdin\b/.test(result.output)) {
    throw new LitRootError('paper_fetch_upgrade_required',
      '请升级 paper-fetch：LitRoot 要求支持 --progress jsonl 和 --control-stdin 的版本。' +
      (result.reason ? ` ${result.reason}` : ''), 409)
  }
}

export async function diagnoseEnvironment(
  runtimeLabel = process.env.LITROOT_RUNTIME_LABEL || '本机'
): Promise<DependencyReport> {
  const paperFetch = paperFetchCommandFromEnvironment()
  const paperFetchResult = await command(
    paperFetch.executable,
    [...paperFetch.prefixArgs, '--version']
  )
  const protocolReason = await requirePaperFetchProgress(paperFetch).then(() => null, (error: Error) => error.message)
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
      ok: paperFetchResult.ok && protocolReason === null,
      version: paperFetchResult.ok ? paperFetchResult.output.split(/\r?\n/, 1)[0] ?? null : null,
      required: '可执行的官方 paper-fetch',
      repairCommand: dependencyRepair.paperFetch,
      reason: paperFetchResult.reason ?? protocolReason
    }
  ]
  return { runtimeLabel, ready: checks.every((check) => check.ok), checks }
}
