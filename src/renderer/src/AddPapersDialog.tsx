import { useModalDialog } from './workspace-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FetchRun, ProjectSummary, ServiceEvent } from '../../shared/contracts'
import { parseBatchInput } from '../../shared/batch-input'
import { bridge, errorMessage } from './bridge'
import { FormattedTitle } from './FormattedTitle'

interface AddPapersDialogProps {
  open: boolean
  project: ProjectSummary
  event: ServiceEvent | null
  refresh?: {
    targets: Array<{ paperId: string; query: string }>
    batch: boolean
    skippedCount: number
  } | null
  focusRunId?: string | null
  onClose(): void
  onOpenPaper(paperId: string): void
}

const stateLabel: Record<FetchRun['items'][number]['state'], string> = {
  pending: '排队',
  cancelling: '取消中',
  running: '进行中',
  complete: '完整',
  degraded: '降级',
  limited: '受限',
  failed: '失败',
  action_required: '需要操作',
  cancelled: '已取消'
}

const stageLabel: Record<FetchRun['items'][number]['stage'], string> = {
  queued: '排队', identity: '身份解析', fetching: '正文获取', assets: '资产处理',
  validating: '抓取验收', writing: '输出写入', acceptance: '验收归档', terminal: '已结束'
}
const runLabel: Record<FetchRun['state'], string> = { queued: '排队中', running: '进行中', cancelling: '取消中', completed: '已结束', cancelled: '已取消', interrupted: '已中断' }

function StageElapsed({ startedAt }: { startedAt: string }) {
  const [tick, setTick] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span>{Math.max(0, Math.floor((tick - Date.parse(startedAt)) / 1000))} 秒</span>
}

const assetLabel = { figure: '正文图', formula: '公式', table: '表格图', supplementary: '补充材料' }

