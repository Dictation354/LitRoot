import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LitRootProject } from '../../src/service/project.js'
import { ServiceEventBus } from '../../src/service/events.js'
import { initializeProject } from '../../src/service/project-layout.js'
import { waitFor } from '../helpers.js'

const fixtures = fileURLToPath(new URL('../fixtures/paper-fetch-7.0.1/', import.meta.url))
const python = process.env.LITROOT_PAPER_FETCH_PYTHON
const source = process.env.LITROOT_PAPER_FETCH_SOURCE

async function projectFor(live: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'litroot-contract-'))
  const command = live
    ? { executable: python!, prefixArgs: [join(fixtures, 'offline-cli.py')] }
    : { executable: process.execPath, prefixArgs: [join(fixtures, 'replay.mjs')] }
  const project = new LitRootProject(await initializeProject(root), new ServiceEventBus(), command)
  await project.start()
  return { project, root, command }
}

for (const live of [false, true]) {
  describe.skipIf(live && !(python && source))(`7.0.1 ${live ? 'local offline CLI' : 'captured records'}`, () => {
    it.each(['complete', 'degraded', 'limited', 'runtime_failure', 'auth', 'slow'])(
      'accepts %s with upstream diagnostics', async (scenario) => {
        const { project, root, command } = await projectFor(live)
        let closed = false
        try {
          const created = await project.fetch.create({ projectId: project.layout.id, inputs: [scenario] })
          if (live && scenario === 'slow') {
            await waitFor(() => project.fetch.get(created.id).state === 'running')
            await project.fetch.cancel(created.id)
          }
          await waitFor(() => ['completed', 'cancelled'].includes(project.fetch.get(created.id).state))
          const item = project.fetch.get(created.id).items[0]!
          expect(item.state).toBe(({ complete: 'complete', degraded: 'degraded', limited: 'limited', runtime_failure: 'failed', auth: 'action_required', slow: 'cancelled' } as Record<string, string>)[scenario])
          expect(item.completionOrder).toBe(1)
          if (scenario === 'auth') expect(item).toMatchObject({ provider: 'wiley', source: null, authCommand: 'paper-fetch auth wiley' })
          if (scenario === 'runtime_failure') expect(item.errorCode).toBe('browser_context_create_failed')
          if (scenario === 'limited') expect(item.contentKind).toBe('abstract_only')
          expect(project.summary().paperCount).toBe(['complete', 'degraded', 'limited'].includes(scenario) ? 1 : 0)
          if (scenario === 'degraded') {
            expect(item.reason).toContain('browser_runtime_prepare_timeout')
            expect(item.diagnostics).toMatchObject({
              acquisition: { provider: 'elsevier', fallback_used: true },
              acceptance: { overall: 'degraded', content: { status: 'fulltext' } },
              failureCodes: ['browser_runtime_prepare_timeout'],
              trace: [{ stage: 'fulltext', code: 'browser_runtime_prepare_timeout' }, { stage: 'fulltext', code: null }]
            })
            await project.close()
            closed = true
            const reopened = new LitRootProject(project.layout, new ServiceEventBus(), command)
            try {
              await reopened.start()
              expect(reopened.fetch.get(created.id).items[0]).toEqual(item)
              expect(reopened.summary().paperCount).toBe(1)
            } finally { await reopened.close() }
          }
        } finally { if (!closed) await project.close(); await rm(root, { recursive: true, force: true }) }
      })

    it('keeps rate-limited unscheduled items distinct from cancellation', async () => {
      const { project, root } = await projectFor(live)
      try {
        const inputs = live ? ['10.1016/rate1', '10.1016/rate2', '10.1016/rate3'] : ['rate1', 'rate2', 'rate3']
        const run = await project.fetch.create({ projectId: project.layout.id, inputs, concurrency: 1 })
        await waitFor(() => project.fetch.get(run.id).state === 'completed')
        const items = project.fetch.get(run.id).items
        expect(items.map((item) => item.state)).toEqual(['action_required', 'not_scheduled', 'not_scheduled'])
        expect(items.map((item) => item.errorCode)).toEqual(Array(3).fill('rate_limited'))
        expect(items[1]?.reason).toContain('not scheduled')
        expect(items[0]?.diagnostics?.retryAfterSeconds).toBe(7)
        expect(items.every((item) => item.authCommand === null)).toBe(true)
      } finally { await project.close(); await rm(root, { recursive: true, force: true }) }
    })
  })
}

it('does not let a failed refresh replace archived full text', async () => {
  const { project, root } = await projectFor(false)
  try {
    const first = await project.fetch.create({ projectId: project.layout.id, inputs: ['complete'] })
    await waitFor(() => project.fetch.get(first.id).state === 'completed')
    const paper = project.search({ projectId: project.layout.id }).items[0]!
    const output = project.fetch.get(first.id).items[0]!.outputPath!
    const raw = await readFile(output, 'utf8')
    const failed = await project.fetch.create({ projectId: project.layout.id, inputs: ['runtime_failure'], refreshPaperId: paper.id })
    await waitFor(() => project.fetch.get(failed.id).state === 'completed')
    expect(project.fetch.get(failed.id).items[0]?.errorCode).toBe('browser_context_create_failed')
    expect(await readFile(output, 'utf8')).toBe(raw)
  } finally { await project.close(); await rm(root, { recursive: true, force: true }) }
})
