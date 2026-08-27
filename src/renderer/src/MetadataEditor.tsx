import { useEffect, useState } from 'react'
import type {
  MetadataField,
  MetadataOverrides,
  PaperDetail
} from '../../shared/contracts'
import { bridge, errorMessage } from './bridge'

interface MetadataEditorProps {
  projectId: string
  paper: PaperDetail
  onChange(paper: PaperDetail): void
  onLocatePaper(paperId: string): void
}

interface MetadataForm {
  title: string
  authors: string
  journal: string
  year: string
  doi: string
  url: string
  abstract: string
  keywords: string
}

function formFor(paper: PaperDetail): MetadataForm {
  return {
    title: paper.title,
    authors: paper.authors.join('\n'),
    journal: paper.journal,
    year: paper.year?.toString() ?? '',
    doi: paper.doi,
    url: paper.url,
    abstract: paper.abstract,
    keywords: paper.keywords.join('\n')
  }
}

function lines(value: string): string[] {
  return value.split(/\r?\n|;/).map((item) => item.trim()).filter(Boolean)
}

export function MetadataEditor({ projectId, paper, onChange, onLocatePaper }: MetadataEditorProps) {
  const [form, setForm] = useState(() => formFor(paper))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => setForm(formFor(paper)), [paper])

  const update = (field: keyof MetadataForm, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }))
    setMessage('')
  }

  const save = async (): Promise<void> => {
    const patch: MetadataOverrides = {}
    if (form.title !== paper.title) patch.title = form.title
    const nextAuthors = lines(form.authors)
    if (JSON.stringify(nextAuthors) !== JSON.stringify(paper.authors)) patch.authors = nextAuthors
    if (form.journal !== paper.journal) patch.journal = form.journal
    if (form.year !== (paper.year?.toString() ?? '')) {
      patch.year = form.year.trim() === '' ? '' : Number(form.year)
    }
    if (form.doi !== paper.doi) patch.doi = form.doi
    if (form.url !== paper.url) patch.url = form.url
    if (form.abstract !== paper.abstract) patch.abstract = form.abstract
    const nextKeywords = lines(form.keywords)
    if (JSON.stringify(nextKeywords) !== JSON.stringify(paper.keywords)) patch.keywords = nextKeywords
    if (Object.keys(patch).length === 0) {
      setMessage('没有需要保存的修改。')
      return
    }
    setSaving(true)
    try {
      const next = await bridge().papers.updateMetadata({ projectId, paperId: paper.id, patch })
      onChange(next)
      setMessage('元数据已保存并更新搜索索引。')
    } catch (error) {
      const message = errorMessage(error)
      setMessage(message)
      if (/DOI|已存在/.test(message) && form.doi.trim()) {
        const result = await bridge().papers.search({ projectId, query: form.doi, limit: 20 })
        const existing = result.items.find((item) => item.doi === form.doi.trim().toLowerCase() && item.id !== paper.id)
        if (existing) onLocatePaper(existing.id)
      }
    } finally {
      setSaving(false)
    }
  }

  const restore = async (field: MetadataField): Promise<void> => {
    setSaving(true)
    try {
      const next = await bridge().papers.updateMetadata({
        projectId,
        paperId: paper.id,
        patch: {},
        restore: [field]
      })
      onChange(next)
      setMessage('已恢复 paper-fetch 抓取值。')
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setSaving(false)
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
          <button type="button" className="text-button" onClick={() => void restore(key)} disabled={saving}>
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
      {field('title', '标题')}
      {field('authors', '作者', 'textarea', '每行一位作者')}
      {field('journal', '期刊 / 会议')}
      {field('year', '年份')}
      {field('doi', 'DOI')}
      {field('url', 'URL')}
      {field('abstract', '摘要', 'textarea')}
      {field('keywords', '关键词', 'textarea', '每行一个关键词')}
      <button type="button" className="primary-button full" onClick={() => void save()} disabled={saving}>
        {saving ? '保存中…' : '保存元数据'}
      </button>
      {message && <p className="form-message" role="status">{message}</p>}
    </div>
  )
}
