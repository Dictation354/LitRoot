import { useEffect, useRef, useState } from 'react'
import type { NoteDocument, NoteKind, ServiceEvent } from '../../shared/contracts'
import { bridge, errorMessage } from './bridge'

interface NoteEditorProps {
  projectId: string
  kind: NoteKind
  paperId?: string
  event: ServiceEvent | null
}

export function NoteEditor({ projectId, kind, paperId, event }: NoteEditorProps) {
  const [document, setDocument] = useState<NoteDocument | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('正在载入…')
  const [conflict, setConflict] = useState(false)
  const saving = useRef(false)
  const draft = useRef(content)
  draft.current = content

  const load = async (): Promise<void> => {
    try {
      const next = await bridge().notes.read({ projectId, kind, ...(paperId ? { paperId } : {}) })
      setDocument(next)
      setContent(next.content)
      setDirty(false)
      setConflict(false)
      setStatus('已保存')
    } catch (error) {
      setStatus(errorMessage(error))
    }
  }

  useEffect(() => { void load() }, [projectId, kind, paperId])

  useEffect(() => {
    if (
      event?.type !== 'note.changed' ||
      event.projectId !== projectId ||
      event.kind !== kind ||
      event.paperId !== (kind === 'paper' ? (paperId ?? null) : null) ||
      event.revision === document?.revision ||
      saving.current
    ) return
    if (dirty) {
      setConflict(true)
      setStatus('磁盘文件已被外部修改，自动保存已暂停。')
    } else {
      void load()
    }
  }, [event, projectId, kind, paperId, dirty, document?.revision])

  useEffect(() => {
    if (!dirty || !document || conflict) return
    const timer = window.setTimeout(() => {
      saving.current = true
      setStatus('保存中…')
      const savingContent = draft.current
      void bridge().notes.write({
        projectId,
        kind,
        ...(paperId ? { paperId } : {}),
        content: savingContent,
        expectedRevision: document.revision
      }).then((next) => {
        setDocument(next)
        if (draft.current === savingContent) {
          setDirty(false)
          setStatus('已保存')
        } else {
          setDirty(true)
          setStatus('有未保存修改')
        }
      }).catch((error) => {
        const message = errorMessage(error)
        if (/外部修改|冲突/.test(message)) setConflict(true)
        setStatus(message)
      }).finally(() => {
        saving.current = false
      })
    }, 800)
    return () => window.clearTimeout(timer)
  }, [content, dirty, document, conflict, projectId, kind, paperId])

  return (
    <div className="note-editor">
      <div className="note-status">
        <span className={conflict ? 'status-error' : ''}>{status}</span>
        <span>Markdown · 自动保存</span>
      </div>
      {conflict && (
        <div className="conflict-banner" role="alert">
          <strong>检测到外部编辑</strong>
          <p>LitRoot 没有覆盖磁盘文件。请重新载入，或先复制当前草稿。</p>
          <div className="button-row">
            <button type="button" onClick={() => void bridge().system.copyText(content)}>复制当前草稿</button>
            <button type="button" className="danger-button" onClick={() => void load()}>重新载入磁盘版本</button>
          </div>
        </div>
      )}
      <textarea
        className="note-textarea"
        value={content}
        onChange={(event) => {
          setContent(event.target.value)
          setDirty(true)
          if (!conflict) setStatus('有未保存修改')
        }}
        spellCheck
        aria-label={kind === 'project' ? '项目总笔记' : '论文笔记'}
      />
      {document && <small className="note-path">{document.path}</small>}
    </div>
  )
}
