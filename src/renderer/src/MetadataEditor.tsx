import { useEffect } from 'react'
import type {
  MetadataField,
  MetadataOverrides,
  PaperDetail
} from '../../shared/contracts'
import { bridge, BridgeError, errorMessage } from './bridge'
import { metadataForm, useEditorSession, type MetadataForm } from './workspace-hooks'

interface MetadataEditorProps {
  projectId: string
  paper: PaperDetail
  onChange(paper: PaperDetail): void
  onLocatePaper(paperId: string): void
}

function lines(value: string): string[] {
  return value.split(/\r?\n|;/).map((item) => item.trim()).filter(Boolean)
}

export function MetadataEditor({ projectId, paper, onChange, onLocatePaper }: MetadataEditorProps) {
  const session = useEditorSession()
  const key = `${projectId}:${paper.id}:metadata`
  let entry = session.metadata.get(key)
  if (!entry) {
    entry = { key, projectId, paperId: paper.id, title: paper.title,
      form: metadataForm(paper), base: metadataForm(paper), modified: new Set(),
      saving: false, message: '', error: '', existingPaperId: '', attached: 0 }
    session.metadata.set(key, entry)
  }
  const draft = entry
  const { form, saving, message } = draft

  useEffect(() => {
    session.metadata.set(draft.key, draft)
    draft.attached += 1
    return () => { draft.attached -= 1; session.releaseMetadata(draft) }
  }, [session, draft])
  useEffect(() => {
    const incoming = metadataForm(paper)
    for (const field of Object.keys(incoming) as MetadataField[]) {
      if (!draft.modified.has(field)) draft.form[field] = incoming[field]
    }
    draft.base = incoming
    session.notify()
  }, [paper, draft, session])

  const update = (field: MetadataField, value: string): void => {
    draft.form[field] = value
    if (!draft.saving && value === draft.base[field]) draft.modified.delete(field)
    else draft.modified.add(field)
    draft.message = ''
    draft.error = ''
    draft.existingPaperId = ''
    session.notify()
  }

  const submit = async (restore?: MetadataField): Promise<void> => {
    if (draft.saving) return
    const fields = restore ? [restore] : [...draft.modified]
    if (!fields.length) return
    const sent = { ...draft.form }
    const patch: MetadataOverrides = {}
    if (!restore) {
      for (const field of fields) {
        if (field === 'year') {
          const value = sent.year.trim()
          if (value && (!/^\d{4}$/.test(value) || Number(value) < 1000)) {
            draft.error = '年份需为 1000–9999 的整数，或留空。'
            session.notify()
            return
          }
          patch.year = value ? Number(value) : ''
        } else if (field === 'authors' || field === 'keywords') patch[field] = lines(sent[field])
        else patch[field] = sent[field]
      }
    }
    draft.saving = true
    draft.error = ''
    draft.message = ''
    session.notify()
    try {
      const next = await bridge().papers.updateMetadata({
        projectId, paperId: paper.id, patch, ...(restore ? { restore: [restore] } : {})
      })
      const incoming = metadataForm(next)
      for (const field of fields) {
        if (draft.form[field] === sent[field]) {
          draft.modified.delete(field)
          draft.form[field] = incoming[field]
        }
      }
      for (const field of Object.keys(incoming) as MetadataField[]) {
        if (!draft.modified.has(field)) draft.form[field] = incoming[field]
      }
      draft.base = incoming
      draft.message = restore ? '已恢复抓取值' : '已保存'
      onChange(next)
    } catch (error) {
      draft.error = errorMessage(error)
      if (error instanceof BridgeError && error.code === 'doi_conflict') {
        const existing = error.details && typeof error.details === 'object'
          ? Reflect.get(error.details, 'existingPaperId') : null
        if (typeof existing === 'string') draft.existingPaperId = existing
      }
    } finally {
      draft.saving = false
      session.releaseMetadata(draft)
      session.notify()
    }
  }

  const field = (
    key: keyof MetadataForm,
    label: string,
    control: 'input' | 'textarea' = 'input',
    hint?: string
  ) => (
    <label className="field" key={key}>
      <span className="field-label">
        {label}
        {Object.hasOwn(paper.overrides, key) && (
          <button type="button" className="text-button" onClick={() => void submit(key)} disabled={saving}>
            恢复抓取值
          </button>
        )}
      </span>
      {control === 'textarea' ? (
        <textarea value={form[key]} onChange={(event) => update(key, event.target.value)} rows={key === 'abstract' ? 8 : 3} />
      ) : (
        <input value={form[key]} onChange={(event) => update(key, event.target.value)} inputMode={key === 'year' ? 'numeric' : undefined} />
      )}
      {hint && <small>{hint}</small>}
    </label>
  )

  return (
    <div className="metadata-editor">
      <details><summary>字段来源</summary><p>默认使用抓取值；手动修改的字段可单独恢复。</p></details>
      {field('title', '标题')}
      {field('authors', '作者', 'textarea', '每行一位作者')}
      {field('journal', '期刊 / 会议')}
      {field('year', '年份')}
      {field('doi', 'DOI')}
      {field('url', 'URL')}
      <details><summary>编辑完整摘要</summary>{field('abstract', '摘要', 'textarea')}</details>
      {field('keywords', '关键词', 'textarea', '每行一个关键词')}
      <button type="button" className="primary-button full" onClick={() => void submit()} disabled={saving || !draft.modified.size}>
        {saving ? '保存中…' : '保存元数据'}
      </button>
      {draft.modified.size > 0 && <button type="button" disabled={saving} onClick={() => {
        draft.form = { ...draft.base }; draft.modified.clear(); draft.error = ''; draft.message = ''
        session.notify()
      }}>放弃修改</button>}
      {draft.error && <div role="alert"><p>保存失败，请检查后重试。</p><details><summary>错误详情</summary>{draft.error}</details></div>}
      {draft.existingPaperId && <button type="button" onClick={() => onLocatePaper(draft.existingPaperId)}>查看已有文献</button>}
      {message && <p className="form-message" role="status">{message}</p>}
    </div>
  )
}
