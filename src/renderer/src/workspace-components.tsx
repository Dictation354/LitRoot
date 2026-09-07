import type {
  Dispatch,
  KeyboardEventHandler,
  PointerEventHandler,
  ReactNode,
  RefObject,
  SetStateAction
} from 'react'
import type {
  FeedSubscription,
  PaperDetail,
  PaperListItem,
  PaperSortField,
  ProjectSummary
} from '../../shared/contracts'
import { ReaderErrorBoundary } from './ErrorBoundary'
import { FormattedTitle } from './FormattedTitle'
import { Icon } from './Icon'
import { LibraryTable } from './LibraryTable'
import type { LibraryPreferences } from './library-preferences'
import { MarkdownReader } from './MarkdownReader'
import {
  LIBRARY_TAB_KEY,
  MAX_INSPECTOR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_INSPECTOR_WIDTH,
  MIN_MAIN_WIDTH,
  MIN_SIDEBAR_WIDTH,
  RESIZER_WIDTH,
  type PaperTab
} from './workspace-hooks'

function authorLine(authors: string[]): string {
  if (authors.length === 0) return '未知作者'
  if (authors.length <= 3) return authors.join(' · ')
  return `${authors.slice(0, 3).join(' · ')} 等`
}

function statusLabel(status: ProjectSummary['status']): string {
  if (status === 'ready') return '已就绪'
  if (status === 'empty') return '空项目'
  if (status === 'scanning') return '扫描中'
  if (status === 'connecting') return '连接中'
  return '连接错误'
}

export function PaperTitleHeader({
  paper,
  doiPrefix = '',
  sourceLabel,
  onOpenExternal,
  action
}: {
  paper: PaperDetail
  doiPrefix?: string
  sourceLabel: string
  onOpenExternal(url: string): void
  action?: ReactNode
}) {
  return (
    <header className="reader-header">
      <span className="eyebrow">{paper.source || 'PAPER-FETCH'}</span>
      <h1><FormattedTitle>{paper.title}</FormattedTitle></h1>
      <p className="reader-authors">{authorLine(paper.authors)}</p>
      <div className="reader-meta">
        {paper.journal && <span>{paper.journal}</span>}
        {paper.year && <span>{paper.year}</span>}
        {paper.doi && (
          <button
            type="button"
            className="text-button"
            onClick={() => onOpenExternal(`https://doi.org/${paper.doi}`)}
          >
            {doiPrefix}{paper.doi}
          </button>
        )}
        {paper.url && (
          <button type="button" className="text-button" onClick={() => onOpenExternal(paper.url)}>
            {sourceLabel}
          </button>
        )}
        {action}
      </div>
    </header>
  )
}

export function ProjectSidebar({
  projects,
  feeds,
  projectId,
  feedScope,
  activeProjectMenuId,
  onAddFeed,
  onSelectFeed,
  onOpenFeedMenu,
  onSelectProject,
  onOpenProjectMenu,
  onConnectProject
}: {
  projects: ProjectSummary[]
  feeds: FeedSubscription[]
  projectId: string
  feedScope: 'recent' | string | null
  activeProjectMenuId: string | null
  onAddFeed(): void
  onSelectFeed(scope: 'recent' | string): void
  onOpenFeedMenu(feed: FeedSubscription, button: HTMLButtonElement): void
  onSelectProject(projectId: string): void
  onOpenProjectMenu(project: ProjectSummary, button: HTMLButtonElement): void
  onConnectProject(): void
}) {
  return (
    <aside className="project-sidebar">
      <div className="brand">
        <div className="brand-mark"><span /></div>
        <div><strong>LitRoot</strong><small>项目即文献库</small></div>
      </div>
      <nav className="project-navigation" aria-label="项目">
        <div className="sidebar-section-title">
          <span>期刊雷达</span>
          <button type="button" className="sidebar-add" aria-label="添加期刊" onClick={onAddFeed}>+</button>
        </div>
        <div className="feed-sidebar-list">
          <button
            type="button"
            className={`feed-sidebar-entry ${feedScope === 'recent' ? 'selected' : ''}`}
            onClick={() => onSelectFeed('recent')}
          >
            <Icon name="library" size={16} />
            <span>最近文献</span>
            <strong>{feeds.reduce((sum, feed) => sum + feed.unreadCount, 0)}</strong>
          </button>
          {feeds.map((feed) => (
            <div
              className={`project-entry feed-source-entry ${feedScope === feed.id ? 'selected' : ''}`}
              key={feed.id}
            >
              <button
                type="button"
                className="project-main"
                title={feed.error || `ISSN ${feed.issn}`}
                onClick={() => onSelectFeed(feed.id)}
              >
                <Icon name="book" size={16} />
                <span>
                  <strong>{feed.title}</strong>
                  <small className={feed.error ? 'status-error' : ''}>
                    {feed.error ? 'Crossref 刷新错误' : `ISSN ${feed.issn}`}
                  </small>
                </span>
                <span className={`project-count ${feed.error ? 'error' : ''}`}>{feed.unreadCount}</span>
              </button>
              <button
                type="button"
                className="project-menu-trigger"
                aria-label={`${feed.title}期刊操作`}
                onClick={(event) => onOpenFeedMenu(feed, event.currentTarget)}
              >
                <Icon name="more" />
              </button>
            </div>
          ))}
        </div>
        <div className="sidebar-section-title"><span>项目</span><span>{projects.length}</span></div>
        <div className="project-list">
          {projects.map((project) => (
            <div
              className={`project-entry ${project.id === projectId ? 'selected' : ''}`}
              key={`${project.runtime?.kind ?? 'service'}-${project.runtime?.kind === 'wsl' ? project.runtime.distribution : ''}-${project.id}`}
            >
              <button
                type="button"
                className="project-main"
                onClick={() => onSelectProject(project.id)}
                title={`${project.path}${project.runtime ? ` · ${project.runtime.kind === 'wsl' ? `WSL · ${project.runtime.distribution}` : '本机'}` : ''}`}
              >
                <Icon name="folder" size={17} />
                <span><strong>{project.name}</strong><small>{statusLabel(project.status)}</small></span>
                <span className={`project-count ${project.status}`}>{project.paperCount}</span>
              </button>
              <button
                type="button"
                className="project-menu-trigger"
                aria-label={`${project.name}项目操作`}
                aria-expanded={activeProjectMenuId === project.id}
                onClick={(event) => onOpenProjectMenu(project, event.currentTarget)}
              >
                <Icon name="more" />
              </button>
            </div>
          ))}
          {projects.length === 0 && <p className="sidebar-empty">连接一个项目目录以开始管理文献。</p>}
        </div>
      </nav>
      <button type="button" className="connect-project-button" onClick={onConnectProject}>
        <Icon name="add" />连接项目
      </button>
    </aside>
  )
}

