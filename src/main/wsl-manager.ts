import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { app } from 'electron'
import type { DependencyReport, RuntimeOption, RuntimeTarget, ServiceEvent } from '../shared/contracts.js'
import { runtimeTargetKey } from '../shared/contracts.js'
import { dependencyRepair } from '../shared/dependency-repair.js'
import type { PaperFetchCommand } from '../service/paper-fetch-command.js'
import { LitRootServiceClient } from './service-client.js'
import {
  cleanWslOutput,
  lastOutputLine,
  nodeVersionFromOutput,
  supportedNode,
  wslLoginShellArgs
} from './wsl-shell.js'

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

interface ServiceSession {
  target: RuntimeTarget
  process: ChildProcess
  client: LitRootServiceClient
  eventsController: AbortController
}

function command(executable: string, args: string[], timeout = 15_000): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-1_000_000) })
    child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-1_000_000) })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    timer.unref()
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolveCommand({ code, stdout, stderr })
    })
  })
}

function localRuntimeLabel(): string {
  if (process.platform === 'win32') return 'Windows 本机'
  if (process.platform === 'darwin') return 'macOS 本机'
  return 'Linux 本机'
}

function localFallbackCommand(): PaperFetchCommand {
  return {
    executable: process.platform === 'win32' ? 'paper-fetch-not-configured.exe' : 'paper-fetch',
    prefixArgs: []
  }
}

export async function windowsPaperFetchCommand(path: string): Promise<PaperFetchCommand> {
  const absolute = resolve(path)
  if (/\.exe$/i.test(absolute)) {
    await access(absolute)
    return { executable: absolute, prefixArgs: [] }
  }
  const bin = dirname(absolute)
  const root = dirname(bin)
  if (!/\.cmd$/i.test(absolute) || bin.toLowerCase() !== join(root, 'bin').toLowerCase()) {
    throw new Error('Windows 本机仅支持官方 paper-fetch 安装器或原生 .exe 入口。')
  }
  const python = join(root, 'runtime', 'python.exe')
  await access(python)
  return { executable: python, prefixArgs: ['-X', 'utf8', '-m', 'paper_fetch.cli'] }
}

async function resolveLocalPaperFetch(): Promise<PaperFetchCommand> {
  const configured = process.env.PAPER_FETCH_BIN
  if (process.platform === 'win32') {
    if (configured) return windowsPaperFetchCommand(configured)
    const located = await command('where.exe', ['paper-fetch'])
    if (located.code !== 0) throw new Error(cleanWslOutput(located.stderr) || '找不到 paper-fetch。')
    const candidates = cleanWslOutput(located.stdout).split('\n').map((item) => item.trim()).filter(Boolean)
    const candidate = candidates.find((item) => /\.(?:exe|cmd)$/i.test(item))
    if (!candidate) throw new Error('找不到受支持的 paper-fetch Windows 入口。')
    return windowsPaperFetchCommand(candidate)
  }
  if (configured) {
    if (!isAbsolute(configured)) throw new Error('PAPER_FETCH_BIN 必须是绝对路径。')
    await access(configured)
    return { executable: configured, prefixArgs: [] }
  }
  const shell = process.env.SHELL && isAbsolute(process.env.SHELL)
    ? process.env.SHELL
    : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  const located = await command(shell, ['-lic', 'command -v -- "$1"', 'litroot', 'paper-fetch'])
  const executable = lastOutputLine(located.stdout)
  if (located.code !== 0 || !executable || !isAbsolute(executable)) {
    throw new Error(cleanWslOutput(located.stderr) || '登录 shell 中找不到 paper-fetch。')
  }
  await access(executable)
  return { executable, prefixArgs: [] }
}

export class ServiceRuntimeManager {
  private readonly sessions = new Map<string, ServiceSession>()
  private readonly starts = new Map<string, Promise<LitRootServiceClient>>()
  private readonly startingProcesses = new Set<ChildProcess>()
  private generation = 0

  constructor(private readonly onEvent: (event: ServiceEvent) => void) {}

  async listRuntimes(): Promise<RuntimeOption[]> {
    const local: RuntimeOption = { key: 'local', label: localRuntimeLabel(), target: { kind: 'local' } }
    if (process.platform !== 'win32') return [local]
    try {
      const result = await command('wsl.exe', ['--list', '--quiet'])
      if (result.code !== 0) return [local]
      const distributions = cleanWslOutput(result.stdout).split('\n').map((item) => item.trim()).filter(Boolean)
      return [
        local,
        ...distributions.map((distribution): RuntimeOption => ({
          key: runtimeTargetKey({ kind: 'wsl', distribution }),
          label: `WSL · ${distribution}`,
          target: { kind: 'wsl', distribution }
        }))
      ]
    } catch {
      return [local]
    }
  }

