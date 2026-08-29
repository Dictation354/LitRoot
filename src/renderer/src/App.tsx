import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  PaperDetail,
  PaperListItem,
  PaperSortField,
  ProjectSummary,
  ServiceEvent
} from '../../shared/contracts'
import { AddPapersDialog } from './AddPapersDialog'
import { bridge, errorMessage } from './bridge'
import { ReaderErrorBoundary } from './ErrorBoundary'
import { FormattedTitle } from './FormattedTitle'
import { Icon } from './Icon'
import { LibraryTable } from './LibraryTable'
import { loadLibraryPreferences, saveLibraryPreferences } from './library-preferences'
import { MarkdownReader } from './MarkdownReader'
import { ProjectDialog } from './ProjectDialog'
import { type InspectorTab, WorkspaceInspector } from './WorkspaceInspector'

const PAGE_SIZE = 50
const PROJECT_STORAGE_KEY = 'litroot.current-project'
const LIBRARY_TAB_KEY = 'library'
const SIDEBAR_WIDTH_KEY = 'litroot.sidebar-width'
const INSPECTOR_WIDTH_KEY = 'litroot.inspector-width'
const DEFAULT_SIDEBAR_WIDTH = 236
const DEFAULT_INSPECTOR_WIDTH = 340
const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 420
const MIN_INSPECTOR_WIDTH = 260
const MAX_INSPECTOR_WIDTH = 520
const MIN_MAIN_WIDTH = 480
const RESIZER_WIDTH = 5

interface PaperTab {
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

function authorLine(authors: string[]): string {
  if (authors.length === 0) return '未知作者'
  if (authors.length <= 3) return authors.join(' · ')
  return `${authors.slice(0, 3).join(' · ')} 等`
}

function paperTabKey(projectId: string, paperId: string): string {
  return `paper:${projectId}:${paperId}`
}

function statusLabel(status: ProjectSummary['status']): string {
  if (status === 'ready') return '已就绪'
  if (status === 'empty') return '空项目'
  if (status === 'scanning') return '扫描中'
  if (status === 'connecting') return '连接中'
  return '连接错误'
}

function ReaderWindow({ projectId, paperId }: { projectId: string; paperId: string }) {
  const [paper, setPaper] = useState<PaperDetail | null>(null)
  const [message, setMessage] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => bridge().events.subscribe((event) => {
    if (event.type === 'papers.changed' && event.projectId === projectId) {
      setRevision((value) => value + 1)
    }
  }), [projectId])

  useEffect(() => {
    let cancelled = false
    void bridge().papers.get(projectId, paperId).then((detail) => {
      if (cancelled) return
      setPaper(detail)
      document.title = detail ? `${detail.title} — LitRoot` : '文献不存在 — LitRoot'
    }).catch((error) => {
      if (!cancelled) setMessage(errorMessage(error))
    })
    return () => { cancelled = true }
  }, [projectId, paperId, revision])

  if (message) return <div className="reader-window-state" role="alert">{message}</div>
  if (!paper) return <div className="reader-window-state">正在载入文献…</div>
  return (
    <main className="reader-window">
      <header className="reader-header">
        <span className="eyebrow">{paper.source || 'PAPER-FETCH'}</span>
        <h1><FormattedTitle>{paper.title}</FormattedTitle></h1>
        <p className="reader-authors">{authorLine(paper.authors)}</p>
        <div className="reader-meta">
          {paper.journal && <span>{paper.journal}</span>}
          {paper.year && <span>{paper.year}</span>}
          {paper.doi && (
            <button type="button" className="text-button" onClick={() => void bridge().system.openExternal(`https://doi.org/${paper.doi}`)}>
              DOI {paper.doi}
            </button>
          )}
          {paper.url && (
            <button type="button" className="text-button" onClick={() => void bridge().system.openExternal(paper.url)}>
              在线查看
            </button>
          )}
        </div>
      </header>
      <ReaderErrorBoundary key={`${projectId}:${paper.id}:${paper.markdownRevision}`}>
        <MarkdownReader projectId={projectId} paperId={paper.id} title={paper.title} markdown={paper.markdown} />
      </ReaderErrorBoundary>
    </main>
  )
}