export function SidebarResizer({
  width,
  onPointerDown,
  onKeyDown
}: {
  width: number
  onPointerDown: PointerEventHandler<HTMLDivElement>
  onKeyDown: KeyboardEventHandler<HTMLDivElement>
}) {
  return (
    <div
      className="pane-resizer sidebar-resizer"
      role="separator"
      aria-label="调整项目栏宽度"
      aria-orientation="vertical"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  )
}

export function WorkspaceTabBar({
  tabs,
  activeKey,
  feedActive,
  onActivate,
  onClose,
  onHome
}: {
  tabs: PaperTab[]
  activeKey: string
  feedActive: boolean
  onActivate(key: string): void
  onClose(key: string): void
  onHome(): void
}) {
  return (
    <nav
      className="workspace-tabs"
      aria-label="工作区标签"
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
        const current = elements.indexOf(document.activeElement as HTMLElement)
        let next = current
        if (event.key === 'ArrowRight') next = (current + 1) % elements.length
        if (event.key === 'ArrowLeft') next = (current - 1 + elements.length) % elements.length
        if (event.key === 'Home') next = 0
        if (event.key === 'End') next = elements.length - 1
        event.preventDefault()
        elements[next]?.focus()
        elements[next]?.click()
      }}
      role="tablist"
    >
      <button
        aria-selected={activeKey === LIBRARY_TAB_KEY}
        className={`workspace-tab home-tab ${activeKey === LIBRARY_TAB_KEY ? 'active' : ''}`}
        onClick={onHome}
        role="tab"
        tabIndex={activeKey === LIBRARY_TAB_KEY ? 0 : -1}
        type="button"
      >
        <Icon name={feedActive ? 'book' : 'library'} />
        <span>{feedActive ? '期刊雷达' : '文献库'}</span>
      </button>
      {tabs.map((tab) => (
        <div
          aria-selected={activeKey === tab.key}
          className={`workspace-tab paper-tab ${activeKey === tab.key ? 'active' : ''}`}
          key={tab.key}
          onClick={() => onActivate(tab.key)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') onActivate(tab.key)
            if (event.key === 'Delete') onClose(tab.key)
          }}
          onMouseDown={(event) => {
            if (event.button === 1) {
              event.preventDefault()
              onClose(tab.key)
            }
          }}
          role="tab"
          tabIndex={activeKey === tab.key ? 0 : -1}
          title={tab.title}
        >
          <Icon name="book" />
          <span><FormattedTitle>{tab.title}</FormattedTitle></span>
          <button
            type="button"
            className="tab-close"
            onClick={(event) => { event.stopPropagation(); onClose(tab.key) }}
            aria-label={`关闭 ${tab.title}`}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </nav>
  )
}

