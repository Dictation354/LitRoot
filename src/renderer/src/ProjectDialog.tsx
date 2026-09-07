import { useModalDialog } from './workspace-hooks'
import { useEffect, useRef, useState } from 'react'
import type { DependencyReport, ProjectSummary, RuntimeOption } from '../../shared/contracts'
import { bridge, errorMessage } from './bridge'

interface ProjectDialogProps {
  open: boolean
  onClose(): void
  onAdded(project: ProjectSummary): void
}

export function ProjectDialog({ open, onClose, onAdded }: ProjectDialogProps) {
  const dialogRef = useModalDialog(open, onClose)
  const [runtimes, setRuntimes] = useState<RuntimeOption[]>([])
  const [runtimeKey, setRuntimeKey] = useState('')
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [report, setReport] = useState<DependencyReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const pickRequest = useRef(0)

  useEffect(() => {
    if (!open) {
      setLoading(false)
      return
    }
    let cancelled = false
    setMessage('')
    void bridge().system.listRuntimes().then((items) => {
      if (cancelled) return
      setRuntimes(items)
      setRuntimeKey((current) => items.some((item) => item.key === current) ? current : items[0]?.key ?? '')
    }).catch((error) => { if (!cancelled) setMessage(errorMessage(error)) })
    return () => { cancelled = true; pickRequest.current += 1 }
  }, [open])

  useEffect(() => {
    const runtime = runtimes.find((item) => item.key === runtimeKey)
    if (!open || !runtime) return
    let cancelled = false
    setReport(null)
    void bridge().system.diagnose(runtime.target).then((next) => {
      if (!cancelled) setReport(next)
    }).catch((error) => { if (!cancelled) setMessage(errorMessage(error)) })
    return () => { cancelled = true }
  }, [open, runtimeKey, runtimes])

  if (!open) return null
  const runtime = runtimes.find((item) => item.key === runtimeKey)
  const nodeReady = report?.checks.find((check) => check.name === 'node')?.ok === true

  const add = async (): Promise<void> => {
    if (loading) return
    const request = ++pickRequest.current
    setLoading(true)
    setMessage('')
    try {
      if (!runtime) return
      const project = await bridge().projects.add(runtime.target, path, name.trim() || undefined)
      if (request !== pickRequest.current) return
      onAdded(project)
      onClose()
    } catch (error) {
      if (request === pickRequest.current) setMessage(errorMessage(error))
    } finally {
      if (request === pickRequest.current) setLoading(false)
    }
  }

  return (
    <dialog ref={dialogRef} className="modal project-modal" aria-labelledby="connect-title">
        <header className="modal-header">
          <div>

            <h2 id="connect-title">连接项目</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">运行环境</span>
            <select disabled={loading} value={runtimeKey} onChange={(event) => {
              pickRequest.current += 1
              setRuntimeKey(event.target.value)
              setPath('')
              setLoading(false)
            }}>
              {runtimes.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}
            </select>
          </label>
          {report && !report.ready && (
            <div className="diagnostic-grid">
              {report.checks.filter((check) => !check.ok).map((check) => (
                <div className={`diagnostic ${check.ok ? 'ok' : 'failed'}`} key={check.name}>
                  <div><strong>{check.name}</strong><span>{check.ok ? '可用' : '需修复'}</span></div>
                  <p>{check.name === 'node' ? '暂时无法连接项目。' : '可浏览，但暂时无法抓取文献。'}</p>
                  <details><summary>修复方法</summary><p>{check.version ?? check.reason ?? check.required}</p>
                  {!check.ok && check.repairCommand && (
                    <button type="button" className="command" onClick={() => void bridge().system.copyText(check.repairCommand).catch((error) => setMessage(errorMessage(error)))}>
                      {check.repairCommand}
                    </button>
                  )}
                  </details>
                </div>
              ))}
            </div>
          )}
          <label className="field">
            <span className="field-label">项目绝对路径</span>
            <div className="input-with-button">
              <input
                value={path}
                disabled={loading}
                onChange={(event) => setPath(event.target.value)}
                placeholder={runtime?.target.kind === 'wsl' ? '/home/me/research/my-project' : '选择本机项目目录'}
              />
              <button type="button" onClick={async () => {
                if (!runtime) return
                const request = ++pickRequest.current
                try {
                  const selected = await bridge().system.pickProjectPath(runtime.target)
                  if (request === pickRequest.current && selected) setPath(selected)
                } catch (error) { if (request === pickRequest.current) setMessage(errorMessage(error)) }
              }} disabled={!runtime || loading}>浏览</button>
            </div>
          </label>
          <label className="field">
            <span className="field-label">项目名称（可选）</span>
            <input disabled={loading} value={name} onChange={(event) => setName(event.target.value)} placeholder="默认使用目录名" />
          </label>

          {report && !report.ready && nodeReady && (
            <p className="warning-box">可先连接并浏览现有文献；添加文献前请按上方提示安装 paper-fetch。</p>
          )}
          {message && <div className="form-message status-error" role="alert"><p>操作未完成，请检查后重试。</p><details><summary>错误详情</summary>{message}</details></div>}
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
    </dialog>
  )
}
