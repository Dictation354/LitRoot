import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import {
  mkdir,
  opendir,
  readFile
} from 'node:fs/promises'
import { z } from 'zod'
import type {
  CreateFetchRunRequest,
  FetchRun
} from '../shared/contracts.js'
import { createFetchRunRequestSchema, fetchRunSchema, fetchAssetProgressSchema } from '../shared/contracts.js'
import type { ProjectLayout } from './project-layout.js'
import type { ProjectDatabase } from './project-database.js'
import type { ProjectScanner } from './scanner.js'
import type { ServiceEventBus } from './events.js'
import { atomicWriteFile } from './safe-fs.js'
import { doiFromInput, sha256 } from './identity.js'
import { errorMessage, LitRootError } from './errors.js'
import { normalizePaperFetchCommand, type PaperFetchCommand } from './paper-fetch-command.js'
import {
  itemFor,
  parseJsonLines,
  parseManifestDocument,
  parseTerminalRecord,
  type ParsedTerminalRecord
} from './fetch-record.js'
import { requirePaperFetchProgress } from './diagnostics.js'
import { FetchAcceptance } from './fetch-acceptance.js'

const progressBase = z.object({
  paper_fetch_progress: z.literal(true),
  protocol_version: z.literal(1),
  run_id: z.string().min(1).max(100),
  index: z.number().int().min(0)
})
const progressEventSchema = z.discriminatedUnion('type', [
  progressBase.extend({ type: z.literal('run_started'), index: z.literal(0), total: z.number().int().min(1) }),
  progressBase.extend({ type: z.literal('stage'), stage: z.enum(['queued', 'identity', 'fetching', 'assets', 'validating', 'writing']) }),
  progressBase.extend({ type: z.literal('assets'), ...fetchAssetProgressSchema.shape }),
  progressBase.extend({ type: z.literal('terminal'), record: z.object({ index: z.number().int().positive(), run_id: z.string().min(1) }).passthrough() }),
  progressBase.extend({ type: z.literal('cancel_response'), status: z.enum(['cancelling', 'already_finished', 'invalid_command', 'stale_run']) })
])

interface RunFiles {
  appManifest: string
  queryFile: string
  paperFetchManifest: string
  batchResults: string
  temporaryDirectory: string
}

interface ProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function now(): string {
  return new Date().toISOString()
}

function copyRun(run: FetchRun): FetchRun {
  return structuredClone(run)
}

export class PaperFetchRunner {
  private readonly processes = new Map<string, ChildProcess>()
  private readonly runs = new Map<string, FetchRun>()
  private readonly engineRunIds = new Map<string, string>()
  private readonly tasks = new Map<string, Promise<void>>()
  private readonly executable: string
  private readonly prefixArgs: string[]
  private readonly acceptance: FetchAcceptance

  constructor(
    private readonly layout: ProjectLayout,
    private readonly database: ProjectDatabase,
    private readonly scanner: ProjectScanner,
    private readonly events: ServiceEventBus,
    command?: string | PaperFetchCommand
  ) {
    const normalized = normalizePaperFetchCommand(command)
    this.executable = normalized.executable
    this.prefixArgs = normalized.prefixArgs
    this.acceptance = new FetchAcceptance(layout, database)
  }

  private files(runId: string): RunFiles {
    return {
      appManifest: join(this.layout.runs, `${runId}.litroot.json`),
      queryFile: join(this.layout.runs, `${runId}.queries.txt`),
      paperFetchManifest: join(this.layout.runs, `${runId}.paper-fetch.json`),
      batchResults: join(this.layout.runs, `${runId}.results.jsonl`),
      temporaryDirectory: join(this.layout.temporary, runId)
    }
  }

  async load(): Promise<void> {
    let entries
    try {
      entries = await opendir(this.layout.runs)
    } catch {
      return
    }
    for await (const entry of entries) {
      if (!entry.isFile() || !/^run_[a-f0-9]{24}\.litroot\.json$/.test(entry.name)) continue
      try {
        const parsed = fetchRunSchema.parse(JSON.parse(await readFile(join(this.layout.runs, entry.name), 'utf8')))
        if (['queued', 'running', 'cancelling'].includes(parsed.state)) parsed.state = 'interrupted'
        this.runs.set(parsed.id, parsed)
        await this.persist(parsed)
      } catch {
        // A corrupt app manifest is ignored; paper-fetch's own manifest remains untouched for audit.
      }
    }
  }

