import { useEffect, useMemo, useState } from 'react'
import type { FetchRun, ProjectSummary, ServiceEvent } from '../../shared/contracts'
import { parseBatchInput } from '../../shared/batch-input'
import { bridge, errorMessage } from './bridge'

interface AddPapersDialogProps {
  open: boolean
  project: ProjectSummary
  event: ServiceEvent | null
  refresh?: { paperId: string; query: string } | null
  onClose(): void
  onOpenPaper(paperId: string): void
}

const stateLabel: Record<FetchRun['items'][number]['state'], string> = {
  pending: '等待',
  running: '进行中',
  complete: '完整',
  degraded: '降级',
  limited: '受限',
  failed: '失败',
  action_required: '需要操作',
  cancelled: '已取消'
}

export function AddPapersDialog({
  open,
  project,
  event,
  refresh,
  onClose,
  onOpenPaper
}: AddPapersDialogProps) {
  const [input, setInput] = useState('')
  const [concurrency, setConcurrency] = useState(4)
  const [runs, setRuns] = useState<FetchRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
  )

  useEffect(() => {
    if (!open) return
    setMessage('')
    if (refresh) setInput(refresh.query)
    void bridge().fetch.list(project.id).then((items) => {
      setRuns(items)
      setSelectedRunId((current) => current ?? items[0]?.id ?? null)
    }).catch((error) => setMessage(errorMessage(error)))
  }, [open, project.id, refresh])

  useEffect(() => {
    if (event?.type !== 'fetch.changed' || event.projectId !== project.id) return
    setRuns((current) => [event.run, ...current.filter((run) => run.id !== event.run.id)])
    setSelectedRunId((current) => current ?? event.run.id)
  }, [event, project.id])

  if (!open) return null

  const create = async (overrideInput?: string): Promise<void> => {
    setSubmitting(true)
    setMessage('')
    try {
      const parsed = parseBatchInput(overrideInput ?? input)
      const run = await bridge().fetch.create({
        projectId: project.id,
        inputs: parsed.inputs,
        concurrency,
        ...(refresh && !overrideInput ? { refreshPaperId: refresh.paperId } : {})
      })
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)])
      setSelectedRunId(run.id)
      if (!overrideInput && !refresh) setInput('')
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  const updateRun = (next: FetchRun): void => {
    setRuns((current) => [next, ...current.filter((run) => run.id !== next.id)])
    setSelectedRunId(next.id)
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal fetch-modal" role="dialog" aria-modal="true" aria-labelledby="fetch-title">
        <header className="modal-header">
          <div>
            <span className="eyebrow">{project.name}</span>
            <h2 id="fetch-title">{refresh ? '安全刷新文献' : '添加文献'}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button>
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
                placeholder={'每行一条，最多 50 条\n10.1145/…\nhttps://arxiv.org/abs/…'}
              />
            </label>
            <div className="field inline-field">
              <span className="field-label">并发数</span>
              <select value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value}>{value}</option>)}
              </select>
            </div>
            <p className="muted">
              固定归档完整正文、全部参考文献与正文图片。每项独立验收，单项失败不会中止其余任务。
            </p>
            <button type="button" className="primary-button full" disabled={submitting || !input.trim()} onClick={() => void create()}>
              {submitting ? '正在创建…' : refresh ? '开始安全刷新' : '开始添加'}
            </button>
            {message && <p className="form-message status-error">{message}</p>}
            {runs.length > 0 && (
              <label className="field run-select">
                <span className="field-label">任务记录</span>
                <select value={selectedRun?.id ?? ''} onChange={(event) => setSelectedRunId(event.target.value)}>
                  {runs.map((run) => <option value={run.id} key={run.id}>{new Date(run.createdAt).toLocaleString()} · {run.state}</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="fetch-progress">
            {selectedRun ? (
              <>
                <div className="run-header">
                  <div><span className={`run-state ${selectedRun.state}`}>{selectedRun.state}</span><small>{selectedRun.id}</small></div>
                  <div className="button-row">
                    {['queued', 'running', 'cancelling'].includes(selectedRun.state) && (
                      <button type="button" onClick={() => void bridge().fetch.cancel(project.id, selectedRun.id).then(updateRun)}>取消</button>
                    )}
                    {['interrupted', 'cancelled', 'completed'].includes(selectedRun.state) && selectedRun.items.some((item) => ['failed', 'cancelled', 'action_required'].includes(item.state)) && (
                      <button type="button" onClick={() => void bridge().fetch.resume(project.id, selectedRun.id).then(updateRun)}>从 manifest 恢复</button>
                    )}
                  </div>
                </div>
                <ol className="fetch-items">
                  {selectedRun.items.map((item) => (
                    <li key={item.index} className={`fetch-item ${item.state}`}>
                      <div className="fetch-item-title">
                        <span className="index">{item.index}</span>
                        <strong>{item.title ?? item.query}</strong>
                        <span className="item-state">{stateLabel[item.state]}</span>
                      </div>
                      <div className="fetch-meta">
                        <span>{item.stage}</span>
                        {item.provider && <span>{item.provider}</span>}
                        {item.contentKind && <span>{item.contentKind}</span>}
                        <span>尝试 {item.attempt}</span>
                      </div>
                      {item.outputPath && <p className="fetch-artifact"><strong>产物：</strong>{item.outputPath}</p>}
                      {item.outputSha256 && <p className="fetch-artifact"><strong>SHA-256：</strong><code>{item.outputSha256}</code></p>}
                      {item.reason && <p>{item.reason}</p>}
                      <div className="button-row">
                        {item.existingPaperId && (
                          <button type="button" onClick={() => onOpenPaper(item.existingPaperId ?? '')}>打开现有条目</button>
                        )}
                        {item.reason?.includes('paper-fetch auth') && (
                          <button type="button" onClick={() => void bridge().system.copyText(item.reason ?? '')}>复制人工命令</button>
                        )}
                        {item.candidates.map((candidate) => (
                          <button
                            type="button"
                            key={`${candidate.doi}-${candidate.url}`}
                            onClick={() => void create(candidate.doi ?? candidate.url ?? candidate.title)}
                          >
                            选择：{candidate.title}
                          </button>
                        ))}
                      </div>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <div className="empty-state compact"><p>尚无抓取任务。</p></div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
