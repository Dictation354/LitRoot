import chokidar, { type FSWatcher } from 'chokidar'
import type { Stats } from 'node:fs'
import { relative } from 'node:path'
import { isSupportedCandidatePath } from './detectors.js'
import type { RootScanner } from './scanner.js'
import { isIgnoredDirectoryName, isPathInsideRoot } from './walk.js'

function shouldIgnorePath(rootPath: string, path: string, stats?: Stats): boolean {
  if (!isPathInsideRoot(rootPath, path)) return true
  if (stats?.isSymbolicLink()) return true

  const relativePath = relative(rootPath, path)
  if (!relativePath) return false
  const parts = relativePath.split(/[\\/]+/).filter(Boolean)
  const directoryParts = stats?.isDirectory() ? parts : parts.slice(0, -1)
  if (directoryParts.some(isIgnoredDirectoryName)) return true
  return stats?.isFile() ? !isSupportedCandidatePath(path) : false
}

export class RootWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly scanner: RootScanner,
    private readonly onError?: (rootId: string, error: unknown) => void
  ) {}

  watch(rootId: string, rootPath: string): void {
    if (this.watchers.has(rootId)) return
    const watcher = chokidar.watch(rootPath, {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 },
      ignored: (path, stats) => shouldIgnorePath(rootPath, path, stats)
    })
    const schedule = (): void => this.schedule(rootId, watcher)
    watcher
      .on('add', schedule)
      .on('change', schedule)
      .on('unlink', schedule)
      .on('unlinkDir', schedule)
    watcher.on('error', (error) => {
      if (this.watchers.get(rootId) === watcher) this.onError?.(rootId, error)
    })
    this.watchers.set(rootId, watcher)
  }

  async unwatch(rootId: string): Promise<void> {
    const timer = this.timers.get(rootId)
    if (timer) clearTimeout(timer)
    this.timers.delete(rootId)
    const watcher = this.watchers.get(rootId)
    this.watchers.delete(rootId)
    if (watcher) await watcher.close()
  }

  private schedule(rootId: string, watcher: FSWatcher): void {
    if (this.watchers.get(rootId) !== watcher) return
    const existing = this.timers.get(rootId)
    if (existing) clearTimeout(existing)
    this.timers.set(
      rootId,
      setTimeout(() => {
        this.timers.delete(rootId)
        if (this.watchers.get(rootId) !== watcher) return
        void this.scanner.scan(rootId).catch(() => undefined)
      }, 1_200)
    )
  }

  async close(): Promise<void> {
    await Promise.all([...this.watchers.keys()].map((rootId) => this.unwatch(rootId)))
  }
}
