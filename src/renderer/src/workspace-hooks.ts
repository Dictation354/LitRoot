import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react'
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {
  NoteDocument, NoteKind, MetadataField, ServiceEvent,
  PaperDetail,
  PaperListItem,
  PaperSortField,
  ProjectSummary
} from '../../shared/contracts'
import { bridge, BridgeError, errorMessage } from './bridge'
import {
  loadLibraryPreferences,
  saveLibraryPreferences
} from './library-preferences'

export const LIBRARY_TAB_KEY = 'library'
export const MIN_SIDEBAR_WIDTH = 180
export const MAX_SIDEBAR_WIDTH = 420
export const MIN_INSPECTOR_WIDTH = 260
export const MAX_INSPECTOR_WIDTH = 520
export const MIN_MAIN_WIDTH = 480
export const RESIZER_WIDTH = 5

const PROJECT_STORAGE_KEY = 'litroot.current-project'
const SIDEBAR_WIDTH_KEY = 'litroot.sidebar-width'
const INSPECTOR_WIDTH_KEY = 'litroot.inspector-width'
const DEFAULT_SIDEBAR_WIDTH = 236
const DEFAULT_INSPECTOR_WIDTH = 340

export interface PaperTab {
  key: string
  projectId: string
  paperId: string
  title: string
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

function paperTabKey(projectId: string, paperId: string): string {
  return `paper:${projectId}:${paperId}`
}

export function useLibraryWorkspace({
  projectId,
  projectStatus,
  revision,
  onMessage
}: {
  projectId: string
  projectStatus: ProjectSummary['status'] | undefined
  revision: number
  onMessage(message: string): void
}) {
  const [query, setQuery] = useState('')
  const [year, setYear] = useState<number | null>(null)
  const [offset, setOffset] = useState(0)
  const [papers, setPapers] = useState<PaperListItem[]>([])
  const [total, setTotal] = useState(0)
  const [years, setYears] = useState<number[]>([])
  const [selectedPaperId, setSelectedPaperId] = useState('')
  const [selectedPaperIds, setSelectedPaperIds] = useState<string[]>([])
  const [selectionAnchorId, setSelectionAnchorId] = useState('')
  const [loadingPapers, setLoadingPapers] = useState(false)
  const [preferences, setPreferences] = useState(
    () => loadLibraryPreferences(window.localStorage)
  )
  const queryState = useMemo(() => ({ projectId, query }), [projectId, query])
  const debounced = useDebounced(queryState, 250)
  const debouncedQuery = debounced.projectId === projectId ? debounced.query : ''

  useEffect(() => saveLibraryPreferences(window.localStorage, preferences), [preferences])

  useLayoutEffect(() => {
    setPapers([])
    setTotal(0)
    setYears([])
    setLoadingPapers(false)
    if (projectId) window.localStorage.setItem(PROJECT_STORAGE_KEY, projectId)
    else window.localStorage.removeItem(PROJECT_STORAGE_KEY)
    setQuery('')
    setYear(null)
    setOffset(0)
    setSelectedPaperId('')
    setSelectedPaperIds([])
    setSelectionAnchorId('')
  }, [projectId])

  useEffect(() => {
    if (!projectId || projectStatus === 'error') {
      setPapers([])
      setTotal(0)
      setYears([])
      return
    }
    let cancelled = false
    setLoadingPapers(true)
    void bridge().papers.search({
      projectId,
      query: debouncedQuery,
      year,
      sortBy: preferences.sortBy,
      sortDirection: preferences.sortDirection,
      limit: preferences.pageSize,
      offset
    }).then((result) => {
      if (cancelled) return
      if (offset > 0 && offset >= result.total) {
        setOffset(Math.max(0, Math.ceil(result.total / preferences.pageSize) - 1) * preferences.pageSize)
        return
      }
      setPapers(result.items)
      setTotal(result.total)
      setYears(result.years)
      setSelectedPaperId((current) => (
        result.items.some((item) => item.id === current)
          ? current
          : (result.items[0]?.id ?? '')
      ))
      setSelectedPaperIds((current) => {
        const retained = current.filter((id) => result.items.some((item) => item.id === id))
        return retained
      })
      setSelectionAnchorId((current) => (
        result.items.some((item) => item.id === current) ? current : (result.items[0]?.id ?? '')
      ))
    }).catch((error) => {
      if (!cancelled) onMessage(errorMessage(error))
    }).finally(() => {
      if (!cancelled) setLoadingPapers(false)
    })
    return () => { cancelled = true }
  }, [
    projectId,
    projectStatus,
    debouncedQuery,
    year,
    offset,
    preferences.sortBy,
    preferences.sortDirection,
    preferences.pageSize,
    revision,
    onMessage
  ])

  const clearSelection = (): void => {
    setSelectedPaperIds([])
    setSelectionAnchorId('')
  }

  const resetFilters = (): void => {
    setQuery('')
    setYear(null)
    setOffset(0)
    clearSelection()
  }

  const changeSort = (sortBy: PaperSortField): void => {
    setPreferences((current) => ({
      ...current,
      sortBy,
      sortDirection: current.sortBy === sortBy && current.sortDirection === 'asc' ? 'desc' : 'asc'
    }))
    setOffset(0)
    clearSelection()
  }

  const changePage = (nextOffset: number): void => {
    setOffset(nextOffset)
    clearSelection()
  }

  const changePageSize = (pageSize: number): void => {
    setPreferences((current) => ({ ...current, pageSize }))
    setOffset(0)
    clearSelection()
  }

  const replacePaper = (next: PaperDetail): void => {
    setPapers((current) => current.map((paper) => paper.id === next.id ? next : paper))
  }

  return {
    query,
    year,
    offset,
    papers,
    total,
    years,
    selectedPaperId,
    selectedPaperIds,
    selectionAnchorId,
    loadingPapers,
    preferences,
    setPreferences,
    setSelectedPaperId,
    setSelectedPaperIds,
    setSelectionAnchorId,
    changeQuery(value: string) {
      setQuery(value)
      setOffset(0)
      clearSelection()
    },
    changeYear(value: number | null) {
      setYear(value)
      setOffset(0)
      clearSelection()
    },
    resetFilters,
    changeSort,
    changePage,
    changePageSize,
    replacePaper
  }
}

export function useWorkspaceTabs({
  projectId,
  revision,
  setProjectId,
  setFeedScope,
  onMessage
}: {
  projectId: string
  revision: number
  setProjectId(projectId: string): void
  setFeedScope(scope: 'recent' | string | null): void
  onMessage(message: string): void
}) {
  const [openTabs, setOpenTabs] = useState<PaperTab[]>([])
  const [activeTabKey, setActiveTabKey] = useState(LIBRARY_TAB_KEY)
  const [readerState, setReaderState] = useState<{ key: string; paper: PaperDetail } | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailMissing, setDetailMissing] = useState(false)
  const [retry, setRetry] = useState(0)
  const positions = useRef(new Map<string, ReadingPosition>())
  const readerPanelRef = useRef<HTMLElement>(null)
  const activePaperTab = useMemo(
    () => openTabs.find((tab) => tab.key === activeTabKey) ?? null,
    [activeTabKey, openTabs]
  )
  const activePaper = activePaperTab && readerState?.key === activePaperTab.key
    ? readerState.paper
    : null