export function ReaderWorkspace({
  project,
  paper,
  panelRef,
  inspectorWidth,
  inspector,
  onOpenExternal,
  onRefresh,
  onResizePointerDown,
  onResizeKeyDown
}: {
  project: ProjectSummary
  paper: PaperDetail | null
  panelRef: RefObject<HTMLElement | null>
  inspectorWidth: number
  inspector: ReactNode
  onOpenExternal(url: string): void
  onRefresh(paper: PaperDetail): void
  onResizePointerDown: PointerEventHandler<HTMLDivElement>
  onResizeKeyDown: KeyboardEventHandler<HTMLDivElement>
}) {
  return (
    <div
      className="reader-workspace"
      style={{ gridTemplateColumns: `minmax(${MIN_MAIN_WIDTH}px, 1fr) ${RESIZER_WIDTH}px ${inspectorWidth}px` }}
    >
      <section className="reader-panel" ref={panelRef}>
        {paper ? (
          <>
            <PaperTitleHeader
              paper={paper}
              sourceLabel="来源页面"
              onOpenExternal={onOpenExternal}
              action={<button type="button" onClick={() => onRefresh(paper)}>安全刷新</button>}
            />
            <ReaderErrorBoundary key={`${project.id}:${paper.id}:${paper.markdownRevision}`}>
              <MarkdownReader projectId={project.id} paperId={paper.id} title={paper.title} markdown={paper.markdown} />
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
        onPointerDown={onResizePointerDown}
        onKeyDown={onResizeKeyDown}
      />
      {inspector}
    </div>
  )
}

export function LibraryWorkspace({
  project,
  items,
  loading,
  query,
  year,
  years,
  total,
  offset,
  selectedPaperId,
  selectedPaperIds,
  selectionAnchorId,
  preferences,
  setPreferences,
  onQueryChange,
  onYearChange,
  onClearFilters,
  onAddPaper,
  onSortChange,
  onSelectionChange,
  onOpen,
  onOpenWindow,
  onOpenOnline,
  onReveal,
  onBatchRefresh,
  onExport,
  onPageChange,
  onPageSizeChange
}: {
  project: ProjectSummary
  items: PaperListItem[]
  loading: boolean
  query: string
  year: number | null
  years: number[]
  total: number
  offset: number
  selectedPaperId: string
  selectedPaperIds: string[]
  selectionAnchorId: string
  preferences: LibraryPreferences
  setPreferences: Dispatch<SetStateAction<LibraryPreferences>>
  onQueryChange(value: string): void
  onYearChange(value: number | null): void
  onClearFilters(): void
  onAddPaper(): void
  onSortChange(sortBy: PaperSortField): void
  onSelectionChange(paperIds: string[], focusedPaperId: string, anchorPaperId: string): void
  onOpen(paper: PaperListItem): void
  onOpenWindow(paper: PaperListItem): void
  onOpenOnline(paper: PaperListItem): void
  onReveal(paper: PaperListItem): void
  onBatchRefresh(papers: PaperListItem[], skippedCount: number): void
  onExport(paperIds: string[], includeImages: boolean): void
  onPageChange(offset: number): void
  onPageSizeChange(pageSize: number): void
}) {
  const pageSize = preferences.pageSize
  return (
    <section className="library-main">
      <header className="library-toolbar">
        <div className="library-identity">
          <span className="eyebrow">LIBRARY</span>
          <h1>{project.name}</h1>
          <span>{total} 篇文献</span>
        </div>
        <div className="library-actions">
          <label className="search-box">
            <Icon name="search" />
            <input
              aria-label="全文搜索"
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="搜索标题、作者、正文…"
            />
          </label>
          <select
            aria-label="年份筛选"
            value={year ?? ''}
            onChange={(event) => onYearChange(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">全部年份</option>
            {years.map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
          {(query || year) && (
            <button type="button" className="text-button clear-filter" onClick={onClearFilters}>清空</button>
          )}
          <button type="button" className="primary-button add-paper-button" onClick={onAddPaper}>
            <Icon name="add" />添加文献
          </button>
        </div>
      </header>
      <LibraryTable
        items={items}
        loading={loading}
        query={query}
        selectedPaperId={selectedPaperId}
        selectedPaperIds={selectedPaperIds}
        selectionAnchorId={selectionAnchorId}
        preferences={preferences}
        setPreferences={setPreferences}
        onSortChange={onSortChange}
        onSelectionChange={onSelectionChange}
        onOpen={onOpen}
        onOpenWindow={onOpenWindow}
        onOpenOnline={onOpenOnline}
        onReveal={onReveal}
        onBatchRefresh={onBatchRefresh}
        onExport={onExport}
      />
      <footer className="library-footer">
        <span>{total === 0 ? '无文献' : `${offset + 1}–${Math.min(offset + pageSize, total)} / ${total}`}</span>
        <div>
          <label>每页条数 <select aria-label="每页条数" value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>
            {[20, 50, 100, 200].map((value) => <option value={value} key={value}>{value}</option>)}
          </select></label>
          <button type="button" disabled={offset === 0} onClick={() => onPageChange(Math.max(0, offset - pageSize))}>上一页</button>
          <span>{total === 0 ? 0 : Math.floor(offset / pageSize) + 1} / {Math.max(1, Math.ceil(total / pageSize))}</span>
          <button type="button" disabled={offset + pageSize >= total} onClick={() => onPageChange(offset + pageSize)}>下一页</button>
        </div>
      </footer>
    </section>
  )
}
