import { useEffect, useState } from 'react'
import type { DependencyReport, ProjectSummary, RuntimeOption } from '../../shared/contracts'
import { bridge, errorMessage } from './bridge'

interface ProjectDialogProps {
  open: boolean
  onClose(): void
  onAdded(project: ProjectSummary): void
}

export function ProjectDialog({ open, onClose, onAdded }: ProjectDialogProps) {
  const [runtimes, setRuntimes] = useState<RuntimeOption[]>([])
  const [runtimeKey, setRuntimeKey] = useState('')
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [report, setReport] = useState<DependencyReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!open) return
    setMessage('')
    void bridge().system.listRuntimes().then((items) => {
      setRuntimes(items)
      setRuntimeKey((current) => items.some((item) => item.key === current) ? current : items[0]?.key ?? '')
    }).catch((error) => setMessage(errorMessage(error)))
  }, [open])

  useEffect(() => {
    const runtime = runtimes.find((item) => item.key === runtimeKey)
    if (!open || !runtime) return
    setReport(null)
    void bridge().system.diagnose(runtime.target).then(setReport).catch((error) => setMessage(errorMessage(error)))
  }, [open, runtimeKey, runtimes])

  if (!open) return null
  const runtime = runtimes.find((item) => item.key === runtimeKey)
  const nodeReady = report?.checks.find((check) => check.name === 'node')?.ok === true

  const add = async (): Promise<void> => {
    setLoading(true)
    setMessage('')
    try {
      if (!runtime) return
      const project = await bridge().projects.add(runtime.target, path, name.trim() || undefined)
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
            <h2 id="connect-title">连接项目</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">运行环境</span>
            <select value={runtimeKey} onChange={(event) => {
              setRuntimeKey(event.target.value)
              setPath('')
            }}>
              {runtimes.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}
            </select>
          </label>
          {report && (
            <div className="diagnostic-grid">
              {report.checks.map((check) => (
                <div className={`diagnostic ${check.ok ? 'ok' : 'failed'}`} key={check.name}>
                  <div><strong>{check.name}</strong><span>{check.ok ? '可用' : '需修复'}</span></div>
                  <p>{check.version ?? check.reason ?? check.required}</p>
                  {!check.ok && check.repairCommand && (
                    <button type="button" className="command" onClick={() => void bridge().system.copyText(check.repairCommand)}>
                      {check.repairCommand}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <label className="field">
            <span className="field-label">项目绝对路径</span>
            <div className="input-with-button">
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder={runtime?.target.kind === 'wsl' ? '/home/me/research/my-project' : '选择本机项目目录'}
              />
              <button type="button" onClick={async () => {
                if (!runtime) return
                const selected = await bridge().system.pickProjectPath(runtime.target)
                if (selected) setPath(selected)
              }} disabled={!runtime}>浏览</button>
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
            <p className="warning-box">可先连接并浏览现有文献；添加文献前请按上方提示安装 paper-fetch。</p>
          )}
          {message && <p className="form-message status-error">{message}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary-button"
            disabled={loading || !runtime || !path.trim() || (report !== null && !nodeReady)}
            onClick={() => void add()}
          >
            {loading ? '连接中…' : '连接项目'}
          </button>
        </footer>
      </section>
    </div>
  )
}