  if (activePaperTab && !positions.current.has(activePaperTab.key)) {
    positions.current.set(activePaperTab.key, { top: 0 })
  }

  useLayoutEffect(() => {
    if (!activePaperTab) {
      setReaderState(null)
      setLoadingDetail(false)
      return
    }
    let cancelled = false
    setLoadingDetail(true)
    setDetailError('')
    setDetailMissing(false)
    void bridge().papers.get(activePaperTab.projectId, activePaperTab.paperId).then((detail) => {
      if (cancelled) return
      setReaderState(detail ? { key: activePaperTab.key, paper: detail } : null)
      setDetailMissing(!detail)
      if (detail) {
        setOpenTabs((current) => current.map((tab) => (
          tab.key === activePaperTab.key ? { ...tab, title: detail.title } : tab
        )))
      }
    }).catch((error) => {
      if (!cancelled) { setReaderState(null); setDetailError(errorMessage(error)) }
    }).finally(() => {
      if (!cancelled) setLoadingDetail(false)
    })
    return () => { cancelled = true }
  }, [
    activePaperTab?.key,
    activePaperTab?.projectId,
    activePaperTab?.paperId,
    revision,
    retry,
    onMessage
  ])

  const activateTab = (key: string): void => {
    if (key === LIBRARY_TAB_KEY) {
      setActiveTabKey(key)
      return
    }
    const tab = openTabs.find((item) => item.key === key)
    if (!tab) return
    setFeedScope(null)
    if (tab.key !== activeTabKey) setReaderState(null)
    setActiveTabKey(key)
    if (tab.projectId !== projectId) setProjectId(tab.projectId)
  }

