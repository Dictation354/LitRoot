import type {
  CreateFetchRunRequest,
  FetchRun,
  MetadataUpdateRequest,
  NoteDocument,
  NoteReadRequest,
  NoteWriteRequest,
  PaperDetail,
  PaperSearchRequest,
  PaperSearchResult,
  ProjectSummary,
  ScanResult,
  ServiceEvent
} from '../shared/contracts.js'
import { serviceEventSchema } from '../shared/contracts.js'

export class ServiceClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'ServiceClientError'
  }
}

export class LitRootServiceClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers
      }
    })
    if (response.status === 204) return undefined as T
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const error = body && typeof body === 'object' && 'error' in body
        ? (body as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error
        : null
      throw new ServiceClientError(
        typeof error?.code === 'string' ? error.code : 'service_error',
        typeof error?.message === 'string' ? error.message : `WSL 服务返回 HTTP ${response.status}。`,
        response.status,
        error?.details
      )
    }
    return body as T
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.request('/projects')
  }

  registerProject(path: string, name?: string): Promise<ProjectSummary> {
    return this.request('/projects/register', {
      method: 'POST',
      body: JSON.stringify({ path, ...(name ? { name } : {}) })
    })
  }

  removeProject(projectId: string): Promise<void> {
    return this.request(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
  }

  scan(projectId: string): Promise<ScanResult> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/scan`, { method: 'POST' })
  }

  search(request: PaperSearchRequest): Promise<PaperSearchResult> {
    return this.request(`/projects/${encodeURIComponent(request.projectId)}/search`, {
      method: 'POST',
      body: JSON.stringify(request)
    })
  }

  getPaper(projectId: string, paperId: string): Promise<PaperDetail> {
    return this.request(
      `/projects/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(paperId)}`
    )
  }

  updateMetadata(request: MetadataUpdateRequest): Promise<PaperDetail> {
    return this.request(
      `/projects/${encodeURIComponent(request.projectId)}/papers/${encodeURIComponent(request.paperId)}/metadata`,
      { method: 'PATCH', body: JSON.stringify(request) }
    )
  }

  readNote(request: NoteReadRequest): Promise<NoteDocument> {
    return this.request(`/projects/${encodeURIComponent(request.projectId)}/notes/read`, {
      method: 'POST', body: JSON.stringify(request)
    })
  }

  writeNote(request: NoteWriteRequest): Promise<NoteDocument> {
    return this.request(`/projects/${encodeURIComponent(request.projectId)}/notes/write`, {
      method: 'POST', body: JSON.stringify(request)
    })
  }

  createFetch(request: CreateFetchRunRequest): Promise<FetchRun> {
    return this.request(`/projects/${encodeURIComponent(request.projectId)}/fetch`, {
      method: 'POST', body: JSON.stringify(request)
    })
  }

  listFetch(projectId: string): Promise<FetchRun[]> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/fetch`)
  }

  getFetch(projectId: string, runId: string): Promise<FetchRun> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/fetch/${encodeURIComponent(runId)}`)
  }

  cancelFetch(projectId: string, runId: string): Promise<FetchRun> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/fetch/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST'
    })
  }

  resumeFetch(projectId: string, runId: string): Promise<FetchRun> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/fetch/${encodeURIComponent(runId)}/resume`, {
      method: 'POST'
    })
  }

  asset(projectId: string, paperId: string, source: string): Promise<Response> {
    return fetch(
      `${this.baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(paperId)}/assets?source=${encodeURIComponent(source)}`,
      { headers: { Authorization: `Bearer ${this.token}` } }
    )
  }

  async subscribe(
    listener: (event: ServiceEvent) => void,
    signal: AbortSignal
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/v1/events`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal
    })
    if (!response.ok || !response.body) throw new Error(`事件流连接失败：HTTP ${response.status}`)
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffer = ''
    const dispatchCompleteEvents = (): void => {
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const eventBlock = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = eventBlock.split('\n').filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6)).join('\n')
        if (data) {
          try {
            listener(serviceEventSchema.parse(JSON.parse(data)))
          } catch {
            // Invalid service events are ignored instead of entering the renderer boundary.
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          buffer += decoder.decode()
          dispatchCompleteEvents()
          break
        }
        buffer += decoder.decode(value, { stream: true })
        dispatchCompleteEvents()
      }
    } finally {
      reader.releaseLock()
    }
  }
}
