import { describe, expect, it, vi } from 'vitest'
import {
  DraftPersistenceQueue,
  flushDraftPersistence
} from '../../src/renderer/src/useDurablePaperDraft.js'

function deferred(): {
  promise: Promise<void>
  resolve(): void
} {
  let resolve = (): void => undefined
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function noOpEvents(): ConstructorParameters<typeof DraftPersistenceQueue>[1] {
  return {
    onDiscarded: vi.fn(),
    onError: vi.fn(),
    onSaved: vi.fn(),
    onSaving: vi.fn()
  }
}

describe('useDurablePaperDraft persistence queue', () => {
  it('serializes a clean-state flush after an in-flight autosave', async () => {
    const saveStarted = deferred()
    const releaseSave = deferred()
    const stored = new Map<string, { note: string; tagInput: string }>()
    const operations: string[] = []
    const backend = {
      saveDraft: vi.fn(async (paperId: string, draft: { note: string; tagInput: string }) => {
        operations.push(`save:${paperId}:start`)
        saveStarted.resolve()
        await releaseSave.promise
        stored.set(paperId, draft)
        operations.push(`save:${paperId}:finish`)
        return {
          paperId,
          ...draft,
          baseStateUpdatedAt: null,
          updatedAt: '2026-08-20T00:00:00.000Z'
        }
      }),
      discardDraft: vi.fn(async (paperId: string) => {
        operations.push(`discard:${paperId}`)
        stored.delete(paperId)
      })
    }
    const persistence = new DraftPersistenceQueue(backend, noOpEvents())
    const autosave = persistence.save({
      paperId: 'paper-a',
      note: 'Transient edit',
      tagInput: 'draft'
    })
    await saveStarted.promise

    const revertedDraft = { paperId: 'paper-a', note: 'Saved note', tagInput: 'saved' }
    const flush = flushDraftPersistence(persistence, 'paper-a', revertedDraft, false)
    releaseSave.resolve()
    await Promise.all([autosave, flush])

    expect(operations).toEqual([
      'save:paper-a:start',
      'save:paper-a:finish',
      'discard:paper-a'
    ])
    expect(stored.has('paper-a')).toBe(false)
    expect(persistence.hasStoredOrPending('paper-a')).toBe(false)
  })

  it('keeps late operations scoped to their original paper after a paper switch', async () => {
    const saveStarted = deferred()
    const releaseSave = deferred()
    const backend = {
      saveDraft: vi.fn(async (paperId: string, draft: { note: string; tagInput: string }) => {
        saveStarted.resolve()
        await releaseSave.promise
        return {
          paperId,
          ...draft,
          baseStateUpdatedAt: null,
          updatedAt: '2026-08-20T00:00:00.000Z'
        }
      }),
      discardDraft: vi.fn(async () => undefined)
    }
    const persistence = new DraftPersistenceQueue(backend, noOpEvents())
    const oldPaperSave = persistence.save({
      paperId: 'paper-a',
      note: 'Old paper edit',
      tagInput: ''
    })
    await saveStarted.promise

    persistence.syncPaper('paper-b', false)
    releaseSave.resolve()
    await oldPaperSave

    expect(persistence.hasStoredOrPending('paper-a')).toBe(true)
    expect(persistence.hasStoredOrPending('paper-b')).toBe(false)
  })
})
