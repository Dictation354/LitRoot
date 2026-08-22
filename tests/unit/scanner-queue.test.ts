import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CandidateFile } from '../../src/main/domain.js'
import type { LibraryDatabase } from '../../src/main/db/library-database.js'

const { walkCandidatesMock } = vi.hoisted(() => ({
  walkCandidatesMock: vi.fn()
}))

vi.mock('../../src/main/ingest/walk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/ingest/walk.js')>()
  return { ...actual, walkCandidates: walkCandidatesMock }
})

import { RootScanner } from '../../src/main/ingest/scanner.js'
import { LibraryService } from '../../src/main/application/library-service.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createDatabase(): {
  database: LibraryDatabase
  beginScan: ReturnType<typeof vi.fn>
  failScan: ReturnType<typeof vi.fn>
  cancelScan: ReturnType<typeof vi.fn>
  removeRoot: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  let runNumber = 0
  const beginScan = vi.fn(() => {
    runNumber += 1
    return { id: `scan-${runNumber}`, startedAt: `started-${runNumber}` }
  })
  const failScan = vi.fn()
  const cancelScan = vi.fn()
  const removeRoot = vi.fn()
  const close = vi.fn()
  const database = {
    getRoot: vi.fn((rootId: string) => ({ id: rootId, path: '/research/root' })),
    beginScan,
    finishScan: vi.fn((scanId: string) => `finished-${scanId}`),
    failScan,
    cancelScan,
    removeRoot,
    close,
    updateRootStatus: vi.fn(),
    listRoots: vi.fn(() => []),
    writeBatch: vi.fn((operation: () => void) => operation()),
    documentFingerprint: vi.fn(() => null),
    ignoredFingerprint: vi.fn(() => null),
    rememberIgnored: vi.fn(),
    touchDocumentRoot: vi.fn(),
    upsertDocument: vi.fn(),
    upsertIssue: vi.fn(),
    reconcileRoot: vi.fn(() => 0)
  } as unknown as LibraryDatabase
  return { database, beginScan, failScan, cancelScan, removeRoot, close }
}

beforeEach(() => {
  walkCandidatesMock.mockReset()
})

describe('RootScanner queued rescans', () => {
  it('coalesces each in-flight generation into exactly one authoritative follow-up', async () => {
    const firstWalk = deferred<CandidateFile[]>()
    const secondWalk = deferred<CandidateFile[]>()
    const thirdWalk = deferred<CandidateFile[]>()
    walkCandidatesMock
      .mockReturnValueOnce(firstWalk.promise)
      .mockReturnValueOnce(secondWalk.promise)
      .mockReturnValueOnce(thirdWalk.promise)
    const { database, beginScan } = createDatabase()
    const scanner = new RootScanner(database)

    const first = scanner.scan('root-1')
    const followUpA = scanner.scan('root-1')
    const followUpB = scanner.scan('root-1')

    expect(followUpA).toBe(followUpB)
    expect(walkCandidatesMock).toHaveBeenCalledTimes(1)

    firstWalk.resolve([])
    await expect(first).resolves.toMatchObject({ startedAt: 'started-1' })
    expect(walkCandidatesMock).toHaveBeenCalledTimes(2)

    let followUpSettled = false
    void followUpA.then(() => {
      followUpSettled = true
    })
    await Promise.resolve()
    expect(followUpSettled).toBe(false)

    const nextGenerationA = scanner.scan('root-1')
    const nextGenerationB = scanner.scan('root-1')
    expect(nextGenerationA).toBe(nextGenerationB)

    secondWalk.resolve([])
    await expect(followUpA).resolves.toMatchObject({ startedAt: 'started-2' })
    expect(followUpSettled).toBe(true)
    expect(walkCandidatesMock).toHaveBeenCalledTimes(3)

    thirdWalk.resolve([])
    await expect(nextGenerationA).resolves.toMatchObject({ startedAt: 'started-3' })
    await Promise.resolve()
    await Promise.resolve()

    expect(beginScan).toHaveBeenCalledTimes(3)
    expect(walkCandidatesMock).toHaveBeenCalledTimes(3)
  })

  it('runs the queued authoritative pass even when the active pass fails', async () => {
    const firstWalk = deferred<CandidateFile[]>()
    const secondWalk = deferred<CandidateFile[]>()
    walkCandidatesMock.mockReturnValueOnce(firstWalk.promise).mockReturnValueOnce(secondWalk.promise)
    const { database, beginScan, failScan } = createDatabase()
    const scanner = new RootScanner(database)

    const first = scanner.scan('root-1')
    const followUp = scanner.scan('root-1')
    firstWalk.reject(new Error('first pass failed'))

    await expect(first).rejects.toThrow('first pass failed')
    expect(walkCandidatesMock).toHaveBeenCalledTimes(2)

    secondWalk.resolve([])
    await expect(followUp).resolves.toMatchObject({ startedAt: 'started-2' })
    expect(beginScan).toHaveBeenCalledTimes(2)
    expect(failScan).toHaveBeenCalledTimes(1)
  })

  it('cancels an active scan and suppresses its queued follow-up', async () => {
    const firstWalk = deferred<CandidateFile[]>()
    walkCandidatesMock.mockReturnValueOnce(firstWalk.promise)
    const { database, beginScan, cancelScan } = createDatabase()
    const scanner = new RootScanner(database)

    const active = scanner.scan('root-1')
    const followUp = scanner.scan('root-1')
    const activeResult = expect(active).rejects.toMatchObject({ name: 'AbortError' })
    const followUpResult = expect(followUp).rejects.toMatchObject({ name: 'AbortError' })
    const cancellation = scanner.cancel('root-1')

    firstWalk.resolve([])
    await Promise.all([activeResult, followUpResult, cancellation])

    expect(beginScan).toHaveBeenCalledTimes(1)
    expect(cancelScan).toHaveBeenCalledTimes(1)
    expect(walkCandidatesMock).toHaveBeenCalledTimes(1)
  })

  it('waits for scan cancellation before removing a root', async () => {
    const walk = deferred<CandidateFile[]>()
    walkCandidatesMock.mockReturnValueOnce(walk.promise)
    const { database, cancelScan, removeRoot } = createDatabase()
    const service = new LibraryService(database)

    const scan = service.rescan('root-1')
    const scanResult = expect(scan).rejects.toMatchObject({ name: 'AbortError' })
    const removal = service.removeRoot('root-1')
    await Promise.resolve()
    expect(removeRoot).not.toHaveBeenCalled()

    walk.resolve([])
    await Promise.all([scanResult, removal])

    expect(cancelScan).toHaveBeenCalledTimes(1)
    expect(removeRoot).toHaveBeenCalledWith('root-1')
    expect(cancelScan.mock.invocationCallOrder[0]).toBeLessThan(removeRoot.mock.invocationCallOrder[0] ?? 0)
    await service.close()
  })

  it('drains a cancelled scan before closing the database', async () => {
    const walk = deferred<CandidateFile[]>()
    walkCandidatesMock.mockReturnValueOnce(walk.promise)
    const { database, cancelScan, close } = createDatabase()
    const service = new LibraryService(database)

    const scan = service.rescan('root-1')
    const scanResult = expect(scan).rejects.toMatchObject({ name: 'AbortError' })
    const closing = service.close()
    await Promise.resolve()
    expect(close).not.toHaveBeenCalled()

    walk.resolve([])
    await Promise.all([scanResult, closing])

    expect(cancelScan).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(cancelScan.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0] ?? 0)
  })
})