  const openPaper = (
    paper: Pick<PaperListItem, 'id' | 'title'>,
    ownerProjectId = projectId
  ): void => {
    if (!ownerProjectId) return
    void bridge().papers.markOpened(ownerProjectId, paper.id)
      .catch((error) => onMessage(errorMessage(error)))
    const key = paperTabKey(ownerProjectId, paper.id)
    setOpenTabs((current) => current.some((tab) => tab.key === key)
      ? current.map((tab) => tab.key === key ? { ...tab, title: paper.title } : tab)
      : [...current, { key, projectId: ownerProjectId, paperId: paper.id, title: paper.title }])
    setReaderState((current) => current?.key === key ? current : null)
    setActiveTabKey(key)
    if (ownerProjectId !== projectId) setProjectId(ownerProjectId)
  }

  const closeTab = (key: string): void => {
    positions.current.delete(key)
    const index = openTabs.findIndex((tab) => tab.key === key)
    if (index < 0) return
    const wasActive = activeTabKey === key
    const remaining = openTabs.filter((tab) => tab.key !== key)
    setOpenTabs(remaining)
    if (!wasActive) return
    const fallback = remaining[Math.min(index, remaining.length - 1)] ?? null
    if (fallback) {
      setActiveTabKey(fallback.key)
      if (fallback.projectId !== projectId) setProjectId(fallback.projectId)
    } else {
      setActiveTabKey(LIBRARY_TAB_KEY)
    }
  }

  const updatePaper = (next: PaperDetail): void => {
    setReaderState((current) => current?.paper.id === next.id
      ? { ...current, paper: next }
      : current)
    setOpenTabs((current) => current.map((tab) => (
      tab.projectId === projectId && tab.paperId === next.id
        ? { ...tab, title: next.title }
        : tab
    )))
  }

  const removeProjectTabs = (removedProjectId: string): void => {
    const removedKeys = new Set(
      openTabs.filter((tab) => tab.projectId === removedProjectId).map((tab) => tab.key)
    )
    removedKeys.forEach((key) => positions.current.delete(key))
    setOpenTabs((current) => current.filter((tab) => tab.projectId !== removedProjectId))
    if (removedKeys.has(activeTabKey)) setActiveTabKey(LIBRARY_TAB_KEY)
  }

  return {
    openTabs,
    activeTabKey,
    activePaperTab,
    activePaper,
    loadingDetail,
    detailError, detailMissing, retryDetail: () => setRetry((value) => value + 1),
    readingPosition: activePaperTab ? positions.current.get(activePaperTab.key) : undefined,
    readerPanelRef,
    activateTab,
    activateLibrary: () => setActiveTabKey(LIBRARY_TAB_KEY),
    openPaper,
    closeTab,
    updatePaper,
    removeProjectTabs
  }
}

function loadStoredWidth(key: string, fallback: number, minimum: number, maximum: number): number {
  try {
    const value = Number(window.localStorage.getItem(key))
    return Number.isFinite(value) && value > 0
      ? Math.min(maximum, Math.max(minimum, Math.round(value)))
      : fallback
  } catch {
    return fallback
  }
}

function saveStoredWidth(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // Layout remains adjustable when browser preferences are unavailable.
  }
}

