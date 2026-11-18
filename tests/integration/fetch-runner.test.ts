import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ServiceEventBus } from '../../src/service/events.js'
import { initializeProject } from '../../src/service/project-layout.js'
import { LitRootProject } from '../../src/service/project.js'
import { fetchRunSchema } from '../../src/shared/contracts.js'
import { createFakePaperFetch, paperMarkdown, waitFor, writePaper } from '../helpers.js'

const sandboxes: string[] = []

async function fixture(withPaper: boolean | readonly string[] = false) {
  const sandbox = await mkdtemp(join(tmpdir(), 'litroot-fetch-'))
  sandboxes.push(sandbox)
  const root = join(sandbox, 'project')
  await mkdir(root)
  if (Array.isArray(withPaper)) {
    for (const doi of withPaper) {
      await writePaper(root, `${doi.split('/')[1]}.md`, paperMarkdown({ doi, body: `Old full text for ${doi}.` }))
    }
  } else if (withPaper) {
    await writePaper(root, 'existing.md', paperMarkdown({ doi: '10.4242/existing', body: 'Old irreplaceable full text.' }))
  }
  const executable = await createFakePaperFetch(join(sandbox, 'bin'))
  const events = new ServiceEventBus()
  const project = new LitRootProject(await initializeProject(root), events, executable)
  await project.start()
  return { sandbox, root, project, executable, events }
}

async function terminal(project: LitRootProject, runId: string) {
  await waitFor(() => ['completed', 'cancelled', 'interrupted'].includes(project.fetch.get(runId).state), 10_000)
  return project.fetch.get(runId)
}

const browserStages = ['waiting_profile', 'executing_browser', 'browser_finished'] as const

async function browserFixture(withPaper = false) {
  const result = await fixture(withPaper)
  const script = await readFile(result.executable, 'utf8')
  await writeFile(result.executable, script.replace(
    "  event('stage', index, { stage: 'fetching' })",
    `  event('stage', index, { stage: 'fetching' })
  for (const stage of ${JSON.stringify(browserStages)}) {
    const data = stage === 'waiting_profile' ? { profile: '/fake/profile' }
      : stage === 'executing_browser' ? { profile: '/fake/profile', queue_seconds: 0.25 }
      : { execution_seconds: 0.5, queue_seconds: 0.25 }
    event('stage', index, { stage, ...data })
    if (query.includes('hold ' + stage)) {
      for (let step = 0; step < 150 && !cancelled.has(index); step += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    } else await new Promise((resolve) => setTimeout(resolve, 50))
    if (cancelled.has(index)) break
  }
  if (query.includes('browser crash')) {
    console.error('Browser crashed')
    event('stage', index, { stage: 'invalid_stage' })
    process.exit(2)
  }`
  ).replace(
    "  if (query.includes('protocol noise')) event('terminal', index, { record: result })",
    "  if (query.includes('protocol noise')) event('terminal', index, { record: result })\n  event('stage', index, { stage: 'browser_finished', execution_seconds: 0.5, queue_seconds: 0.25 })"
  ))
  return result
}

afterEach(async () => {
  delete process.env.PAPER_FETCH_ARGS_LOG
  delete process.env.PAPER_FETCH_TEST_FAILURE
  for (const path of sandboxes.splice(0).reverse()) await rm(path, { recursive: true, force: true })
})

