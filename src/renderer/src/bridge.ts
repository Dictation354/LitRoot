import type {
  BridgeResult,
  LitRootBridge,
  LitRootTransportBridge
} from '../../shared/contracts'

export class BridgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

async function value<T>(result: Promise<BridgeResult<T>>): Promise<T> {
  const settled = await result
  if (settled.ok) return settled.value
  throw new BridgeError(settled.error.code, settled.error.message, settled.error.details)
}

async function complete(result: Promise<BridgeResult<null>>): Promise<void> {
  await value(result)
}

let currentTransport: LitRootTransportBridge | null = null
let currentBridge: LitRootBridge | null = null

function facade(transport: LitRootTransportBridge): LitRootBridge {
  return {
    system: {
      listRuntimes: () => value(transport.system.listRuntimes()),
      diagnose: (target) => value(transport.system.diagnose(target)),
      pickProjectPath: (target) => value(transport.system.pickProjectPath(target)),
      openExternal: (url) => complete(transport.system.openExternal(url)),
      copyText: (text) => complete(transport.system.copyText(text))
    },
    projects: {
      list: () => value(transport.projects.list()),
      add: (target, path, name) => value(transport.projects.add(target, path, name)),
      remove: (projectId) => complete(transport.projects.remove(projectId)),
      scan: (projectId) => value(transport.projects.scan(projectId))
    },
    papers: {
      search: (request) => value(transport.papers.search(request)),
      get: (projectId, paperId) => value(transport.papers.get(projectId, paperId)),
      updateMetadata: (request) => value(transport.papers.updateMetadata(request)),
      markOpened: (projectId, paperId) => value(transport.papers.markOpened(projectId, paperId)),
      openWindow: (projectId, paperId) => complete(transport.papers.openWindow(projectId, paperId)),
      reveal: (projectId, paperId) => complete(transport.papers.reveal(projectId, paperId)),
      export: (projectId, paperIds, includeImages) => value(
        transport.papers.export(projectId, paperIds, includeImages)
      ),
      copyImage: (projectId, paperId, source) => complete(
        transport.papers.copyImage(projectId, paperId, source)
      ),
      openImage: (projectId, paperId, source) => complete(
        transport.papers.openImage(projectId, paperId, source)
      ),
      assetUrl: (projectId, paperId, source) => transport.papers.assetUrl(projectId, paperId, source)
    },
    notes: {
      read: (request) => value(transport.notes.read(request)),
      write: (request) => value(transport.notes.write(request))
    },
    fetch: {
      create: (request) => value(transport.fetch.create(request)),
      get: (projectId, runId) => value(transport.fetch.get(projectId, runId)),
      list: (projectId) => value(transport.fetch.list(projectId)),
      cancel: (projectId, runId) => value(transport.fetch.cancel(projectId, runId)),
      resume: (projectId, runId) => value(transport.fetch.resume(projectId, runId))
    },
    feeds: {
      list: () => value(transport.feeds.list()),
      searchJournals: (request) => value(transport.feeds.searchJournals(request)),
      add: (request) => value(transport.feeds.add(request)),
      remove: (subscriptionId) => complete(transport.feeds.remove(subscriptionId)),
      refresh: (subscriptionId) => value(transport.feeds.refresh(subscriptionId)),
      items: (request) => value(transport.feeds.items(request)),
      markRead: (request) => complete(transport.feeds.markRead(request))
    },
    events: transport.events
  }
}

export function bridge(): LitRootBridge {
  if (!window.litroot) throw new Error('LitRoot 安全桥接尚未就绪。')
  if (window.litroot !== currentTransport) {
    currentTransport = window.litroot
    currentBridge = facade(window.litroot)
  }
  return currentBridge!
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败。'
}
