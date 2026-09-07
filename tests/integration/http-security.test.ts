import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LitRootHttpServer } from '../../src/service/http-server.js'
import { ProjectRegistry } from '../../src/service/project-registry.js'
import { LitRootServiceClient } from '../../src/main/service-client.js'
import { createFakePaperFetch, paperMarkdown, writePaper, waitFor } from '../helpers.js'

const sandboxes: string[] = []

afterEach(async () => {
  for (const path of sandboxes.splice(0).reverse()) await rm(path, { recursive: true, force: true })
})

describe('localhost service security', () => {
  it('requires a session token on every endpoint and keeps APIs project-scoped', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'litroot-http-'))
    sandboxes.push(sandbox)
    const projectPath = join(sandbox, 'project')
    await mkdir(projectPath)
    await writePaper(projectPath, 'paper.md', paperMarkdown())
    const fake = await createFakePaperFetch(join(sandbox, 'bin'))
    const registry = new ProjectRegistry(join(sandbox, 'registry.json'), fake)
    const token = 'a'.repeat(64)
    const server = new LitRootHttpServer(registry, token)
    const port = await server.start()
    const base = `http://127.0.0.1:${port}/api/v1`

    expect((await fetch(`${base}/health`)).status).toBe(401)
    const registered = await fetch(`${base}/projects/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath })
    })
    expect(registered.status).toBe(201)
    const project = await registered.json() as { id: string }
    const search = await fetch(`${base}/projects/${project.id}/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '" OR * ) (^' })
    })
    expect(search.status).toBe(200)
    expect(search.headers.get('access-control-allow-origin')).toBeNull()

    const browserOrigin = await fetch(`${base}/projects`, {
      headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.test' }
    })
    expect(browserOrigin.status).toBe(403)
    const client = new LitRootServiceClient(`http://127.0.0.1:${port}`, token)
    const inputs = [...Array.from({ length: 49 }, (_, index) => `failed paper ${index}`), '10.5555/other', 'slow HTTP cancel']
    const run = await client.createFetch({ projectId: project.id, inputs })
    expect(run.items.map((item) => item.query)).toEqual(inputs)
    const endpoint = `${base}/projects/${project.id}/fetch/${run.id}/items/51/cancel`
    expect((await fetch(endpoint, { method: 'POST' })).status).toBe(401)
    await expect(client.cancelFetchItem(project.id, run.id, 0)).rejects.toMatchObject({ status: 400 })
    await expect(client.cancelFetchItem(project.id, run.id, 52)).rejects.toMatchObject({ status: 404 })
    await waitFor(() => registry.require(project.id).fetch.get(run.id).items[50]?.assetProgress !== null)
    expect((await client.getFetch(project.id, run.id)).items[50]?.stage).toBe('assets')
    expect((await client.cancelFetchItem(project.id, run.id, 51)).items[50]?.state).toBe('cancelling')
    await waitFor(() => registry.require(project.id).fetch.get(run.id).state === 'completed')
    expect((await client.getFetch(project.id, run.id)).items.map((item) => item.state)).toEqual([...Array(49).fill('failed'), 'complete', 'cancelled'])
    await server.close()
    await registry.close()
  })
})