describe('paper-fetch task orchestration', () => {
  it.each(['manifest', 'paths', 'body', 'bad-hash'])('recovers a single result from a CLI receipt (%s)', async (mode) => {
    const { project, executable } = await fixture(true)
    const script = await readFile(executable, 'utf8')
    await writeFile(executable, script.replace(
      '  if (manifest) await writeFile(manifest, JSON.stringify(result))',
      `  const mode = ${JSON.stringify(mode)}
  const readingDir = join(outputDir, '.paper-fetch-results', runId, '1')
  await mkdir(readingDir, { recursive: true })
  const body = join(readingDir, 'body.md')
  await writeFile(body, await readFile(artifact.path))
  const detailedManifest = join(readingDir, 'manifest.json')
  if (mode === 'manifest' || mode === 'bad-hash') {
    const detailed = mode === 'bad-hash' ? { ...result, output_artifacts: [{ ...artifact, sha256: '0'.repeat(64) }] } : result
    await writeFile(detailedManifest, JSON.stringify(detailed))
  }
  const receipt = {
    schema_version: 1, contract: 'paper-fetch/receipt', index: 1, status: 'completed',
    identity: { doi: result.doi, title: 'Receipt paper' }, error: null,
    acceptance: { overall: 'complete', identity: 'resolved', content: 'fulltext' }, content_kind: 'fulltext',
    manifest_path: detailedManifest, body_path: body,
    output_paths: mode === 'body' ? [] : [join(outputDir, 'paper.json'), mode === 'manifest' ? join(outputDir, 'missing.md') : artifact.path]
  }`
    ).replace('  console.log(JSON.stringify(result))', '  console.log(JSON.stringify(receipt))'))
    try {
      const created = await project.fetch.create({ projectId: project.layout.id,
        inputs: ['10.4242/existing', 'missing event receipt'] })
      const done = await terminal(project, created.id)
      expect(done.executionIndexes).toEqual([2])
      expect(done.items[0]?.state).toBe('action_required')
      const item = done.items[1]!
      if (mode === 'bad-hash') {
        expect(item).toMatchObject({ state: 'failed', errorCode: 'output_hash_mismatch' })
        expect(project.summary().paperCount).toBe(1)
      } else {
        expect(item).toMatchObject({ stage: 'terminal', state: 'complete', completionOrder: null })
        expect(item.outputPath).toBe(join(project.layout.papers, mode === 'body' ? 'body.md' : 'FetchBot_2025_Fetched_paper_1.md'))
        expect(await readFile(item.outputPath!, 'utf8')).toContain('Complete fake full text body.')
        expect(project.summary()).toMatchObject({ paperCount: 2, issueCount: 0 })
      }
    } finally { await project.close() }
  })

  it.each([1, 2])('publishes browser stages with original indexes and accepts terminals (%i active items)', async (count) => {
    const { project, events } = await browserFixture(true)
    const updates: Array<ReturnType<typeof project.fetch.get>> = []
    const unsubscribe = events.subscribe((event) => {
      if (event.type === 'fetch.changed') updates.push(event.run)
    })
    try {
      const created = await project.fetch.create({ projectId: project.layout.id,
        inputs: ['10.4242/existing', ...Array.from({ length: count }, (_, index) => `browser paper ${index}`)] })
      const done = await terminal(project, created.id)
      expect(done.executionIndexes).toEqual(Array.from({ length: count }, (_, index) => index + 2))
      expect(done.items[0]).toMatchObject({ stage: 'terminal', state: 'action_required' })
      for (const item of done.items.slice(1)) {
        const stages = updates.map((update) => update.items[item.index - 1]?.stage)
        expect(stages).toEqual(expect.arrayContaining(['acceptance', 'terminal']))
        const browserUpdates = updates.filter((update) => browserStages.includes(update.items[item.index - 1]?.stage as typeof browserStages[number]))
        expect([...new Set(browserUpdates.map((update) => update.items[item.index - 1]?.stage))]).toEqual(browserStages)
        for (const update of browserUpdates) {
          expect(fetchRunSchema.safeParse(update).success).toBe(true)
          expect(update.items[item.index - 1]).toMatchObject({ state: 'running', stageStartedAt: expect.any(String) })
          expect(update.items[0]?.stage).toBe('terminal')
        }
        expect(item).toMatchObject({ stage: 'terminal', state: 'complete', completionOrder: count - item.index + 2 })
      }
      expect(done.completionCounter).toBe(count)
      expect(project.search({ projectId: project.layout.id }).total).toBe(count + 1)
    } finally { unsubscribe(); await project.close() }
  })

  it.each([1, 2])('excludes browser progress from stderr while preserving actual diagnostics (%i items)', async (count) => {
    const { project } = await browserFixture()
    try {
      const created = await project.fetch.create({ projectId: project.layout.id,
        inputs: Array.from({ length: count }, () => 'browser crash') })
      const done = await terminal(project, created.id)
      for (const item of done.items) {
        expect(item.state).toBe('failed')
        expect(item.reason).toContain('Browser crashed')
        expect(item.reason).toContain('"stage":"invalid_stage"')
        for (const stage of browserStages) expect(item.reason).not.toContain(`"stage":"${stage}"`)
      }
    } finally { await project.close() }
  })

  it.each(browserStages)('cancels an item during %s using its mapped engine index', async (stage) => {
    const { project } = await browserFixture(true)
    try {
      const created = await project.fetch.create({ projectId: project.layout.id,
        inputs: ['10.4242/existing', 'browser remaining', `hold ${stage}`] })
      await waitFor(() => project.fetch.get(created.id).items[2]?.stage === stage)
      await project.fetch.cancelItem(created.id, 3)
      const done = await terminal(project, created.id)
      expect(done.executionIndexes).toEqual([2, 3])
      expect(done.items.map((item) => item.state)).toEqual(['action_required', 'complete', 'cancelled'])
      expect(done.items[2]).toMatchObject({ stage: 'terminal', reason: 'Cancelled by control', completionOrder: 1 })
      expect(done.items[1]?.completionOrder).toBe(2)
    } finally { await project.close() }
  })

  it('keeps batch input order while reporting complete, limited, ambiguity, auth and failure independently', async () => {
    const { sandbox, project } = await fixture()
    const argsLog = join(sandbox, 'paper-fetch-args.json')
    process.env.PAPER_FETCH_ARGS_LOG = argsLog
    const created = await project.fetch.create({
      projectId: project.layout.id,
      inputs: [
        '10.5555/complete',
        'limited paper',
        'ambiguous paper',
        'auth paper',
        'failed paper'
      ],
      concurrency: 4
    })
    const run = await terminal(project, created.id)
    expect(run.items.map((item) => item.index)).toEqual([1, 2, 3, 4, 5])
    expect(run.items.map((item) => item.state)).toEqual([
      'complete', 'limited', 'action_required', 'action_required', 'failed'
    ])
    expect(run.items[0]?.completionOrder).toBe(5)
    expect(run.items[3]?.authCommand).toBe('paper-fetch auth wiley')
    expect(project.search({ projectId: project.layout.id, query: 'Fetched' }).total).toBe(2)
    const args = JSON.parse(await readFile(argsLog, 'utf8')) as string[]
    expect(args).toContain('--query-file')
    expect(args).toContain('--batch-results')
    expect(args).not.toContain('--run-manifest')
    expect(args).not.toContain('--resume')
    expect(args).toEqual(expect.arrayContaining([
      '--artifact-mode', 'markdown-assets', '--asset-profile', 'body',
      '--include-refs', 'all', '--max-tokens', 'full_text'
    ]))
    delete process.env.PAPER_FETCH_ARGS_LOG
    await project.close()
  })

  it('reports CLI startup errors and restores a batch of more than 50 items without a paper-fetch manifest', async () => {
    const { project, executable } = await fixture()
    process.env.PAPER_FETCH_TEST_FAILURE = 'paper-fetch: error: unrecognized arguments: --run-manifest'
    const inputs = Array.from({ length: 51 }, (_, index) => `10.5555/paper-${index}`)
    const created = await project.fetch.create({
      projectId: project.layout.id, inputs
    })
    const failed = await terminal(project, created.id)
    for (const item of failed.items) {
      expect(item.state).toBe('failed')
      expect(item.reason).toContain('exited with code 2')
      expect(item.reason).toContain('unrecognized arguments: --run-manifest')
    }
    await expect(readFile(join(project.layout.runs, `${created.id}.paper-fetch.json`))).rejects.toMatchObject({ code: 'ENOENT' })
    await project.close()
    delete process.env.PAPER_FETCH_TEST_FAILURE

    const reopened = new LitRootProject(project.layout, new ServiceEventBus(), executable)
    await reopened.start()
    await reopened.fetch.resume(created.id)
    const finished = await terminal(reopened, created.id)
    expect(finished.items.map((item) => item.query)).toEqual(inputs)
    expect(finished.items.map((item) => item.state)).toEqual(inputs.map(() => 'complete'))
    expect(finished.items.map((item) => item.attempt)).toEqual(inputs.map(() => 2))
    await reopened.close()
  })

  it.each([1, 2])('resumes only %i failed batch refresh items and preserves their original targets', async (count) => {
    const dois = ['10.4242/complete', ...Array.from({ length: count }, (_, index) => `10.4242/retry-${index}`)]
    const { sandbox, project } = await fixture(dois)
    const argsLog = join(sandbox, 'resume-args.json')
    process.env.PAPER_FETCH_ARGS_LOG = argsLog
    const papers = project.search({ projectId: project.layout.id }).items
    const byDoi = new Map(papers.map((paper) => [paper.doi, paper]))
    const created = await project.fetch.create({
      projectId: project.layout.id, inputs: dois,
      refreshPaperIds: dois.map((doi) => byDoi.get(doi)?.id ?? '')
    })
    const first = await terminal(project, created.id)
    expect(first.items.map((item) => item.state)).toEqual(['complete', ...Array(count).fill('failed')])
    expect(first.items[1]?.reason).toBe('Fake network failure')

    await project.fetch.resume(created.id)
    const finished = await terminal(project, created.id)
    expect(finished.items[0]).toEqual(first.items[0])
    expect(finished.items.map((item) => item.state)).toEqual(dois.map(() => 'complete'))
    expect(finished.items.slice(1).map((item) => item.attempt)).toEqual(Array(count).fill(2))
    expect(finished.executionIndexes).toEqual(Array.from({ length: count }, (_, index) => index + 2))
    for (const doi of dois) {
      const paper = byDoi.get(doi)!
      const relativePath = project.getPaper(paper.id)?.relativePath ?? ''
      expect(await readFile(join(project.layout.root, relativePath), 'utf8')).toContain(`Fetched ${doi}`)
    }
    const args = JSON.parse(await readFile(argsLog, 'utf8')) as string[]
    expect(args).toContain('--overwrite')
    expect(args).not.toContain('--resume')
    expect(args).not.toContain('--run-manifest')
    if (count > 1) {
      expect(await readFile(args[args.indexOf('--query-file') + 1]!, 'utf8')).toBe(`${dois.slice(1).join('\n')}\n`)
    } else {
      expect(args[args.indexOf('--query') + 1]).toBe(dois[1])
    }
    await project.close()
  })

  it('does not reuse old JSONL records when a resumed batch exits before writing results', async () => {
    const { project } = await fixture()
    const created = await project.fetch.create({
      projectId: project.layout.id, inputs: ['10.5555/complete', 'retry first', 'retry second']
    })
    const first = await terminal(project, created.id)
    expect(first.items.map((item) => item.state)).toEqual(['complete', 'failed', 'failed'])
    process.env.PAPER_FETCH_TEST_FAILURE = 'paper-fetch: output directory is not writable'
    await project.fetch.resume(created.id)
    const finished = await terminal(project, created.id)
    expect(finished.items[0]).toEqual(first.items[0])
    for (const item of finished.items.slice(1)) {
      expect(item.state).toBe('failed')
      expect(item.reason).toContain('output directory is not writable')
      expect(item.reason).toContain('exited with code 2')
    }
    await project.close()
  })

  it('blocks an existing DOI before invoking a duplicate archive', async () => {
    const { project } = await fixture(true)
    const existing = project.search({ projectId: project.layout.id }).items[0]
    const created = await project.fetch.create({
      projectId: project.layout.id,
      inputs: ['Smith et al. Existing paper. DOI: 10.4242/existing.']
    })
    const run = await terminal(project, created.id)
    expect(run.items[0]).toMatchObject({
      state: 'action_required',
      acceptance: 'action_required',
      existingPaperId: existing?.id
    })
    expect(project.search({ projectId: project.layout.id }).total).toBe(1)
    await project.close()
  })

  it('archives the generated filename directly in papers without a hash directory', async () => {
    const { sandbox, project } = await fixture()
    const argsLog = join(sandbox, 'paper-fetch-single-args.json')
    process.env.PAPER_FETCH_ARGS_LOG = argsLog
    const created = await project.fetch.create({
      projectId: project.layout.id,
      inputs: ['10.5555/generated-name']
    })

    const run = await terminal(project, created.id)
    const expectedFilename = `FetchBot_2025_${'A'.repeat(165)}.md`

    expect(run.items[0]?.state).toBe('complete')
    expect(run.items[0]?.outputPath).toBe(join(project.layout.papers, expectedFilename))
    expect(await readdir(project.layout.papers)).toEqual([expectedFilename])
    expect(JSON.parse(await readFile(argsLog, 'utf8')) as string[]).not.toContain('--output')
    delete process.env.PAPER_FETCH_ARGS_LOG
    await project.close()
  })

  it('preserves an existing paper when a different DOI produces the same filename', async () => {
    const { project } = await fixture()
    const first = await project.fetch.create({ projectId: project.layout.id, inputs: ['10.5555/first'] })
    const saved = (await terminal(project, first.id)).items[0]!
    const original = await readFile(saved.outputPath!, 'utf8')
    const second = await project.fetch.create({ projectId: project.layout.id, inputs: ['10.5555/second'] })
    const rejected = (await terminal(project, second.id)).items[0]!

    expect(rejected).toMatchObject({ state: 'failed', errorCode: 'archive_commit_failed' })
    expect(rejected.reason).toContain('重名')
    expect(await readFile(saved.outputPath!, 'utf8')).toBe(original)
    expect(await readdir(project.layout.papers)).toEqual(['FetchBot_2025_Fetched_paper_1.md'])
    expect(project.search({ projectId: project.layout.id }).total).toBe(1)
    await project.close()
  })

  it.each([false, true])('preserves relative image paths and refuses asset collisions (existing=%s)', async (existing) => {
    const { project } = await fixture()
    const asset = join(project.layout.papers, 'assets', 'figure.png')
    if (existing) {
      await mkdir(join(project.layout.papers, 'assets'))
      await writeFile(asset, 'Existing image bytes')
    }
    const created = await project.fetch.create({ projectId: project.layout.id, inputs: ['local asset'] })
    const item = (await terminal(project, created.id)).items[0]!

    if (existing) {
      expect(item).toMatchObject({ state: 'failed', errorCode: 'archive_commit_failed' })
      expect(item.reason).toContain('重名')
      expect(await readFile(asset, 'utf8')).toBe('Existing image bytes')
      expect(await readdir(project.layout.papers)).toEqual(['assets'])
    } else {
      expect(item.state).toBe('complete')
      expect(item.outputPath).toBe(join(project.layout.papers, 'FetchBot_2025_Fetched_paper_1.md'))
      expect(await readFile(item.outputPath!, 'utf8')).toContain('![Local figure](assets/figure.png)')
      expect(await readFile(asset)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    }
    await project.close()
  })

  it('keeps the old full text when refresh produces only an abstract', async () => {
    const { project } = await fixture(true)
    const existing = project.search({ projectId: project.layout.id }).items[0]
    if (!existing) throw new Error('Expected existing paper.')
    const path = project.getPaper(existing.id)?.relativePath
    const original = await readFile(join(project.layout.root, path ?? ''), 'utf8')
    const created = await project.fetch.create({
      projectId: project.layout.id,
      inputs: ['10.4242/existing limited refresh'],
      refreshPaperId: existing.id
    })
    const run = await terminal(project, created.id)
    expect(run.items[0]).toMatchObject({ state: 'limited', errorCode: 'refresh_not_fulltext' })
    expect(await readFile(join(project.layout.root, path ?? ''), 'utf8')).toBe(original)
    await project.close()
  })

  it('refreshes multiple existing papers in one run and keeps item targets aligned', async () => {
    const dois = ['10.4242/first', '10.4242/second']
    const { project } = await fixture(dois)
    const papers = project.search({ projectId: project.layout.id }).items
    const byDoi = new Map(papers.map((paper) => [paper.doi, paper]))
    const created = await project.fetch.create({
      projectId: project.layout.id,
      inputs: dois,
      refreshPaperIds: dois.map((doi) => byDoi.get(doi)?.id ?? '')
    })

    const run = await terminal(project, created.id)
    expect(run.items.map((item) => item.state)).toEqual(['complete', 'complete'])
    for (const doi of dois) {
      const paper = byDoi.get(doi)
      const relativePath = paper ? project.getPaper(paper.id)?.relativePath : null
      expect(relativePath && await readFile(join(project.layout.root, relativePath), 'utf8'))
        .toContain('Complete fake full text body.')
    }
    expect(project.search({ projectId: project.layout.id }).total).toBe(2)
    await project.close()
  })

  it('isolates a limited result while the other batch refresh succeeds', async () => {
    const dois = ['10.4242/limited', '10.4242/complete'] as const
    const { project } = await fixture(dois)
    const papers = project.search({ projectId: project.layout.id }).items
    const byDoi = new Map(papers.map((paper) => [paper.doi, paper]))
    const limited = byDoi.get(dois[0])
    const complete = byDoi.get(dois[1])
    if (!limited || !complete) throw new Error('Expected both existing papers.')
    const limitedPath = project.getPaper(limited.id)?.relativePath ?? ''
    const completePath = project.getPaper(complete.id)?.relativePath ?? ''
    const limitedOriginal = await readFile(join(project.layout.root, limitedPath), 'utf8')
    const created = await project.fetch.create({
      projectId: project.layout.id,
      inputs: [`${dois[0]} limited`, dois[1]],
      refreshPaperIds: [limited.id, complete.id]
    })

    const run = await terminal(project, created.id)
    expect(run.items.map((item) => item.state)).toEqual(['limited', 'complete'])
    expect(await readFile(join(project.layout.root, limitedPath), 'utf8')).toBe(limitedOriginal)
    expect(await readFile(join(project.layout.root, completePath), 'utf8'))
      .toContain('Complete fake full text body.')
    await project.close()
  })

  it('rejects invalid batch refresh target mappings', async () => {
    const { project } = await fixture(['10.4242/first', '10.4242/second'])
    const papers = project.search({ projectId: project.layout.id }).items
    const first = papers.find((paper) => paper.doi === '10.4242/first')
    if (!first) throw new Error('Expected the first existing paper.')

    await expect(project.fetch.create({
      projectId: project.layout.id,
      inputs: ['10.4242/first', '10.4242/second'],
      refreshPaperIds: [first.id]
    })).rejects.toThrow('批量刷新目标必须与输入逐项对应')
    await expect(project.fetch.create({
      projectId: project.layout.id,
      inputs: ['10.4242/first', '10.4242/second'],
      refreshPaperIds: [first.id, first.id]
    })).rejects.toThrow('批量刷新目标不能重复')
    await expect(project.fetch.create({
      projectId: project.layout.id,
      inputs: ['10.4242/missing'],
      refreshPaperIds: ['paper_missing']
    })).rejects.toThrow('批量刷新只支持当前项目中已存在的论文')
    await project.close()
  })

  it('lowers inconsistent full-text claims and archives safe text when an image is missing', async () => {
    const { project } = await fixture()
    const created = await project.fetch.create({
      projectId: project.layout.id,
      inputs: ['inconsistent fulltext', 'missing asset']
    })
    const run = await terminal(project, created.id)
    expect(run.items.map((item) => item.state)).toEqual(['limited', 'degraded'])
    expect(run.items[1]?.reason).toContain('已阻止加载')
    expect(project.search({ projectId: project.layout.id }).total).toBe(2)
    await project.close()
  })

  it('cancels cooperatively and can explicitly resume from the app manifest', async () => {
    const { sandbox, project } = await fixture()
    const argsLog = join(sandbox, 'paper-fetch-resume-args.json')
    process.env.PAPER_FETCH_ARGS_LOG = argsLog
    const created = await project.fetch.create({ projectId: project.layout.id, inputs: ['slow paper'] })
    await waitFor(() => project.fetch.get(created.id).state === 'running')
    await project.fetch.cancel(created.id)
    const cancelled = await terminal(project, created.id)
    expect(cancelled.state).toBe('cancelled')
    const resumed = await project.fetch.resume(created.id)
    expect(resumed.items[0]?.attempt).toBe(2)
    const finished = await terminal(project, created.id)
    expect(finished.items[0]?.state).toBe('complete')
    expect(JSON.parse(await readFile(argsLog, 'utf8'))).toContain('--overwrite')
    delete process.env.PAPER_FETCH_ARGS_LOG
    await project.close()
  })

  it('waits for an active child before closing the project and persists an interrupted run', async () => {
    const { project, executable } = await fixture()
    const created = await project.fetch.create({ projectId: project.layout.id, inputs: ['slow shutdown'] })
    await waitFor(() => project.fetch.get(created.id).state === 'running')
    await project.close()
    expect(project.fetch.get(created.id).state).toBe('interrupted')

    const reopened = new LitRootProject(project.layout, new ServiceEventBus(), executable)
    await reopened.start()
    expect(reopened.fetch.get(created.id).state).toBe('interrupted')
    await reopened.close()
  })

  it('makes an item left running by an abrupt service stop resumable after reopening', async () => {
    const { project, executable } = await fixture()
    const created = await project.fetch.create({
      projectId: project.layout.id, inputs: ['slow shutdown']
    })
    await waitFor(async () => {
      const stored = fetchRunSchema.parse(JSON.parse(await readFile(created.manifestPath, 'utf8')))
      return stored.state === 'running' && stored.items[0]?.state === 'running'
    })
    const activeManifest = await readFile(created.manifestPath)
    await project.close()
    // Restore the last persisted snapshot before shutdown finalized the run.
    await writeFile(created.manifestPath, activeManifest)

    const reopened = new LitRootProject(project.layout, new ServiceEventBus(), executable)
    try {
      await reopened.start()
      const interrupted = reopened.fetch.get(created.id)
      expect(interrupted.state).toBe('interrupted')
      expect(interrupted.items[0]).toMatchObject({ stage: 'terminal', state: 'cancelled' })
      const resumed = await reopened.fetch.resume(created.id)
      expect(resumed.items[0]?.attempt).toBe(2)
    } finally { await reopened.close() }
  })

  it('archives early terminals, parses split and joined progress lines, and ignores stale and duplicate events', async () => {
    const { project, events } = await fixture()
    const scopes: string[] = []
    const unsubscribe = events.subscribe((event) => {
      if (event.type === 'fetch.changed' && event.run.items[0]?.assetProgress) scopes.push(event.run.items[0].assetProgress.scope)
    })
    const created = await project.fetch.create({ projectId: project.layout.id,
      inputs: ['slow protocol noise', '10.5555/early'] })
    await waitFor(() => project.fetch.get(created.id).items[1]?.state === 'complete')
    expect(project.fetch.get(created.id).state).toBe('running')
    expect(project.search({ projectId: project.layout.id }).total).toBe(1)
    expect(scopes).toContain('fragmented')
    expect(project.fetch.get(created.id).items[0]?.stage).toBe('assets')
    await expect(readFile(join(project.layout.runs, `${created.id}.results.jsonl`))).rejects.toMatchObject({ code: 'ENOENT' })
    // Cancellation may finish before cancelItem returns its latest run snapshot.
    await project.fetch.cancelItem(created.id, 1)
    const done = await terminal(project, created.id)
    expect(done.items.map((item) => item.state)).toEqual(['cancelled', 'complete'])
    expect(project.search({ projectId: project.layout.id }).total).toBe(1)
    unsubscribe()
    await project.close()
  })

  it('cancels a queued item without stopping another running item', async () => {
    const { project } = await fixture()
    const created = await project.fetch.create({ projectId: project.layout.id,
      inputs: ['10.5555/queued', 'slow remaining'] })
    await waitFor(() => project.fetch.get(created.id).items[1]?.stage === 'assets')
    await project.fetch.cancelItem(created.id, 1)
    const done = await terminal(project, created.id)
    expect(done.items.map((item) => item.state)).toEqual(['cancelled', 'complete'])
    expect(project.search({ projectId: project.layout.id }).total).toBe(1)
    await project.close()
  })

  it.each([false, true])('keeps existing full text on cancelled refresh (batch=%s)', async (batch) => {
    const { project, root } = await fixture(batch ? ['10.4242/existing', '10.4242/another'] : true)
    const papers = project.search({ projectId: project.layout.id }).items
    const paper = papers.find((item) => item.doi === '10.4242/existing')!
    const old = await readFile(join(root, 'papers', 'existing.md'), 'utf8')
    const created = await project.fetch.create({ projectId: project.layout.id,
      inputs: batch ? ['10.4242/existing slow', '10.4242/another'] : ['10.4242/existing slow'],
      ...(batch ? { refreshPaperIds: [paper.id, papers.find((item) => item.doi === '10.4242/another')!.id] } : { refreshPaperId: paper.id }) })
    await waitFor(() => project.fetch.get(created.id).items[0]?.stage === 'assets')
    await project.fetch.cancelItem(created.id, 1)
    expect((await terminal(project, created.id)).items[0]?.state).toBe('cancelled')
    expect(await readFile(join(root, 'papers', 'existing.md'), 'utf8')).toBe(old)
    expect(project.search({ projectId: project.layout.id }).total).toBe(batch ? 2 : 1)
    await project.close()
  })

  it('rejects an old engine before creating or resuming a run', async () => {
    const { project, executable } = await fixture()
    const created = await project.fetch.create({ projectId: project.layout.id, inputs: ['failed paper'] })
    await terminal(project, created.id)
    await writeFile(executable, (await readFile(executable, 'utf8')).replace('--progress auto|text|jsonl|none --control-stdin', '--query'))
    await expect(project.fetch.create({ projectId: project.layout.id, inputs: ['new paper'] })).rejects.toMatchObject({ code: 'paper_fetch_upgrade_required' })
    await expect(project.fetch.resume(created.id)).rejects.toMatchObject({ code: 'paper_fetch_upgrade_required' })
    expect(project.fetch.list()).toHaveLength(1)
    await project.close()
  })

})

it.each(['7.0.0', '7.0.1-rc.1', 'invalid'])('rejects version %s without creating or resetting tasks', async (version) => {
  const { project, executable } = await fixture()
  try {
    const created = await project.fetch.create({ projectId: project.layout.id, inputs: ['failed paper'] })
    const before = await terminal(project, created.id)
    await writeFile(executable, (await readFile(executable, 'utf8')).replace('paper-fetch 7.0.1', `paper-fetch ${version}`))
    await expect(project.fetch.create({ projectId: project.layout.id, inputs: ['new paper'] })).rejects.toMatchObject({ code: 'paper_fetch_upgrade_required' })
    await expect(project.fetch.resume(created.id)).rejects.toMatchObject({ code: 'paper_fetch_upgrade_required' })
    expect(project.fetch.list()).toEqual([before])
    expect(JSON.parse(await readFile(before.manifestPath, 'utf8'))).toEqual(before)
  } finally { await project.close() }
})

it('keeps completion counters across recovery and leaves reconciled results unordered', async () => {
  const { project, executable } = await fixture()
  const created = await project.fetch.create({ projectId: project.layout.id, inputs: ['missing event', 'retry paper', 'protocol noise'] })
  const first = await terminal(project, created.id)
  expect(first.items.map((item) => item.completionOrder)).toEqual([null, 2, 1])
  expect(first.completionCounter).toBe(2)
  await project.close()
  // Simulate an old app manifest with no new fields. Never infer diagnostics for it.
  const stored = JSON.parse(await readFile(first.manifestPath, 'utf8'))
  delete stored.completionCounter
  for (const item of stored.items) {
    delete item.diagnostics
    delete item.authCommand
    delete item.source
  }
  await writeFile(first.manifestPath, JSON.stringify(stored))
  const reopened = new LitRootProject(project.layout, new ServiceEventBus(), executable)
  try {
    await reopened.start()
    expect(reopened.fetch.get(created.id).completionCounter).toBe(2)
    expect(reopened.fetch.get(created.id).items[0]).toMatchObject({ source: null, authCommand: null, diagnostics: null })
    await reopened.fetch.resume(created.id)
    const finished = await terminal(reopened, created.id)
    expect(finished.items.map((item) => item.completionOrder)).toEqual([null, 3, 1])
    expect(finished.completionCounter).toBe(3)
  } finally { await reopened.close() }
})

it('treats auth help failure as advisory and clears old diagnostics on retry', async () => {
  const { project, executable } = await fixture()
  try {
    await writeFile(executable, (await readFile(executable, 'utf8')).replace("console.log('positional arguments: {wiley,science}'); process.exit(0)", 'process.exit(1)'))
    const created = await project.fetch.create({ projectId: project.layout.id, inputs: ['auth paper', 'complete paper'] })
    const first = await terminal(project, created.id)
    expect(first.items[0]).toMatchObject({ state: 'action_required', provider: 'wiley', authCommand: null })
    expect(first.items[1]?.state).toBe('complete')
    const retry = await project.fetch.resume(created.id)
    expect(retry.items[0]).toMatchObject({ diagnostics: null, source: null, provider: null, authCommand: null })
    expect(retry.items[1]).toEqual(first.items[1])
    await terminal(project, created.id)
  } finally { await project.close() }
})

it('uses the same installer configuration for compatibility checks and fetch', async () => {
  const { project, executable } = await fixture()
  await project.close()
  const script = await readFile(executable, 'utf8')
  await writeFile(executable, script.replace('const args = process.argv.slice(2)', "if (process.env.LITROOT_TEST_CONFIG !== 'installer config with spaces') process.exit(2)\nconst args = process.argv.slice(2)"))
  const reopened = new LitRootProject(project.layout, new ServiceEventBus(), {
    executable, prefixArgs: [], envDefaults: { LITROOT_TEST_CONFIG: 'installer config with spaces' }
  })
  try {
    await reopened.start()
    const created = await reopened.fetch.create({ projectId: project.layout.id, inputs: ['complete paper'] })
    expect((await terminal(reopened, created.id)).items[0]?.state).toBe('complete')
  } finally { await reopened.close() }
})
