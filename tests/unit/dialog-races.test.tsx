// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DependencyReport,
  FetchRun,
  JournalCandidate,
  LitRootBridge,
  PaperListItem,
  ProjectSummary
} from '../../src/shared/contracts.js'
import { AddPapersDialog } from '../../src/renderer/src/AddPapersDialog.js'
import { AddFeedDialog } from '../../src/renderer/src/FeedInbox.js'
import { LibraryTable } from '../../src/renderer/src/LibraryTable.js'
import { ProjectDialog } from '../../src/renderer/src/ProjectDialog.js'
import { defaultLibraryPreferences } from '../../src/renderer/src/library-preferences.js'
import { transportFor } from '../renderer-transport.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function project(id: string, name: string): ProjectSummary {
  return {
    id,
    name,
    path: `/projects/${name}`,
    runtime: { kind: 'local' },
    status: 'ready',
    error: null,
    paperCount: 0,
    issueCount: 0,
    years: [],
    lastScannedAt: null
  }
}

function run(id: string, projectId: string, createdAt: string): FetchRun {
  return {
    schemaVersion: 1,
    id,
    projectId,
    state: 'completed',
    concurrency: 1,
    refreshPaperId: null,
    refreshPaperIds: null,
    createdAt,
    startedAt: createdAt,
    finishedAt: createdAt,
    manifestPath: `/runs/${id}.json`,
    executionIndexes: [],
    items: []
  }
}

function paper(id: string, doi: string): PaperListItem {
  return {
    id,
    relativePath: `papers/${id}.md`,
    title: id,
    authors: [],
    journal: '',
    year: null,
    doi,
    url: '',
    abstract: '',
    keywords: [],
    source: 'test',
    contentKind: 'fulltext',
    hasFulltext: true,
    addedAt: null,
    lastOpenedAt: null,
    modifiedAt: '2026-09-02T00:00:00.000Z',
    searchSnippet: null,
    hasOverrides: false
  }
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
}

