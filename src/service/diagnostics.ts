import { spawn } from 'node:child_process'
import type { DependencyReport } from '../shared/contracts.js'
import { dependencyRepair } from '../shared/dependency-repair.js'
import { paperFetchCommandFromEnvironment } from './paper-fetch-command.js'

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
    child.stdout.on('data', (chunk: string) => { output = `${output}${chunk}`.slice(-8_000) })
    child.stderr.on('data', (chunk: string) => { error = `${error}${chunk}`.slice(-8_000) })
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

function nodeSupported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return major === 24 && (minor > 15 || (minor === 15 && patch >= 0))
}

export async function diagnoseEnvironment(
  runtimeLabel = process.env.LITROOT_RUNTIME_LABEL || '本机'
): Promise<DependencyReport> {
  const paperFetch = paperFetchCommandFromEnvironment()
  const paperFetchResult = await command(
    paperFetch.executable,
    [...paperFetch.prefixArgs, '--version']
  )
  const nodeVersion = process.version
  const checks: DependencyReport['checks'] = [
    {
      name: 'node',
      ok: nodeSupported(nodeVersion),
      version: nodeVersion,
      required: '24.15+',
      repairCommand: dependencyRepair.node,
      reason: nodeSupported(nodeVersion) ? null : 'LitRoot 服务要求 Node.js 24.15 或更高的 24.x 版本。'
    },
    {
      name: 'paper-fetch',
      ok: paperFetchResult.ok,
      version: paperFetchResult.ok ? paperFetchResult.output.split(/\r?\n/, 1)[0] ?? null : null,
      required: '可执行的官方 paper-fetch',
      repairCommand: dependencyRepair.paperFetch,
      reason: paperFetchResult.reason
    }
  ]
  return { runtimeLabel, ready: checks.every((check) => check.ok), checks }
}