export function usePaneLayout(inspectorKey: string | null) {
  const hasInspector = inspectorKey !== null
  const [sidebarWidth, setSidebarWidth] = useState(() => loadStoredWidth(
    SIDEBAR_WIDTH_KEY,
    DEFAULT_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH
  ))
  const [inspectorWidth, setInspectorWidth] = useState(() => loadStoredWidth(
    INSPECTOR_WIDTH_KEY,
    DEFAULT_INSPECTOR_WIDTH,
    MIN_INSPECTOR_WIDTH,
    MAX_INSPECTOR_WIDTH
  ))
  const appShellRef = useRef<HTMLDivElement>(null)
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])

  useEffect(() => saveStoredWidth(SIDEBAR_WIDTH_KEY, sidebarWidth), [sidebarWidth])
  useEffect(() => saveStoredWidth(INSPECTOR_WIDTH_KEY, inspectorWidth), [inspectorWidth])

  const [availableWidth, setAvailableWidth] = useState(window.innerWidth)
  useLayoutEffect(() => {
    const measure = (): void => setAvailableWidth(appShellRef.current?.clientWidth || window.innerWidth)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  let fittedSidebar = sidebarWidth
  let fittedInspector = inspectorWidth
  let overflow = fittedSidebar + MIN_MAIN_WIDTH + RESIZER_WIDTH
    + (hasInspector ? fittedInspector + RESIZER_WIDTH : 0) - availableWidth
  if (hasInspector && overflow > 0) {
    const reduction = Math.min(overflow, fittedInspector - MIN_INSPECTOR_WIDTH)
    fittedInspector -= reduction
    overflow -= reduction
  }
  if (overflow > 0) fittedSidebar = Math.max(MIN_SIDEBAR_WIDTH, fittedSidebar - overflow)

  const appWidth = (): number => appShellRef.current?.clientWidth || window.innerWidth
  const clampSidebar = (value: number, currentInspector = fittedInspector): number => {
    const dynamicMaximum = appWidth() - MIN_MAIN_WIDTH - RESIZER_WIDTH
      - (hasInspector ? currentInspector + RESIZER_WIDTH : 0)
    return Math.round(Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.max(MIN_SIDEBAR_WIDTH, dynamicMaximum),
      Math.max(MIN_SIDEBAR_WIDTH, value)
    ))
  }
  const clampInspector = (value: number, currentSidebar = fittedSidebar): number => {
    const dynamicMaximum = appWidth() - currentSidebar - MIN_MAIN_WIDTH - RESIZER_WIDTH * 2
    return Math.round(Math.min(
      MAX_INSPECTOR_WIDTH,
      Math.max(MIN_INSPECTOR_WIDTH, dynamicMaximum),
      Math.max(MIN_INSPECTOR_WIDTH, value)
    ))
  }

  const beginResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    target: 'sidebar' | 'inspector'
  ): void => {
    event.preventDefault()
    dragCleanup.current?.()
    const startX = event.clientX
    const startSidebar = fittedSidebar
    const startInspector = fittedInspector
    document.body.classList.add('resizing-panes')
    const move = (nextEvent: globalThis.PointerEvent): void => {
      const delta = nextEvent.clientX - startX
      if (target === 'sidebar') setSidebarWidth(clampSidebar(startSidebar + delta, startInspector))
      else setInspectorWidth(clampInspector(startInspector - delta, startSidebar))
    }
    const finish = (): void => {
      document.body.classList.remove('resizing-panes')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
    dragCleanup.current = finish
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  const resizeWithKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    target: 'sidebar' | 'inspector'
  ): void => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 10 : -10
    if (target === 'sidebar') setSidebarWidth(clampSidebar(fittedSidebar + direction))
    else setInspectorWidth(clampInspector(fittedInspector - direction))
  }

  return {
    appShellRef,
    sidebarWidth: fittedSidebar,
    inspectorWidth: fittedInspector,
    beginResize,
    resizeWithKeyboard
  }
}

// Editor state belongs to the workspace: component unmount must not cancel a write.
export interface NoteDraft {
  key: string
  title: string
  projectId: string
  paperId?: string | undefined
  kind: NoteKind
  document: NoteDocument | null
  content: string
  dirty: boolean
  saving: boolean
  loading: boolean
  conflict: boolean
  error: string
  readRequest: number
  timer?: ReturnType<typeof setTimeout>
  attached: number
}

export type MetadataForm = Record<MetadataField, string>
export interface MetadataDraft {
  key: string
  projectId: string
  paperId: string
  title: string
  form: MetadataForm
  base: MetadataForm
  modified: Set<MetadataField>
  saving: boolean
  message: string
  error: string
  existingPaperId: string
  attached: number
}

export function metadataForm(paper: PaperDetail): MetadataForm {
  return {
    title: paper.title, authors: paper.authors.join('\n'), journal: paper.journal,
    year: paper.year?.toString() ?? '', doi: paper.doi, url: paper.url,
    abstract: paper.abstract, keywords: paper.keywords.join('\n')
  }
}

