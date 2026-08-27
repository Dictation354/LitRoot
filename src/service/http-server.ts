import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { z, ZodError } from 'zod'
import {
  createFetchRunRequestSchema,
  metadataUpdateRequestSchema,
  noteReadRequestSchema,
  noteWriteRequestSchema,
  paperSearchRequestSchema
} from '../shared/contracts.js'
import type { ServiceEvent } from '../shared/contracts.js'
import { ProjectRegistry } from './project-registry.js'
import { LitRootError } from './errors.js'
import { diagnoseEnvironment } from './diagnostics.js'

const MAX_JSON_BODY_BYTES = 3 * 1024 * 1024

function securityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox")
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  securityHeaders(response)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(`${JSON.stringify(value)}\n`)
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  const prefix = 'Bearer '
  if (!actual?.startsWith(prefix)) return false
  const supplied = Buffer.from(actual.slice(prefix.length), 'utf8')
  const target = Buffer.from(expected, 'utf8')
  return supplied.length === target.length && timingSafeEqual(supplied, target)
}

function validHost(host: string | undefined): boolean {
  if (!host) return false
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  return ['127.0.0.1', 'localhost', '::1'].includes(hostname)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) throw new LitRootError('body_too_large', '请求内容过大。', 413)
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new LitRootError('invalid_json', '请求 JSON 无效。')
  }
}

function parseSegments(pathname: string): string[] {
  try {
    return pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    throw new LitRootError('invalid_path', '请求路径编码无效。')
  }
}

function projectId(value: string | undefined): string {
  if (!value || !/^project_[a-f0-9]{24}$/.test(value)) throw new LitRootError('invalid_project_id', '项目 ID 无效。')
  return value
}

function paperId(value: string | undefined): string {
  if (!value || !/^paper_[a-f0-9]{24}$/.test(value)) throw new LitRootError('invalid_paper_id', '论文 ID 无效。')
  return value
}

function runId(value: string | undefined): string {
  if (!value || !/^run_[a-f0-9]{24}$/.test(value)) throw new LitRootError('invalid_run_id', '任务 ID 无效。')
  return value
}

export class LitRootHttpServer {
  private server: Server | null = null

  constructor(
    private readonly registry: ProjectRegistry,
    private readonly token: string
  ) {
    if (Buffer.byteLength(token) < 32) throw new Error('LitRoot session token must contain at least 32 bytes.')
  }

