import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  PaperDetail,
  PaperRelayBridge,
  PaperUserDraftInput,
  PaperUserState
} from '../../shared/contracts.js'

export type DraftPersistenceStatus = 'idle' | 'saving' | 'saved' | 'error'

interface LocalDraft extends PaperUserDraftInput {
  paperId: string
}

export interface DurablePaperDraftController {
  paperId: string | null
  note: string
  tagInput: string
  dirty: boolean
  recoveredAt: string | null
  status: DraftPersistenceStatus
  error: string | null
  setNote(value: string): void
  setTagInput(value: string): void
  flush(): Promise<void>
  commit(): Promise<PaperUserState>
  discard(): Promise<void>
}

const DRAFT_DEBOUNCE_MS = 450

function initialDraft(paper: PaperDetail | null): LocalDraft | null {
  if (!paper) return null
  return {
    paperId: paper.id,
    note: paper.userDraft?.note ?? paper.userState.note,
    tagInput: paper.userDraft?.tagInput ?? paper.userState.tags.join(', ')
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The draft could not be saved locally.'
}

type DraftPersistenceBackend = Pick<
  PaperRelayBridge['papers'],
  'saveDraft' | 'discardDraft'
>

interface DraftPersistenceEvents {
  onSaving(paperId: string): void
  onSaved(paperId: string): void
  onDiscarded(paperId: string): void
  onError(paperId: string, error: unknown): void
}

interface PaperPersistenceState {
  stored: boolean
  pendingOperations: number
}

export class DraftPersistenceQueue {
  private backend: DraftPersistenceBackend
  private readonly events: DraftPersistenceEvents
  private queue: Promise<unknown> = Promise.resolve()
  private readonly paperStates = new Map<string, PaperPersistenceState>()

  constructor(backend: DraftPersistenceBackend, events: DraftPersistenceEvents) {
    this.backend = backend
    this.events = events
  }

  setBackend(backend: DraftPersistenceBackend): void {
    this.backend = backend
  }

  syncPaper(paperId: string, stored: boolean): void {
    const state = this.paperState(paperId)
    if (state.pendingOperations === 0) state.stored = stored
  }

  hasStoredOrPending(paperId: string): boolean {
    const state = this.paperState(paperId)
    return state.stored || state.pendingOperations > 0
  }

  save(draft: LocalDraft): Promise<void> {
    const state = this.paperState(draft.paperId)
    state.pendingOperations += 1
    const operation = this.queue
      .catch(() => undefined)
      .then(async () => {
        this.events.onSaving(draft.paperId)
        try {
          await this.backend.saveDraft(draft.paperId, {
            note: draft.note,
            tagInput: draft.tagInput
          })
          state.stored = true
          this.events.onSaved(draft.paperId)
        } catch (error) {
          this.events.onError(draft.paperId, error)
          throw error
        } finally {
          state.pendingOperations -= 1
        }
      })
    this.queue = operation
    return operation
  }

  discard(paperId: string): Promise<void> {
    const state = this.paperState(paperId)
    state.pendingOperations += 1
    const operation = this.queue
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.backend.discardDraft(paperId)
          state.stored = false
          this.events.onDiscarded(paperId)
        } catch (error) {
          this.events.onError(paperId, error)
          throw error
        } finally {
          state.pendingOperations -= 1
        }
      })
    this.queue = operation
    return operation
  }

  private paperState(paperId: string): PaperPersistenceState {
    let state = this.paperStates.get(paperId)
    if (!state) {
      state = { stored: false, pendingOperations: 0 }
      this.paperStates.set(paperId, state)
    }
    return state
  }
}

export function flushDraftPersistence(
  persistence: DraftPersistenceQueue,
  paperId: string,
  draft: LocalDraft,
  dirty: boolean
): Promise<void> {
  return dirty ? persistence.save(draft) : persistence.discard(paperId)
}

