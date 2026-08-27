import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import type { DependencyReport, ServiceEvent } from '../shared/contracts.js'
import { dependencyRepair } from '../shared/dependency-repair.js'
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
  distribution: string
  process: ChildProcess
  client: LitRootServiceClient
  eventsController: AbortController
}

function command(
  executable: string,
  args: string[],
  timeout = 15_000
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
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
      resolve({ code, stdout, stderr })
    })
  })
}

export class WslServiceManager {
  private readonly sessions = new Map<string, ServiceSession>()
  private readonly starts = new Map<string, Promise<LitRootServiceClient>>()
  private readonly startingProcesses = new Set<ChildProcess>()
  private generation = 0

  constructor(private readonly onEvent: (event: ServiceEvent) => void) {}

  async listDistributions(): Promise<string[]> {
    if (process.platform !== 'win32') return [process.env.LITROOT_DEV_DISTRIBUTION || 'Local WSL development']
    const result = await command('wsl.exe', ['--list', '--quiet'])
    if (result.code !== 0) throw new Error(cleanWslOutput(result.stderr) || '无法读取 WSL 发行版。')
    return cleanWslOutput(result.stdout).split('\n').map((item) => item.trim()).filter(Boolean)
  }

  async diagnose(distribution: string): Promise<DependencyReport> {
    await this.assertDistribution(distribution)
    const run = (args: string[]): Promise<CommandResult> => process.platform === 'win32'
      ? command('wsl.exe', wslLoginShellArgs(distribution, args))
      : command(args[0] ?? '', args.slice(1))
    const [node, paperFetch, git] = await Promise.all([
      run(['node', '--version']).catch((error) => ({ code: -1, stdout: '', stderr: String(error) })),
      run(['paper-fetch', '--version']).catch((error) => ({ code: -1, stdout: '', stderr: String(error) })),
      run(['git', '--version']).catch((error) => ({ code: -1, stdout: '', stderr: String(error) }))
    ])
    const nodeVersion = nodeVersionFromOutput(node.stdout)
    const nodeOk = node.code === 0 && supportedNode(nodeVersion)
    const paperFetchVersion = paperFetch.code === 0 ? lastOutputLine(paperFetch.stdout) : null
    const gitVersion = git.code === 0 ? lastOutputLine(git.stdout) : null
    const checks: DependencyReport['checks'] = [
      {
        name: 'node', ok: nodeOk,
        version: nodeVersion, required: '24.15+',
        repairCommand: dependencyRepair.node,
        reason: nodeOk
          ? null
          : cleanWslOutput(node.stderr) || '需要 Node.js 24.15+。'
      },
      {
        name: 'paper-fetch', ok: paperFetch.code === 0,
        version: paperFetchVersion,
        required: '可执行的官方 paper-fetch',
        repairCommand: dependencyRepair.paperFetch,
        reason: paperFetch.code === 0 ? null : cleanWslOutput(paperFetch.stderr) || 'paper-fetch 不可执行。'
      },
      {
        name: 'git', ok: git.code === 0,
        version: gitVersion,
        required: 'Git',
        repairCommand: dependencyRepair.git,
        reason: git.code === 0 ? null : cleanWslOutput(git.stderr) || 'Git 不可执行。'
      }
    ]
    return { distribution, ready: checks.every((check) => check.ok), checks }
  }

  client(distribution: string): Promise<LitRootServiceClient> {
    const existing = this.sessions.get(distribution)
    if (existing) return Promise.resolve(existing.client)
    const starting = this.starts.get(distribution)
    if (starting) return starting

    const generation = this.generation
    const start = this.startClient(distribution, generation)
    const tracked = start.finally(() => {
      if (this.starts.get(distribution) === tracked) this.starts.delete(distribution)
    })
    this.starts.set(distribution, tracked)
    return tracked
  }

  private async startClient(distribution: string, generation: number): Promise<LitRootServiceClient> {
    await this.assertDistribution(distribution)
    this.assertCurrentGeneration(generation)
    const servicePath = await this.servicePath(distribution)
    this.assertCurrentGeneration(generation)
    const token = randomBytes(32).toString('hex')
    const args = process.platform === 'win32'
      ? wslLoginShellArgs(distribution, [
          '/usr/bin/env',
          `LITROOT_SESSION_TOKEN=${token}`,
          'node',
          servicePath
        ])
      : [servicePath]
    const executable = process.platform === 'win32' ? 'wsl.exe' : process.execPath
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      env: process.platform === 'win32' ? process.env : { ...process.env, LITROOT_SESSION_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.startingProcesses.add(child)
    try {
      const port = await this.waitForReady(child)
      this.assertCurrentGeneration(generation)
      const client = new LitRootServiceClient(`http://127.0.0.1:${port}`, token)
      const eventsController = new AbortController()
      const session: ServiceSession = { distribution, process: child, client, eventsController }
      this.sessions.set(distribution, session)
      child.once('exit', () => {
        if (this.sessions.get(distribution) === session) this.sessions.delete(distribution)
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

  async toWslPath(distribution: string, windowsPath: string): Promise<string> {
    await this.assertDistribution(distribution)
    if (process.platform !== 'win32') return windowsPath
    const result = await command('wsl.exe', ['-d', distribution, '--exec', 'wslpath', '-u', windowsPath])
    if (result.code !== 0) throw new Error(cleanWslOutput(result.stderr) || '无法转换 WSL 路径。')
    return cleanWslOutput(result.stdout)
  }

  async asset(distribution: string, projectId: string, paperId: string, source: string): Promise<Response> {
    return (await this.client(distribution)).asset(projectId, paperId, source)
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
    if (generation !== this.generation) throw new Error('WSL 服务启动已取消。')
  }

  private async assertDistribution(distribution: string): Promise<void> {
    const available = await this.listDistributions()
    if (!available.includes(distribution)) throw new Error('所选 WSL 发行版不存在。')
  }

  private async servicePath(distribution: string): Promise<string> {
    const windowsPath = app.isPackaged
      ? join(process.resourcesPath, 'service', 'litroot-service.cjs')
      : join(app.getAppPath(), 'dist', 'service', 'litroot-service.cjs')
    if (process.platform !== 'win32') return windowsPath
    const result = await command('wsl.exe', ['-d', distribution, '--exec', 'wslpath', '-a', windowsPath])
    if (result.code !== 0) throw new Error(cleanWslOutput(result.stderr) || '无法定位 WSL 服务文件。')
    return cleanWslOutput(result.stdout)
  }

  private waitForReady(child: ChildProcess): Promise<number> {
    return new Promise((resolve, reject) => {
      let buffer = ''
      let errors = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('WSL 服务启动超时。'))
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
              resolve(Number((value as Record<string, unknown>).port))
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
        reject(new Error(cleanWslOutput(errors) || 'WSL 服务在就绪前退出。'))
      })
    })
  }
}