  list(): FetchRun[] {
    return [...this.runs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(copyRun)
  }

  get(runId: string): FetchRun {
    const run = this.runs.get(runId)
    if (!run) throw new LitRootError('run_not_found', '抓取任务不存在。', 404)
    return copyRun(run)
  }

  async create(request: CreateFetchRunRequest): Promise<FetchRun> {
    const normalizedRequest = createFetchRunRequestSchema.parse(request)
    await requirePaperFetchProgress({ executable: this.executable, prefixArgs: this.prefixArgs })
    const runId = `run_${sha256(`${now()}\0${Math.random()}`).slice(0, 24)}`
    const files = this.files(runId)
    const inputs = normalizedRequest.inputs.map((input) => input.trim())
    const run: FetchRun = {
      schemaVersion: 1,
      id: runId,
      projectId: this.layout.id,
      state: 'queued',
      concurrency: normalizedRequest.concurrency,
      refreshPaperId: normalizedRequest.refreshPaperId ?? null,
      refreshPaperIds: normalizedRequest.refreshPaperIds ?? null,
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      manifestPath: files.appManifest,
      executionIndexes: [],
      items: inputs.map((input, index) => itemFor(index + 1, input))
    }
    if (run.refreshPaperId && (run.items.length !== 1 || !this.database.reference(run.refreshPaperId))) {
      throw new LitRootError('invalid_refresh', '刷新只支持当前项目中已存在的单篇论文。')
    }
    if (run.refreshPaperIds?.some((paperId) => !this.database.reference(paperId))) {
      throw new LitRootError('invalid_refresh', '批量刷新只支持当前项目中已存在的论文。')
    }
    await mkdir(files.temporaryDirectory, { recursive: true })
    await atomicWriteFile(files.queryFile, `${inputs.join('\n')}\n`)
    this.runs.set(run.id, run)
    await this.persist(run)
    this.launch(run, false)
    return copyRun(run)
  }

  async cancel(runId: string): Promise<FetchRun> {
    const run = this.requireMutable(runId)
    if (!['queued', 'running'].includes(run.state)) return copyRun(run)
    run.state = 'cancelling'
    for (const item of run.items) {
      if (item.stage !== 'terminal' && item.stage !== 'acceptance') item.state = 'cancelling'
    }
    this.sendCancel(run, null)
    await this.persist(run)
    return copyRun(run)
  }

  async cancelItem(runId: string, index: number): Promise<FetchRun> {
    const run = this.requireMutable(runId)
    const item = Number.isInteger(index) && index > 0 ? run.items[index - 1] : undefined
    if (!item) throw new LitRootError('item_not_found', '抓取条目不存在。', 404)
    if (!['queued', 'running', 'cancelling'].includes(run.state) ||
      item.stage === 'terminal' || item.stage === 'acceptance' || item.state === 'cancelling') return copyRun(run)
    item.state = 'cancelling'
    this.sendCancel(run, index)
    await this.persist(run)
    return copyRun(run)
  }

  private sendCancel(run: FetchRun, index: number | null): void {
    const engineRunId = this.engineRunIds.get(run.id)
    const child = this.processes.get(run.id)
    if (!engineRunId || !child?.stdin?.writable) return
    const engineIndex = index === null ? null : run.executionIndexes.indexOf(index) + 1
    if (engineIndex === 0) return
    child.stdin.write(`${JSON.stringify({ protocol_version: 1, run_id: engineRunId, command: 'cancel', index: engineIndex })}\n`)
  }

  async resume(runId: string): Promise<FetchRun> {
    const run = this.requireMutable(runId)
    if (this.processes.has(runId)) throw new LitRootError('run_active', '抓取任务仍在运行。', 409)
    if (!['interrupted', 'cancelled', 'completed'].includes(run.state)) {
      throw new LitRootError('run_not_resumable', '该任务当前不能恢复。', 409)
    }
    await requirePaperFetchProgress({ executable: this.executable, prefixArgs: this.prefixArgs })
    for (const item of run.items) {
      if (['complete', 'degraded', 'limited'].includes(item.state)) continue
      item.stage = 'queued'
      item.stageStartedAt = now()
      item.assetProgress = null
      item.state = 'pending'
      item.attempt += 1
      item.reason = null
      item.errorCode = null
      item.acceptance = null
      item.completionOrder = null
    }
    run.state = 'queued'
    run.startedAt = null
    run.finishedAt = null
    await this.persist(run)
    this.launch(run, true)
    return copyRun(run)
  }

  async close(): Promise<void> {
    for (const run of this.runs.values()) {
      if (['queued', 'running', 'cancelling'].includes(run.state)) run.state = 'interrupted'
    }
    for (const [runId, child] of this.processes) this.terminateProcess(runId, child)
    await Promise.all([...this.tasks.values()].map((task) => task.catch(() => undefined)))
    await Promise.all([...this.runs.values()].map((run) => this.persist(run)))
  }

  private launch(run: FetchRun, resume: boolean): void {
    const task = this.execute(run, resume)
      .catch((error) => this.failRun(run, error))
      .finally(() => {
        if (this.tasks.get(run.id) === task) this.tasks.delete(run.id)
      })
    this.tasks.set(run.id, task)
  }

  private requireMutable(runId: string): FetchRun {
    const run = this.runs.get(runId)
    if (!run) throw new LitRootError('run_not_found', '抓取任务不存在。', 404)
    return run
  }

  private activeIndexes(run: FetchRun): number[] {
    const active: number[] = []
    for (const item of run.items) {
      if (!['pending', 'cancelling'].includes(item.state)) continue
      const refreshPaperId = run.refreshPaperIds?.[item.index - 1] ?? run.refreshPaperId ?? undefined
      const normalized = doiFromInput(item.query)
      if (normalized) {
        const existing = this.database.findByDoi(normalized, refreshPaperId)
        if (existing) {
          item.stage = 'terminal'
          item.state = 'action_required'
          item.acceptance = 'action_required'
          item.canonicalDoi = normalized
          item.existingPaperId = existing.id
          item.reason = '当前项目中已存在该 DOI，未创建副本。'
          continue
        }
      }
      item.stage = 'queued'
      item.stageStartedAt = now()
      if (item.state !== 'cancelling') item.state = 'running'
      active.push(item.index)
    }
    return active
  }

  private async execute(run: FetchRun, resume: boolean): Promise<void> {
    const files = this.files(run.id)
    const activeIndexes = this.activeIndexes(run)
    run.executionIndexes = [...activeIndexes]
    if (run.state !== 'cancelling') run.state = 'running'
    run.startedAt = now()
    await this.persist(run)
    if (activeIndexes.length === 0) {
      this.finishRun(run)
      await this.persist(run)
      return
    }

    const activeQueries = activeIndexes.map((index) => run.items[index - 1]?.query ?? '')
    await atomicWriteFile(files.queryFile, `${activeQueries.join('\n')}\n`)

    const batch = run.executionIndexes.length > 1
    const args = batch
      ? this.batchArguments(run, files, resume)
      : this.singleArguments(run, files, activeIndexes[0] ?? 1, resume)
    if (resume) await atomicWriteFile(batch ? files.batchResults : files.paperFetchManifest, '')
    const result = await this.spawnProcess(run, args)

    if (batch) {
      await this.applyBatchRecords(run, files, activeIndexes, result)
    } else if (run.items[(activeIndexes[0] ?? 1) - 1]?.stage !== 'terminal') {
      const values = [
        ...parseJsonLines(result.stdout),
        ...await this.readManifestValues(files.paperFetchManifest)
      ]
      const record = values.map((value) => parseTerminalRecord(value, 1)).findLast(Boolean)
      await this.acceptRecord(
        run,
        activeIndexes[0] ?? 1,
        record ?? parseTerminalRecord({
          index: 1,
          status: (run.state as string) === 'cancelling'
            ? 'cancelled'
            : result.exitCode === 0 ? 'ok' : 'error',
          output_path: join(files.temporaryDirectory, `item-${activeIndexes[0] ?? 1}-attempt-${run.items[(activeIndexes[0] ?? 1) - 1]?.attempt ?? 1}.md`),
          reason: result.stderr.trim() || `paper-fetch exited with code ${result.exitCode}`
        }) as ParsedTerminalRecord,
        files.temporaryDirectory
      )
    }

    await this.scanner.scan()
    if ((run.state as string) === 'interrupted') {
      for (const item of run.items) {
        if (['pending', 'running', 'cancelling'].includes(item.state)) {
          item.stage = 'terminal'
          item.state = 'cancelled'
          item.reason = '服务已停止；可从 manifest 恢复。'
        }
      }
      run.state = 'interrupted'
    } else if ((run.state as string) === 'cancelling' || result.signal) {
      for (const item of run.items) {
        if (['pending', 'running', 'cancelling'].includes(item.state)) {
          item.stage = 'terminal'
          item.state = 'cancelled'
          item.reason = '任务已取消；可从 manifest 恢复。'
        }
      }
      run.state = 'cancelled'
    } else {
      this.finishRun(run)
    }
    run.finishedAt = now()
    await this.persist(run)
  }

  private batchArguments(run: FetchRun, files: RunFiles, resume: boolean): string[] {
    const args = [
      'fetch', '--progress', 'jsonl', '--control-stdin', '--query-file', files.queryFile,
      '--format', 'markdown',
      '--output-dir', files.temporaryDirectory,
      '--batch-concurrency', String(run.concurrency),
      '--batch-results', files.batchResults
    ]
    if (resume) args.push('--overwrite')
    return [
      ...args,
      '--artifact-mode', 'markdown-assets',
      '--asset-profile', 'body',
      '--include-refs', 'all',
      '--max-tokens', 'full_text'
    ]
  }

  private singleArguments(
    run: FetchRun,
    files: RunFiles,
    originalIndex: number,
    resume: boolean
  ): string[] {
    const item = run.items[originalIndex - 1]
    const args = [
      'fetch', '--progress', 'jsonl', '--control-stdin', '--query', item?.query ?? '',
      '--format', 'markdown',
      '--output-dir', files.temporaryDirectory,
      '--manifest', files.paperFetchManifest
    ]
    if (resume) args.push('--overwrite')
    return [
      ...args,
      '--artifact-mode', 'markdown-assets',
      '--asset-profile', 'body',
      '--include-refs', 'all',
      '--max-tokens', 'full_text'
    ]
  }

  private spawnProcess(run: FetchRun, args: string[]): Promise<ProcessResult> {
    return new Promise((resolveProcess, reject) => {
      const child = spawn(this.executable, [...this.prefixArgs, ...args], {
        cwd: this.layout.root,
        env: process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.processes.set(run.id, child)
      let stdout = ''
      let stderr = ''
      let partial = ''
      let updates = Promise.resolve()
      let updateError: unknown
      let progressPending = false
      const terminals = new Set<number>()
      const enqueue = (update: () => Promise<void>): void => {
        updates = updates.then(update).catch((error: unknown) => { updateError ??= error })
      }
      const persistProgress = (): void => {
        if (progressPending) return
        progressPending = true
        enqueue(async () => {
          progressPending = false
          await this.persist(run)
        })
      }
      const receive = (line: string): void => {
        let raw: unknown
        try { raw = JSON.parse(line) } catch { raw = null }
        const parsed = progressEventSchema.safeParse(raw)
        if (!parsed.success) {
          stderr = `${stderr}${line}\n`.slice(-1_000_000)
          return
        }
        const event = parsed.data
        if (event.type === 'run_started') {
          if (this.engineRunIds.has(run.id) || event.total !== run.executionIndexes.length) return
          this.engineRunIds.set(run.id, event.run_id)
          if (run.state === 'cancelling') this.sendCancel(run, null)
          else for (const item of run.items) {
            if (item.state === 'cancelling') this.sendCancel(run, item.index)
          }
          return
        }
        if (event.run_id !== this.engineRunIds.get(run.id)) return
        const index = run.executionIndexes[event.index - 1]
        const item = index ? run.items[index - 1] : undefined
        if (!index || !item || terminals.has(index) || item.stage === 'terminal') return
        if (event.type === 'terminal') {
          const record = parseTerminalRecord(event.record)
          if (!record || record.index !== event.index || event.record.run_id !== event.run_id) return
          terminals.add(index)
          item.stage = 'acceptance'
          item.stageStartedAt = now()
          item.state = 'running'
          enqueue(async () => {
            await this.persist(run)
            await this.acceptRecord(run, index, record, this.files(run.id).temporaryDirectory)
            await this.scanner.scan()
            await this.persist(run)
          })
        } else if (event.type === 'stage') {
          if (item.stage !== event.stage) {
            item.stage = event.stage
            item.stageStartedAt = now()
            if (event.stage === 'identity' || event.stage === 'fetching') item.assetProgress = null
          }
          persistProgress()
        } else if (event.type === 'assets') {
          item.assetProgress = { scope: event.scope, counts: event.counts }
          persistProgress()
        } else if (event.type === 'cancel_response' && event.status === 'cancelling') {
          item.state = 'cancelling'
          persistProgress()
        }
      }
      child.stdin.on('error', () => { /* Exit reconciliation reports a closed control channel. */ })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-1_000_000) })
      child.stderr.on('data', (chunk: string) => {
        partial += chunk
        let end: number
        while ((end = partial.indexOf('\n')) !== -1) {
          const line = partial.slice(0, end)
          partial = partial.slice(end + 1)
          receive(line)
        }
        if (partial.length > 1_000_000) {
          stderr = partial.slice(-1_000_000)
          partial = ''
        }
      })
      child.once('error', reject)
      child.once('close', (exitCode, signal) => {
        if (partial) receive(partial)
        if (this.processes.get(run.id) === child) this.processes.delete(run.id)
        this.engineRunIds.delete(run.id)
        void updates.then(() => {
          if (updateError) reject(updateError)
          else resolveProcess({ exitCode, signal, stdout, stderr })
        })
      })
      if (run.state === 'interrupted') this.terminateProcess(run.id, child)
    })
  }

