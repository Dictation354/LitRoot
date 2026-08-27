import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectRegistry } from '../../src/service/project-registry.js'
import { paperMarkdown, writePaper } from '../helpers.js'

const sandboxes: string[] = []

afterEach(async () => {
  for (const path of sandboxes.splice(0).reverse()) await rm(path, { recursive: true, force: true })
})

describe('strict project isolation', () => {
  it('never searches or opens a paper through another project ID', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'litroot-isolation-'))
    sandboxes.push(sandbox)
    const firstPath = join(sandbox, 'first')
    const secondPath = join(sandbox, 'second')
    await Promise.all([mkdir(firstPath), mkdir(secondPath)])
    await writePaper(firstPath, 'first.md', paperMarkdown({ title: 'Only Alpha', doi: '10.4242/alpha' }))
    await writePaper(secondPath, 'second.md', paperMarkdown({ title: 'Only Beta', doi: '10.4242/beta' }))
    const registry = new ProjectRegistry(join(sandbox, 'registry.json'))
    const first = await registry.register(firstPath)
    const second = await registry.register(secondPath)
    const alpha = registry.search({ projectId: first.id, query: 'Alpha' }).items[0]
    if (!alpha) throw new Error('Expected alpha paper.')

    expect(registry.search({ projectId: second.id, query: 'Alpha' }).total).toBe(0)
    expect(registry.getPaper(second.id, alpha.id)).toBeNull()
    await registry.close()
  })
})
