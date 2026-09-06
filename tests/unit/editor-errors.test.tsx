// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LitRootBridge, PaperDetail } from '../../src/shared/contracts.js'
import { MetadataEditor } from '../../src/renderer/src/MetadataEditor.js'
import { NoteEditor } from '../../src/renderer/src/NoteEditor.js'
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
