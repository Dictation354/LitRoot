import { opendir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import type { ScanResult } from '../shared/contracts.js'
import { paperIdFor, sha256 } from './identity.js'
import { mergeMetadata, MetadataStore } from './metadata.js'
import { fallbackMarkdownName, parsePaperMarkdown } from './paper-markdown.js'
import type { ProjectDatabase } from './project-database.js'
import type { ProjectLayout } from './project-layout.js'
import { isPathInside, portableRelativePath } from './safe-fs.js'
import type { ServiceEventBus } from './events.js'

interface Candidate {
  path: string
  relativePath: string
  modifiedAt: string
  size: number
}

const MAX_MARKDOWN_BYTES = 64 * 1024 * 1024

async function walkPapers(layout: ProjectLayout, signal?: AbortSignal): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  const canonicalPapers = await realpath(layout.papers)

  const visit = async (directory: string): Promise<void> => {
    signal?.throwIfAborted()
    const entries = await opendir(directory)
    for await (const entry of entries) {
      signal?.throwIfAborted()
      if (entry.isSymbolicLink()) continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (!entry.isFile() || !['.md', '.markdown'].includes(extname(entry.name).toLowerCase())) continue
      const info = await stat(path)
      if (info.size > MAX_MARKDOWN_BYTES) continue
      const canonical = await realpath(path)
      if (!isPathInside(canonicalPapers, canonical)) continue
      candidates.push({
        path: canonical,
        relativePath: portableRelativePath(relative(layout.root, canonical)),
        modifiedAt: info.mtime.toISOString(),
        size: info.size
      })
    }
  }

  await visit(canonicalPapers)
  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return candidates
}

export class ProjectScanner {
  private current: Promise<ScanResult> | null = null
  private followUp: Promise<ScanResult> | null = null
  private controller: AbortController | null = null

  constructor(
    private readonly layout: ProjectLayout,
    private readonly database: ProjectDatabase,
    private readonly metadata: MetadataStore,
    private readonly events: ServiceEventBus
  ) {}

  scan(): Promise<ScanResult> {
    if (!this.current) {
      const operation = this.run()
      this.current = operation
      void operation.finally(() => {
        if (this.current === operation && !this.followUp) this.current = null
      }).catch(() => undefined)
      return operation
    }
    if (this.followUp) return this.followUp
    const followUp = this.current.then(() => this.run(), () => this.run())
    this.current = followUp
    this.followUp = followUp
    void followUp.finally(() => {
      if (this.current === followUp) this.current = null
      if (this.followUp === followUp) this.followUp = null
    }).catch(() => undefined)
    return followUp
  }

  async close(): Promise<void> {
    this.controller?.abort()
    await this.current?.catch(() => undefined)
  }

  private async run(): Promise<ScanResult> {
    const controller = new AbortController()
    this.controller = controller
    const startedAt = new Date().toISOString()
    this.events.emit({ type: 'scan.started', projectId: this.layout.id, at: startedAt })
    const counts = { discovered: 0, indexed: 0, unchanged: 0, removed: 0, issues: 0 }
    try {
      const [candidates, persistedIdentities] = await Promise.all([
        walkPapers(this.layout, controller.signal),
        this.metadata.identitiesBySourcePath()
      ])
      counts.discovered = candidates.length
      const seen = new Set<string>()
      const seenCandidates = new Set(candidates.map((candidate) => candidate.relativePath))

      for (const candidate of candidates) {
        controller.signal.throwIfAborted()
        const raw = await readFile(candidate.path, { encoding: 'utf8', signal: controller.signal })
        const storedAtPath = persistedIdentities.get(candidate.relativePath)
        const knownPaperId = this.database.idAtPath(candidate.relativePath) ?? storedAtPath?.paperId
        let knownStored = storedAtPath
        if (!knownStored && knownPaperId) {
          try {
            knownStored = await this.metadata.read(knownPaperId) ?? undefined
          } catch (error) {
            this.database.setIssue(candidate.relativePath, error instanceof Error ? error.message : String(error))
            counts.issues += 1
            continue
          }
        }
        const knownFingerprint = sha256(`${raw}\0${JSON.stringify(knownStored?.overrides ?? {})}`)
        if (this.database.fingerprint(candidate.relativePath) === knownFingerprint) {
          seen.add(candidate.relativePath)
          counts.unchanged += 1
          continue
        }
        const parsed = parsePaperMarkdown(raw, fallbackMarkdownName(candidate.path))
        if (parsed.kind === 'ignore') continue
        if (parsed.kind === 'issue') {
          this.database.setIssue(candidate.relativePath, parsed.reason)
          counts.issues += 1
          continue
        }

        const paperId = knownPaperId ??
          paperIdFor(
            parsed.paper.metadata.doi || null,
            parsed.paper.metadata.url || null,
            candidate.relativePath
          )
        let stored = knownStored?.paperId === paperId ? knownStored : null
        if (!stored) {
          try {
            stored = await this.metadata.read(paperId)
          } catch (error) {
            this.database.setIssue(candidate.relativePath, error instanceof Error ? error.message : String(error))
            counts.issues += 1
            continue
          }
        }
        const overrides = stored?.overrides ?? {}
        const effective = mergeMetadata(parsed.paper.metadata, overrides)
        const duplicate = effective.doi
          ? this.database.findByDoi(effective.doi, paperId)
          : null
        if (duplicate) {
          this.database.setIssue(
            candidate.relativePath,
            `DOI ${effective.doi} 与 ${duplicate.relativePath} 冲突。`
          )
          counts.issues += 1
          continue
        }

        seen.add(candidate.relativePath)
        this.database.upsert({
          id: paperId,
          relativePath: candidate.relativePath,
          filePath: candidate.path,
          fingerprint: sha256(`${raw}\0${JSON.stringify(overrides)}`),
          rawMarkdown: raw,
          parsed: parsed.paper,
          overrides,
          modifiedAt: candidate.modifiedAt
        })
        await this.metadata.write(paperId, candidate.relativePath, overrides)
        counts.indexed += 1
      }

      counts.removed = this.database.removeMissing(seen, seenCandidates)
      const finishedAt = new Date().toISOString()
      this.database.markScanned(finishedAt)
      const result: ScanResult = {
        projectId: this.layout.id,
        ...counts,
        startedAt,
        finishedAt
      }
      this.events.emit({ type: 'scan.completed', projectId: this.layout.id, at: finishedAt, result })
      this.events.emit({ type: 'papers.changed', projectId: this.layout.id, at: finishedAt })
      return result
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }
}
