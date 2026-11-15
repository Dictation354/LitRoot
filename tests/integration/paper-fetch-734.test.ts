import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ServiceEventBus } from '../../src/service/events.js'
import { LitRootProject } from '../../src/service/project.js'
import { initializeProject } from '../../src/service/project-layout.js'
import { waitFor } from '../helpers.js'

const python = process.env.LITROOT_PAPER_FETCH_PYTHON
const source = process.env.LITROOT_PAPER_FETCH_SOURCE
const adapter = fileURLToPath(new URL('../fixtures/paper-fetch-7.3.4/offline-cli.py', import.meta.url))
const fixtures: Array<{ project: LitRootProject; root: string }> = []

interface RecordValue {
  index: number
  run_id: string
  query: string
  record_status: string
  tool_version: string
  output_artifacts: Array<{ kind: string; path: string; sha256: string }>
  error: { code: string } | null
}

interface ProgressEvent {
  paper_fetch_progress: boolean
  protocol_version: number
  run_id: string
  type: string
  index: number
  stage?: string
  status?: string
  record?: RecordValue
}

async function jsonLines<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, 'utf8').catch(() => '')
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T)
}

async function fixture(commitGate = false) {
  const root = await mkdtemp(join(tmpdir(), 'litroot-pf734-'))
  const project = new LitRootProject(await initializeProject(root), new ServiceEventBus(), {
    executable: python!, prefixArgs: [adapter],
    envDefaults: {
      LITROOT_PAPER_FETCH_SOURCE: source!, LITROOT_CONTRACT_ROOT: root,
      LITROOT_CONTRACT_COMMIT_GATE: commitGate ? '1' : '0'
    }
  })
  fixtures.push({ project, root })
  await project.start()
  return { project, root }
}

async function finish(project: LitRootProject, id: string) {
  await waitFor(() => ['completed', 'cancelled', 'interrupted'].includes(project.fetch.get(id).state), 12_000)
  return project.fetch.get(id)
}

async function verifyRecords(project: LitRootProject, root: string, id: string) {
  const run = project.fetch.get(id)
  const batch = run.executionIndexes.length > 1
  const records = batch
    ? await jsonLines<RecordValue>(join(project.layout.runs, `${id}.results.jsonl`))
    : [JSON.parse(await readFile(join(project.layout.runs, `${id}.paper-fetch.json`), 'utf8')) as RecordValue]
  const events = (await jsonLines<ProgressEvent>(join(root, 'events.jsonl'))).filter((event) => event.paper_fetch_progress)
  expect(events[0]).toMatchObject({ type: 'run_started', index: 0, protocol_version: 1 })
  expect(events.every((event) => event.run_id === events[0]!.run_id && event.protocol_version === 1)).toBe(true)
  expect(records.map((record) => record.index)).toEqual(run.executionIndexes.map((_, index) => index + 1))
  const terminals = events.filter((event) => event.type === 'terminal')
  expect(terminals).toHaveLength(records.length)
  expect([...terminals].sort((a, b) => a.index - b.index).map((event) => event.record)).toEqual(records)
  for (const [position, event] of terminals.entries()) {
    expect(run.items[run.executionIndexes[event.index - 1]! - 1]!.completionOrder).toBe(position + 1)
    expect(events.slice(events.indexOf(event) + 1).filter((later) => later.index === event.index && later.type !== 'cancel_response')).toEqual([])
  }
  for (const record of records) {
    expect(record.tool_version).toBe('7.3.4')
    for (const artifact of record.output_artifacts) {
      expect(artifact.path.startsWith(join(project.layout.temporary, id))).toBe(true)
      expect(createHash('sha256').update(await readFile(artifact.path)).digest('hex')).toBe(artifact.sha256)
    }
  }
  const persisted = JSON.parse(await readFile(run.manifestPath, 'utf8'))
  expect(persisted).toEqual(run)
  return { records, events }
}

afterEach(async () => {
  for (const { project, root } of fixtures.splice(0)) {
    await writeFile(join(root, 'release-fetch'), '')
    await writeFile(join(root, 'release-terminal'), '')
    await project.close()
    await rm(root, { recursive: true, force: true })
  }
})

