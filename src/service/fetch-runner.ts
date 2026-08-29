import { spawn, type ChildProcess } from 'node:child_process'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  unlink
} from 'node:fs/promises'
import chokidar, { type FSWatcher } from 'chokidar'
import YAML from 'yaml'
import type {
  AcceptanceOverall,
  ContentKind,
  CreateFetchRunRequest,
  FetchItem,
  FetchRun,
  IdentityCandidate
} from '../shared/contracts.js'
import { createFetchRunRequestSchema, fetchRunSchema } from '../shared/contracts.js'
import type { ProjectLayout } from './project-layout.js'
import type { ProjectDatabase } from './project-database.js'
import type { ProjectScanner } from './scanner.js'
import type { ServiceEventBus } from './events.js'
import { candidateAssetPath, parsePaperMarkdown } from './paper-markdown.js'
import {
  atomicWriteFile,
  canonicalDirectory,
  canonicalFileInside,
  isPathInside
} from './safe-fs.js'
import { canonicalHttpUrl, doiFromInput, normalizeDoi, paperIdFor, sha256 } from './identity.js'
import { errorMessage, LitRootError } from './errors.js'
import { validatedImageFileInside } from './assets.js'
import { normalizePaperFetchCommand, type PaperFetchCommand } from './paper-fetch-command.js'

type UnknownRecord = Record<string, unknown>

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

interface ParsedTerminalRecord {
  index: number
  attempt: number
  status: string
  canonicalDoi: string | null
  canonicalUrl: string | null
  title: string | null
  provider: string | null
  reason: string | null
  errorCode: string | null
  candidates: IdentityCandidate[]
  acceptance: AcceptanceOverall | null
  contentKind: ContentKind | null
  outputPath: string | null
  outputSha256: string | null
  completionOrder: number | null
  raw: UnknownRecord
}

function now(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function integer(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function nested(record: UnknownRecord, key: string): UnknownRecord {
  return isRecord(record[key]) ? record[key] as UnknownRecord : {}
}

function acceptance(value: unknown): AcceptanceOverall | null {
  return ['complete', 'degraded', 'limited', 'failed', 'action_required'].includes(String(value))
    ? value as AcceptanceOverall
    : null
}

function contentKind(value: unknown): ContentKind | null {
  return ['fulltext', 'abstract_only', 'metadata_only'].includes(String(value))
    ? value as ContentKind
    : null
}

function candidates(value: unknown): IdentityCandidate[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate): IdentityCandidate[] => {
    if (!isRecord(candidate)) return []
    const title = text(candidate.title)
    if (!title) return []
    return [{
      doi: normalizeDoi(candidate.doi),
      title,
      url: text(candidate.url ?? candidate.landing_url)
    }]
  }).slice(0, 20)
}

function parseTerminalRecord(value: unknown, fallbackIndex = 1): ParsedTerminalRecord | null {
  if (!isRecord(value)) return null
  const acceptanceRecord = nested(value, 'acceptance')
  const identityRecord = nested(acceptanceRecord, 'identity')
  const contentRecord = nested(acceptanceRecord, 'content')
  const errorRecord = nested(value, 'error')
  const outputRecord = nested(value, 'output')
  const outputArtifacts = Array.isArray(value.output_artifacts) ? value.output_artifacts : []
  const markdownArtifact = outputArtifacts.find((item) => isRecord(item) && /markdown/i.test(String(item.kind)))
  const artifact = isRecord(markdownArtifact) ? markdownArtifact : {}
  return {
    index: integer(value.index, fallbackIndex),
    attempt: integer(value.attempt, 1),
    status: text(value.status) ?? 'unknown',
    canonicalDoi: normalizeDoi(
      value.doi ?? value.canonical_doi ?? identityRecord.doi ?? identityRecord.canonical_doi
    ),
    canonicalUrl: text(
      value.canonical_url ?? value.url ?? identityRecord.url ?? identityRecord.canonical_url
    ),
    title: text(value.title ?? identityRecord.title),
    provider: text(value.provider ?? value.source ?? nested(value, 'metadata').provider),
    reason: text(errorRecord.reason ?? value.reason ?? value.message),
    errorCode: text(errorRecord.code ?? errorRecord.error_category ?? value.code ?? value.error_category),
    candidates: candidates(value.candidates ?? errorRecord.candidates),
    acceptance: acceptance(acceptanceRecord.overall ?? value.overall),
    contentKind: contentKind(
      contentRecord.kind ?? contentRecord.content_kind ?? value.content_kind
    ),
    outputPath: text(
      value.output_path ?? value.saved_markdown_path ?? outputRecord.path ?? artifact.path
    ),
    outputSha256: text(
      value.output_sha256 ?? value.sha256 ?? outputRecord.sha256 ?? artifact.sha256
    ),
    completionOrder: value.completion_order === undefined
      ? null
      : integer(value.completion_order, fallbackIndex),
    raw: value
  }
}

