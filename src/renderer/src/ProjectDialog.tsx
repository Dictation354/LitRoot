import { useEffect, useState } from 'react'
import type { DependencyReport, ProjectSummary } from '../../shared/contracts'
import { bridge, errorMessage } from './bridge'

interface ProjectDialogProps {
  open: boolean
  onClose(): void
  onAdded(project: ProjectSummary): void
}

export function ProjectDialog({ open, onClose, onAdded }: ProjectDialogProps) {
  const [distributions, setDistributions] = useState<string[]>([])
  const [distribution, setDistribution] = useState('')
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [report, setReport] = useState<DependencyReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!open) return
    setMessage('')
    void bridge().system.listDistributions().then((items) => {
      setDistributions(items)
      setDistribution((current) => current || items[0] || '')
    }).catch((error) => setMessage(errorMessage(error)))
  }, [open])

  useEffect(() => {
    if (!open || !distribution) return
    setReport(null)
    void bridge().system.diagnose(distribution).then(setReport).catch((error) => setMessage(errorMessage(error)))
  }, [open, distribution])

  if (!open) return null
  const nodeReady = report?.checks.find((check) => check.name === 'node')?.ok === true

  const add = async (): Promise<void> => {
    setLoading(true)
    setMessage('')
    try {
      const project = await bridge().projects.add(distribution, path, name.trim() || undefined)
      onAdded(project)
      onClose()
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal project-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">
        <header className="modal-header">
          <div>
            <span className="eyebrow">项目连接</span>
            <h2 id="connect-title">连接 WSL 项目</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">WSL 发行版</span>
            <select value={distribution} onChange={(event) => setDistribution(event.target.value)}>
              {distributions.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          {report && (
            <div className="diagnostic-grid">
              {report.checks.map((check) => (
                <div className={`diagnostic ${check.ok ? 'ok' : 'failed'}`} key={check.name}>
                  <div><strong>{check.name}</strong><span>{check.ok ? '可用' : '需修复'}</span></div>
                  <p>{check.version ?? check.reason ?? check.required}</p>
                  {!check.ok && (
                    <button type="button" className="command" onClick={() => void bridge().system.copyText(check.repairCommand)}>
                      {check.repairCommand}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <label className="field">
            <span className="field-label">WSL 绝对路径</span>
            <div className="input-with-button">
              <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/home/me/research/my-project" />
              <button type="button" onClick={async () => {
                const selected = await bridge().system.pickProjectPath(distribution)
                if (selected) setPath(selected)
              }}>浏览</button>
            </div>
          </label>
          <label className="field">
            <span className="field-label">项目名称（可选）</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="默认使用目录名" />
          </label>
          <p className="muted">
            首次连接只创建缺失的 papers、notes 和 .litroot 目录。断开项目不会删除任何文件。
          </p>
          {report && !report.ready && nodeReady && (
            <p className="warning-box">可先连接并浏览现有文献；添加文献前请按上方提示修复 paper-fetch / Git。</p>
          )}
          {message && <p className="form-message status-error">{message}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary-button"
            disabled={loading || !distribution || !path.trim() || (report !== null && !nodeReady)}
            onClick={() => void add()}
          >
            {loading ? '连接中…' : '连接项目'}
          </button>
        </footer>
      </section>
    </div>
  )
}