function createEditorSession() {
  const notes = new Map<string, NoteDraft>()
  const metadata = new Map<string, MetadataDraft>()
  const listeners = new Set<() => void>()
  let revision = 0
  const notify = (): void => { revision += 1; listeners.forEach((listener) => listener()) }
  const releaseNote = (draft: NoteDraft): void => {
    if (!draft.attached && !draft.dirty && !draft.saving && !draft.loading) notes.delete(draft.key)
  }
  const saveNote = async (draft: NoteDraft): Promise<void> => {
    clearTimeout(draft.timer)
    if (!draft.document || !draft.dirty || draft.saving || draft.conflict || draft.error) return
    draft.saving = true
    const content = draft.content
    notify()
    try {
      const next = await bridge().notes.write({
        projectId: draft.projectId, kind: draft.kind,
        ...(draft.paperId ? { paperId: draft.paperId } : {}),
        content, expectedRevision: draft.document.revision
      })
      draft.document = next
      draft.dirty = draft.content !== content
    } catch (error) {
      draft.error = errorMessage(error)
      draft.conflict = error instanceof BridgeError && error.code === 'note_conflict'
    } finally {
      draft.saving = false
      releaseNote(draft)
      notify()
    }
    if (draft.dirty && !draft.error && !draft.conflict) void saveNote(draft)
  }
  const loadNote = async (draft: NoteDraft, discard = false): Promise<void> => {
    if (draft.saving || (!discard && draft.dirty)) return
    const request = ++draft.readRequest
    draft.loading = true
    draft.error = ''
    notify()
    try {
      const next = await bridge().notes.read({
        projectId: draft.projectId, kind: draft.kind,
        ...(draft.paperId ? { paperId: draft.paperId } : {})
      })
      if (request !== draft.readRequest || (!discard && draft.dirty)) return
      draft.document = next
      draft.content = next.content
      draft.dirty = false
      draft.conflict = false
    } catch (error) {
      if (request === draft.readRequest) draft.error = errorMessage(error)
    } finally {
      if (request === draft.readRequest) draft.loading = false
      releaseNote(draft)
      notify()
    }
  }
  return {
    notes, metadata, notify, saveNote, loadNote,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot: () => revision,
    releaseNote,
    releaseMetadata(draft: MetadataDraft) {
      if (!draft.attached && !draft.modified.size && !draft.saving) metadata.delete(draft.key)
    },
    changeNote(draft: NoteDraft, content: string) {
      draft.content = content
      draft.dirty = draft.conflict || content !== draft.document?.content
      clearTimeout(draft.timer)
      if (!draft.error && !draft.conflict) draft.timer = setTimeout(() => { void saveNote(draft) }, 800)
      notify()
    },
    noteEvent(event: ServiceEvent) {
      if (event.type !== 'note.changed') return
      for (const draft of notes.values()) {
        if (draft.projectId !== event.projectId || draft.kind !== event.kind ||
          (draft.paperId ?? null) !== event.paperId || draft.document?.revision === event.revision || draft.saving) continue
        if (draft.dirty) {
          draft.conflict = true
          draft.error = '磁盘文件已被外部修改，自动保存已暂停。'
          clearTimeout(draft.timer)
          notify()
        } else void loadNote(draft)
      }
    },
    pending() {
      return [
        ...[...notes.values()].filter((draft) => draft.dirty || draft.saving),
        ...[...metadata.values()].filter((draft) => draft.modified.size || draft.saving)
      ]
    },
    discardProject(projectId: string) {
      for (const draft of notes.values()) {
        if (draft.projectId !== projectId) continue
        clearTimeout(draft.timer)
        draft.dirty = false
        draft.readRequest += 1
        notes.delete(draft.key)
      }
      for (const draft of metadata.values()) if (draft.projectId === projectId) {
        draft.modified.clear()
        metadata.delete(draft.key)
      }
      notify()
    }
  }
}

export const EditorSessionContext = createContext<ReturnType<typeof createEditorSession> | null>(null)

export function useEditorSession() {
  const context = useContext(EditorSessionContext)
  const [local] = useState(createEditorSession)
  const session = context ?? local
  useSyncExternalStore(session.subscribe, session.snapshot)
  return session
}

export interface ReadingPosition { top: number; anchorIndex?: number; anchorOffset?: number }

export function useModalDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    const previous = document.activeElement as HTMLElement | null
    dialog.showModal()
    ;(dialog.querySelector('input:not(:disabled), textarea:not(:disabled), select:not(:disabled)') as HTMLElement | null ?? dialog.querySelector('button'))?.focus()
    const cancel = (event: Event): void => { event.preventDefault(); close.current() }
    dialog.addEventListener('cancel', cancel)
    return () => {
      dialog.removeEventListener('cancel', cancel)
      dialog.close()
      previous?.focus()
    }
  }, [open])
  return ref
}

export function useMenuFocus(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const menu = ref.current
    if (!open || !menu) return
    const previous = document.activeElement as HTMLElement | null
    const bounds = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - bounds.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(bounds.top, window.innerHeight - bounds.height - 8))}px`
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'))
    items[0]?.focus()
    const keydown = (event: KeyboardEvent): void => {
      const index = items.indexOf(document.activeElement as HTMLElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % items.length
          : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : -1
      if (next >= 0) { event.preventDefault(); items[next]?.focus() }
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation(); close.current()
      }
    }
    menu.addEventListener('keydown', keydown)
    return () => { menu.removeEventListener('keydown', keydown); previous?.focus() }
  }, [open])
  return ref
}
