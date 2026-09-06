import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  PaperDetail,
  ProjectSummary,
  ServiceEvent,
  FeedSubscription
} from '../../shared/contracts'
import { AddPapersDialog } from './AddPapersDialog'
import { bridge, errorMessage } from './bridge'
import { ReaderErrorBoundary } from './ErrorBoundary'
import { AddFeedDialog, FeedInbox } from './FeedInbox'
import { Icon } from './Icon'
import { MarkdownReader } from './MarkdownReader'
import { ProjectDialog } from './ProjectDialog'
import { type InspectorTab, WorkspaceInspector } from './WorkspaceInspector'
import {
  LIBRARY_TAB_KEY,
  RESIZER_WIDTH,
  useLibraryWorkspace,
  usePaneLayout,
  useWorkspaceTabs
} from './workspace-hooks'
import {
  LibraryWorkspace,
  PaperTitleHeader,
  ProjectSidebar,
  ReaderWorkspace,
  SidebarResizer,
  WorkspaceTabBar
} from './workspace-components'

const PROJECT_STORAGE_KEY = 'litroot.current-project'
const TRANSIENT_PROJECT_REFRESH_MS = 1_000

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
      <PaperTitleHeader
        paper={paper}
        doiPrefix="DOI "
        sourceLabel="在线查看"
        onOpenExternal={(url) => { void bridge().system.openExternal(url) }}
      />
      <ReaderErrorBoundary key={`${projectId}:${paper.id}:${paper.markdownRevision}`}>
        <MarkdownReader projectId={projectId} paperId={paper.id} title={paper.title} markdown={paper.markdown} />
      </ReaderErrorBoundary>
    </main>
  )
}