describe.skipIf(!(python && source))('7.3.4 real offline CLI and LitRoot archival', () => {
  it('fans out DOI spellings and a resolved title while archiving only one paper', async () => {
    const { project, root } = await fixture()
    const inputs = ['10.5555/shared', 'https://doi.org/10.5555/SHARED', 'Synthetic shared title']
    const created = await project.fetch.create({ projectId: project.layout.id, inputs })
    const run = await finish(project, created.id)
    expect(run.items.map((item) => item.state)).toEqual(['complete', 'action_required', 'action_required'])
    expect(project.summary().paperCount).toBe(1)
    expect(await jsonLines(join(root, 'fetches.jsonl'))).toHaveLength(1)
    const { records } = await verifyRecords(project, root, run.id)
    expect(records.map((record) => record.query)).toEqual(inputs)
    expect(records.map((record) => record.record_status)).toEqual(inputs.map(() => 'completed'))
    expect(new Set(records.map((record) => record.output_artifacts[0]!.path)).size).toBe(1)
    expect(await readFile(run.items[0]!.outputPath!)).toEqual(await readFile(records[0]!.output_artifacts[0]!.path))
  })

  it.each([{ indexes: [1] }, { indexes: [2] }, { indexes: [1, 2] }, { indexes: null }])('cancels logical duplicate inputs $indexes through stdin', async ({ indexes }) => {
    const { project, root } = await fixture()
    const inputs = ['10.5555/gated', 'https://doi.org/10.5555/GATED']
    if (indexes === null) inputs.push('10.5555/queued')
    const created = await project.fetch.create({ projectId: project.layout.id, inputs, concurrency: 1 })
    await waitFor(() => project.fetch.get(created.id).items[0]!.stage === 'fetching')
    if (indexes === null) await project.fetch.cancel(created.id)
    else for (const index of indexes) await project.fetch.cancelItem(created.id, index)
    await waitFor(async () => (await jsonLines(join(root, 'controls.jsonl'))).length === (indexes?.length ?? 1))
    await writeFile(join(root, 'release-fetch'), '')
    const run = await finish(project, created.id)
    const cancelled = indexes ?? [1, 2, 3]
    expect(run.state).toBe(indexes === null ? 'cancelled' : 'completed')
    expect(run.items.map((item) => item.state)).toEqual(inputs.map((_, index) => cancelled.includes(index + 1) ? 'cancelled' : 'complete'))
    expect(project.summary().paperCount).toBe(cancelled.length >= 2 ? 0 : 1)
    expect(await jsonLines(join(root, 'fetches.jsonl'))).toHaveLength(1)
    const { records, events } = await verifyRecords(project, root, run.id)
    expect(records.map((record) => record.record_status)).toEqual(inputs.map((_, index) => cancelled.includes(index + 1) ? 'aborted' : 'completed'))
    for (const index of cancelled) {
      expect(records[index - 1]!.error?.code).toBe('request_cancelled')
      expect(records[index - 1]!.output_artifacts).toEqual([])
    }
    expect(events.filter((event) => event.type === 'cancel_response').map((event) => event.index)).toEqual(indexes ?? [0])
  })

  it('archives an out-of-order completion before JSONL exists, then cancels the remaining input', async () => {
    const { project, root } = await fixture()
    const created = await project.fetch.create({ projectId: project.layout.id, inputs: ['10.5555/gated', '10.5555/fast'], concurrency: 2 })
    await waitFor(() => project.fetch.get(created.id).items[1]!.state === 'complete')
    expect(project.summary().paperCount).toBe(1)
    await expect(access(join(project.layout.runs, `${created.id}.results.jsonl`))).rejects.toMatchObject({ code: 'ENOENT' })
    await project.fetch.cancelItem(created.id, 2)
    expect(await jsonLines(join(root, 'controls.jsonl'))).toHaveLength(0)
    await project.fetch.cancel(created.id)
    const run = await finish(project, created.id)
    expect(run.items.map((item) => item.state)).toEqual(['cancelled', 'complete'])
    expect(project.summary().paperCount).toBe(1)
    const { events } = await verifyRecords(project, root, run.id)
    expect(events.filter((event) => event.type === 'terminal').map((event) => event.index)).toEqual([2, 1])
  })

  it('lets cancellation win after staging writes but before the batch terminal lock', async () => {
    const { project, root } = await fixture(true)
    const created = await project.fetch.create({ projectId: project.layout.id, inputs: ['10.5555/shared', '10.5555/shared'] })
    await waitFor(async () => access(join(root, 'before-terminal')).then(() => true, () => false))
    const staging = join(project.layout.temporary, created.id)
    expect((await readdir(staging)).filter((name) => name.endsWith('.md'))).toHaveLength(1)
    await project.fetch.cancel(created.id)
    await waitFor(async () => (await jsonLines(join(root, 'controls.jsonl'))).length === 1)
    await writeFile(join(root, 'release-terminal'), '')
    const run = await finish(project, created.id)
    expect(run.items.map((item) => item.state)).toEqual(['cancelled', 'cancelled'])
    expect(project.summary().paperCount).toBe(0)
    expect((await readdir(staging)).filter((name) => name.endsWith('.md'))).toHaveLength(1)
    const { records } = await verifyRecords(project, root, run.id)
    expect(records.every((record) => record.record_status === 'aborted' && record.output_artifacts.length === 0)).toBe(true)
  })

  it('keeps failure, degraded and limited results distinct in one batch', async () => {
    const { project, root } = await fixture()
    const created = await project.fetch.create({ projectId: project.layout.id, inputs: ['10.5555/failure', '10.5555/degraded', '10.5555/limited'] })
    const run = await finish(project, created.id)
    expect(run.items.map((item) => item.state)).toEqual(['failed', 'degraded', 'limited'])
    expect(run.items[0]!.errorCode).toBe('browser_context_create_failed')
    expect(run.items[0]!.outputPath).toBeNull()
    expect(run.items[1]!.reason).toContain('browser_runtime_prepare_timeout')
    expect(run.items[2]!.contentKind).toBe('abstract_only')
    expect(project.summary().paperCount).toBe(2)
    await verifyRecords(project, root, run.id)
  })

  it('keeps a single completion that holds the terminal lock when cancellation arrives', async () => {
    const { project, root } = await fixture(true)
    const created = await project.fetch.create({ projectId: project.layout.id, inputs: ['10.5555/shared'] })
    await waitFor(async () => access(join(root, 'before-terminal')).then(() => true, () => false))
    // The real single CLI holds the completion lock while writing this manifest.
    const manifest = join(project.layout.runs, `${created.id}.paper-fetch.json`)
    expect(JSON.parse(await readFile(manifest, 'utf8')).record_status).toBe('completed')
    await project.fetch.cancel(created.id)
    await waitFor(async () => (await jsonLines(join(root, 'received-controls.jsonl'))).length === 1)
    await writeFile(join(root, 'release-terminal'), '')
    const run = await finish(project, created.id)
    expect(run.items[0]!.state).toBe('complete')
    expect(project.summary().paperCount).toBe(1)
    const { records } = await verifyRecords(project, root, run.id)
    expect(records[0]!.record_status).toBe('completed')
  })

  it('archives single-manifest Markdown and its local image without moving staging evidence', async () => {
    const { project, root } = await fixture()
    const created = await project.fetch.create({ projectId: project.layout.id, inputs: ['10.5555/asset'] })
    const run = await finish(project, created.id)
    expect(run.items[0]!.state, JSON.stringify(run.items[0])).toBe('complete')
    const { records } = await verifyRecords(project, root, run.id)
    const artifact = records[0]!.output_artifacts.find((value) => value.kind.includes('markdown'))!
    const raw = await readFile(artifact.path, 'utf8')
    expect(await readFile(run.items[0]!.outputPath!, 'utf8')).toBe(raw)
    expect(raw).toContain('assets/figure.png')
    expect(await readFile(join(project.layout.papers, 'assets/figure.png'))).toEqual(await readFile(join(project.layout.temporary, run.id, 'assets/figure.png')))
    expect((await readdir(join(project.layout.temporary, run.id))).some((name) => name.endsWith('.part'))).toBe(false)
  })
})
