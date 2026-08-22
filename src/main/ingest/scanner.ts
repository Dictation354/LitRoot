import { open, readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { ScanResult } from '../../shared/contracts.js'
import { LibraryDatabase } from '../db/library-database.js'
import { canonicalAssetPath } from './asset-path.js'
import { detectDocument } from './detectors.js'
import { walkCandidates } from './walk.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(String(error.code))
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function scanCancelledError(): Error {
  const error = new Error('Research folder scan was cancelled.')
  error.name = 'AbortError'
  return error
}

const PREFILTER_BYTES = 64 * 1024
const DATABASE_BATCH_ACTIONS = 48
const DATABASE_BATCH_BYTES = 16 * 1024 * 1024
const DEFINITE_JSON_CANDIDATE = /(?:^article\.json$|\.both\.json$|\.fetch-envelope\.json$)/i
const DEFINITE_HTML_CANDIDATE = /(?:^article\.html?$|^original\.html?$|_original\.html?$|\.paper\.html?$)/i

function passesContentPrefilter(path: string, head: string): boolean {
  const extension = extname(path).toLowerCase()
  if (extension === '.html' || extension === '.htm') return DEFINITE_HTML_CANDIDATE.test(basename(path))
  if (extension === '.md' || extension === '.markdown') {
    if (!head.startsWith('---')) return false
    const frontmatterEnd = head.indexOf('\n---', 3)
    if (frontmatterEnd < 0) return false
    const frontmatter = head.slice(0, frontmatterEnd)
    const trusted = frontmatter.match(
      /^(?:doi|source|has_fulltext|content_kind|has_abstract|token_estimate)\s*:/gim
    )
    return (trusted?.length ?? 0) >= 2
  }
  if (extension !== '.json') return false
  if (DEFINITE_JSON_CANDIDATE.test(basename(path))) return true
  if (!head.trimStart().startsWith('{')) return false
  return (
    (/"payload"\s*:/.test(head) && /"article"\s*:/.test(head)) ||
    (/"article"\s*:/.test(head) && /"markdown"\s*:/.test(head)) ||
    (/"metadata"\s*:/.test(head) && (/"doi"\s*:/.test(head) || /"source"\s*:/.test(head)))
  )
}

async function readCandidateText(path: string, size: number, signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted()
  if (size <= PREFILTER_BYTES) {
    const raw = await readFile(path, { encoding: 'utf8', signal })
    return passesContentPrefilter(path, raw) ? raw : null
  }

  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(PREFILTER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    signal.throwIfAborted()
    const head = buffer.subarray(0, bytesRead).toString('utf8')
    if (!passesContentPrefilter(path, head)) return null
  } finally {
    await handle.close()
  }
  return readFile(path, { encoding: 'utf8', signal })
}

export class RootScanner {
  private readonly inFlight = new Map<
    string,
    { current: Promise<ScanResult>; followUp: Promise<ScanResult> | null }
  >()
  private readonly activeControllers = new Map<string, AbortController>()
  private readonly cancelledRoots = new Set<string>()
  private readonly cancellations = new Map<string, Promise<void>>()

  constructor(private readonly database: LibraryDatabase) {}

  scan(rootId: string): Promise<ScanResult> {
    if (this.cancelledRoots.has(rootId)) return Promise.reject(scanCancelledError())
    const state = this.inFlight.get(rootId)
    if (!state) {
      const current = this.runScan(rootId)
      const nextState = { current, followUp: null }
      this.inFlight.set(rootId, nextState)
      this.removeCompletedState(rootId, nextState, current)
      return current
    }

    if (state.followUp) return state.followUp

    const launchFollowUp = (): Promise<ScanResult> => {
      state.followUp = null
      return this.runScan(rootId)
    }
    const followUp = state.current.then(launchFollowUp, launchFollowUp)
    state.current = followUp
    state.followUp = followUp
    this.removeCompletedState(rootId, state, followUp)
    return followUp
  }

  cancel(rootId: string): Promise<void> {
    const existing = this.cancellations.get(rootId)
    if (existing) return existing

    const operation = (async (): Promise<void> => {
      this.cancelledRoots.add(rootId)
      this.activeControllers.get(rootId)?.abort()
      await this.inFlight.get(rootId)?.current.catch(() => undefined)
    })()
    this.cancellations.set(rootId, operation)
    void operation.then(() => {
      if (this.cancellations.get(rootId) === operation) this.cancellations.delete(rootId)
      this.cancelledRoots.delete(rootId)
    })
    return operation
  }

  async cancelAll(): Promise<void> {
    const rootIds = new Set([...this.inFlight.keys(), ...this.activeControllers.keys()])
    await Promise.all([...rootIds].map((rootId) => this.cancel(rootId)))
  }

  private removeCompletedState(
    rootId: string,
    state: { current: Promise<ScanResult>; followUp: Promise<ScanResult> | null },
    operation: Promise<ScanResult>
  ): void {
    const complete = (): void => {
      if (this.inFlight.get(rootId) === state && state.current === operation && !state.followUp) {
        this.inFlight.delete(rootId)
      }
    }
    void operation.then(complete, complete)
  }

  private async runScan(rootId: string): Promise<ScanResult> {
    if (this.cancelledRoots.has(rootId)) throw scanCancelledError()
    const controller = new AbortController()
    this.activeControllers.set(rootId, controller)
    const { signal } = controller
    const counts = { discovered: 0, indexed: 0, unchanged: 0, issues: 0, removed: 0 }
    let run: { id: string; startedAt: string } | null = null
    let pendingBytes = 0
    let pendingWrites: Array<() => void> = []

    const flushWrites = (): void => {
      if (pendingWrites.length === 0) return
      signal.throwIfAborted()
      const writes = pendingWrites
      pendingWrites = []
      pendingBytes = 0
      this.database.writeBatch(() => {
        for (const write of writes) write()
      })
    }

    const queueWrite = (write: () => void, bytes = 0): void => {
      signal.throwIfAborted()
      pendingWrites.push(write)
      pendingBytes += bytes
      if (pendingWrites.length >= DATABASE_BATCH_ACTIONS || pendingBytes >= DATABASE_BATCH_BYTES) {
        flushWrites()
      }
    }

    try {
      signal.throwIfAborted()
      const root = this.database.getRoot(rootId)
      if (!root) throw new Error('Research folder is no longer registered.')
      const activeRun = this.database.beginScan(rootId)
      run = activeRun
      const candidates = await walkCandidates(root.path, signal)
      signal.throwIfAborted()
      counts.discovered = candidates.length

      for (const [index, candidate] of candidates.entries()) {
        if (index > 0 && index % 12 === 0) {
          await yieldToEventLoop()
          signal.throwIfAborted()
        }
        const known = this.database.documentFingerprint(candidate.canonicalPath)
        if (known?.fingerprint === candidate.fingerprint) {
          queueWrite(() => {
            this.database.touchDocumentRoot(
              candidate.canonicalPath,
              rootId,
              candidate.relativePath,
              activeRun.id
            )
          })
          counts.unchanged += 1
          if (known.parseStatus === 'unreadable') counts.issues += 1
          continue
        }
        if (!known && this.database.ignoredFingerprint(candidate.canonicalPath) === candidate.fingerprint) {
          continue
        }

        let raw: string
        try {
          const candidateText = await readCandidateText(candidate.path, candidate.size, signal)
          if (candidateText === null) {
            queueWrite(() => {
              this.database.rememberIgnored(candidate.canonicalPath, candidate.fingerprint)
            })
            continue
          }
          raw = candidateText
        } catch (error) {
          if (isAbortError(error)) throw error
          queueWrite(() => {
            this.database.upsertIssue(
              rootId,
              activeRun.id,
              candidate,
              `Could not read artifact: ${errorMessage(error)}`
            )
          })
          counts.issues += 1
          continue
        }

        const detection = detectDocument(candidate.path, raw)
        if (detection.kind === 'ignore') {
          queueWrite(() => {
            this.database.rememberIgnored(candidate.canonicalPath, candidate.fingerprint)
          })
          continue
        }
        if (detection.kind === 'issue') {
          queueWrite(() => {
            this.database.upsertIssue(rootId, activeRun.id, candidate, detection.message)
          })
          counts.issues += 1
          continue
        }

        for (const asset of detection.document.assets) {
          signal.throwIfAborted()
          const path = asset.path ? await canonicalAssetPath(root.path, asset.path) : null
          signal.throwIfAborted()
          asset.path = path
          asset.available = Boolean(path)
        }
        queueWrite(() => {
          this.database.upsertDocument(rootId, activeRun.id, candidate, detection.document)
        }, candidate.size)
        counts.indexed += 1
      }

      signal.throwIfAborted()
      flushWrites()
      counts.removed = this.database.reconcileRoot(rootId, activeRun.id)
      signal.throwIfAborted()
      const finishedAt = this.database.finishScan(activeRun.id, counts)
      return {
        rootId,
        ...counts,
        startedAt: activeRun.startedAt,
        finishedAt
      }
    } catch (error) {
      pendingWrites = []
      if (run) {
        if (isAbortError(error)) this.database.cancelScan(run.id)
        else this.database.failScan(run.id, errorMessage(error), isUnavailableError(error))
      }
      throw error
    } finally {
      if (this.activeControllers.get(rootId) === controller) this.activeControllers.delete(rootId)
    }
  }
}
