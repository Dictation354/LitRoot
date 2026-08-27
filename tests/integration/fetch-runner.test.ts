import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ServiceEventBus } from '../../src/service/events.js'
import { initializeProject } from '../../src/service/project-layout.js'
import { LitRootProject } from '../../src/service/project.js'
import { createFakePaperFetch, paperMarkdown, waitFor, writePaper } from '../helpers.js'

const sandboxes: string[] = []

async function fixture(withPaper = false) {
  const sandbox = await mkdtemp(join(tmpdir(), 'litroot-fetch-'))
  sandboxes.push(sandbox)
  const root = join(sandbox, 'project')
  await mkdir(root)
  if (withPaper) await writePaper(root, 'existing.md', paperMarkdown({ doi: '10.4242/existing', body: 'Old irreplaceable full text.' }))
  const executable = await createFakePaperFetch(join(sandbox, 'bin'))
  const project = new LitRootProject(await initializeProject(root), new ServiceEventBus(), executable)
  await project.start()
  return { sandbox, root, project, executable }
}

async function terminal(project: LitRootProject, runId: string) {
  await waitFor(() => ['completed', 'cancelled', 'interrupted'].includes(project.fetch.get(runId).state), 10_000)
  return project.fetch.get(runId)
}

afterEach(async () => {
  delete process.env.PAPER_FETCH_ARGS_LOG
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
    expect(args).toContain('--run-manifest')
    expect(args).toEqual(expect.arrayContaining([
      '--artifact-mode', 'markdown-assets', '--asset-profile', 'body',
      '--include-refs', 'all', '--max-tokens', 'full_text'
    ]))
    delete process.env.PAPER_FETCH_ARGS_LOG
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
})
