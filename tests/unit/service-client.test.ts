import { afterEach, describe, expect, it, vi } from 'vitest'
import { LitRootServiceClient, ServiceClientError } from '../../src/main/service-client.js'

afterEach(() => vi.unstubAllGlobals())

describe('LitRoot service client response boundary', () => {
  it('accepts schema-valid JSON and rejects malformed successful responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ projects: [] }))
      .mockResolvedValueOnce(Response.json({ openedAt: 42 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new LitRootServiceClient('http://127.0.0.1:43123', 'token')

    await expect(client.listProjects()).resolves.toEqual([])
    await expect(client.listProjects()).rejects.toMatchObject({
      code: 'invalid_service_response',
      status: 200
    })
    await expect(client.markPaperOpened('project_test', 'paper_test')).rejects.toMatchObject({
      code: 'invalid_service_response',
      status: 200
    })
  })

  it('parses structured API errors and uses the fallback for malformed error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({
        error: {
          code: 'doi_conflict',
          message: '当前项目中已存在使用该 DOI 的论文。',
          details: { existingPaperId: 'paper_aaaaaaaaaaaaaaaaaaaaaaaa' }
        }
      }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ error: 'bad' }, { status: 503 })))
    const client = new LitRootServiceClient('http://127.0.0.1:43123', 'token')

    await expect(client.listProjects()).rejects.toMatchObject({
      code: 'doi_conflict',
      status: 409,
      details: { existingPaperId: 'paper_aaaaaaaaaaaaaaaaaaaaaaaa' }
    })
    await expect(client.listProjects()).rejects.toEqual(expect.objectContaining<Partial<ServiceClientError>>({
      code: 'service_error',
      status: 503
    }))
  })
})