function WorkspaceApp() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [feeds, setFeeds] = useState<FeedSubscription[]>([])
  const [feedScope, setFeedScope] = useState<'recent' | string | null>(null)
  const [feedDialog, setFeedDialog] = useState(false)
  const [projectId, setProjectId] = useState(
    () => window.localStorage.getItem(PROJECT_STORAGE_KEY) ?? ''
  )
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('metadata')
  const [projectDialog, setProjectDialog] = useState(false)
  const [fetchDialog, setFetchDialog] = useState(false)
  const [focusFetchRunId, setFocusFetchRunId] = useState<string | null>(null)
  const [refreshTarget, setRefreshTarget] = useState<{
    targets: Array<{ paperId: string; query: string }>
    batch: boolean
    skippedCount: number
  } | null>(null)
  const [event, setEvent] = useState<ServiceEvent | null>(null)
  const [revision, setRevision] = useState(0)
  const [projectMenu, setProjectMenu] = useState<{
    project: ProjectSummary
    left: number
    top: number
  } | null>(null)
  const [feedMenu, setFeedMenu] = useState<{ feed: FeedSubscription; left: number; top: number } | null>(null)

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? null,
    [projects, projectId]
  )
  const library = useLibraryWorkspace({
    projectId,
    projectStatus: selectedProject?.status,
    revision,
    onMessage: setMessage
  })
  const tabs = useWorkspaceTabs({
    projectId,
    revision,
    setProjectId,
    setFeedScope,
    onMessage: setMessage
  })
  const pane = usePaneLayout(tabs.activePaperTab?.key ?? null)
  const {
    query, year, offset, papers, total, years, selectedPaperId, selectedPaperIds,
    selectionAnchorId, loadingPapers, preferences, setPreferences, setSelectedPaperId,
    setSelectedPaperIds, setSelectionAnchorId, changeSort, changePage
  } = library
  const {
    openTabs, activeTabKey, activePaperTab, activePaper, loadingDetail, readerPanelRef,
    activateTab, openPaper, closeTab
  } = tabs
  const {
    appShellRef, sidebarWidth, inspectorWidth, beginResize, resizeWithKeyboard
  } = pane

  useEffect(() => {
    if (!projectMenu && !feedMenu) return
    const close = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') { setProjectMenu(null); setFeedMenu(null) }
    }
    const dismiss = (): void => { setProjectMenu(null); setFeedMenu(null) }
    window.addEventListener('keydown', close)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('keydown', close)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [feedMenu, projectMenu])

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

  const loadFeeds = useCallback(async () => {
    try {
      const next = await bridge().feeds.list()
      setFeeds(next)
      setFeedScope((current) => current && current !== 'recent' && !next.some((feed) => feed.id === current) ? 'recent' : current)
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }, [])

  useEffect(() => { void loadProjects() }, [loadProjects])
  useEffect(() => { void loadFeeds() }, [loadFeeds])

  useEffect(() => {
    if (!projects.some((project) => project.status === 'connecting' || project.status === 'scanning')) return
    const timeout = window.setTimeout(() => { void loadProjects() }, TRANSIENT_PROJECT_REFRESH_MS)
    return () => window.clearTimeout(timeout)
  }, [loadProjects, projects])

  useEffect(() => bridge().events.subscribe((next) => {
    setEvent(next)
    if (next.type === 'feeds.changed') void loadFeeds()
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
  }), [loadFeeds, loadProjects])


  const selectProject = (nextProjectId: string): void => {
    setFeedScope(null)
    tabs.activateLibrary()
    if (nextProjectId !== projectId) setProjectId(nextProjectId)
  }

  const selectFeed = (scope: 'recent' | string): void => {
    tabs.activateLibrary()
    setFeedScope(scope)
  }

  const locatePaper = async (nextPaperId: string): Promise<void> => {
    if (!projectId) return
    library.resetFilters()
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
    tabs.updatePaper(next)
    library.replacePaper(next)
    setRevision((value) => value + 1)
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
      tabs.removeProjectTabs(project.id)
      await loadProjects()
    } catch (error) {
      setMessage(errorMessage(error))
    }
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

  const openFeedMenu = (feed: FeedSubscription, button: HTMLButtonElement): void => {
    const bounds = button.getBoundingClientRect()
    setFeedMenu({ feed, left: Math.max(8, Math.min(window.innerWidth - 158, bounds.right - 150)), top: bounds.bottom + 2 })
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
      <ProjectSidebar
        projects={projects}
        feeds={feeds}
        projectId={projectId}
        feedScope={feedScope}
        activeProjectMenuId={projectMenu?.project.id ?? null}
        onAddFeed={() => setFeedDialog(true)}
        onSelectFeed={selectFeed}
        onOpenFeedMenu={openFeedMenu}
        onSelectProject={selectProject}
        onOpenProjectMenu={openProjectMenu}
        onConnectProject={() => setProjectDialog(true)}
      />
      <SidebarResizer
        width={sidebarWidth}
        onPointerDown={(event) => beginResize(event, 'sidebar')}
        onKeyDown={(event) => resizeWithKeyboard(event, 'sidebar')}
      />
      <div className="workspace-shell">
        <WorkspaceTabBar
          tabs={openTabs}
          activeKey={activeTabKey}
          feedActive={Boolean(feedScope)}
          onActivate={activateTab}
          onClose={closeTab}
          onHome={() => {
            activateTab(LIBRARY_TAB_KEY)
            if (feedScope && projectId) setFeedScope(null)
          }}
        />

        <main className="workspace-content">
          {feedScope ? (
            <FeedInbox
              scope={feedScope}
              feeds={feeds}
              projects={projects}
              event={event}
              onMessage={setMessage}
              onFetchCreated={(targetProjectId, runId) => {
                selectProject(targetProjectId)
                setFocusFetchRunId(runId)
                setRefreshTarget(null)
                setFetchDialog(true)
              }}
            />
          ) : !selectedProject ? (
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
            <ReaderWorkspace
              project={selectedProject}
              paper={activePaper}
              panelRef={readerPanelRef}
              inspectorWidth={inspectorWidth}
              inspector={renderInspector(selectedProject, activePaper)}
              onOpenExternal={(url) => { void bridge().system.openExternal(url) }}
              onRefresh={(paper) => {
                setRefreshTarget({
                  targets: [{
                    paperId: paper.id,
                    query: paper.doi || paper.url || paper.title
                  }],
                  batch: false,
                  skippedCount: 0
                })
                setFetchDialog(true)
              }}
              onResizePointerDown={(event) => beginResize(event, 'inspector')}
              onResizeKeyDown={(event) => resizeWithKeyboard(event, 'inspector')}
            />
          ) : (
            <LibraryWorkspace
              project={selectedProject}
              items={papers}
              loading={loadingPapers}
              query={query}
              year={year}
              years={years}
              total={total}
              offset={offset}
              selectedPaperId={selectedPaperId}
              selectedPaperIds={selectedPaperIds}
              selectionAnchorId={selectionAnchorId}
              preferences={preferences}
              setPreferences={setPreferences}
              onQueryChange={library.changeQuery}
              onYearChange={library.changeYear}
              onClearFilters={library.resetFilters}
              onAddPaper={() => { setRefreshTarget(null); setFetchDialog(true) }}
              onSortChange={changeSort}
              onSelectionChange={(paperIds, focusedPaperId, anchorPaperId) => {
                setSelectedPaperIds(paperIds)
                setSelectedPaperId(focusedPaperId)
                setSelectionAnchorId(anchorPaperId)
              }}
              onOpen={openPaper}
              onOpenWindow={(paper) => {
                if (!projectId) return
                void bridge().papers.openWindow(projectId, paper.id)
                  .catch((error) => setMessage(errorMessage(error)))
              }}
              onOpenOnline={(paper) => {
                const url = paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : '')
                if (url) void bridge().system.openExternal(url)
                  .catch((error) => setMessage(errorMessage(error)))
              }}
              onReveal={(paper) => {
                if (!projectId) return
                void bridge().papers.reveal(projectId, paper.id)
                  .catch((error) => setMessage(errorMessage(error)))
              }}
              onBatchRefresh={(selected, skippedCount) => {
                const targets = selected.map((paper) => ({ paperId: paper.id, query: paper.doi }))
                if (targets.length === 0) {
                  setMessage('所选文献均缺少 DOI，无法批量刷新。')
                  return
                }
                setRefreshTarget({ targets, batch: true, skippedCount })
                setFocusFetchRunId(null)
                setFetchDialog(true)
              }}
              onExport={(paperIds, includeImages) => { void exportPapers(paperIds, includeImages) }}
              onPageChange={changePage}
            />
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

      {feedMenu && createPortal(
        <div className="project-menu-layer" onMouseDown={() => setFeedMenu(null)}>
          <div className="project-menu-popup feed-menu-popup" role="menu" style={{ left: feedMenu.left, top: feedMenu.top }} onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" role="menuitem" onClick={() => {
              const feed = feedMenu.feed
              setFeedMenu(null)
              void bridge().feeds.refresh(feed.id).catch((error) => setMessage(errorMessage(error)))
            }}><Icon name="refresh" />立即刷新</button>
            <button type="button" role="menuitem" onClick={() => {
              const feed = feedMenu.feed
              setFeedMenu(null)
              void bridge().feeds.markRead({ subscriptionId: feed.id, allUnread: true, read: true }).catch((error) => setMessage(errorMessage(error)))
            }}>全部标为已读</button>
            <button type="button" role="menuitem" className="danger-text" onClick={() => {
              const feed = feedMenu.feed
              setFeedMenu(null)
              if (!window.confirm(`移除期刊“${feed.title}”？其临时文献和阅读状态会被删除。`)) return
              void bridge().feeds.remove(feed.id).then(() => {
                if (feedScope === feed.id) setFeedScope('recent')
              }).catch((error) => setMessage(errorMessage(error)))
            }}><Icon name="unlink" />移除期刊</button>
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
      <AddFeedDialog
        open={feedDialog}
        onClose={() => setFeedDialog(false)}
        onAdded={(feed) => {
          setFeeds((current) => [...current.filter((item) => item.id !== feed.id), feed])
          selectFeed(feed.id)
        }}
      />
      {selectedProject && (
        <AddPapersDialog
          open={fetchDialog}
          project={selectedProject}
          event={event}
          refresh={refreshTarget}
          focusRunId={focusFetchRunId}
          onClose={() => { setFetchDialog(false); setRefreshTarget(null); setFocusFetchRunId(null) }}
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
