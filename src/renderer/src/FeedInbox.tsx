import { useModalDialog } from './workspace-hooks'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  FeedItem,
  FeedSubscription,
  JournalCandidate,
  ProjectSummary,
  ServiceEvent
} from '../../shared/contracts'
import { bridge, errorMessage } from './bridge'
import { FormattedTitle } from './FormattedTitle'

const PAGE_SIZE_KEY = 'litroot.feed-page-size'
type FeedDays = 1 | 3 | 7 | 14 | 30

function authors(value: string[]): string {
  if (value.length === 0) return '未知作者'
  return value.length > 3 ? `${value.slice(0, 3).join(' · ')} 等` : value.join(' · ')
}

function date(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : '日期未知'
}

export function FeedInbox({
  scope,
  feeds,
  projects,
  event,
  onFetchCreated,
  onMessage
}: {
  scope: 'recent' | string
  feeds: FeedSubscription[]
  projects: ProjectSummary[]
  event: ServiceEvent | null
  onFetchCreated(projectId: string, runId: string): void
  onMessage(message: string): void
}) {
  const [items, setItems] = useState<FeedItem[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState(() => {
    try {
      const value: unknown = JSON.parse(window.localStorage.getItem(PAGE_SIZE_KEY) ?? 'null')
      return typeof value === 'number' && [20, 50, 100, 200].includes(value) ? value : 50
    } catch {
      return 50
    }
  })
  const [selected, setSelected] = useState<string[]>([])
  const [focusedId, setFocusedId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [days, setDays] = useState<FeedDays>(7)
  const [revision, setRevision] = useState('')
  const [detailOpen, setDetailOpen] = useState(false)
  const fetchRequest = useRef(0)
  useEffect(() => { if (event?.type === 'feeds.changed') setRevision(event.at) }, [event])
  useEffect(() => () => { fetchRequest.current += 1 }, [scope])
  const focused = items.find((item) => item.id === focusedId) ?? null
  const source = scope === 'recent' ? null : feeds.find((feed) => feed.id === scope) ?? null
  const eligibleProjects = useMemo(
    () => projects.filter((project) => (
      project.status === 'ready' || project.status === 'empty' || project.status === 'scanning'
    )),
    [projects]
  )

  useEffect(() => {
    try {
      window.localStorage.setItem(PAGE_SIZE_KEY, String(pageSize))
    } catch {
      // Pagination remains usable when browser preferences are unavailable.
    }
  }, [pageSize])

  useLayoutEffect(() => {
    setItems([])
    setTotal(0)
    setDetailOpen(false)
    setSubmitting(false)
    setOffset(0)
    setSelected([])
    setFocusedId('')
  }, [scope])

  useEffect(() => {
    if (!eligibleProjects.some((project) => project.id === projectId)) setProjectId(eligibleProjects[0]?.id ?? '')
  }, [eligibleProjects, projectId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void bridge().feeds.items({
      subscriptionId: scope === 'recent' ? null : scope,
      days,
      limit: pageSize,
      offset
    }).then((result) => {
      if (cancelled) return
      if (offset > 0 && offset >= result.total) {
        setOffset(Math.max(0, Math.ceil(result.total / pageSize) - 1) * pageSize)
        return
      }
      setItems(result.items)
      setTotal(result.total)
      setFocusedId((current) => result.items.some((item) => item.id === current) ? current : result.items[0]?.id ?? '')
      setSelected((current) => current.filter((id) => result.items.some((item) => item.id === id)))
    }).catch((error) => { if (!cancelled) onMessage(errorMessage(error)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days, scope, offset, pageSize, revision, onMessage])

  const focus = (item: FeedItem, toggle = false): void => {
    setFocusedId(item.id)
    setDetailOpen(true)
    if (toggle) {
      setSelected((current) => current.includes(item.id)
        ? current.filter((id) => id !== item.id)
        : current.length < 50 ? [...current, item.id] : current)
    } else if (!selected.includes(item.id)) {
      setSelected([item.id])
    }
    if (!item.readAt) {
      void bridge().feeds.markRead({ itemIds: [item.id], read: true }).catch((error) => onMessage(errorMessage(error)))
    }
  }

  const createFetch = async (): Promise<void> => {
    if (!projectId || selected.length === 0 || submitting) return
    const request = ++fetchRequest.current
    const chosen = selected.map((id) => items.find((item) => item.id === id)).filter((item): item is FeedItem => Boolean(item))
    setSubmitting(true)
    try {
      const run = await bridge().fetch.create({
        projectId,
        inputs: chosen.map((item) => item.doi || item.url || item.title),
        concurrency: 4
      })
      if (request !== fetchRequest.current) return
      onFetchCreated(projectId, run.id)
      void bridge().feeds.markRead({ itemIds: chosen.map((item) => item.id), read: true })
        .catch(() => onMessage('任务已创建，但标记已读失败；请在雷达中重试标记。'))
    } catch (error) {
      if (request === fetchRequest.current) onMessage(errorMessage(error))
    } finally {
      if (request === fetchRequest.current) setSubmitting(false)
    }
  }

  return (
    <div className={`feed-workspace ${detailOpen ? 'detail-open' : ''}`}>
      <section className="feed-main">
        <header className="library-toolbar">
          <div className="library-identity">

            <h1>{source?.title ?? '最近文献'}</h1>
            <span>{total} 条</span>
          </div>
          <div className="feed-fetch-controls">
            <select
              aria-label="登记时间范围"
              value={days}
              onChange={(event) => { setDays(Number(event.target.value) as FeedDays); setOffset(0) }}
            >
              {[1, 3, 7, 14, 30].map((value) => <option value={value} key={value}>近 {value} 天</option>)}
            </select>
            {selected.length > 0 && <span>已选 {selected.length}/50</span>}
            <select aria-label="目标项目" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {eligibleProjects.length === 0 && <option value="">无可用项目</option>}
              {eligibleProjects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
            </select>
            <button className="primary-button" type="button" disabled={!projectId || selected.length === 0 || submitting} onClick={() => void createFetch()}>
              {submitting ? '正在创建…' : '添加到项目'}
            </button>
          </div>
        </header>
        <div className="feed-list" role="grid" aria-label="雷达文献" aria-multiselectable="true" aria-busy={loading}>
          {items.map((item) => (
            <div
              className={`feed-row ${focusedId === item.id ? 'focused' : ''} ${item.readAt ? '' : 'unread'}`}
              key={item.id}
              onClick={(event) => focus(item, event.ctrlKey || event.metaKey)}
              onDoubleClick={() => { if (item.url) void bridge().system.openExternal(item.url).catch((error) => onMessage(errorMessage(error))) }}
              role="row"
              aria-selected={selected.includes(item.id)}
              tabIndex={focusedId === item.id ? 0 : -1}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focus(item, event.key === ' ') }
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const rows = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('.feed-row') ?? [])
                const index = rows.indexOf(event.currentTarget)
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
                rows[next]?.focus()
                if (items[next]) setFocusedId(items[next].id)
              }}
            >
              <span role="gridcell"><input
                aria-label={`选择 ${item.title}`}
                checked={selected.includes(item.id)}
                onChange={() => focus(item, true)}
                onClick={(event) => event.stopPropagation()}
                type="checkbox"
              /></span>
              <span className="feed-unread-dot" aria-hidden="true" />
              <div role="gridcell">
                <strong><FormattedTitle>{item.title}</FormattedTitle></strong>
                <small>{authors(item.authors)}</small>
              </div>
              <span role="gridcell">{item.sourceTitle}</span>
              <time role="gridcell">{date(item.publishedAt ?? item.discoveredAt)}</time>
            </div>
          ))}
          {!loading && items.length === 0 && <div className="empty-state"><h2>这段时间没有文献</h2><p>Crossref 登记的新文献会在刷新期刊后出现。</p></div>}
        </div>
        <footer className="library-footer">
          <span>{total === 0 ? '无条目' : `${offset + 1}–${Math.min(offset + pageSize, total)} / ${total}`}</span>
          <div>
            <label>每页条数 <select aria-label="每页条数" value={pageSize} onChange={(event) => {
              setPageSize(Number(event.target.value))
              setOffset(0)
              setSelected([])
            }}>
              {[20, 50, 100, 200].map((value) => <option value={value} key={value}>{value}</option>)}
            </select></label>
            <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>上一页</button>
            <button type="button" disabled={offset + pageSize >= total} onClick={() => setOffset(offset + pageSize)}>下一页</button>
          </div>
        </footer>
      </section>
      <aside className="feed-detail">
        <button type="button" className="feed-back" onClick={() => { setDetailOpen(false); requestAnimationFrame(() => document.querySelector<HTMLElement>('.feed-row[tabindex="0"]')?.focus()) }}>返回列表</button>
        {focused ? (
          <>
            <span className="eyebrow">{focused.sourceTitle}</span>
            <h2><FormattedTitle>{focused.title}</FormattedTitle></h2>
            <p className="reader-authors">{authors(focused.authors)}</p>
            <div className="feed-detail-meta">
              <span>{date(focused.publishedAt)}</span>
              {focused.doi && <button className="text-button" type="button" onClick={() => void bridge().system.openExternal(`https://doi.org/${focused.doi}`).catch((error) => onMessage(errorMessage(error)))}>DOI {focused.doi}</button>}
              {focused.url && <button className="text-button" type="button" onClick={() => void bridge().system.openExternal(focused.url).catch((error) => onMessage(errorMessage(error)))}>打开原文</button>}
              <button className="text-button" type="button" onClick={() => void bridge().feeds.markRead({ itemIds: [focused.id], read: !focused.readAt }).catch((error) => onMessage(errorMessage(error)))}>
                {focused.readAt ? '恢复未读' : '标为已读'}
              </button>
            </div>
            <p className="feed-summary">{focused.summary || 'Crossref 没有提供该文献的摘要。'}</p>
          </>
        ) : <div className="empty-state compact"><p>选择一条查看详情。</p></div>}
      </aside>
    </div>
  )
}

export function AddFeedDialog({ open, onClose, onAdded }: {
  open: boolean
  onClose(): void
  onAdded(feed: FeedSubscription): void
}) {
  const dialogRef = useModalDialog(open, onClose)
  const [input, setInput] = useState('')
  const [message, setMessage] = useState('')
  const [candidates, setCandidates] = useState<JournalCandidate[]>([])
  const [addingIssn, setAddingIssn] = useState('')
  const [searching, setSearching] = useState(false)
  const request = useRef(0)

  useEffect(() => {
    if (!open) {
      request.current += 1
      setSearching(false)
      setAddingIssn('')
    }
    return () => { request.current += 1 }
  }, [open])

  if (!open) return null

  const trimmed = input.trim()
  const changeInput = (value: string): void => {
    request.current += 1
    setSearching(false)
    setAddingIssn('')
    setInput(value)
    setCandidates([])
    setMessage('')
  }
  const search = async (): Promise<void> => {
    if (!trimmed) return
    const current = ++request.current
    setSearching(true)
    setMessage('')
    try {
      const result = await bridge().feeds.searchJournals({ query: trimmed })
      if (current !== request.current) return
      setCandidates(result.candidates)
      if (result.candidates.length === 0) setMessage('没有找到可添加的匹配期刊。')
    } catch (error) {
      if (current === request.current) setMessage(errorMessage(error))
    } finally {
      if (current === request.current) setSearching(false)
    }
  }
  const add = async (candidate: JournalCandidate): Promise<void> => {
    const current = ++request.current
    setAddingIssn(candidate.issn)
    setMessage('')
    try {
      const feed = await bridge().feeds.add({ issn: candidate.issn, title: candidate.displayName })
      if (current !== request.current) return
      setInput('')
      setCandidates([])
      onAdded(feed)
      onClose()
    } catch (error) {
      if (current === request.current) setMessage(errorMessage(error))
    } finally {
      if (current === request.current) setAddingIssn('')
    }
  }
  const working = searching || Boolean(addingIssn)
  return (
    <dialog ref={dialogRef} className="modal feed-add-modal" aria-labelledby="feed-add-title">
        <header className="modal-header"><div><h2 id="feed-add-title">添加期刊</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button></header>
        <div className="modal-body">
          <label className="field"><span className="field-label">期刊名称或 ISSN</span><input value={input} onChange={(event) => changeInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !working) void search() }} placeholder="例如 Remote Sensing of Environment 或 0034-4257" /></label>

          {candidates.length > 0 && (
            <div className="journal-results" aria-label="期刊搜索结果">
              {candidates.map((candidate) => (
                <button type="button" className="journal-result" key={`${candidate.issn}-${candidate.displayName}`} disabled={working} onClick={() => void add(candidate)}>
                  <strong>{candidate.displayName}</strong>
                  <span>{candidate.publisher || '出版社未知'}</span>
                  <small>ISSN {candidate.issns.join(' · ')}</small>
                  {addingIssn === candidate.issn && <em>正在验证期刊并回填文献…</em>}
                </button>
              ))}
            </div>
          )}
          {message && <div className="form-message status-error" role="alert"><p>操作未完成，请检查后重试。</p><details><summary>错误详情</summary>{message}</details></div>}
        </div>
        <footer className="modal-footer"><button type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" disabled={working || !trimmed} onClick={() => void search()}>{searching ? '正在搜索…' : '搜索期刊'}</button></footer>
    </dialog>
  )
}
