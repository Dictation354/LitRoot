import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ServiceEventBus } from '../../src/service/events.js'
import { initializeProject } from '../../src/service/project-layout.js'
import { LitRootProject } from '../../src/service/project.js'
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

afterEach(async () => {
  delete process.env.PAPER_FETCH_ARGS_LOG
  delete process.env.PAPER_FETCH_TEST_FAILURE
  for (const path of sandboxes.splice(0).reverse()) await rm(path, { recursive: true, force: true })
})

describe('paper-fetch task orchestration', () => {
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
    expect(run.items[3]?.reason).toContain('paper-fetch auth fakepaywall')
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

  it('keeps the paper-fetch generated filename for a single-paper archive', async () => {
    const { sandbox, project } = await fixture()
    const argsLog = join(sandbox, 'paper-fetch-single-args.json')
    process.env.PAPER_FETCH_ARGS_LOG = argsLog
    const created = await project.fetch.create({
      projectId: project.layout.id,
      inputs: ['10.5555/generated-name']
    })

    const run = await terminal(project, created.id)
    const expectedFilename = `FetchBot_2025_${'A'.repeat(165)}.md`

    expect(run.items[0]?.outputPath && basename(run.items[0].outputPath)).toBe(expectedFilename)
    expect(JSON.parse(await readFile(argsLog, 'utf8')) as string[]).not.toContain('--output')
    delete process.env.PAPER_FETCH_ARGS_LOG
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
