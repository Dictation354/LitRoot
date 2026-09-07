import { useEffect } from 'react'
import type { NoteKind, ServiceEvent } from '../../shared/contracts'
import { bridge, errorMessage } from './bridge'
import { useEditorSession, type NoteDraft } from './workspace-hooks'

interface NoteEditorProps {
  projectId: string
  kind: NoteKind
  paperId?: string | undefined
  title?: string | undefined
  event: ServiceEvent | null
}

export function NoteEditor({ projectId, kind, paperId, title, event }: NoteEditorProps) {
  const session = useEditorSession()
  const key = `${projectId}:${paperId ?? ''}:${kind}-note`
  let draft = session.notes.get(key)
  if (!draft) {
    draft = { key, projectId, paperId, kind, title: title ?? (kind === 'project' ? '项目笔记' : '论文笔记'), document: null, content: '', dirty: false,
      saving: false, loading: true, conflict: false, error: '', readRequest: 0, attached: 0 }
    session.notes.set(key, draft)
  }
  const note: NoteDraft = draft
  useEffect(() => {
    session.notes.set(note.key, note)
    note.attached += 1
    if (!note.document) void session.loadNote(note)
    return () => {
      note.attached -= 1
      void session.saveNote(note)
      session.releaseNote(note)
    }
  }, [session, note])
  useEffect(() => {
    if (title && note.title !== title) { note.title = title; session.notify() }
  }, [title, note, session])
  useEffect(() => { if (event) session.noteEvent(event) }, [session, event])

  const status = note.loading ? '正在载入…' : note.saving ? '保存中…' : note.error
    ? (note.conflict ? '保存冲突' : note.document ? '保存失败，请重试' : '载入失败，请重试') : note.dirty ? '有未保存修改' : '已保存'
  return (
    <div className={`note-editor ${note.error ? 'has-error' : ''}`}>
      <div className="note-status" role="status"><span>{status}</span>
        {note.dirty && !note.saving && <button type="button" className="text-button" disabled={note.loading} onClick={() => void session.loadNote(note, true)}>放弃修改</button>}
      </div>
      {note.error && (
        <div className="conflict-banner" role="alert">
          <p>{note.conflict ? '磁盘文件已改变，草稿已保留。' : '未能完成操作，草稿已保留。'}</p>
          <details><summary>错误详情</summary>{note.error}</details>
          <div className="button-row">
            <button type="button" onClick={() => {
              void bridge().system.copyText(note.content).catch((error) => { note.error = errorMessage(error); session.notify() })
            }}>复制当前草稿</button>
            {note.conflict ? (
              <button type="button" disabled={note.loading} onClick={() => void session.loadNote(note, true)}>重新载入磁盘版本</button>
            ) : (
              <button type="button" onClick={() => {
                note.error = ''
                if (note.document) void session.saveNote(note)
                else void session.loadNote(note)
              }}>重试</button>
            )}
          </div>
        </div>
      )}
      <textarea
        className="note-textarea" value={note.content} disabled={!note.document || note.loading}
        onChange={(event) => session.changeNote(note, event.target.value)} spellCheck
        aria-label={kind === 'project' ? '项目总笔记' : '论文笔记'}
      />
      {note.document && <details className="note-path"><summary>文件位置</summary>{note.document.path}</details>}
    </div>
  )
}