export function useDurablePaperDraft(
  papersBridge: PaperRelayBridge['papers'],
  paper: PaperDetail | null
): DurablePaperDraftController {
  const [local, setLocal] = useState<LocalDraft | null>(() => initialDraft(paper))
  const [status, setStatus] = useState<DraftPersistenceStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [recoveredAt, setRecoveredAt] = useState<string | null>(
    paper?.userDraft?.updatedAt ?? null
  )
  const timerRef = useRef<number | null>(null)
  const activePaperIdRef = useRef<string | null>(paper?.id ?? null)
  const persistenceRef = useRef<DraftPersistenceQueue | null>(null)
  if (!persistenceRef.current) {
    persistenceRef.current = new DraftPersistenceQueue(papersBridge, {
      onSaving: (paperId) => {
        if (activePaperIdRef.current !== paperId) return
        setStatus('saving')
        setError(null)
      },
      onSaved: (paperId) => {
        if (activePaperIdRef.current === paperId) setStatus('saved')
      },
      onDiscarded: (paperId) => {
        if (activePaperIdRef.current !== paperId) return
        setStatus('idle')
        setError(null)
        setRecoveredAt(null)
      },
      onError: (paperId, nextError) => {
        if (activePaperIdRef.current !== paperId) return
        setStatus('error')
        setError(message(nextError))
      }
    })
  }
  const persistence = persistenceRef.current
  persistence.setBackend(papersBridge)

  const effective = useMemo(() => {
    if (!paper) return null
    return local?.paperId === paper.id ? local : initialDraft(paper)
  }, [local, paper])

  const dirty = Boolean(
    paper &&
      effective &&
      (effective.note !== paper.userState.note ||
        effective.tagInput !== paper.userState.tags.join(', '))
  )

  useEffect(() => {
    activePaperIdRef.current = paper?.id ?? null
    const next = initialDraft(paper)
    setLocal(next)
    setStatus(paper?.userDraft ? 'saved' : 'idle')
    setError(null)
    setRecoveredAt(paper?.userDraft?.updatedAt ?? null)
    if (paper) persistence.syncPaper(paper.id, Boolean(paper.userDraft))
  }, [paper?.id])

  const enqueueSave = useCallback(
    (draft: LocalDraft): Promise<void> => persistence.save(draft),
    [persistence]
  )

  const enqueueDiscard = useCallback(
    (paperId: string): Promise<void> => persistence.discard(paperId),
    [persistence]
  )

  const clearTimer = useCallback((): void => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const flush = useCallback(async (): Promise<void> => {
    clearTimer()
    if (!paper || !effective) return
    await flushDraftPersistence(persistence, paper.id, effective, dirty)
  }, [clearTimer, dirty, effective, paper, persistence])

  useEffect(() => {
    clearTimer()
    if (!paper || !effective) return
    if (!dirty) {
      if (persistence.hasStoredOrPending(paper.id)) {
        void enqueueDiscard(paper.id).catch(() => undefined)
      }
      return
    }
    setStatus('idle')
    setError(null)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void enqueueSave(effective).catch(() => undefined)
    }, DRAFT_DEBOUNCE_MS)
    return clearTimer
  }, [clearTimer, dirty, effective, enqueueDiscard, enqueueSave, paper])

  const commit = useCallback(async (): Promise<PaperUserState> => {
    if (!paper) throw new Error('No paper is open.')
    await flush()
    const next = await papersBridge.commitDraft(paper.id)
    persistence.syncPaper(paper.id, false)
    setLocal({ paperId: paper.id, note: next.note, tagInput: next.tags.join(', ') })
    setStatus('idle')
    setError(null)
    setRecoveredAt(null)
    return next
  }, [flush, paper, papersBridge, persistence])

  const discard = useCallback(async (): Promise<void> => {
    if (!paper) return
    clearTimer()
    await enqueueDiscard(paper.id)
    setLocal({
      paperId: paper.id,
      note: paper.userState.note,
      tagInput: paper.userState.tags.join(', ')
    })
  }, [clearTimer, enqueueDiscard, paper])

  const setNote = useCallback(
    (value: string): void => {
      if (!paper) return
      setLocal((current) => ({
        paperId: paper.id,
        note: value,
        tagInput:
          current?.paperId === paper.id ? current.tagInput : paper.userState.tags.join(', ')
      }))
    },
    [paper]
  )

  const setTagInput = useCallback(
    (value: string): void => {
      if (!paper) return
      setLocal((current) => ({
        paperId: paper.id,
        note: current?.paperId === paper.id ? current.note : paper.userState.note,
        tagInput: value
      }))
    },
    [paper]
  )

  return {
    paperId: paper?.id ?? null,
    note: effective?.note ?? '',
    tagInput: effective?.tagInput ?? '',
    dirty,
    recoveredAt,
    status,
    error,
    setNote,
    setTagInput,
    flush,
    commit,
    discard
  }
}