  private async acceptRecord(run: FetchRun, index: number, record: ParsedTerminalRecord, stagingRoot: string): Promise<void> {
    const item = run.items[index - 1]
    if (!item || item.stage === 'terminal') return
    item.stage = 'acceptance'
    item.stageStartedAt = now()
    // Acceptance mutates its item before I/O; publish it only once archival finishes.
    const accepted = copyRun(run)
    await this.acceptance.accept(accepted, index, record, stagingRoot)
    Object.assign(item, accepted.items[index - 1])
    item.stageStartedAt = now()
  }

  private terminateProcess(runId: string, child: ChildProcess): void {
    child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (this.processes.get(runId) === child) child.kill('SIGKILL')
    }, 2_000)
    timer.unref()
    child.once('close', () => clearTimeout(timer))
  }

  private async recordsFromJsonl(path: string): Promise<ParsedTerminalRecord[]> {
    try {
      const values = parseJsonLines(await readFile(path, 'utf8'))
      const latest = new Map<number, ParsedTerminalRecord>()
      for (const value of values) {
        const record = parseTerminalRecord(value)
        if (!record) continue
        const current = latest.get(record.index)
        if (!current || record.attempt >= current.attempt) latest.set(record.index, record)
      }
      return [...latest.values()].sort((left, right) => left.index - right.index)
    } catch {
      return []
    }
  }

  private async applyBatchRecords(
    run: FetchRun,
    files: RunFiles,
    indexes: number[],
    result: ProcessResult
  ): Promise<void> {
    const records = await this.recordsFromJsonl(files.batchResults)
    const byIndex = new Map(records.map((record) => [record.index, record]))
    for (const [position, originalIndex] of indexes.entries()) {
      if (run.items[originalIndex - 1]?.stage === 'terminal') continue
      const record = byIndex.get(position + 1) ?? parseTerminalRecord({
        index: position + 1,
        status: ['cancelling', 'interrupted'].includes(run.state) || result.signal ? 'cancelled' : 'error',
        reason: [
          'paper-fetch 没有为该输入写入 terminal JSONL record。',
          result.signal ? `paper-fetch terminated by ${result.signal}` : `paper-fetch exited with code ${result.exitCode}`,
          result.stderr.trim() || result.stdout.trim()
        ].filter(Boolean).join('\n')
      }) as ParsedTerminalRecord
      await this.acceptRecord(run, originalIndex, record, files.temporaryDirectory)
    }
  }

  private finishRun(run: FetchRun): void {
    for (const item of run.items) {
      if (['pending', 'running', 'cancelling'].includes(item.state)) {
        item.stage = 'terminal'
        item.state = 'failed'
        item.acceptance = 'failed'
        item.reason = item.reason ?? '任务结束时没有 terminal record。'
      }
    }
    run.state = 'completed'
    run.finishedAt = now()
  }

  private async readManifestValues(path: string): Promise<unknown[]> {
    try {
      return parseManifestDocument(await readFile(path, 'utf8'))
    } catch {
      return []
    }
  }

  private async failRun(run: FetchRun, error: unknown): Promise<void> {
    const stopping = run.state === 'cancelling' || run.state === 'interrupted'
    for (const item of run.items) {
      if (['pending', 'running', 'cancelling'].includes(item.state)) {
        item.stage = 'terminal'
        item.state = stopping ? 'cancelled' : 'failed'
        item.acceptance = stopping ? null : 'failed'
        item.reason = errorMessage(error)
        item.errorCode = error instanceof LitRootError ? error.code : 'runner_error'
      }
    }
    run.state = run.state === 'cancelling' ? 'cancelled' : 'interrupted'
    run.finishedAt = now()
    await this.persist(run)
  }

  private async persist(run: FetchRun): Promise<void> {
    const parsed = fetchRunSchema.parse(run)
    await atomicWriteFile(this.files(run.id).appManifest, `${JSON.stringify(parsed, null, 2)}\n`)
    this.events.emit({
      type: 'fetch.changed',
      projectId: this.layout.id,
      at: now(),
      run: copyRun(parsed)
    })
  }
}
