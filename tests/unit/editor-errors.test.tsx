// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LitRootBridge, PaperDetail } from '../../src/shared/contracts.js'
import { MetadataEditor } from '../../src/renderer/src/MetadataEditor.js'
import { NoteEditor } from '../../src/renderer/src/NoteEditor.js'
import { EditorSessionContext, useEditorSession } from '../../src/renderer/src/workspace-hooks.js'
import { transportFor } from '../renderer-transport.js'

const projectId = 'project_aaaaaaaaaaaaaaaaaaaaaaaa'
const paperId = 'paper_bbbbbbbbbbbbbbbbbbbbbbbb'

const paper: PaperDetail = {
  id: paperId,
  relativePath: 'papers/paper.md',
  title: 'Paper',
  authors: ['Ada'],
  journal: 'Journal',
  year: 2026,
  doi: '10.4242/original',
  url: 'https://example.test/paper',
  abstract: 'Abstract',
  keywords: [],
  source: 'test',
  contentKind: 'fulltext',
  hasFulltext: true,
  addedAt: null,
  lastOpenedAt: null,
  modifiedAt: '2026-09-02T00:00:00.000Z',
  searchSnippet: null,
  hasOverrides: false,
  fetchedMetadata: {
    title: 'Paper', authors: ['Ada'], journal: 'Journal', year: 2026,
    doi: '10.4242/original', url: 'https://example.test/paper', abstract: 'Abstract', keywords: []
  },
  overrides: {},
  markdown: '# Paper',
  markdownRevision: 'revision',
  assetPaths: []
}

function codedError(code: string, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { code, details })
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
}

async function change(control: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = control instanceof HTMLInputElement
    ? HTMLInputElement.prototype
    : HTMLTextAreaElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  await act(async () => {
    setter?.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete window.litroot
})

describe('structured renderer errors', () => {
  it('locates a DOI conflict from details without searching or matching localized text', async () => {
    const search = vi.fn()
    const locate = vi.fn()
    window.litroot = transportFor({
      papers: {
        updateMetadata: vi.fn(async () => {
          throw codedError(
            'doi_conflict',
            'A deliberately non-Chinese message',
            { existingPaperId: 'paper_cccccccccccccccccccccccc' }
          )
        }),
        search
      }
    } as unknown as LitRootBridge)
    await act(async () => root.render(
      <MetadataEditor projectId={projectId} paper={paper} onChange={vi.fn()} onLocatePaper={locate} />
    ))
    const doi = [...container.querySelectorAll<HTMLLabelElement>('label')]
      .find((label) => label.textContent?.startsWith('DOI'))
      ?.querySelector<HTMLInputElement>('input')
    if (!doi) throw new Error('DOI input missing')
    await change(doi, '10.4242/conflict')
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '保存元数据')?.click())
    await settle()

    expect(locate).not.toHaveBeenCalled()
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '查看已有文献')?.click())
    expect(locate).toHaveBeenCalledWith('paper_cccccccccccccccccccccccc')
    expect(search).not.toHaveBeenCalled()
  })

  it('pauses note autosave based on note_conflict while preserving the visible message', async () => {
    const conflictMessage = '笔记已被外部修改，当前草稿没有覆盖磁盘文件。'
    window.litroot = transportFor({
      notes: {
        read: vi.fn(async () => ({
          projectId,
          kind: 'paper' as const,
          paperId,
          content: 'Original',
          revision: 'revision-one',
          modifiedAt: '2026-09-02T00:00:00.000Z',
          path: '/notes/paper.md'
        })),
        write: vi.fn(async () => { throw codedError('note_conflict', conflictMessage) })
      }
    } as unknown as LitRootBridge)
    await act(async () => root.render(
      <NoteEditor projectId={projectId} kind="paper" paperId={paperId} event={null} />
    ))
    await settle()
    const textarea = container.querySelector<HTMLTextAreaElement>('.note-textarea')!
    await change(textarea, 'Unsaved draft')
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 850)) })
    await settle()

    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.textContent).toContain(conflictMessage)
    expect(textarea.value).toBe('Unsaved draft')
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function Session({ children }: { children: React.ReactNode }) {
  const session = useEditorSession()
  return <EditorSessionContext.Provider value={session}>{children}</EditorSessionContext.Provider>
}

