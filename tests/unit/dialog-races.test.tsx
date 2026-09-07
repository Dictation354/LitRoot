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
import { itemFor } from '../../src/service/fetch-record.js'
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
    expect(select?.textContent).toContain('已结束')
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
      ready: false,
      checks: [{
        name: 'node', ok: false, version, required: '24.15+', repairCommand: '', reason: null
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


it.each(['single', 'batch', 'refresh', 'batch-refresh'])('shows real stages and item cancellation for %s', async (mode) => {
  const selectedProject = project('project_test', 'Test')
  const running = run('run_test', selectedProject.id, new Date().toISOString())
  running.state = 'running'
  running.items = [itemFor(1, 'First')]
  Object.assign(running.items[0]!, { stage: 'assets', state: 'running',
    assetProgress: { scope: 'source-1', counts: [{ kind: 'formula', completed: 2, total: 4, failed: 0 }] } })
  if (mode.includes('batch')) running.items.push({ ...itemFor(2, 'Second'), stage: 'acceptance', state: 'running' })
  const cancelled = structuredClone(running)
  Object.assign(cancelled.items[0]!, { stage: 'terminal', state: 'cancelled' })
  const response = deferred<FetchRun>()
  const cancelItem = vi.fn(() => response.promise)
  window.litroot = transportFor({ fetch: { list: async () => [running], cancelItem } } as unknown as LitRootBridge)
  const refresh = mode.includes('refresh') ? { targets: running.items.map((item) => ({ paperId: `paper_${item.index}`, query: item.query })), batch: mode.includes('batch'), skippedCount: 0 } : undefined
  await act(async () => {
    root.render(<AddPapersDialog open project={selectedProject} event={null} {...(refresh ? { refresh } : {})} onClose={() => undefined} onOpenPaper={() => undefined} />)
  })
  await settle()
  expect(container.textContent).toContain('资产处理')
  expect(container.textContent).toContain('公式 已处理 2/4')
  expect(container.textContent).toContain(`已结束 0/${running.items.length}`)
  const buttons = [...container.querySelectorAll('button')].filter((button) => button.textContent === '取消此篇')
  expect(buttons).toHaveLength(1)
  await act(async () => { buttons[0]!.click() })
  expect(cancelItem).toHaveBeenCalledWith(selectedProject.id, running.id, 1)
  expect(buttons[0]!.disabled).toBe(true)
  expect(container.textContent).toContain('取消中')
  await act(async () => response.resolve(cancelled))
  expect(container.textContent).not.toContain('成功 0')
  expect(container.textContent).toContain('已取消 1')
  expect([...container.querySelectorAll('button')].some((button) => button.textContent === '取消此篇')).toBe(false)
})

it('uses a modal dialog with initial input focus, Escape and trigger focus restoration', async () => {
  window.litroot = transportFor({ feeds: { searchJournals: vi.fn() } } as unknown as LitRootBridge)
  const close = vi.fn()
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  await act(async () => root.render(<AddFeedDialog open onClose={close} onAdded={vi.fn()} />))
  const dialog = container.querySelector('dialog')!
  expect(dialog.open).toBe(true)
  expect(document.activeElement).toBe(dialog.querySelector('input'))
  await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })))
  expect(close).toHaveBeenCalledTimes(1)
  await act(async () => root.render(<AddFeedDialog open={false} onClose={close} onAdded={vi.fn()} />))
  expect(document.activeElement).toBe(trigger)
  trigger.remove()
})

it('renders only 50 items from a 1000-item run and updates elapsed time only in running leaves', async () => {
  vi.useFakeTimers()
  const projectOne = project('project_a', 'Large run')
  const large = run('run_large', projectOne.id, new Date().toISOString())
  large.state = 'running'
  large.items = Array.from({ length: 1000 }, (_, index) => ({ ...itemFor(index + 1, `Paper ${index + 1}`),
    title: `Title **${index + 1}**`, state: index === 0 ? 'running' as const : 'complete' as const,
    stage: index === 0 ? 'fetching' as const : 'terminal' as const, stageStartedAt: new Date().toISOString() }))
  window.litroot = transportFor({ fetch: { list: async () => [large] } } as unknown as LitRootBridge)
  const start = performance.now()
  try {
    await act(async () => root.render(<AddPapersDialog open project={projectOne} event={null} onClose={vi.fn()} onOpenPaper={vi.fn()} />))
    expect(container.querySelectorAll('.fetch-item')).toHaveLength(50)
    expect(container.querySelector('.fetch-summary')?.textContent).toContain('999/1000')
    expect(container.querySelector('.fetch-item details')?.hasAttribute('open')).toBe(false)
    const records: MutationRecord[] = []
    const observer = new MutationObserver((mutations) => records.push(...mutations))
    observer.observe(container, { characterData: true, subtree: true, childList: true })
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    observer.disconnect()
    expect(records.length).toBeGreaterThan(0)
    expect(records.every((record) => record.target.parentElement?.closest('.fetch-item.running details'))).toBe(true)
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '下一页')!.click())
    expect(container.querySelectorAll('.fetch-item')).toHaveLength(50)
    expect(container.querySelector('.fetch-item-title .index')?.textContent).toBe('51')
    console.log(`1000 tasks: mount and page navigation ${(performance.now() - start).toFixed(1)} ms; 50 rendered; timer mutations ${records.length}`)
  } finally { vi.useRealTimers() }
})

it('reports resume failure and ignores an action response after changing projects', async () => {
  const firstProject = project('project_first', 'First')
  const secondProject = project('project_second', 'Second')
  const firstRun = run('run_first', firstProject.id, '2026-09-07T00:00:00Z')
  firstRun.items = [{ ...itemFor(1, 'Failed paper'), state: 'failed', stage: 'terminal' }]
  const secondRun = run('run_second', secondProject.id, '2026-09-07T00:00:00Z')
  const response = deferred<FetchRun>()
  const resume = vi.fn().mockRejectedValueOnce(new Error('resume failed')).mockReturnValueOnce(response.promise)
  window.litroot = transportFor({ fetch: { list: async (id: string) => id === firstProject.id ? [firstRun] : [secondRun], resume } } as unknown as LitRootBridge)
  const render = (project: ProjectSummary) => <AddPapersDialog open project={project} event={null} onClose={vi.fn()} onOpenPaper={vi.fn()} />
  await act(async () => root.render(render(firstProject)))
  const resumeButton = () => [...container.querySelectorAll('button')].find((button) => button.textContent === '继续未完成项')!
  await act(async () => resumeButton().click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('resume failed')
  await act(async () => resumeButton().click())
  expect(resumeButton().disabled).toBe(true)
  await act(async () => root.render(render(secondProject)))
  await act(async () => response.resolve(firstRun))
  expect(container.querySelector<HTMLSelectElement>('.run-select select')?.value).toBe(secondRun.id)
  expect(container.textContent).not.toContain('Failed paper')
})