  async start(): Promise<number> {
    if (this.server) throw new Error('LitRoot service is already listening.')
    const server = createServer((request, response) => {
      void this.route(request, response).catch((error) => this.handleError(response, error))
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('LitRoot service did not receive a TCP port.')
    return address.port
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!validHost(request.headers.host)) throw new LitRootError('invalid_host', 'Host 不受信任。', 403)
    if (!tokenMatches(request.headers.authorization, this.token)) {
      throw new LitRootError('unauthorized', '缺少有效的会话令牌。', 401)
    }
    if (request.headers.origin) throw new LitRootError('browser_origin_denied', '浏览器来源不能直接访问 WSL 服务。', 403)

    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const segments = parseSegments(url.pathname)
    const method = request.method ?? 'GET'
    if (segments[0] !== 'api' || segments[1] !== 'v1') {
      throw new LitRootError('not_found', '接口不存在。', 404)
    }
    const path = segments.slice(2)

    if (method === 'GET' && path[0] === 'health' && path.length === 1) {
      sendJson(response, 200, { ok: true, apiVersion: 1 })
      return
    }
    if (method === 'GET' && path[0] === 'diagnostics' && path.length === 1) {
      sendJson(response, 200, await diagnoseEnvironment('WSL'))
      return
    }
    if (method === 'GET' && path[0] === 'events' && path.length === 1) {
      this.streamEvents(response, url.searchParams.get('projectId'))
      return
    }
    if (method === 'GET' && path[0] === 'projects' && path.length === 1) {
      sendJson(response, 200, this.registry.list())
      return
    }
    if (method === 'POST' && path[0] === 'projects' && path[1] === 'register') {
      const body = z.object({ path: z.string().min(1), name: z.string().trim().min(1).max(200).optional() }).parse(await readJson(request))
      sendJson(response, 201, await this.registry.register(body.path, body.name))
      return
    }

    if (path[0] !== 'projects') throw new LitRootError('not_found', '接口不存在。', 404)
    const selectedProjectId = projectId(path[1])
    const project = this.registry.require(selectedProjectId)

    if (method === 'DELETE' && path.length === 2) {
      await this.registry.remove(selectedProjectId)
      securityHeaders(response)
      response.statusCode = 204
      response.end()
      return
    }
    if (method === 'POST' && path[2] === 'scan' && path.length === 3) {
      sendJson(response, 200, await project.scan())
      return
    }
    if (method === 'POST' && path[2] === 'search' && path.length === 3) {
      const body = paperSearchRequestSchema.parse({ ...await readJson(request) as object, projectId: selectedProjectId })
      sendJson(response, 200, project.search(body))
      return
    }
    if (path[2] === 'papers' && path[3]) {
      const selectedPaperId = paperId(path[3])
      if (method === 'GET' && path.length === 4) {
        const detail = project.getPaper(selectedPaperId)
        if (!detail) throw new LitRootError('paper_not_found', '论文不存在。', 404)
        sendJson(response, 200, detail)
        return
      }
      if (method === 'PATCH' && path[4] === 'metadata' && path.length === 5) {
        const body = metadataUpdateRequestSchema.parse({
          ...await readJson(request) as object,
          projectId: selectedProjectId,
          paperId: selectedPaperId
        })
        sendJson(response, 200, await project.updateMetadata(body))
        return
      }
      if (method === 'GET' && path[4] === 'assets' && path.length === 5) {
        const source = url.searchParams.get('source')
        if (!source || source.length > 8_000) throw new LitRootError('invalid_asset', '资产路径无效。')
        const asset = await project.readAsset(selectedPaperId, source)
        if (!asset) throw new LitRootError('asset_not_found', '资产不存在或越出项目边界。', 404)
        securityHeaders(response)
        response.statusCode = 200
        response.setHeader('Content-Type', asset.contentType)
        response.setHeader('Content-Length', asset.data.byteLength)
        response.end(asset.data)
        return
      }
    }
    if (method === 'POST' && path[2] === 'notes' && path[3] === 'read') {
      const body = noteReadRequestSchema.parse({ ...await readJson(request) as object, projectId: selectedProjectId })
      sendJson(response, 200, await this.registry.readNote(body))
      return
    }
    if (method === 'POST' && path[2] === 'notes' && path[3] === 'write') {
      const body = noteWriteRequestSchema.parse({ ...await readJson(request) as object, projectId: selectedProjectId })
      sendJson(response, 200, await this.registry.writeNote(body))
      return
    }
    if (path[2] === 'fetch') {
      if (method === 'POST' && path.length === 3) {
        const body = createFetchRunRequestSchema.parse({ ...await readJson(request) as object, projectId: selectedProjectId })
        sendJson(response, 202, await this.registry.createFetch(body))
        return
      }
      if (method === 'GET' && path.length === 3) {
        sendJson(response, 200, project.fetch.list())
        return
      }
      const selectedRunId = runId(path[3])
      if (method === 'GET' && path.length === 4) {
        sendJson(response, 200, project.fetch.get(selectedRunId))
        return
      }
      if (method === 'POST' && path[4] === 'cancel' && path.length === 5) {
        sendJson(response, 200, await project.fetch.cancel(selectedRunId))
        return
      }
      if (method === 'POST' && path[4] === 'resume' && path.length === 5) {
        sendJson(response, 202, await project.fetch.resume(selectedRunId))
        return
      }
    }
    throw new LitRootError('not_found', '接口不存在。', 404)
  }

  private streamEvents(response: ServerResponse, selectedProjectId: string | null): void {
    if (selectedProjectId) this.registry.require(projectId(selectedProjectId))
    securityHeaders(response)
    response.statusCode = 200
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Connection', 'keep-alive')
    response.flushHeaders()
    response.write(': connected\n\n')
    const send = (event: ServiceEvent): void => {
      if (!selectedProjectId || event.projectId === selectedProjectId) {
        response.write(`data: ${JSON.stringify(event)}\n\n`)
      }
    }
    const unsubscribe = this.registry.events.subscribe(send)
    const keepalive = setInterval(() => response.write(': keepalive\n\n'), 15_000)
    response.once('close', () => {
      clearInterval(keepalive)
      unsubscribe()
    })
  }

  private handleError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.end()
      return
    }
    if (error instanceof ZodError) {
      sendJson(response, 400, {
        error: { code: 'validation_error', message: '请求字段无效。', details: error.issues }
      })
      return
    }
    const known = error instanceof LitRootError
      ? error
      : new LitRootError('internal_error', error instanceof Error ? error.message : '服务内部错误。', 500)
    sendJson(response, known.status, {
      error: {
        code: known.code,
        message: known.message,
        ...(known.details === undefined ? {} : { details: known.details })
      }
    })
  }
}