  async diagnose(target: RuntimeTarget): Promise<DependencyReport> {
    await this.assertTarget(target)
    if (target.kind === 'local') {
      const nodeVersion = process.version
      const nodeOk = supportedNode(nodeVersion)
      let paperFetch: CommandResult
      try {
        const descriptor = await resolveLocalPaperFetch()
        paperFetch = await command(descriptor.executable, [...descriptor.prefixArgs, '--version'])
      } catch (error) {
        paperFetch = { code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
      }
      const checks: DependencyReport['checks'] = [
        {
          name: 'node', ok: nodeOk,
          version: nodeVersion, required: 'LitRoot 内置 Node.js 24.15+',
          repairCommand: '', reason: nodeOk ? null : '当前 LitRoot 内置 Node.js 版本不受支持。'
        },
        {
          name: 'paper-fetch', ok: paperFetch.code === 0,
          version: paperFetch.code === 0 ? lastOutputLine(paperFetch.stdout) : null,
          required: '可执行的官方 paper-fetch', repairCommand: dependencyRepair.paperFetch,
          reason: paperFetch.code === 0 ? null : cleanWslOutput(paperFetch.stderr) || 'paper-fetch 不可执行。'
        }
      ]
      return { runtimeLabel: localRuntimeLabel(), ready: checks.every((check) => check.ok), checks }
    }

    const run = (args: string[]): Promise<CommandResult> =>
      command('wsl.exe', wslLoginShellArgs(target.distribution, args))
    const [node, paperFetch] = await Promise.all([
      run(['node', '--version']).catch((error) => ({ code: -1, stdout: '', stderr: String(error) })),
      run(['paper-fetch', '--version']).catch((error) => ({ code: -1, stdout: '', stderr: String(error) }))
    ])
    const nodeVersion = nodeVersionFromOutput(node.stdout)
    const nodeOk = node.code === 0 && supportedNode(nodeVersion)
    const checks: DependencyReport['checks'] = [
      {
        name: 'node', ok: nodeOk, version: nodeVersion, required: '24.15+',
        repairCommand: dependencyRepair.node,
        reason: nodeOk ? null : cleanWslOutput(node.stderr) || '需要 Node.js 24.15+。'
      },
      {
        name: 'paper-fetch', ok: paperFetch.code === 0,
        version: paperFetch.code === 0 ? lastOutputLine(paperFetch.stdout) : null,
        required: '可执行的官方 paper-fetch', repairCommand: dependencyRepair.paperFetch,
        reason: paperFetch.code === 0 ? null : cleanWslOutput(paperFetch.stderr) || 'paper-fetch 不可执行。'
      }
    ]
    return { runtimeLabel: `WSL · ${target.distribution}`, ready: checks.every((check) => check.ok), checks }
  }

  client(target: RuntimeTarget): Promise<LitRootServiceClient> {
    const key = runtimeTargetKey(target)
    const existing = this.sessions.get(key)
    if (existing) return Promise.resolve(existing.client)
    const starting = this.starts.get(key)
    if (starting) return starting
    const generation = this.generation
    const start = this.startClient(target, generation)
    const tracked = start.finally(() => {
      if (this.starts.get(key) === tracked) this.starts.delete(key)
    })
    this.starts.set(key, tracked)
    return tracked
  }

  private async startClient(target: RuntimeTarget, generation: number): Promise<LitRootServiceClient> {
    await this.assertTarget(target)
    this.assertCurrentGeneration(generation)
    const servicePath = await this.servicePath(target)
    this.assertCurrentGeneration(generation)
    const token = randomBytes(32).toString('hex')
    let executable: string
    let args: string[]
    let env: NodeJS.ProcessEnv
    if (target.kind === 'wsl') {
      executable = 'wsl.exe'
      args = wslLoginShellArgs(target.distribution, [
        '/usr/bin/env',
        `LITROOT_SESSION_TOKEN=${token}`,
        `LITROOT_RUNTIME_LABEL=WSL · ${target.distribution}`,
        'node', servicePath
      ])
      env = process.env
    } else {
      const paperFetch = await resolveLocalPaperFetch().catch(localFallbackCommand)
      executable = process.execPath
      args = [servicePath]
      env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        LITROOT_SESSION_TOKEN: token,
        LITROOT_RUNTIME_LABEL: localRuntimeLabel(),
        LITROOT_REGISTRY_PATH: join(app.getPath('userData'), 'local-service-projects.json'),
        PAPER_FETCH_BIN: paperFetch.executable,
        PAPER_FETCH_PREFIX_ARGS: JSON.stringify(paperFetch.prefixArgs)
      }
    }
    const child = spawn(executable, args, {
      shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe']
    })
    this.startingProcesses.add(child)
    const key = runtimeTargetKey(target)
    try {
      const port = await this.waitForReady(child)
      this.assertCurrentGeneration(generation)
      const client = new LitRootServiceClient(`http://127.0.0.1:${port}`, token)
      const eventsController = new AbortController()
      const session: ServiceSession = { target, process: child, client, eventsController }
      this.sessions.set(key, session)
      child.once('exit', () => {
        if (this.sessions.get(key) === session) this.sessions.delete(key)
        eventsController.abort()
      })
      void client.subscribe(this.onEvent, eventsController.signal).catch(() => undefined)
      return client
    } catch (error) {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
      throw error
    } finally {
      this.startingProcesses.delete(child)
    }
  }

