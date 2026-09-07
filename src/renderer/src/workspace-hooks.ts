import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  PaperDetail,
  PaperListItem,
  PaperSortField,
  ProjectSummary
} from '../../shared/contracts'
import { bridge, errorMessage } from './bridge'
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
  const debouncedQuery = useDebounced(query, 250)

  useEffect(() => saveLibraryPreferences(window.localStorage, preferences), [preferences])

  useEffect(() => {
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
        return retained.length > 0 ? retained : (result.items[0] ? [result.items[0].id] : [])
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
  const readerPanelRef = useRef<HTMLElement>(null)
  const activePaperTab = useMemo(
    () => openTabs.find((tab) => tab.key === activeTabKey) ?? null,
    [activeTabKey, openTabs]
  )
  const activePaper = activePaperTab && readerState?.key === activePaperTab.key
    ? readerState.paper
    : null

  useLayoutEffect(() => {
    if (readerPanelRef.current) readerPanelRef.current.scrollTop = 0
  }, [activeTabKey])

  useEffect(() => {
    if (!activePaperTab) {
      setReaderState(null)
      return
    }
    let cancelled = false
    setLoadingDetail(true)
    void bridge().papers.get(activePaperTab.projectId, activePaperTab.paperId).then((detail) => {
      if (cancelled) return
      if (detail) setReaderState({ key: activePaperTab.key, paper: detail })
      if (detail) {
        setOpenTabs((current) => current.map((tab) => (
          tab.key === activePaperTab.key ? { ...tab, title: detail.title } : tab
        )))
      }
    }).catch((error) => {
      if (!cancelled) onMessage(errorMessage(error))
    }).finally(() => {
      if (!cancelled) setLoadingDetail(false)
    })
    return () => { cancelled = true }
  }, [
    activePaperTab?.key,
    activePaperTab?.projectId,
    activePaperTab?.paperId,
    revision,
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
    setOpenTabs((current) => current.filter((tab) => tab.projectId !== removedProjectId))
    if (removedKeys.has(activeTabKey)) setActiveTabKey(LIBRARY_TAB_KEY)
  }

  return {
    openTabs,
    activeTabKey,
    activePaperTab,
    activePaper,
    loadingDetail,
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

  useEffect(() => saveStoredWidth(SIDEBAR_WIDTH_KEY, sidebarWidth), [sidebarWidth])
  useEffect(() => saveStoredWidth(INSPECTOR_WIDTH_KEY, inspectorWidth), [inspectorWidth])

  useLayoutEffect(() => {
    const fitLayout = (): void => {
      const total = appShellRef.current?.clientWidth || window.innerWidth
      let nextSidebar = sidebarWidth
      let nextInspector = inspectorWidth
      let overflow = nextSidebar + MIN_MAIN_WIDTH + RESIZER_WIDTH
        + (hasInspector ? nextInspector + RESIZER_WIDTH : 0) - total
      if (hasInspector && overflow > 0) {
        const inspectorReduction = Math.min(overflow, nextInspector - MIN_INSPECTOR_WIDTH)
        nextInspector -= inspectorReduction
        overflow -= inspectorReduction
      }
      if (overflow > 0) nextSidebar = Math.max(MIN_SIDEBAR_WIDTH, nextSidebar - overflow)
      if (nextSidebar !== sidebarWidth) setSidebarWidth(Math.round(nextSidebar))
      if (nextInspector !== inspectorWidth) setInspectorWidth(Math.round(nextInspector))
    }
    fitLayout()
    window.addEventListener('resize', fitLayout)
    return () => window.removeEventListener('resize', fitLayout)
  }, [inspectorKey, inspectorWidth, sidebarWidth])

  const appWidth = (): number => appShellRef.current?.clientWidth || window.innerWidth
  const clampSidebar = (value: number, currentInspector = inspectorWidth): number => {
    const dynamicMaximum = appWidth() - MIN_MAIN_WIDTH - RESIZER_WIDTH
      - (hasInspector ? currentInspector + RESIZER_WIDTH : 0)
    return Math.round(Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.max(MIN_SIDEBAR_WIDTH, dynamicMaximum),
      Math.max(MIN_SIDEBAR_WIDTH, value)
    ))
  }
  const clampInspector = (value: number, currentSidebar = sidebarWidth): number => {
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
    const startX = event.clientX
    const startSidebar = sidebarWidth
    const startInspector = inspectorWidth
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
    if (target === 'sidebar') setSidebarWidth((value) => clampSidebar(value + direction))
    else setInspectorWidth((value) => clampInspector(value - direction))
  }

  return {
    appShellRef,
    sidebarWidth,
    inspectorWidth,
    beginResize,
    resizeWithKeyboard
  }
}