const noteDocument = { projectId, kind: 'paper' as const, paperId, content: 'Original',
  revision: 'one', modifiedAt: null, path: '/notes/paper.md' }

function inputFor(label: string): HTMLInputElement | HTMLTextAreaElement {
  const field = [...container.querySelectorAll('label')].find((field) => field.textContent?.startsWith(label))
  const input = field?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')
  if (!input) throw new Error(`Missing ${label}`)
  return input
}

function button(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((button) => button.textContent === label)
  if (!button) throw new Error(`Missing ${label}`)
  return button
}

describe('workspace session drafts', () => {
  it('flushes a note before 800ms when leaving and serializes input during a write with the new revision', async () => {
    vi.useFakeTimers()
    const first = deferred<typeof noteDocument>()
    const second = deferred<typeof noteDocument>()
    const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    window.litroot = transportFor({ notes: { read: async () => noteDocument, write } } as unknown as LitRootBridge)
    const editor = <NoteEditor projectId={projectId} paperId={paperId} kind="paper" event={null} />
    try {
      await act(async () => root.render(<Session>{editor}</Session>))
      await change(container.querySelector('textarea')!, 'First draft')
      await act(async () => vi.advanceTimersByTimeAsync(799))
      expect(write).not.toHaveBeenCalled()
      await act(async () => root.render(<Session>{null}</Session>))
      expect(write).toHaveBeenCalledTimes(1)
      await act(async () => root.render(<Session>{editor}</Session>))
      expect(container.querySelector('textarea')?.value).toBe('First draft')
      await change(container.querySelector('textarea')!, 'Latest draft')
      await act(async () => vi.advanceTimersByTimeAsync(1000))
      expect(write).toHaveBeenCalledTimes(1)
      await act(async () => first.resolve({ ...noteDocument, content: 'First draft', revision: 'two' }))
      expect(write).toHaveBeenCalledTimes(2)
      expect(write.mock.calls[1]?.[0]).toMatchObject({ content: 'Latest draft', expectedRevision: 'two' })
      await act(async () => second.resolve({ ...noteDocument, content: 'Latest draft', revision: 'three' }))
      expect(container.textContent).toContain('已保存')
    } finally { vi.useRealTimers() }
  })

  it('retains failed drafts after closing and reopening, retries explicitly, and pauses external conflicts', async () => {
    vi.useFakeTimers()
    const write = vi.fn().mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValue({ ...noteDocument, content: 'Draft', revision: 'two' })
    window.litroot = transportFor({ notes: { read: async () => noteDocument, write } } as unknown as LitRootBridge)
    const editor = (event: React.ComponentProps<typeof NoteEditor>['event'] = null) => <NoteEditor projectId={projectId} paperId={paperId} kind="paper" event={event} />
    try {
      await act(async () => root.render(<Session>{editor()}</Session>))
      await change(container.querySelector('textarea')!, 'Draft')
      await act(async () => root.render(<Session>{null}</Session>))
      await act(async () => vi.advanceTimersByTimeAsync(2000))
      expect(write).toHaveBeenCalledTimes(1)
      await act(async () => root.render(<Session>{editor()}</Session>))
      expect(container.querySelector('textarea')?.value).toBe('Draft')
      await act(async () => button('重试').click())
      expect(write).toHaveBeenCalledTimes(2)
      await change(container.querySelector('textarea')!, 'Conflict draft')
      await act(async () => root.render(<Session>{editor({ type: 'note.changed', projectId, paperId, kind: 'paper', revision: 'external', at: '2026-09-07T00:00:00Z' })}</Session>))
      await act(async () => vi.advanceTimersByTimeAsync(2000))
      expect(write).toHaveBeenCalledTimes(2)
      expect(container.querySelector('textarea')?.value).toBe('Conflict draft')
      expect(container.textContent).toContain('保存冲突')
    } finally { vi.useRealTimers() }
  })

  it('disables note input until loading completes and ignores a stale read from another paper', async () => {
    const old = deferred<typeof noteDocument>()
    window.litroot = transportFor({ notes: { read: ({ paperId: id }: { paperId: string }) => id === paperId ? old.promise : Promise.resolve({ ...noteDocument, content: 'Second', paperId: id }) } } as unknown as LitRootBridge)
    await act(async () => root.render(<Session><NoteEditor projectId={projectId} paperId={paperId} kind="paper" event={null} /></Session>))
    expect(container.querySelector('textarea')?.disabled).toBe(true)
    await act(async () => root.render(<Session><NoteEditor projectId={projectId} paperId="other" kind="paper" event={null} /></Session>))
    await act(async () => old.resolve(noteDocument))
    expect(container.querySelector('textarea')?.value).toBe('Second')
    expect(container.querySelector('textarea')?.disabled).toBe(false)
  })

  it('merges clean metadata fields on refresh, preserves drafts on reopen, and saves only modified fields', async () => {
    const request = deferred<PaperDetail>()
    const updateMetadata = vi.fn(() => request.promise)
    window.litroot = transportFor({ papers: { updateMetadata } } as unknown as LitRootBridge)
    const onChange = vi.fn()
    const editor = (next = paper) => <MetadataEditor projectId={projectId} paper={next} onChange={onChange} onLocatePaper={vi.fn()} />
    await act(async () => root.render(<Session>{editor()}</Session>))
    expect(button('保存元数据').disabled).toBe(true)
    await change(inputFor('标题'), 'Local title')
    const refreshed = { ...paper, title: 'Remote title', journal: 'Remote journal' }
    await act(async () => root.render(<Session>{editor(refreshed)}</Session>))
    expect(inputFor('标题').value).toBe('Local title')
    expect(inputFor('期刊').value).toBe('Remote journal')
    await act(async () => root.render(<Session>{null}</Session>))
    await act(async () => root.render(<Session>{editor(refreshed)}</Session>))
    expect(inputFor('标题').value).toBe('Local title')
    await act(async () => button('保存元数据').click())
    expect(updateMetadata).toHaveBeenCalledWith({ projectId, paperId, patch: { title: 'Local title' } })
    // Reverting to the old base while a different value is in flight is still an unsaved edit.
    await change(inputFor('标题'), 'Remote title')
    await act(async () => request.resolve({ ...refreshed, title: 'Local title' }))
    expect(inputFor('标题').value).toBe('Remote title')
    expect(button('保存元数据').disabled).toBe(false)
  })

  it('restores one metadata field without discarding others and validates the existing year contract', async () => {
    const updateMetadata = vi.fn(async () => paper)
    window.litroot = transportFor({ papers: { updateMetadata } } as unknown as LitRootBridge)
    await act(async () => root.render(<Session><MetadataEditor projectId={projectId} paper={{ ...paper, overrides: { title: 'Override' } }} onChange={vi.fn()} onLocatePaper={vi.fn()} /></Session>))
    await change(inputFor('期刊'), 'Local journal')
    await act(async () => button('恢复抓取值').click())
    expect(updateMetadata).toHaveBeenCalledWith({ projectId, paperId, patch: {}, restore: ['title'] })
    expect(inputFor('期刊').value).toBe('Local journal')
    await change(inputFor('年份'), '2026.5')
    await act(async () => button('保存元数据').click())
    expect(updateMetadata).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('1000–9999')
  })
})