  async toServicePath(target: RuntimeTarget, hostPath: string): Promise<string> {
    await this.assertTarget(target)
    if (target.kind === 'local') return hostPath
    const result = await command('wsl.exe', ['-d', target.distribution, '--exec', 'wslpath', '-u', hostPath])
    if (result.code !== 0) throw new Error(cleanWslOutput(result.stderr) || '无法转换 WSL 路径。')
    return cleanWslOutput(result.stdout)
  }

  async toHostPath(target: RuntimeTarget, servicePath: string): Promise<string> {
    await this.assertTarget(target)
    if (target.kind === 'local') return servicePath
    const result = await command('wsl.exe', ['-d', target.distribution, '--exec', 'wslpath', '-w', servicePath])
    if (result.code !== 0) throw new Error(cleanWslOutput(result.stderr) || '无法转换 Windows 路径。')
    return cleanWslOutput(result.stdout)
  }

  async asset(target: RuntimeTarget, projectId: string, paperId: string, source: string): Promise<Response> {
    return (await this.client(target)).asset(projectId, paperId, source)
  }

  async close(): Promise<void> {
    this.generation += 1
    this.starts.clear()
    const startingProcesses = [...this.startingProcesses]
    this.startingProcesses.clear()
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    for (const process of startingProcesses) process.kill('SIGTERM')
    for (const session of sessions) {
      session.eventsController.abort()
      session.process.kill('SIGTERM')
    }
  }

  private assertCurrentGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error('LitRoot 服务启动已取消。')
  }

  private async assertTarget(target: RuntimeTarget): Promise<void> {
    if (target.kind === 'local') return
    if (process.platform !== 'win32') throw new Error('当前平台不支持 WSL。')
    const result = await command('wsl.exe', ['--list', '--quiet'])
    if (result.code !== 0) throw new Error(cleanWslOutput(result.stderr) || '无法读取 WSL 发行版。')
    const available = cleanWslOutput(result.stdout).split('\n').map((item) => item.trim()).filter(Boolean)
    if (!available.includes(target.distribution)) throw new Error('所选 WSL 发行版不存在。')
  }

  private async servicePath(target: RuntimeTarget): Promise<string> {
    const hostPath = app.isPackaged
      ? join(process.resourcesPath, 'service', 'litroot-service.cjs')
      : join(app.getAppPath(), 'dist', 'service', 'litroot-service.cjs')
    if (target.kind === 'local') return hostPath
    const result = await command('wsl.exe', ['-d', target.distribution, '--exec', 'wslpath', '-a', hostPath])
    if (result.code !== 0) throw new Error(cleanWslOutput(result.stderr) || '无法定位 WSL 服务文件。')
    return cleanWslOutput(result.stdout)
  }

  private waitForReady(child: ChildProcess): Promise<number> {
    return new Promise((resolveReady, reject) => {
      let buffer = ''
      let errors = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('LitRoot 服务启动超时。'))
      }, 20_000)
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => { errors = `${errors}${chunk}`.slice(-20_000) })
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          try {
            const value: unknown = JSON.parse(line)
            if (
              typeof value === 'object' && value !== null &&
              (value as Record<string, unknown>).type === 'ready' &&
              Number.isInteger((value as Record<string, unknown>).port)
            ) {
              clearTimeout(timer)
              resolveReady(Number((value as Record<string, unknown>).port))
              return
            }
          } catch {
            // Only a structured ready line completes startup.
          }
        }
      })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error(cleanWslOutput(errors) || 'LitRoot 服务在就绪前退出。'))
      })
    })
  }
}
