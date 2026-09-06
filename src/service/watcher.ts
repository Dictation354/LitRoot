import chokidar, { type FSWatcher } from 'chokidar'
import { relative } from 'node:path'
import type { ProjectLayout } from './project-layout.js'
import type { ProjectScanner } from './scanner.js'
import type { ServiceEventBus } from './events.js'
import { sha256 } from './identity.js'
import { readFile } from 'node:fs/promises'

export class ProjectWatcher {
  private watcher: FSWatcher | null = null
  private scanTimer: NodeJS.Timeout | null = null
  private noteTimer: NodeJS.Timeout | null = null
  private readonly pendingNotePaths = new Set<string>()
  private readonly noteTasks = new Set<Promise<void>>()

  constructor(
    private readonly layout: ProjectLayout,
    private readonly scanner: ProjectScanner,
    private readonly events: ServiceEventBus
  ) {}

  async start(): Promise<void> {
    if (this.watcher) return
    const watcher = chokidar.watch([this.layout.papers, this.layout.notes, this.layout.metadata], {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      ignored: (_path, stats) => Boolean(stats?.isSymbolicLink())
    })
    const changed = (path: string): void => {
      if (path.startsWith(this.layout.papers)) this.scheduleScan()
      else if (path.startsWith(this.layout.metadata)) this.scheduleScan()
      else if (path.startsWith(this.layout.notes)) this.scheduleNote(path)
    }
    watcher.on('add', changed).on('change', changed).on('unlink', changed).on('unlinkDir', changed)
    this.watcher = watcher
    await new Promise<void>((resolve, reject) => {
      watcher.once('ready', resolve)
      watcher.once('error', reject)
    })
  }

  private scheduleScan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer)
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null
      void this.scanner.scan().catch(() => undefined)
    }, 700)
  }

  private scheduleNote(path: string): void {
    this.pendingNotePaths.add(path)
    if (this.noteTimer) clearTimeout(this.noteTimer)
    this.noteTimer = setTimeout(() => {
      this.noteTimer = null
      const paths = [...this.pendingNotePaths]
      this.pendingNotePaths.clear()
      const task = this.emitNotes(paths).finally(() => this.noteTasks.delete(task))
      this.noteTasks.add(task)
    }, 300)
  }

  private async emitNotes(paths: string[]): Promise<void> {
    for (const path of paths) await this.emitNote(path)
  }

  private async emitNote(path: string): Promise<void> {
    const relativePath = relative(this.layout.notes, path).replaceAll('\\', '/')
    const match = /^papers\/(paper_[a-f0-9]{24})\.md$/.exec(relativePath)
    const kind = relativePath === 'project.md' ? 'project' : match ? 'paper' : null
    if (!kind) return
    let revision = 'missing'
    try {
      revision = sha256(await readFile(path))
    } catch {
      // A deletion is still an external change and carries a stable missing revision.
    }
    this.events.emit({
      type: 'note.changed',
      projectId: this.layout.id,
      at: new Date().toISOString(),
      kind,
      paperId: match?.[1] ?? null,
      revision
    })
  }

  async close(): Promise<void> {
    if (this.scanTimer) clearTimeout(this.scanTimer)
    if (this.noteTimer) clearTimeout(this.noteTimer)
    this.scanTimer = null
    this.noteTimer = null
    this.pendingNotePaths.clear()
    const watcher = this.watcher
    this.watcher = null
    await watcher?.close()
    await Promise.all([...this.noteTasks])
  }
}