export function AddPapersDialog({
  open,
  project,
  event,
  refresh,
  focusRunId,
  onClose,
  onOpenPaper
}: AddPapersDialogProps) {
  const dialogRef = useModalDialog(open, onClose)
  const [input, setInput] = useState('')
  const [concurrency, setConcurrency] = useState(4)
  const [runs, setRuns] = useState<FetchRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const createRequest = useRef(0)
  const [page, setPage] = useState(0)
  const [pendingAction, setPendingAction] = useState('')
  const actionBusy = useRef(false)

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setMessage('')
    setRuns([])
    setSelectedRunId(focusRunId ?? null)
    if (refresh) setInput(refresh.targets.map((target) => target.query).join('\n'))
    void bridge().fetch.list(project.id).then((items) => {
      if (cancelled) return
      setRuns((current) => [...current, ...items.filter((item) => !current.some((run) => run.id === item.id))])
      setSelectedRunId((current) => current ?? items[0]?.id ?? null)
    }).catch((error) => { if (!cancelled) setMessage(errorMessage(error)) })
    return () => { cancelled = true }
  }, [open, project.id, refresh])

  useEffect(() => {
    setSubmitting(false)
    setPendingAction('')
    actionBusy.current = false
    return () => { createRequest.current += 1 }
  }, [open, project.id])

  useEffect(() => {
    if (open && focusRunId) setSelectedRunId(focusRunId)
  }, [focusRunId, open])

  useEffect(() => {
    if (!open || event?.type !== 'fetch.changed' || event.projectId !== project.id) return
    setRuns((current) => [event.run, ...current.filter((run) => run.id !== event.run.id)])
    setSelectedRunId((current) => current ?? event.run.id)
  }, [event, open, project.id])

  useEffect(() => setPage(0), [selectedRun?.id])
  const counts = useMemo(() => {
    const result = { ended: 0, complete: 0, degraded: 0, failed: 0, limited: 0, action_required: 0, cancelled: 0 }
    for (const item of selectedRun?.items ?? []) {
      if (item.stage === 'terminal') result.ended += 1
      if (Object.hasOwn(result, item.state)) result[item.state as keyof typeof result] += 1
    }
    return result
  }, [selectedRun])

  if (!open) return null

  const create = async (overrideInput?: string): Promise<void> => {
    if (submitting) return
    const request = ++createRequest.current
    setSubmitting(true)
    setMessage('')
    try {
      const parsed = parseBatchInput(overrideInput ?? input)
      const run = await bridge().fetch.create({
        projectId: project.id,
        inputs: parsed.inputs,
        concurrency,
        ...(refresh && !overrideInput
          ? refresh.batch
            ? { refreshPaperIds: refresh.targets.map((target) => target.paperId) }
            : { refreshPaperId: refresh.targets[0]?.paperId }
          : {})
      })
      if (request !== createRequest.current) return
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)])
      setSelectedRunId(run.id)
      if (!overrideInput && !refresh) setInput('')
    } catch (error) {
      if (request === createRequest.current) setMessage(errorMessage(error))
    } finally {
      if (request === createRequest.current) setSubmitting(false)
    }
  }

  const updateRun = (next: FetchRun): void => {
    setRuns((current) => [next, ...current.filter((run) => run.id !== next.id)])
  }

  const runAction = async (action: 'cancel' | 'resume' | 'item', run: FetchRun, index?: number): Promise<void> => {
    if (actionBusy.current) return
    actionBusy.current = true
    const request = createRequest.current
    setPendingAction(index === undefined ? action : `item:${index}`)
    setMessage('')
    try {
      const next = action === 'item' ? await bridge().fetch.cancelItem(project.id, run.id, index!)
        : action === 'cancel' ? await bridge().fetch.cancel(project.id, run.id)
          : await bridge().fetch.resume(project.id, run.id)
      if (request === createRequest.current) updateRun(next)
    } catch (error) {
      if (request === createRequest.current) setMessage(errorMessage(error))
    } finally {
      if (request === createRequest.current) { actionBusy.current = false; setPendingAction('') }
    }
  }

  return (
    <dialog ref={dialogRef} className="modal fetch-modal" aria-labelledby="fetch-title">
        <header className="modal-header">
          <div>
            <span className="eyebrow">{project.name}</span>
            <h2 id="fetch-title">{refresh?.batch ? '批量刷新文献' : refresh ? '安全刷新文献' : '添加文献'}</h2>
          </div>
          <button type="button" className="icon-button" onClick={() => {
            if (refresh) setInput('')
            onClose()
          }} aria-label="关闭">×</button>
        </header>
        <div className="fetch-layout">
          <div className="fetch-create">
            <label className="field">
              <span className="field-label">DOI、URL、arXiv ID、标题或引用条目</span>
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                rows={12}
                readOnly={Boolean(refresh)}
                placeholder={'每行一条\n10.1145/…\nhttps://arxiv.org/abs/…'}
              />
            </label>
            <div className="field inline-field">
              <span className="field-label">并发数</span>
              <select value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value}>{value}</option>)}
              </select>
            </div>

            {refresh?.batch && refresh.skippedCount > 0 && (
              <p className="form-message">已跳过 {refresh.skippedCount} 篇缺少 DOI 的文献。</p>
            )}
            <button type="button" className="primary-button full" disabled={submitting || Boolean(pendingAction) || !input.trim()} onClick={() => void create()}>
              {submitting ? '正在创建…' : refresh?.batch ? '开始批量刷新' : refresh ? '开始安全刷新' : '开始添加'}
            </button>
            {message && <div className="form-message status-error" role="alert"><p>操作未完成，请检查后重试。</p><details><summary>错误详情</summary>{message}</details></div>}
            {runs.length > 0 && (
              <label className="field run-select">
                <span className="field-label">任务记录</span>
                <select value={selectedRun?.id ?? ''} onChange={(event) => setSelectedRunId(event.target.value)}>
                  {runs.map((run) => <option value={run.id} key={run.id}>{new Date(run.createdAt).toLocaleString()} · {runLabel[run.state]}</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="fetch-progress">
            {selectedRun ? (
              <>
                <div className="run-header">
                  <div><span className={`run-state ${selectedRun.state}`}>{runLabel[selectedRun.state]}</span></div>
                  <div className="button-row">
                    {['queued', 'running', 'cancelling'].includes(selectedRun.state) && (
                      <button type="button" disabled={submitting || Boolean(pendingAction) || selectedRun.state === 'cancelling'} onClick={() => void runAction('cancel', selectedRun)}>取消整批</button>
                    )}
                    {['interrupted', 'cancelled', 'completed'].includes(selectedRun.state) && selectedRun.items.some((item) => ['failed', 'cancelled', 'action_required'].includes(item.state)) && (
                      <button type="button" disabled={submitting || Boolean(pendingAction)} onClick={() => void runAction('resume', selectedRun)}>继续未完成项</button>
                    )}
                  </div>
                </div>
                <p className="fetch-summary" aria-live="polite">
                  已结束 {counts.ended}/{selectedRun.items.length}
                  {(['complete', 'degraded', 'failed', 'limited', 'action_required', 'cancelled'] as const).map((state) => (
                    counts[state] > 0 && <span key={state}> · {state === 'complete' ? '成功' : stateLabel[state]} {counts[state]}</span>
                  ))}
                </p>
                {pendingAction && <p role="status">{pendingAction === 'resume' ? '正在继续未完成项…' : '正在取消…'}</p>}
                <details><summary>任务详情</summary><p>任务 ID：{selectedRun.id}</p><p>{selectedRun.manifestPath}</p></details>
                <ol className="fetch-items" start={page * 50 + 1}>
                  {selectedRun.items.slice(page * 50, (page + 1) * 50).map((item) => (
                    <li key={item.index} className={`fetch-item ${item.state}`}>
                      <div className="fetch-item-title">
                        <span className="index">{item.index}</span>
                        <strong>
                          {item.title ? <FormattedTitle>{item.title}</FormattedTitle> : item.query}
                        </strong>
                        <span className="item-state">{stateLabel[item.state]}</span>
                      </div>
                      <div className="fetch-meta"><span>{stageLabel[item.stage]}</span></div>
                      <details><summary>详情</summary>
                      <div className="fetch-meta">
                        {item.state === 'running' && item.stageStartedAt && (
                          <StageElapsed startedAt={item.stageStartedAt} />
                        )}
                        {item.assetProgress?.counts.map((count) => (
                          <span key={count.kind}>{assetLabel[count.kind]} 已处理 {count.completed}/{count.total ?? '未知'}{count.failed > 0 ? `，失败 ${count.failed}` : ''}</span>
                        ))}
                        {item.provider && <span>{item.provider}</span>}
                        {item.contentKind && <span>{item.contentKind}</span>}
                        <span>尝试 {item.attempt}</span>
                      </div>
                      {item.outputPath && <p className="fetch-artifact"><strong>产物：</strong>{item.outputPath}</p>}
                      {item.outputSha256 && <p className="fetch-artifact"><strong>SHA-256：</strong><code>{item.outputSha256}</code></p>}
                      {item.reason && <p>{item.reason}</p>}
                      </details>
                      <div className="button-row">
                        {['queued', 'running', 'cancelling'].includes(selectedRun.state) && !['terminal', 'acceptance'].includes(item.stage) && (
                          <button type="button" disabled={submitting || Boolean(pendingAction) || item.state === 'cancelling'} onClick={() => void runAction('item', selectedRun, item.index)}>
                            {item.state === 'cancelling' || pendingAction === `item:${item.index}` ? '取消中' : '取消此篇'}
                          </button>
                        )}
                        {item.existingPaperId && (
                          <button type="button" onClick={() => onOpenPaper(item.existingPaperId ?? '')}>打开现有条目</button>
                        )}
                        {item.reason?.includes('paper-fetch auth') && (
                          <button type="button" onClick={() => void bridge().system.copyText(item.reason ?? '').catch((error) => setMessage(errorMessage(error)))}>复制人工命令</button>
                        )}
                        {item.candidates.map((candidate) => (
                          <button
                            type="button"
                            key={`${candidate.doi}-${candidate.url}`}
                            disabled={submitting || Boolean(pendingAction)}
                            onClick={() => void create(candidate.doi ?? candidate.url ?? candidate.title)}
                          >
                            选择：<FormattedTitle>{candidate.title}</FormattedTitle>
                          </button>
                        ))}
                      </div>
                    </li>
                  ))}
                </ol>
                {selectedRun.items.length > 50 && <div className="button-row fetch-pagination">
                  <button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>上一页</button>
                  <span>{page + 1} / {Math.ceil(selectedRun.items.length / 50)}</span>
                  <button type="button" disabled={(page + 1) * 50 >= selectedRun.items.length} onClick={() => setPage((value) => value + 1)}>下一页</button>
                </div>}
              </>
            ) : (
              <div className="empty-state compact"><p>尚无抓取任务。</p></div>
            )}
          </div>
        </div>
    </dialog>
  )
}