function parseJsonLines(raw: string): unknown[] {
  return raw.split(/\r?\n/).flatMap((line): unknown[] => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

function itemFor(index: number, query: string): FetchItem {
  return {
    index,
    query,
    stage: 'queued',
    state: 'pending',
    attempt: 1,
    canonicalDoi: doiFromInput(query),
    canonicalUrl: null,
    title: null,
    provider: null,
    reason: null,
    errorCode: null,
    candidates: [],
    acceptance: null,
    contentKind: null,
    outputPath: null,
    outputSha256: null,
    existingPaperId: null,
    completionOrder: null
  }
}

function stateForOverall(overall: AcceptanceOverall): FetchItem['state'] {
  return overall
}

function actionRequired(record: ParsedTerminalRecord): boolean {
  return (
    record.acceptance === 'action_required' ||
    ['ambiguous', 'no_access', 'auth_required', 'challenge', 'multiple_candidates'].includes(record.status) ||
    ['manual_auth', 'lawful_access_boundary'].includes(record.errorCode ?? '')
  )
}

function safeOutputBasename(path: string): string {
  const name = basename(path)
  if (!['.md', '.markdown'].includes(extname(name).toLowerCase())) return 'article.md'
  return name.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 160) || 'article.md'
}

function copyRun(run: FetchRun): FetchRun {
  return structuredClone(run)
}

export class PaperFetchRunner {
  private readonly processes = new Map<string, ChildProcess>()
  private readonly runs = new Map<string, FetchRun>()
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly tasks = new Map<string, Promise<void>>()
  private readonly executable: string
  private readonly prefixArgs: string[]

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
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      manifestPath: files.appManifest,
      executionIndexes: [],
      items: inputs.map((input, index) => itemFor(index + 1, input))
    }
    if (run.refreshPaperId && (run.items.length !== 1 || !this.database.get(run.refreshPaperId))) {
      throw new LitRootError('invalid_refresh', '刷新只支持当前项目中已存在的单篇论文。')
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
    await this.persist(run)
    const child = this.processes.get(runId)
    if (child) this.terminateProcess(runId, child)
    return copyRun(run)
  }

  async resume(runId: string): Promise<FetchRun> {
    const run = this.requireMutable(runId)
    if (this.processes.has(runId)) throw new LitRootError('run_active', '抓取任务仍在运行。', 409)
    if (!['interrupted', 'cancelled', 'completed'].includes(run.state)) {
      throw new LitRootError('run_not_resumable', '该任务当前不能恢复。', 409)
    }
    for (const item of run.items) {
      if (['complete', 'degraded', 'limited'].includes(item.state)) continue
      item.stage = 'queued'
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
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.close().catch(() => undefined)))
    this.watchers.clear()
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
    const canonicalIndexes = new Map<string, number>()
    const active: number[] = []
    for (const item of run.items) {
      if (item.state !== 'pending') continue
      const normalized = doiFromInput(item.query)
      if (normalized) {
        const existing = this.database.findByDoi(normalized, run.refreshPaperId ?? undefined)
        if (existing) {
          item.stage = 'terminal'
          item.state = 'action_required'
          item.acceptance = 'action_required'
          item.canonicalDoi = normalized
          item.existingPaperId = existing.id
          item.reason = '当前项目中已存在该 DOI，未创建副本。'
          continue
        }
        const primary = canonicalIndexes.get(normalized)
        if (primary !== undefined) {
          item.stage = 'identity'
          item.state = 'running'
          item.reason = `与第 ${primary} 条输入合并。`
          continue
        }
        canonicalIndexes.set(normalized, item.index)
      }
      item.stage = 'identity'
      item.state = 'running'
      active.push(item.index)
    }
    return active
  }

  private async execute(run: FetchRun, resume: boolean): Promise<void> {
    const files = this.files(run.id)
    const activeIndexes = resume && run.executionIndexes.length > 0
      ? [...run.executionIndexes]
      : this.activeIndexes(run)
    if (!resume) run.executionIndexes = [...activeIndexes]
    run.state = 'running'
    run.startedAt = now()
    await this.persist(run)
    if (activeIndexes.length === 0) {
      this.finishRun(run)
      await this.persist(run)
      return
    }

    if (resume && activeIndexes.length > 1) await this.audit(files.paperFetchManifest)
    const activeQueries = activeIndexes.map((index) => run.items[index - 1]?.query ?? '')
    await atomicWriteFile(files.queryFile, `${activeQueries.join('\n')}\n`)

    const batch = run.executionIndexes.length > 1
    const args = batch
      ? this.batchArguments(run, files, resume)
      : this.singleArguments(run, files, activeIndexes[0] ?? 1, resume)
    if (batch) await this.watchBatchResults(run, files, activeIndexes)
    const result = await this.spawnProcess(run, args)
    await this.stopResultWatcher(run.id)

    if (batch) {
      await this.applyBatchRecords(run, files, activeIndexes)
    } else {
      const values = [
        ...parseJsonLines(result.stdout),
        ...parseJsonLines(result.stderr),
        ...await this.readManifestValues(files.paperFetchManifest)
      ]
      const record = values.map((value) => parseTerminalRecord(value, 1)).findLast(Boolean)
      await this.acceptItem(
        run,
        activeIndexes[0] ?? 1,
        record ?? parseTerminalRecord({
          index: 1,
          status: (run.state as string) === 'cancelling'
            ? 'cancelled'
            : result.exitCode === 0 ? 'ok' : 'error',
          output_path: join(files.temporaryDirectory, `item-${activeIndexes[0] ?? 1}-attempt-${run.items[(activeIndexes[0] ?? 1) - 1]?.attempt ?? 1}.md`),
          reason: result.stderr.trim() || `paper-fetch exited with code ${result.exitCode}`
        }) as ParsedTerminalRecord
      )
    }

    this.resolveMergedInputs(run)
    await this.scanner.scan()
    if ((run.state as string) === 'interrupted') {
      for (const item of run.items) {
        if (['pending', 'running'].includes(item.state)) {
          item.stage = 'terminal'
          item.state = 'cancelled'
          item.reason = '服务已停止；可从 manifest 恢复。'
        }
      }
      run.state = 'interrupted'
    } else if ((run.state as string) === 'cancelling' || result.signal) {
      for (const item of run.items) {
        if (['pending', 'running'].includes(item.state)) {
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
      'fetch', '--query-file', files.queryFile,
      '--format', 'markdown',
      '--output-dir', files.temporaryDirectory,
      '--batch-concurrency', String(run.concurrency)
    ]
    if (resume) args.push('--resume', files.paperFetchManifest)
    else args.push('--batch-results', files.batchResults, '--run-manifest', files.paperFetchManifest)
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
    const output = join(
      files.temporaryDirectory,
      `item-${originalIndex}-attempt-${item?.attempt ?? 1}.md`
    )
    const args = [
      'fetch', '--query', item?.query ?? '',
      '--format', 'markdown',
      '--output', output,
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

  private async audit(manifestPath: string): Promise<void> {
    const result = await this.spawnDetached(['manifest', 'audit', manifestPath])
    if (result.exitCode !== 0) {
      throw new LitRootError(
        'manifest_audit_failed',
        `paper-fetch manifest audit 未通过：${result.stderr.trim() || result.stdout.trim()}`,
        409
      )
    }
  }

  private spawnProcess(run: FetchRun, args: string[]): Promise<ProcessResult> {
    return new Promise((resolveProcess, reject) => {
      const child = spawn(this.executable, [...this.prefixArgs, ...args], {
        cwd: this.layout.root,
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.processes.set(run.id, child)
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-1_000_000) })
      child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-1_000_000) })
      child.once('error', reject)
      child.once('close', (exitCode, signal) => {
        if (this.processes.get(run.id) === child) this.processes.delete(run.id)
        resolveProcess({ exitCode, signal, stdout, stderr })
      })
      if (run.state === 'cancelling' || run.state === 'interrupted') {
        this.terminateProcess(run.id, child)
      }
    })
  }

  private terminateProcess(runId: string, child: ChildProcess): void {
    child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (this.processes.get(runId) === child) child.kill('SIGKILL')
    }, 2_000)
    timer.unref()
    child.once('close', () => clearTimeout(timer))
  }

  private spawnDetached(args: string[]): Promise<ProcessResult> {
    const diagnosticRun = { id: `audit_${Date.now()}` } as FetchRun
    return this.spawnProcess(diagnosticRun, args)
  }

  private async watchBatchResults(run: FetchRun, files: RunFiles, indexes: number[]): Promise<void> {
    const watcher = chokidar.watch(files.batchResults, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
    })
    const update = (): void => {
      void this.previewBatchRecords(run, files, indexes).catch(() => undefined)
    }
    watcher.on('add', update).on('change', update)
    this.watchers.set(run.id, watcher)
  }

  private async stopResultWatcher(runId: string): Promise<void> {
    const watcher = this.watchers.get(runId)
    this.watchers.delete(runId)
    await watcher?.close()
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

  private async previewBatchRecords(run: FetchRun, files: RunFiles, indexes: number[]): Promise<void> {
    for (const record of await this.recordsFromJsonl(files.batchResults)) {
      const original = indexes[record.index - 1]
      if (!original) continue
      const item = run.items[original - 1]
      if (!item || item.stage === 'terminal') continue
      this.projectRecord(item, record)
      item.stage = 'acceptance'
      item.state = 'running'
    }
    await this.persist(run)
  }

  private async applyBatchRecords(run: FetchRun, files: RunFiles, indexes: number[]): Promise<void> {
    const records = await this.recordsFromJsonl(files.batchResults)
    const byIndex = new Map(records.map((record) => [record.index, record]))
    for (const [position, originalIndex] of indexes.entries()) {
      const record = byIndex.get(position + 1) ?? parseTerminalRecord({
        index: position + 1,
        status: run.state === 'cancelling' ? 'cancelled' : 'error',
        reason: 'paper-fetch 没有为该输入写入 terminal JSONL record。'
      }) as ParsedTerminalRecord
      await this.acceptItem(run, originalIndex, record)
    }
  }

  private projectRecord(item: FetchItem, record: ParsedTerminalRecord): void {
    item.attempt = Math.max(item.attempt, record.attempt)
    item.canonicalDoi = record.canonicalDoi
    item.canonicalUrl = record.canonicalUrl
    item.title = record.title
    item.provider = record.provider
    item.reason = record.reason
    item.errorCode = record.errorCode
    item.candidates = record.candidates
    item.acceptance = record.acceptance
    item.contentKind = record.contentKind
    item.completionOrder = record.completionOrder
  }

  private async acceptItem(run: FetchRun, originalIndex: number, record: ParsedTerminalRecord): Promise<void> {
    const item = run.items[originalIndex - 1]
    if (!item) return
    this.projectRecord(item, record)
    item.stage = 'terminal'

    if (record.status === 'cancelled') {
      item.state = 'cancelled'
      item.reason = record.reason ?? '任务已取消。'
      return
    }
    if (actionRequired(record)) {
      item.acceptance = 'action_required'
      item.state = 'action_required'
      if (record.provider && ['no_access', 'auth_required', 'challenge'].includes(record.status)) {
        item.reason = `${record.reason ?? '需要人工认证或合法访问权限。'}\n人工命令：paper-fetch auth ${record.provider}`
      }
      return
    }

    if (!record.acceptance && !['ok', 'success', 'complete'].includes(record.status)) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.reason = record.reason ?? `paper-fetch 返回状态 ${record.status}。`
      return
    }

    if (!record.outputPath) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.errorCode = item.errorCode ?? 'missing_markdown_output'
      item.reason = record.reason ?? '抓取未返回 Markdown 产物路径。'
      return
    }
    const files = this.files(run.id)
    const output = await canonicalFileInside(files.temporaryDirectory, record.outputPath)
    if (!output) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.errorCode = 'output_path_outside_staging'
      item.reason = 'paper-fetch 返回的产物不在本次暂存区内。'
      return
    }

    let raw: string
    try {
      raw = await readFile(output, 'utf8')
    } catch (error) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.reason = `无法读取抓取产物：${errorMessage(error)}`
      return
    }
    const actualHash = sha256(raw)
    if (record.outputSha256 && record.outputSha256.toLowerCase() !== actualHash) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.errorCode = 'output_hash_mismatch'
      item.reason = '产物 SHA-256 与 manifest 不一致。'
      return
    }
    const parsed = parsePaperMarkdown(raw, safeOutputBasename(output))
    if (parsed.kind !== 'paper') {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.errorCode = 'untrusted_markdown'
      item.reason = parsed.reason
      return
    }
    const expectedDoi = record.canonicalDoi ?? doiFromInput(item.query)
    if (expectedDoi && parsed.paper.metadata.doi !== expectedDoi) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.errorCode = 'identity_mismatch'
      item.reason = 'Markdown DOI 与已解析身份不一致。'
      return
    }
    const expectedUrl = canonicalHttpUrl(record.canonicalUrl)
    if (
      !expectedDoi && expectedUrl && parsed.paper.metadata.url &&
      parsed.paper.metadata.url !== expectedUrl
    ) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.errorCode = 'identity_mismatch'
      item.reason = 'Markdown 来源 URL 与已解析身份不一致。'
      return
    }
    if (run.refreshPaperId) {
      const existing = this.database.get(run.refreshPaperId)
      const existingDoi = normalizeDoi(existing?.doi)
      const existingUrl = canonicalHttpUrl(existing?.url)
      const identityMatches = Boolean(existing) && (
        existingDoi
          ? parsed.paper.metadata.doi === existingDoi
          : Boolean(existingUrl && parsed.paper.metadata.url === existingUrl)
      )
      if (!identityMatches) {
        item.acceptance = 'failed'
        item.state = 'failed'
        item.errorCode = 'refresh_identity_mismatch'
        item.reason = existingDoi || existingUrl
          ? '刷新产物与原论文身份不一致，旧全文已保留。'
          : '原论文没有可核验的 DOI 或来源 URL，无法安全刷新；旧全文已保留。'
        return
      }
    }
    if (!run.refreshPaperId && parsed.paper.metadata.doi) {
      const duplicate = this.database.findByDoi(parsed.paper.metadata.doi)
      if (duplicate) {
        item.canonicalDoi = parsed.paper.metadata.doi
        item.title = parsed.paper.metadata.title
        item.contentKind = parsed.paper.contentKind
        item.acceptance = 'action_required'
        item.state = 'action_required'
        item.existingPaperId = duplicate.id
        item.reason = '抓取解析出的 DOI 已存在于当前项目，未创建副本。'
        return
      }
      const prior = run.items.find((candidate) => (
        candidate.index !== item.index &&
        candidate.canonicalDoi === parsed.paper.metadata.doi &&
        candidate.outputPath !== null &&
        ['complete', 'degraded', 'limited'].includes(candidate.state)
      ))
      if (prior) {
        item.canonicalDoi = parsed.paper.metadata.doi
        item.title = parsed.paper.metadata.title
        item.contentKind = parsed.paper.contentKind
        item.acceptance = 'action_required'
        item.state = 'action_required'
        item.existingPaperId = paperIdFor(parsed.paper.metadata.doi, null, '')
        item.reason = `与第 ${prior.index} 条抓取结果解析为同一 DOI，未创建副本。`
        return
      }
    }

    const missingAssets = await this.missingAssets(output, parsed.paper.assetSources, files.temporaryDirectory)
    let overall = record.acceptance ?? (
      parsed.paper.hasFulltext ? 'complete' : 'limited'
    )
    if (!parsed.paper.hasFulltext && ['complete', 'degraded'].includes(overall)) {
      overall = 'limited'
    }
    if (overall === 'complete' && (missingAssets.length > 0 || parsed.paper.remoteAssetSources.length > 0)) {
      overall = 'degraded'
    }
    if (['failed', 'action_required'].includes(overall)) {
      item.acceptance = overall
      item.state = stateForOverall(overall)
      item.reason = record.reason ?? 'paper-fetch 验收未通过。'
      return
    }
    if (run.refreshPaperId && !parsed.paper.hasFulltext) {
      item.acceptance = 'limited'
      item.state = 'limited'
      item.contentKind = parsed.paper.contentKind
      item.errorCode = 'refresh_not_fulltext'
      item.reason = '刷新结果只有摘要或元数据，旧全文已保留。'
      return
    }
    if (
      run.refreshPaperId &&
      (missingAssets.length > 0 || parsed.paper.remoteAssetSources.length > 0)
    ) {
      item.acceptance = 'degraded'
      item.state = 'degraded'
      item.errorCode = 'refresh_asset_validation_failed'
      item.reason = `刷新有 ${missingAssets.length + parsed.paper.remoteAssetSources.length} 个正文资产未通过本地验收，旧全文已保留。`
      return
    }

    let finalPath: string
    try {
      const missingAssetSet = new Set(missingAssets)
      finalPath = await this.archiveOutput(
        run,
        item,
        output,
        raw,
        parsed.paper.assetSources.filter((source) => !missingAssetSet.has(source))
      )
    } catch (error) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.errorCode = 'archive_commit_failed'
      item.reason = `${errorMessage(error)}${run.refreshPaperId ? '；旧正文未替换，资产变更已进入回滚流程。' : ''}`
      return
    }
    item.outputPath = finalPath
    item.outputSha256 = actualHash
    item.canonicalDoi = parsed.paper.metadata.doi || record.canonicalDoi
    item.title = parsed.paper.metadata.title
    item.contentKind = parsed.paper.contentKind
    item.acceptance = overall
    item.state = stateForOverall(overall)
    const unavailableAssets = missingAssets.length + parsed.paper.remoteAssetSources.length
    item.reason = unavailableAssets > 0
      ? `正文已保存，但 ${unavailableAssets} 个图片资产缺失、越界或为远程资源，已阻止加载。`
      : record.reason
  }

  private async missingAssets(output: string, sources: string[], stagingRoot: string): Promise<string[]> {
    const missing: string[] = []
    for (const source of sources) {
      const candidate = candidateAssetPath(output, source)
      if (!candidate || !await validatedImageFileInside(stagingRoot, candidate)) missing.push(source)
    }
    return missing
  }

  private async archiveOutput(
    run: FetchRun,
    item: FetchItem,
    output: string,
    raw: string,
    assetSources: string[]
  ): Promise<string> {
    if (run.refreshPaperId) {
      const target = this.database.filePath(run.refreshPaperId)
      if (!target) throw new Error('刷新目标不存在。')
      await this.replaceRefresh(output, target, raw, assetSources)
      return target
    }

    const parsed = parsePaperMarkdown(raw, safeOutputBasename(output))
    if (parsed.kind !== 'paper') throw new Error('暂存 Markdown 不是可信论文。')
    const provisionalRelative = `papers/${safeOutputBasename(output)}`
    const identityPaperId = paperIdFor(
      parsed.paper.metadata.doi || null,
      parsed.paper.metadata.url || item.canonicalUrl,
      provisionalRelative
    )
    const duplicate = parsed.paper.metadata.doi
      ? this.database.findByDoi(parsed.paper.metadata.doi)
      : null
    if (duplicate) {
      item.existingPaperId = duplicate.id
      item.reason = '同批或当前项目中的相同 DOI 已存在；本项映射到现有论文。'
      return this.database.filePath(duplicate.id) ?? duplicate.relativePath
    }
    const archiveDirectory = parsed.paper.metadata.doi || parsed.paper.metadata.url || item.canonicalUrl
      ? identityPaperId
      : `paper-${sha256(item.query).slice(0, 16)}`
    const directory = join(this.layout.papers, archiveDirectory)
    await mkdir(directory, { recursive: true })
    if (!isPathInside(this.layout.root, await canonicalDirectory(directory))) {
      throw new Error('归档目录通过符号链接越出了项目。')
    }
    const target = join(directory, safeOutputBasename(output))
    await this.copyAssets(output, target, assetSources)
    await atomicWriteFile(target, raw)
    return target
  }

  private async copyAssets(sourceMarkdown: string, targetMarkdown: string, sources: string[]): Promise<void> {
    for (const source of sources) {
      const from = candidateAssetPath(sourceMarkdown, source)
      const to = candidateAssetPath(targetMarkdown, source)
      if (!from || !to || !isPathInside(this.layout.root, to)) {
        throw new Error(`资产路径不安全：${source}`)
      }
      const canonical = await validatedImageFileInside(this.filesRootFor(sourceMarkdown), from)
      if (!canonical) throw new Error(`资产不存在或越出暂存区：${source}`)
      await mkdir(dirname(to), { recursive: true })
      if (!isPathInside(this.layout.root, await canonicalDirectory(dirname(to)))) {
        throw new Error(`资产目标目录越出项目：${source}`)
      }
      const data = await readFile(canonical)
      await atomicWriteFile(to, data)
    }
  }

  private async replaceRefresh(
    sourceMarkdown: string,
    targetMarkdown: string,
    markdown: string,
    sources: string[]
  ): Promise<void> {
    const changes: Array<{ path: string; previous: Uint8Array | null }> = []
    try {
      for (const source of sources) {
        const from = candidateAssetPath(sourceMarkdown, source)
        const to = candidateAssetPath(targetMarkdown, source)
        if (!from || !to || !isPathInside(this.layout.root, to)) throw new Error(`资产路径不安全：${source}`)
        const canonicalSource = await validatedImageFileInside(this.filesRootFor(sourceMarkdown), from)
        if (!canonicalSource) throw new Error(`资产不存在或格式不安全：${source}`)
        await mkdir(dirname(to), { recursive: true })
        if (!isPathInside(this.layout.root, await canonicalDirectory(dirname(to)))) {
          throw new Error(`资产目标目录越出项目：${source}`)
        }
        const existing = await canonicalFileInside(this.layout.root, to)
        let previous: Uint8Array | null = null
        if (existing) {
          previous = await readFile(existing)
        } else {
          try {
            await lstat(to)
            throw new Error(`既有资产路径不是安全的项目内文件：${source}`)
          } catch (error) {
            if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
          }
        }
        changes.push({ path: to, previous })
        await atomicWriteFile(to, await readFile(canonicalSource))
      }
      await atomicWriteFile(targetMarkdown, markdown)
    } catch (error) {
      for (const change of changes.reverse()) {
        if (change.previous !== null) await atomicWriteFile(change.path, change.previous).catch(() => undefined)
        else await unlink(change.path).catch(() => undefined)
      }
      throw error
    }
  }

  private filesRootFor(markdownPath: string): string {
    const relativePath = relative(this.layout.temporary, markdownPath)
    const runDirectory = relativePath.split(/[\\/]/, 1)[0]
    return resolve(this.layout.temporary, runDirectory || '.')
  }

  private resolveMergedInputs(run: FetchRun): void {
    const primaryByDoi = new Map<string, FetchItem>()
    for (const item of run.items) {
      const doi = item.canonicalDoi ?? doiFromInput(item.query)
      if (!doi) continue
      const primary = primaryByDoi.get(doi)
      if (!primary && item.stage === 'terminal') {
        primaryByDoi.set(doi, item)
        continue
      }
      if (primary && item.stage !== 'terminal') {
        const query = item.query
        const index = item.index
        Object.assign(item, structuredClone(primary), { query, index })
        item.reason = `与第 ${primary.index} 条输入合并；${primary.reason ?? '共享同一验收结果。'}`
      }
    }
  }

  private finishRun(run: FetchRun): void {
    for (const item of run.items) {
      if (item.state === 'pending' || item.state === 'running') {
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
      const raw = await readFile(path, 'utf8')
      try {
        const value: unknown = JSON.parse(raw)
        if (Array.isArray(value)) return value
        if (isRecord(value) && Array.isArray(value.results)) return value.results
        return [value]
      } catch {
        const value: unknown = YAML.parse(raw)
        return Array.isArray(value) ? value : [value]
      }
    } catch {
      return []
    }
  }

  private async failRun(run: FetchRun, error: unknown): Promise<void> {
    await this.stopResultWatcher(run.id)
    const stopping = run.state === 'cancelling' || run.state === 'interrupted'
    for (const item of run.items) {
      if (['pending', 'running'].includes(item.state)) {
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