function WorkspaceApp() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectId, setProjectId] = useState(
    () => window.localStorage.getItem(PROJECT_STORAGE_KEY) ?? ''
  )
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [year, setYear] = useState<number | null>(null)
  const [offset, setOffset] = useState(0)
  const [papers, setPapers] = useState<PaperListItem[]>([])
  const [total, setTotal] = useState(0)
  const [years, setYears] = useState<number[]>([])
  const [selectedPaperId, setSelectedPaperId] = useState('')
  const [selectedPaperIds, setSelectedPaperIds] = useState<string[]>([])
  const [selectionAnchorId, setSelectionAnchorId] = useState('')
  const [libraryPaper, setLibraryPaper] = useState<PaperDetail | null>(null)
  const [readerState, setReaderState] = useState<{ key: string; paper: PaperDetail } | null>(null)
  const [loadingPapers, setLoadingPapers] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [message, setMessage] = useState('')
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('metadata')
  const [projectDialog, setProjectDialog] = useState(false)
  const [fetchDialog, setFetchDialog] = useState(false)
  const [refreshTarget, setRefreshTarget] = useState<{ paperId: string; query: string } | null>(null)
  const [event, setEvent] = useState<ServiceEvent | null>(null)
  const [revision, setRevision] = useState(0)
  const [openTabs, setOpenTabs] = useState<PaperTab[]>([])
  const [activeTabKey, setActiveTabKey] = useState(LIBRARY_TAB_KEY)
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
  const [projectMenu, setProjectMenu] = useState<{
    project: ProjectSummary
    left: number
    top: number
  } | null>(null)
  const [preferences, setPreferences] = useState(
    () => loadLibraryPreferences(window.localStorage)
  )
  const readerPanelRef = useRef<HTMLElement>(null)
  const appShellRef = useRef<HTMLDivElement>(null)
  const debouncedQuery = useDebounced(query, 250)

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? null,
    [projects, projectId]
  )
  const activePaperTab = useMemo(
    () => openTabs.find((tab) => tab.key === activeTabKey) ?? null,
    [activeTabKey, openTabs]
  )
  const activePaper = activePaperTab && readerState?.key === activePaperTab.key
    ? readerState.paper
    : null
  const inspectorPaper = activePaperTab ? activePaper : libraryPaper

  useEffect(() => saveLibraryPreferences(window.localStorage, preferences), [preferences])
  useEffect(() => saveStoredWidth(SIDEBAR_WIDTH_KEY, sidebarWidth), [sidebarWidth])
  useEffect(() => saveStoredWidth(INSPECTOR_WIDTH_KEY, inspectorWidth), [inspectorWidth])

  useEffect(() => {
    if (!projectMenu) return
    const close = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setProjectMenu(null)
    }
    const dismiss = (): void => setProjectMenu(null)
    window.addEventListener('keydown', close)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('keydown', close)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [projectMenu])

  useLayoutEffect(() => {
    const fitLayout = (): void => {
      const total = appShellRef.current?.clientWidth || window.innerWidth
      let nextSidebar = sidebarWidth
      let nextInspector = inspectorWidth
      let overflow = nextSidebar + nextInspector + MIN_MAIN_WIDTH + RESIZER_WIDTH * 2 - total
      if (overflow > 0) {
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
  }, [inspectorWidth, sidebarWidth])

  useLayoutEffect(() => {
    if (readerPanelRef.current) readerPanelRef.current.scrollTop = 0
  }, [activeTabKey])

  const loadProjects = useCallback(async () => {
    try {
      const next = await bridge().projects.list()
      setProjects(next)
      setProjectId((current) => {
        if (next.some((project) => project.id === current)) return current
        return next[0]?.id ?? ''
      })
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setProjectsLoading(false)
    }
  }, [])

  useEffect(() => { void loadProjects() }, [loadProjects])

  useEffect(() => bridge().events.subscribe((next) => {
    setEvent(next)
    if (next.type === 'papers.changed') setRevision((value) => value + 1)
    if (next.type === 'scan.started') {
      setProjects((current) => current.map((project) => (
        project.id === next.projectId ? { ...project, status: 'scanning' } : project
      )))
    }
    if (next.type === 'scan.completed') {
      setRevision((value) => value + 1)
      void loadProjects()
    }
  }), [loadProjects])

  useEffect(() => {
    if (projectId) window.localStorage.setItem(PROJECT_STORAGE_KEY, projectId)
    else window.localStorage.removeItem(PROJECT_STORAGE_KEY)
    setQuery('')
    setYear(null)
    setOffset(0)
    setSelectedPaperId('')
    setSelectedPaperIds([])
    setSelectionAnchorId('')
    setLibraryPaper(null)
  }, [projectId])

  useEffect(() => {
    if (!projectId || selectedProject?.status === 'error') {
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
      limit: PAGE_SIZE,
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
      if (!cancelled) setMessage(errorMessage(error))
    }).finally(() => {
      if (!cancelled) setLoadingPapers(false)
    })
    return () => { cancelled = true }
  }, [
    projectId,
    selectedProject?.status,
    debouncedQuery,
    year,
    offset,
    preferences.sortBy,
    preferences.sortDirection,
    revision
  ])

  useEffect(() => {
    if (!projectId || !selectedPaperId) {
      setLibraryPaper(null)
      return
    }
    let cancelled = false
    setLoadingDetail(true)
    void bridge().papers.get(projectId, selectedPaperId).then((detail) => {
      if (!cancelled) setLibraryPaper(detail)
    }).catch((error) => {
      if (!cancelled) setMessage(errorMessage(error))
    }).finally(() => {
      if (!cancelled) setLoadingDetail(false)
    })
    return () => { cancelled = true }
  }, [projectId, selectedPaperId, revision])

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
      if (!cancelled) setMessage(errorMessage(error))
    }).finally(() => {
      if (!cancelled) setLoadingDetail(false)
    })
    return () => { cancelled = true }
  }, [activePaperTab?.key, activePaperTab?.projectId, activePaperTab?.paperId, revision])

  const selectProject = (nextProjectId: string): void => {
    setActiveTabKey(LIBRARY_TAB_KEY)
    if (nextProjectId !== projectId) setProjectId(nextProjectId)
  }

  const activateTab = (key: string): void => {
    if (key === LIBRARY_TAB_KEY) {
      setActiveTabKey(key)
      return
    }
    const tab = openTabs.find((item) => item.key === key)
    if (!tab) return
    if (tab.key !== activeTabKey) setReaderState(null)
    setActiveTabKey(key)
    if (tab.projectId !== projectId) setProjectId(tab.projectId)
  }

  const openPaper = (paper: Pick<PaperListItem, 'id' | 'title'>, ownerProjectId = projectId): void => {
    if (!ownerProjectId) return
    void bridge().papers.markOpened(ownerProjectId, paper.id).catch((error) => setMessage(errorMessage(error)))
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

  const locatePaper = async (nextPaperId: string): Promise<void> => {
    if (!projectId) return
    setQuery('')
    setYear(null)
    setOffset(0)
    setSelectedPaperIds([])
    setSelectionAnchorId('')
    setFetchDialog(false)
    setRefreshTarget(null)
    try {
      const detail = await bridge().papers.get(projectId, nextPaperId)
      if (detail) openPaper(detail)
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  const updatePaper = (next: PaperDetail): void => {
    setLibraryPaper((current) => current?.id === next.id ? next : current)
    setReaderState((current) => current?.paper.id === next.id
      ? { ...current, paper: next }
      : current)
    setPapers((current) => current.map((paper) => paper.id === next.id ? next : paper))
    setOpenTabs((current) => current.map((tab) => (
      tab.projectId === projectId && tab.paperId === next.id
        ? { ...tab, title: next.title }
        : tab
    )))
    setRevision((value) => value + 1)
  }

  const changeSort = (sortBy: PaperSortField): void => {
    setPreferences((current) => ({
      ...current,
      sortBy,
      sortDirection: current.sortBy === sortBy && current.sortDirection === 'asc' ? 'desc' : 'asc'
    }))
    setOffset(0)
    setSelectedPaperIds([])
    setSelectionAnchorId('')
  }

  const changePage = (nextOffset: number): void => {
    setOffset(nextOffset)
    setSelectedPaperIds([])
    setSelectionAnchorId('')
  }

  const exportPapers = async (paperIds: string[], includeImages: boolean): Promise<void> => {
    if (!projectId || paperIds.length === 0) return
    try {
      const result = await bridge().papers.export(projectId, paperIds, includeImages)
      if (!result) return
      setMessage(result.failures.length > 0
        ? `已导出 ${result.papers} 篇文献、${result.images} 张图片；${result.failures.length} 个文件失败。`
        : `已导出 ${result.papers} 篇文献、${result.images} 张图片。`)
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  const scanProject = async (targetProjectId: string): Promise<void> => {
    try {
      await bridge().projects.scan(targetProjectId)
      setRevision((value) => value + 1)
      await loadProjects()
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  const removeProject = async (project: ProjectSummary): Promise<void> => {
    if (!window.confirm(`只断开“${project.name}”？项目文件不会被删除。`)) return
    try {
      await bridge().projects.remove(project.id)
      const removedKeys = new Set(openTabs.filter((tab) => tab.projectId === project.id).map((tab) => tab.key))
      setOpenTabs((current) => current.filter((tab) => tab.projectId !== project.id))
      if (removedKeys.has(activeTabKey)) setActiveTabKey(LIBRARY_TAB_KEY)
      await loadProjects()
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  const appWidth = (): number => appShellRef.current?.clientWidth || window.innerWidth

  const clampSidebar = (value: number, currentInspector = inspectorWidth): number => {
    const dynamicMaximum = appWidth() - currentInspector - MIN_MAIN_WIDTH - RESIZER_WIDTH * 2
    return Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, dynamicMaximum), Math.max(MIN_SIDEBAR_WIDTH, value)))
  }

  const clampInspector = (value: number, currentSidebar = sidebarWidth): number => {
    const dynamicMaximum = appWidth() - currentSidebar - MIN_MAIN_WIDTH - RESIZER_WIDTH * 2
    return Math.round(Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, dynamicMaximum), Math.max(MIN_INSPECTOR_WIDTH, value)))
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

  const openProjectMenu = (project: ProjectSummary, button: HTMLButtonElement): void => {
    const bounds = button.getBoundingClientRect()
    const menuWidth = 145
    const menuHeight = 83
    setProjectMenu({
      project,
      left: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, bounds.right - menuWidth)),
      top: bounds.bottom + menuHeight <= window.innerHeight - 8
        ? bounds.bottom + 2
        : Math.max(8, bounds.top - menuHeight - 2)
    })
  }

  const renderInspector = (project: ProjectSummary, paper: PaperDetail | null) => (
    <WorkspaceInspector
      project={project}
      paper={paper}
      loadingPaper={loadingDetail}
      tab={inspectorTab}
      event={event}
      onTabChange={setInspectorTab}
      onPaperChange={updatePaper}
      onLocatePaper={(paperId) => { void locatePaper(paperId) }}
    />
  )

  if (projectsLoading) {
    return (
      <div className="splash">
        <div className="brand-mark large"><span /></div>
        <p>正在连接 LitRoot…</p>
      </div>
    )
  }

  return (
    <div
      className="app-shell"
      ref={appShellRef}
      style={{ gridTemplateColumns: `${sidebarWidth}px ${RESIZER_WIDTH}px minmax(0, 1fr)` }}
    >
      <aside className="project-sidebar">
        <div className="brand">
          <div className="brand-mark"><span /></div>
          <div><strong>LitRoot</strong><small>项目即文献库</small></div>
        </div>
        <nav className="project-navigation" aria-label="项目">
          <div className="sidebar-section-title">
            <span>项目</span>
            <span>{projects.length}</span>
          </div>
          <div className="project-list">
            {projects.map((project) => (
              <div className={`project-entry ${project.id === projectId ? 'selected' : ''}`} key={`${project.runtime?.kind ?? 'service'}-${project.runtime?.kind === 'wsl' ? project.runtime.distribution : ''}-${project.id}`}>
                <button
                  type="button"
                  className="project-main"
                  onClick={() => selectProject(project.id)}
                  title={`${project.path}${project.runtime ? ` · ${project.runtime.kind === 'wsl' ? `WSL · ${project.runtime.distribution}` : '本机'}` : ''}`}
                >
                  <Icon name="folder" size={17} />
                  <span>
                    <strong>{project.name}</strong>
                    <small>{statusLabel(project.status)}</small>
                  </span>
                  <span className={`project-count ${project.status}`}>{project.paperCount}</span>
                </button>
                <button
                  type="button"
                  className="project-menu-trigger"
                  aria-label={`${project.name}项目操作`}
                  aria-expanded={projectMenu?.project.id === project.id}
                  onClick={(event) => openProjectMenu(project, event.currentTarget)}
                >
                  <Icon name="more" />
                </button>
              </div>
            ))}
            {projects.length === 0 && (
              <p className="sidebar-empty">连接一个项目目录以开始管理文献。</p>
            )}
          </div>
        </nav>
        <button type="button" className="connect-project-button" onClick={() => setProjectDialog(true)}>
          <Icon name="add" />连接项目
        </button>
      </aside>

      <div
        className="pane-resizer sidebar-resizer"
        role="separator"
        aria-label="调整项目栏宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onPointerDown={(event) => beginResize(event, 'sidebar')}
        onKeyDown={(event) => resizeWithKeyboard(event, 'sidebar')}
      />

      <div className="workspace-shell">
        <nav
          className="workspace-tabs"
          aria-label="工作区标签"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
            const current = tabs.indexOf(document.activeElement as HTMLElement)
            let next = current
            if (event.key === 'ArrowRight') next = (current + 1) % tabs.length
            if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length
            if (event.key === 'Home') next = 0
            if (event.key === 'End') next = tabs.length - 1
            event.preventDefault()
            tabs[next]?.focus()
            tabs[next]?.click()
          }}
          role="tablist"
        >
          <button
            aria-selected={activeTabKey === LIBRARY_TAB_KEY}
            className={`workspace-tab home-tab ${activeTabKey === LIBRARY_TAB_KEY ? 'active' : ''}`}
            onClick={() => activateTab(LIBRARY_TAB_KEY)}
            role="tab"
            tabIndex={activeTabKey === LIBRARY_TAB_KEY ? 0 : -1}
            type="button"
          >
            <Icon name="library" />
            <span>文献库</span>
          </button>
          {openTabs.map((tab) => (
            <div
              aria-selected={activeTabKey === tab.key}
              className={`workspace-tab paper-tab ${activeTabKey === tab.key ? 'active' : ''}`}
              key={tab.key}
              onClick={() => activateTab(tab.key)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') activateTab(tab.key)
                if (event.key === 'Delete') closeTab(tab.key)
              }}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  closeTab(tab.key)
                }
              }}
              role="tab"
              tabIndex={activeTabKey === tab.key ? 0 : -1}
              title={tab.title}
            >
              <Icon name="book" />
              <span><FormattedTitle>{tab.title}</FormattedTitle></span>
              <button
                type="button"
                className="tab-close"
                onClick={(event) => { event.stopPropagation(); closeTab(tab.key) }}
                aria-label={`关闭 ${tab.title}`}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
        </nav>

        <main className="workspace-content">
          {!selectedProject ? (
            <section className="welcome">
              <div className="brand-mark hero"><span /></div>
              <span className="eyebrow">LOCAL · WSL · MARKDOWN</span>
              <h1>让项目目录成为<br />文献事实来源。</h1>
              <p>连接项目后，文献会以可搜索、可配置的表格展示，并可在多个阅读标签间切换。</p>
              <button type="button" className="primary-button hero-button" onClick={() => setProjectDialog(true)}>连接第一个项目</button>
            </section>
          ) : selectedProject.status === 'error' ? (
            <section className="welcome error-welcome">
              <span className="eyebrow">连接错误</span>
              <h1>{selectedProject.name}</h1>
              <p>{selectedProject.error}</p>
              <div className="button-row welcome-actions">
                <button type="button" onClick={() => void scanProject(selectedProject.id)}>重新扫描</button>
                <button type="button" onClick={() => setProjectDialog(true)}>连接其他项目</button>
              </div>
            </section>
          ) : activePaperTab ? (
            <div
              className="reader-workspace"
              style={{ gridTemplateColumns: `minmax(${MIN_MAIN_WIDTH}px, 1fr) ${RESIZER_WIDTH}px ${inspectorWidth}px` }}
            >
              <section className="reader-panel" ref={readerPanelRef}>
                {activePaper ? (
                  <>
                    <header className="reader-header">
                      <span className="eyebrow">{activePaper.source || 'PAPER-FETCH'}</span>
                      <h1><FormattedTitle>{activePaper.title}</FormattedTitle></h1>
                      <p className="reader-authors">{authorLine(activePaper.authors)}</p>
                      <div className="reader-meta">
                        {activePaper.journal && <span>{activePaper.journal}</span>}
                        {activePaper.year && <span>{activePaper.year}</span>}
                        {activePaper.doi && (
                          <button type="button" className="text-button" onClick={() => void bridge().system.openExternal(`https://doi.org/${activePaper.doi}`)}>
                            {activePaper.doi}
                          </button>
                        )}
                        {activePaper.url && (
                          <button type="button" className="text-button" onClick={() => void bridge().system.openExternal(activePaper.url)}>
                            来源页面
                          </button>
                        )}
                        <button type="button" onClick={() => {
                          setRefreshTarget({
                            paperId: activePaper.id,
                            query: activePaper.doi || activePaper.url || activePaper.title
                          })
                          setFetchDialog(true)
                        }}>
                          安全刷新
                        </button>
                      </div>
                    </header>
                    <ReaderErrorBoundary key={`${selectedProject.id}:${activePaper.id}:${activePaper.markdownRevision}`}>
                      <MarkdownReader projectId={selectedProject.id} paperId={activePaper.id} title={activePaper.title} markdown={activePaper.markdown} />
                    </ReaderErrorBoundary>
                  </>
                ) : (
                  <div className="empty-state"><h2>正在载入文献…</h2></div>
                )}
              </section>
              <div
                className="pane-resizer inspector-resizer"
                role="separator"
                aria-label="调整详情栏宽度"
                aria-orientation="vertical"
                aria-valuemin={MIN_INSPECTOR_WIDTH}
                aria-valuemax={MAX_INSPECTOR_WIDTH}
                aria-valuenow={inspectorWidth}
                tabIndex={0}
                onPointerDown={(event) => beginResize(event, 'inspector')}
                onKeyDown={(event) => resizeWithKeyboard(event, 'inspector')}
              />
              {renderInspector(selectedProject, activePaper)}
            </div>
          ) : (
            <div
              className="library-workspace"
              style={{ gridTemplateColumns: `minmax(${MIN_MAIN_WIDTH}px, 1fr) ${RESIZER_WIDTH}px ${inspectorWidth}px` }}
            >
              <section className="library-main">
                <header className="library-toolbar">
                  <div className="library-identity">
                    <span className="eyebrow">LIBRARY</span>
                    <h1>{selectedProject.name}</h1>
                    <span>{total} 篇文献</span>
                  </div>
                  <div className="library-actions">
                    <label className="search-box">
                      <Icon name="search" />
                      <input
                        aria-label="全文搜索"
                        type="search"
                        value={query}
                        onChange={(event) => {
                          setQuery(event.target.value)
                          setOffset(0)
                          setSelectedPaperIds([])
                          setSelectionAnchorId('')
                        }}
                        placeholder="搜索标题、作者、正文…"
                      />
                    </label>
                    <select
                      aria-label="年份筛选"
                      value={year ?? ''}
                      onChange={(event) => {
                        setYear(event.target.value ? Number(event.target.value) : null)
                        setOffset(0)
                        setSelectedPaperIds([])
                        setSelectionAnchorId('')
                      }}
                    >
                      <option value="">全部年份</option>
                      {years.map((item) => <option value={item} key={item}>{item}</option>)}
                    </select>
                    {(query || year) && (
                      <button type="button" className="text-button clear-filter" onClick={() => {
                        setQuery('')
                        setYear(null)
                        setOffset(0)
                        setSelectedPaperIds([])
                        setSelectionAnchorId('')
                      }}>
                        清空
                      </button>
                    )}
                    <button type="button" className="primary-button add-paper-button" onClick={() => { setRefreshTarget(null); setFetchDialog(true) }}>
                      <Icon name="add" />添加文献
                    </button>
                  </div>
                </header>
                <LibraryTable
                  items={papers}
                  loading={loadingPapers}
                  query={query}
                  selectedPaperId={selectedPaperId}
                  selectedPaperIds={selectedPaperIds}
                  selectionAnchorId={selectionAnchorId}
                  preferences={preferences}
                  setPreferences={setPreferences}
                  onSortChange={changeSort}
                  onSelectionChange={(paperIds, focusedPaperId, anchorPaperId) => {
                    setSelectedPaperIds(paperIds)
                    setSelectedPaperId(focusedPaperId)
                    setSelectionAnchorId(anchorPaperId)
                  }}
                  onOpen={openPaper}
                  onOpenWindow={(paper) => {
                    if (!projectId) return
                    void bridge().papers.openWindow(projectId, paper.id).catch((error) => setMessage(errorMessage(error)))
                  }}
                  onOpenOnline={(paper) => {
                    const url = paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : '')
                    if (url) void bridge().system.openExternal(url).catch((error) => setMessage(errorMessage(error)))
                  }}
                  onReveal={(paper) => {
                    if (!projectId) return
                    void bridge().papers.reveal(projectId, paper.id).catch((error) => setMessage(errorMessage(error)))
                  }}
                  onExport={(paperIds, includeImages) => { void exportPapers(paperIds, includeImages) }}
                />
                <footer className="library-footer">
                  <span>
                    {total === 0 ? '无文献' : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} / ${total}`}
                  </span>
                  <div>
                    <button type="button" disabled={offset === 0} onClick={() => changePage(Math.max(0, offset - PAGE_SIZE))}>上一页</button>
                    <span>{total === 0 ? 0 : Math.floor(offset / PAGE_SIZE) + 1} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
                    <button type="button" disabled={offset + PAGE_SIZE >= total} onClick={() => changePage(offset + PAGE_SIZE)}>下一页</button>
                  </div>
                </footer>
              </section>
              <div
                className="pane-resizer inspector-resizer"
                role="separator"
                aria-label="调整详情栏宽度"
                aria-orientation="vertical"
                aria-valuemin={MIN_INSPECTOR_WIDTH}
                aria-valuemax={MAX_INSPECTOR_WIDTH}
                aria-valuenow={inspectorWidth}
                tabIndex={0}
                onPointerDown={(event) => beginResize(event, 'inspector')}
                onKeyDown={(event) => resizeWithKeyboard(event, 'inspector')}
              />
              {renderInspector(selectedProject, inspectorPaper)}
            </div>
          )}
        </main>
      </div>

      {projectMenu && createPortal(
        <div className="project-menu-layer" onMouseDown={() => setProjectMenu(null)}>
          <div
            className="project-menu-popup"
            role="menu"
            style={{ left: projectMenu.left, top: projectMenu.top }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" onClick={() => {
              setProjectMenu(null)
              void scanProject(projectMenu.project.id)
            }}>
              <Icon name="refresh" />重新扫描
            </button>
            <button type="button" role="menuitem" className="danger-text" onClick={() => {
              const project = projectMenu.project
              setProjectMenu(null)
              void removeProject(project)
            }}>
              <Icon name="unlink" />断开项目
            </button>
          </div>
        </div>,
        document.body
      )}

      {message && (
        <div className="toast" role="alert">
          <span>{message}</span>
          <button type="button" onClick={() => setMessage('')} aria-label="关闭消息">×</button>
        </div>
      )}
      <ProjectDialog
        open={projectDialog}
        onClose={() => setProjectDialog(false)}
        onAdded={(project) => {
          setProjects((current) => [...current.filter((item) => item.id !== project.id), project])
          selectProject(project.id)
        }}
      />
      {selectedProject && (
        <AddPapersDialog
          open={fetchDialog}
          project={selectedProject}
          event={event}
          refresh={refreshTarget}
          onClose={() => { setFetchDialog(false); setRefreshTarget(null) }}
          onOpenPaper={(paperId) => { void locatePaper(paperId) }}
        />
      )}
    </div>
  )
}

export default function App() {
  const parameters = new URLSearchParams(window.location.search)
  const readerProjectId = parameters.get('readerProjectId') ?? ''
  const readerPaperId = parameters.get('readerPaperId') ?? ''
  if (/^project_[a-f0-9]{24}$/.test(readerProjectId) && /^paper_[a-f0-9]{24}$/.test(readerPaperId)) {
    return <ReaderWindow projectId={readerProjectId} paperId={readerPaperId} />
  }
  return <WorkspaceApp />
}