async function enter(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
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

describe('dialog request races', () => {
  it('keeps the newest AddPapersDialog project response', async () => {
    const first = deferred<FetchRun[]>()
    const second = deferred<FetchRun[]>()
    const projectOne = project('project_aaaaaaaaaaaaaaaaaaaaaaaa', 'First')
    const projectTwo = project('project_bbbbbbbbbbbbbbbbbbbbbbbb', 'Second')
    window.litroot = transportFor({
      fetch: {
        list: vi.fn((projectId: string) => (
          projectId === projectOne.id ? first.promise : second.promise
        ))
      }
    } as unknown as LitRootBridge)

    await act(async () => root.render(
      <AddPapersDialog
        open
        project={projectOne}
        event={null}
        onClose={vi.fn()}
        onOpenPaper={vi.fn()}
      />
    ))
    await act(async () => root.render(
      <AddPapersDialog
        open
        project={projectTwo}
        event={null}
        onClose={vi.fn()}
        onOpenPaper={vi.fn()}
      />
    ))
    second.resolve([run('run_cccccccccccccccccccccccc', projectTwo.id, '2026-09-02T02:00:00.000Z')])
    await settle()
    first.resolve([run('run_dddddddddddddddddddddddd', projectOne.id, '2026-09-01T01:00:00.000Z')])
    await settle()

    const select = container.querySelector<HTMLSelectElement>('.run-select select')
    expect(select?.textContent).toContain('completed')
    expect(select?.querySelector('option')?.value).toBe('run_cccccccccccccccccccccccc')
  })

  it('prefills and submits aligned DOI targets for a batch refresh', async () => {
    const selectedProject = project('project_aaaaaaaaaaaaaaaaaaaaaaaa', 'Batch')
    const createdRun = run('run_cccccccccccccccccccccccc', selectedProject.id, '2026-09-02T02:00:00.000Z')
    const create = vi.fn(async () => createdRun)
    window.litroot = transportFor({
      fetch: { list: vi.fn(async () => []), create }
    } as unknown as LitRootBridge)

    await act(async () => root.render(
      <AddPapersDialog
        open
        project={selectedProject}
        event={null}
        refresh={{
          targets: [
            { paperId: 'paper_aaaaaaaaaaaaaaaaaaaaaaaa', query: '10.4242/first' },
            { paperId: 'paper_bbbbbbbbbbbbbbbbbbbbbbbb', query: '10.4242/second' }
          ],
          batch: true,
          skippedCount: 1
        }}
        onClose={vi.fn()}
        onOpenPaper={vi.fn()}
      />
    ))
    await settle()

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')
    expect(textarea?.value).toBe('10.4242/first\n10.4242/second')
    expect(textarea?.readOnly).toBe(true)
    expect(container.textContent).toContain('已跳过 1 篇缺少 DOI 的文献。')
    const submit = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '开始批量刷新')
    await act(async () => { submit?.click() })

    expect(create).toHaveBeenCalledWith({
      projectId: selectedProject.id,
      inputs: ['10.4242/first', '10.4242/second'],
      concurrency: 4,
      refreshPaperIds: [
        'paper_aaaaaaaaaaaaaaaaaaaaaaaa',
        'paper_bbbbbbbbbbbbbbbbbbbbbbbb'
      ]
    })
  })

  it('passes the active multi-selection to the library batch refresh action', async () => {
    const papers = [paper('paper_aaaaaaaaaaaaaaaaaaaaaaaa', '10.4242/first'), paper('paper_bbbbbbbbbbbbbbbbbbbbbbbb', '')]
    const onBatchRefresh = vi.fn()
    await act(async () => root.render(
      <LibraryTable
        items={papers}
        loading={false}
        query=""
        selectedPaperId={papers[0].id}
        selectedPaperIds={papers.map((item) => item.id)}
        selectionAnchorId={papers[0].id}
        preferences={defaultLibraryPreferences()}
        setPreferences={vi.fn()}
        onSortChange={vi.fn()}
        onSelectionChange={vi.fn()}
        onOpen={vi.fn()}
        onOpenWindow={vi.fn()}
        onOpenOnline={vi.fn()}
        onReveal={vi.fn()}
        onBatchRefresh={onBatchRefresh}
        onExport={vi.fn()}
      />
    ))
    const row = container.querySelector<HTMLElement>('[data-paper-id="paper_aaaaaaaaaaaaaaaaaaaaaaaa"]')
    await act(async () => row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    const action = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === '批量刷新')
    await act(async () => { action?.click() })

    expect(onBatchRefresh).toHaveBeenCalledWith([papers[0]], 1)
  })

  it('keeps the newest ProjectDialog diagnosis after switching runtimes', async () => {
    const local = deferred<DependencyReport>()
    const wsl = deferred<DependencyReport>()
    window.litroot = transportFor({
      system: {
        listRuntimes: vi.fn(async () => [
          { key: 'local', label: 'Local', target: { kind: 'local' } },
          { key: 'wsl:Ubuntu', label: 'WSL', target: { kind: 'wsl', distribution: 'Ubuntu' } }
        ]),
        diagnose: vi.fn((target) => target.kind === 'local' ? local.promise : wsl.promise)
      }
    } as unknown as LitRootBridge)
    await act(async () => root.render(
      <ProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />
    ))
    await settle()
    const runtime = container.querySelector<HTMLSelectElement>('select')!
    await act(async () => {
      runtime.value = 'wsl:Ubuntu'
      runtime.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const report = (version: string): DependencyReport => ({
      runtimeLabel: version,
      ready: true,
      checks: [{
        name: 'node', ok: true, version, required: '24.15+', repairCommand: '', reason: null
      }]
    })
    wsl.resolve(report('v24.17.0'))
    await settle()
    expect(container.textContent).toContain('v24.17.0')
    local.resolve(report('v24.15.0'))
    await settle()
    expect(container.textContent).toContain('v24.17.0')
    expect(container.textContent).not.toContain('v24.15.0')
  })

  it('keeps the newest AddFeedDialog search response', async () => {
    const first = deferred<{ candidates: JournalCandidate[] }>()
    const second = deferred<{ candidates: JournalCandidate[] }>()
    const search = vi.fn(({ query }: { query: string }) => (
      query === 'First query' ? first.promise : second.promise
    ))
    window.litroot = transportFor({ feeds: { searchJournals: search } } as unknown as LitRootBridge)
    await act(async () => root.render(<AddFeedDialog open onClose={vi.fn()} onAdded={vi.fn()} />))
    const input = container.querySelector<HTMLInputElement>('input')!
    await enter(input, 'First query')
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '搜索期刊')?.click())
    await enter(input, 'Second query')
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '搜索期刊')?.click())
    second.resolve({ candidates: [{
      displayName: 'Second Journal', publisher: null, issn: '2041-1723', issns: ['2041-1723']
    }] })
    await settle()
    first.resolve({ candidates: [{
      displayName: 'First Journal', publisher: null, issn: '0034-4257', issns: ['0034-4257']
    }] })
    await settle()

    expect(container.textContent).toContain('Second Journal')
    expect(container.textContent).not.toContain('First Journal')
  })
})
