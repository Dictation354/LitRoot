// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LitRootBridge,
  PaperDetail,
  PaperSearchRequest,
  PaperSearchResult,
  ProjectSummary,
  ServiceEvent
} from '../../src/shared/contracts.js'
import App from '../../src/renderer/src/App.js'
import { transportFor } from '../renderer-transport.js'

const PROJECT_ONE = 'project_aaaaaaaaaaaaaaaaaaaaaaaa'
const PROJECT_TWO = 'project_bbbbbbbbbbbbbbbbbbbbbbbb'
const PAPER_ONE = 'paper_cccccccccccccccccccccccc'
const PAPER_TWO = 'paper_dddddddddddddddddddddddd'
const PAPER_THREE = 'paper_eeeeeeeeeeeeeeeeeeeeeeee'

const projects: ProjectSummary[] = [
  {
    id: PROJECT_ONE,
    name: 'Project One',
    path: '/projects/one',
    runtime: { kind: 'wsl', distribution: 'Ubuntu' },
    status: 'ready',
    error: null,
    paperCount: 1,
    issueCount: 0,
    years: [2024],
    lastScannedAt: '2026-08-25T00:00:00.000Z'
  },
  {
    id: PROJECT_TWO,
    name: 'Project Two',
    path: '/projects/two',
    runtime: { kind: 'wsl', distribution: 'Ubuntu' },
    status: 'ready',
    error: null,
    paperCount: 1,
    issueCount: 0,
    years: [2025],
    lastScannedAt: '2026-08-25T00:00:00.000Z'
  }
]

function paper(id: string, title: string, year: number): PaperDetail {
  const metadata = {
    title,
    authors: ['Ada Researcher'],
    journal: 'Journal of Tabs',
    year,
    doi: `10.4242/${id}`,
    url: 'https://example.test/paper',
    abstract: 'Abstract',
    keywords: ['tabs']
  }
  return {
    id,
    relativePath: `papers/${id}.md`,
    ...metadata,
    source: 'test_provider',
    contentKind: 'fulltext',
    hasFulltext: true,
    addedAt: '2026-08-20T00:00:00.000Z',
    lastOpenedAt: null,
    modifiedAt: '2026-08-25T00:00:00.000Z',
    searchSnippet: null,
    hasOverrides: false,
    fetchedMetadata: metadata,
    overrides: {},
    markdown: `# ${title}\n\nBody`,
    markdownRevision: `revision-${id}`,
    assetPaths: []
  }
}

const firstPaper = paper(PAPER_ONE, 'Alpha paper', 2024)
const secondPaper = paper(PAPER_TWO, 'Beta paper', 2025)
const thirdPaper = paper(PAPER_THREE, 'Gamma paper', 2024)
const requests: PaperSearchRequest[] = []
const exports: string[][] = []
const listProjects = vi.fn(async (): Promise<ProjectSummary[]> => projects)
const getPaper = vi.fn(async (projectId: string, paperId: string): Promise<PaperDetail | null> => {
  if (projectId === PROJECT_ONE && paperId === PAPER_ONE) return firstPaper
  if (projectId === PROJECT_ONE && paperId === PAPER_THREE) return thirdPaper
  if (projectId === PROJECT_TWO && paperId === PAPER_TWO) return secondPaper
  return null
})
let eventListener: ((event: ServiceEvent) => void) | null = null
let container: HTMLDivElement
let root: Root

function bridgeMock(): LitRootBridge {
  const unused = async (): Promise<never> => { throw new Error('Unexpected bridge call') }
  return {
    system: {
      listRuntimes: unused,
      diagnose: unused,
      pickProjectPath: unused,
      openExternal: async () => undefined,
      copyText: async () => undefined
    },
    projects: {
      list: listProjects,
      add: unused,
      remove: async () => undefined,
      scan: unused
    },
    papers: {
      search: async (request) => {
        requests.push(request)
        const items = request.projectId === PROJECT_ONE ? [firstPaper, thirdPaper] : [secondPaper]
        return { items, total: items.length, years: [items[0]?.year ?? 2025] }
      },
      get: getPaper,
      updateMetadata: unused,
      markOpened: async () => '2026-08-29T00:00:00.000Z',
      openWindow: async () => undefined,
      reveal: async () => undefined,
      export: async (_projectId, paperIds) => {
        exports.push(paperIds)
        return { papers: paperIds.length, images: 0, files: paperIds.length, failures: [] }
      },
      copyImage: async () => undefined,
      openImage: async () => undefined,
      assetUrl: (_projectId, paperId, source) => `litroot-asset://${paperId}/${source}`
    },
    notes: { read: unused, write: unused },
    fetch: {
      create: unused,
      get: unused,
      list: async () => [],
      cancel: unused,
      resume: unused
    },
    feeds: {
      list: async () => [],
      searchJournals: unused,
      add: unused,
      remove: unused,
      refresh: unused,
      items: async () => ({ items: [], total: 0 }),
      markRead: async () => undefined
    },
    events: {
      subscribe: (listener) => {
        eventListener = listener
        return () => { eventListener = null }
      }
    }
  }
}

async function waitFor<T>(read: () => T | null | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = read()
    if (value) return value
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
  }
  throw new Error('Timed out waiting for workspace state.')
}

beforeEach(async () => {
  requests.length = 0
  exports.length = 0
  listProjects.mockClear()
  listProjects.mockImplementation(async () => projects)
  getPaper.mockClear()
  eventListener = null
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 })
  window.localStorage.clear()
  window.localStorage.setItem('litroot.current-project', PROJECT_ONE)
  window.litroot = transportFor(bridgeMock())
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(<App />) })
})

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => { root.unmount() })
  container.remove()
  window.localStorage.clear()
  delete window.litroot
})

describe('workspace tabs', () => {
  it.each([20, 50, 100, 200])('uses %i items per page while retaining filters and clearing multiselection', async (pageSize) => {
    await act(async () => root.unmount())
    const allItems = Array.from({ length: pageSize + 53 }, (_, index) => (
      paper(`paper_${String(index).padStart(24, '0')}`, `Paper ${index}`, 2024)
    ))
    const mock = bridgeMock()
    mock.papers.search = async (request) => {
      requests.push(request)
      return { items: allItems.slice(request.offset, request.offset + request.limit), total: allItems.length, years: [2024] }
    }
    window.litroot = transportFor(mock)
    root = createRoot(container)
    await act(async () => root.render(<App />))
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="每页条数"]')!
    expect(select.value).toBe('50')
    expect([...select.options].map((option) => option.value)).toEqual(['20', '50', '100', '200'])
    const search = container.querySelector<HTMLInputElement>('input[aria-label="全文搜索"]')!
    const year = container.querySelector<HTMLSelectElement>('select[aria-label="年份筛选"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Paper')
      search.dispatchEvent(new Event('input', { bubbles: true }))
      year.value = '2024'
      year.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 270)) })
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('.table-column-header button')]
        .find((button) => button.textContent?.includes('标题'))!.click()
    })
    const [previous, next] = container.querySelectorAll<HTMLButtonElement>('.library-footer button')
    await act(async () => next!.click())
    expect(requests.at(-1)).toMatchObject({ limit: 50, offset: 50 })
    const rows = container.querySelectorAll<HTMLElement>('.paper-row')
    await act(async () => rows[0]!.click())
    await act(async () => rows[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })))
    expect(container.querySelectorAll('.paper-row[aria-selected="true"]')).toHaveLength(2)
    await act(async () => {
      select.value = String(pageSize)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(requests.at(-1)).toMatchObject({ limit: pageSize, offset: 0, query: 'Paper', year: 2024, sortBy: 'title', sortDirection: 'desc' })
    expect(search.value).toBe('Paper')
    expect(year.value).toBe('2024')
    expect(container.querySelectorAll('.paper-row')).toHaveLength(pageSize)
    expect(container.querySelectorAll('.paper-row[aria-selected="true"]')).toHaveLength(0)
    expect(previous!.disabled).toBe(true)
    expect(container.querySelector('.library-footer > span')?.textContent).toBe(`1–${pageSize} / ${allItems.length}`)
    for (let offset = pageSize; offset < allItems.length; offset += pageSize) {
      await act(async () => next!.click())
      expect(requests.at(-1)).toMatchObject({ limit: pageSize, offset })
      expect(container.querySelector('.library-footer > span')?.textContent)
        .toBe(`${offset + 1}–${Math.min(offset + pageSize, allItems.length)} / ${allItems.length}`)
      expect(container.querySelector('.library-footer > div > span')?.textContent)
        .toBe(`${offset / pageSize + 1} / ${Math.ceil(allItems.length / pageSize)}`)
    }
    expect(next!.disabled).toBe(true)
    await act(async () => previous!.click())
    expect(requests.at(-1)?.offset).toBe((Math.ceil(allItems.length / pageSize) - 2) * pageSize)

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('.project-main')]
        .find((button) => button.textContent?.includes('Project Two'))!.click()
    })
    expect(requests.at(-1)).toMatchObject({ projectId: PROJECT_TWO, limit: pageSize, offset: 0 })
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<App />))
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="每页条数"]')?.value).toBe(String(pageSize))
    expect(requests.at(-1)).toMatchObject({ limit: pageSize, offset: 0 })
  })

  it('keeps library and radar page sizes independent across remounts', async () => {
    const librarySelect = container.querySelector<HTMLSelectElement>('select[aria-label="每页条数"]')!
    await act(async () => {
      librarySelect.value = '200'
      librarySelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLButtonElement>('.feed-sidebar-entry')!.click())
    const feedSelect = container.querySelector<HTMLSelectElement>('select[aria-label="每页条数"]')!
    expect(feedSelect.value).toBe('50')
    await act(async () => {
      feedSelect.value = '20'
      feedSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<App />))
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="每页条数"]')?.value).toBe('200')
    await act(async () => container.querySelector<HTMLButtonElement>('.feed-sidebar-entry')!.click())
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="每页条数"]')?.value).toBe('20')
  })

  it('ignores a stale page size response and displays empty pagination', async () => {
    await act(async () => root.unmount())
    let resolveOld!: (result: PaperSearchResult) => void
    const old = new Promise<PaperSearchResult>((resolve) => { resolveOld = resolve })
    const mock = bridgeMock()
    const search = vi.fn().mockReturnValueOnce(old).mockResolvedValue({ items: [], total: 0, years: [] })
    mock.papers.search = search
    window.litroot = transportFor(mock)
    root = createRoot(container)
    await act(async () => root.render(<App />))
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('select[aria-label="每页条数"]')!
      select.value = '100'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100, offset: 0 }))
    await act(async () => resolveOld({ items: [firstPaper], total: 1, years: [2024] }))
    expect(container.querySelectorAll('.paper-row')).toHaveLength(0)
    expect(container.querySelector('.library-footer > span')?.textContent).toBe('无文献')
    expect(container.querySelector('.library-footer > div > span')?.textContent).toBe('0 / 1')
    expect([...container.querySelectorAll<HTMLButtonElement>('.library-footer button')].every((button) => button.disabled)).toBe(true)
    expect(container.querySelector('.library-table-frame')?.getAttribute('aria-busy')).toBe('false')
  })

  it('shows the inspector only in paper reader tabs and does not load details on selection', async () => {
    const firstRow = await waitFor(() => container.querySelector<HTMLElement>(`[data-paper-id="${PAPER_ONE}"]`))
    const thirdRow = await waitFor(() => container.querySelector<HTMLElement>(`[data-paper-id="${PAPER_THREE}"]`))

    expect(container.querySelector('.library-main')).not.toBeNull()
    expect(firstRow.getAttribute('aria-selected')).toBe('false')
    expect(container.querySelector('.inspector-panel')).toBeNull()
    expect(container.querySelector('.inspector-resizer')).toBeNull()
    expect(getPaper).not.toHaveBeenCalled()

    await act(async () => { thirdRow.click() })
    expect(thirdRow.getAttribute('aria-selected')).toBe('true')
    expect(getPaper).not.toHaveBeenCalled()

    await act(async () => {
      thirdRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await waitFor(() => container.querySelector('.reader-header h1')?.textContent === 'Gamma paper')
    expect(container.querySelector('.inspector-panel')).not.toBeNull()
    expect(container.querySelector('.inspector-resizer')).not.toBeNull()
    expect(getPaper).toHaveBeenCalledWith(PROJECT_ONE, PAPER_THREE)

    const homeTab = container.querySelector<HTMLButtonElement>('.home-tab')
    await act(async () => { homeTab?.click() })
    await waitFor(() => container.querySelector('.library-main'))
    expect(container.querySelector('.inspector-panel')).toBeNull()
    expect(container.querySelector('.inspector-resizer')).toBeNull()
    expect(container.querySelector(`[data-paper-id="${PAPER_ONE}"]`)).not.toBeNull()
  })

  it('keeps scanning projects selectable while recovering a missed completion event', async () => {
    const recent = await waitFor(() => container.querySelector<HTMLButtonElement>('.feed-sidebar-entry'))
    await act(async () => { recent.click() })
    const target = await waitFor(() => container.querySelector<HTMLSelectElement>('select[aria-label="目标项目"]'))
    expect(target.textContent).toContain('Project One')

    vi.useFakeTimers()
    await act(async () => {
      eventListener?.({ type: 'scan.started', projectId: PROJECT_ONE, at: new Date().toISOString() })
      eventListener?.({ type: 'scan.started', projectId: PROJECT_TWO, at: new Date().toISOString() })
    })
    expect(target.textContent).toContain('Project One')
    expect(target.textContent).toContain('Project Two')
    listProjects.mockClear()

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })

    expect(listProjects).toHaveBeenCalledOnce()
    expect(target.textContent).toContain('Project One')
  })

  it('opens unique paper tabs and keeps them while switching projects', async () => {
    const firstRow = await waitFor(() => container.querySelector<HTMLElement>(`[data-paper-id="${PAPER_ONE}"]`))
    await act(async () => { firstRow.click() })
    expect(container.querySelector('.reader-panel')).toBeNull()

    await act(async () => {
      firstRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await waitFor(() => container.querySelector('.reader-header h1')?.textContent === 'Alpha paper')

    const homeTab = container.querySelector<HTMLButtonElement>('.home-tab')
    await act(async () => { homeTab?.click() })
    const secondProject = [...container.querySelectorAll<HTMLButtonElement>('.project-main')]
      .find((button) => button.textContent?.includes('Project Two'))
    await act(async () => { secondProject?.click() })
    const secondRow = await waitFor(() => container.querySelector<HTMLElement>(`[data-paper-id="${PAPER_TWO}"]`))
    await act(async () => {
      secondRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    await waitFor(() => container.querySelector('.reader-header h1')?.textContent === 'Beta paper')
    expect(container.querySelectorAll('.paper-tab')).toHaveLength(2)

    const firstTab = [...container.querySelectorAll<HTMLElement>('.paper-tab')]
      .find((tab) => tab.textContent?.includes('Alpha paper'))
    await act(async () => { firstTab?.click() })
    await waitFor(() => container.querySelector('.reader-header h1')?.textContent === 'Alpha paper')
    const selectedProject = container.querySelector('.project-entry.selected')
    expect(selectedProject?.textContent).toContain('Project One')

    const close = container.querySelector<HTMLButtonElement>('[aria-label="关闭 Alpha paper"]')
    await act(async () => { close?.click() })
    await waitFor(() => container.querySelector('.reader-header h1')?.textContent === 'Beta paper')
    expect(container.querySelectorAll('.paper-tab')).toHaveLength(1)
    expect(container.querySelector('.project-entry.selected')?.textContent).toContain('Project Two')
  })

  it('requests server-side sorting when a table header changes', async () => {
    const titleHeader = await waitFor(() => (
      [...container.querySelectorAll<HTMLButtonElement>('.table-column-header button')]
        .find((button) => button.textContent?.includes('标题'))
    ))
    await act(async () => { titleHeader.click() })
    await waitFor(() => requests.some((request) => request.sortDirection === 'desc'))
    expect(requests.at(-1)).toMatchObject({ sortBy: 'title', sortDirection: 'desc', offset: 0 })
  })

  it('resizes only the two columns beside an internal divider', async () => {
    const headers = await waitFor(() => {
      const values = [...container.querySelectorAll<HTMLElement>('.table-column-header')]
      return values.length === 6 ? values : null
    })
    const widths = [380, 220, 84, 220, 150, 150]
    headers.forEach((header, index) => {
      header.getBoundingClientRect = () => ({
        bottom: 34,
        height: 34,
        left: widths.slice(0, index).reduce((sum, width) => sum + width, 0),
        right: widths.slice(0, index + 1).reduce((sum, width) => sum + width, 0),
        top: 0,
        width: widths[index],
        x: 0,
        y: 0,
        toJSON: () => undefined
      })
    })

    const resizers = container.querySelectorAll<HTMLElement>('.column-resizer')
    expect(resizers).toHaveLength(headers.length - 1)
    expect(headers.at(-1)?.querySelector('.column-resizer')).toBeNull()

    await act(async () => {
      resizers[0]?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100 }))
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 140 }))
    })

    const resizingTracks = container.querySelector<HTMLElement>('.table-grid')?.style.gridTemplateColumns
    expect(resizingTracks).toBe('420px 180px 84px 220px 150px 150px')

    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 140 }))
    })
    const stored = JSON.parse(window.localStorage.getItem('litroot.library-preferences.v1') ?? '{}')
    expect(stored.columns.slice(0, 3)).toMatchObject([
      { key: 'title', width: 420 },
      { key: 'authors', width: 180 },
      { key: 'year', width: 84 }
    ])
    expect(stored.columns[0].width + stored.columns[1].width).toBe(600)
    expect(document.body.classList.contains('resizing-panes')).toBe(false)
  })

  it('stops an internal column divider when either adjacent column reaches its minimum', async () => {
    const headers = await waitFor(() => {
      const values = [...container.querySelectorAll<HTMLElement>('.table-column-header')]
      return values.length === 6 ? values : null
    })
    const widths = [380, 220, 84, 220, 150, 150]
    headers.forEach((header, index) => {
      header.getBoundingClientRect = () => ({
        bottom: 34,
        height: 34,
        left: 0,
        right: widths[index],
        top: 0,
        width: widths[index],
        x: 0,
        y: 0,
        toJSON: () => undefined
      })
    })

    const firstResizer = container.querySelector<HTMLElement>('.column-resizer')
    await act(async () => {
      firstResizer?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100 }))
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: -1000 }))
    })
    expect(container.querySelector<HTMLElement>('.table-grid')?.style.gridTemplateColumns)
      .toBe('64px 536px 84px 220px 150px 150px')

    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointercancel'))
    })
    expect(document.body.classList.contains('resizing-panes')).toBe(false)
  })

  it('opens the project menu outside the scrolling sidebar and persists keyboard resizing', async () => {
    const menuButton = await waitFor(() => container.querySelector<HTMLButtonElement>('.project-menu-trigger'))
    await act(async () => { menuButton.click() })
    const popup = document.body.querySelector<HTMLElement>('.project-menu-popup')
    expect(popup?.parentElement?.classList.contains('project-menu-layer')).toBe(true)
    expect(popup?.textContent).toContain('重新扫描')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.body.querySelector('.project-menu-popup')).toBeNull()

    const sidebarResizer = container.querySelector<HTMLElement>('.sidebar-resizer')
    const before = Number(sidebarResizer?.getAttribute('aria-valuenow'))
    await act(async () => {
      sidebarResizer?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))
    })
    const after = Number(sidebarResizer?.getAttribute('aria-valuenow'))
    expect(after).toBeGreaterThan(before)
    expect(window.localStorage.getItem('litroot.sidebar-width')).toBe(String(after))
  })

  it('selects a range with Shift and exports the complete selection from the context menu', async () => {
    const firstRow = await waitFor(() => container.querySelector<HTMLElement>(`[data-paper-id="${PAPER_ONE}"]`))
    const thirdRow = await waitFor(() => container.querySelector<HTMLElement>(`[data-paper-id="${PAPER_THREE}"]`))
    await act(async () => {
      firstRow.click()
      thirdRow.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    })
    expect(firstRow.getAttribute('aria-selected')).toBe('true')
    expect(thirdRow.getAttribute('aria-selected')).toBe('true')
    expect(thirdRow.style.gridTemplateColumns).toContain('fr')
    expect(container.textContent).toContain('添加日期')
    expect(container.textContent).toContain('最后打开日期')

    await act(async () => {
      firstRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    })
    const exportButton = [...container.querySelectorAll<HTMLButtonElement>('.paper-context-menu button')]
      .find((button) => button.textContent?.includes('仅文本'))
    await act(async () => { exportButton?.click() })
    expect(exports).toEqual([[PAPER_ONE, PAPER_THREE]])
  })
})

it('clears old project data immediately and ignores late failure and unrelated project events', async () => {
  await act(async () => root.unmount())
  let rejectOld!: (error: Error) => void
  let resolveNew!: (result: PaperSearchResult) => void
  const old = new Promise<PaperSearchResult>((_resolve, reject) => { rejectOld = reject })
  const next = new Promise<PaperSearchResult>((resolve) => { resolveNew = resolve })
  const mock = bridgeMock()
  const search = vi.fn(({ projectId }: PaperSearchRequest) => projectId === PROJECT_ONE ? old : next)
  mock.papers.search = search
  window.litroot = transportFor(mock)
  root = createRoot(container)
  await act(async () => root.render(<App />))
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.project-main')].find((button) => button.textContent?.includes('Project Two'))!.click())
  expect(container.querySelectorAll('.paper-row')).toHaveLength(0)
  expect(container.querySelector('.library-identity')?.textContent).toContain('0 篇文献')
  expect(container.querySelectorAll('[aria-label="年份筛选"] option')).toHaveLength(1)
  await act(async () => rejectOld(new Error('stale project failure')))
  expect(container.textContent).not.toContain('stale project failure')
  await act(async () => resolveNew({ items: [secondPaper], total: 1, years: [2025] }))
  const count = search.mock.calls.length
  await act(async () => eventListener?.({ type: 'papers.changed', projectId: PROJECT_ONE, at: '2026-09-07T00:00:00Z' }))
  expect(search).toHaveBeenCalledTimes(count)
  expect(container.querySelector('.paper-row')?.textContent).toContain('Beta paper')
})

it('returns to a valid page after a background result shrinks and distinguishes missing detail from loading', async () => {
  await act(async () => root.unmount())
  let total = 51
  const mock = bridgeMock()
  mock.papers.search = async (request) => {
    requests.push(request)
    return { items: request.offset < total ? [firstPaper] : [], total, years: [2024] }
  }
  mock.papers.get = async () => null
  window.litroot = transportFor(mock)
  root = createRoot(container)
  await act(async () => root.render(<App />))
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.library-footer button')[1]!.click())
  total = 1
  await act(async () => eventListener?.({ type: 'papers.changed', projectId: PROJECT_ONE, at: '2026-09-07T00:00:00Z' }))
  expect(requests.at(-1)?.offset).toBe(0)
  await act(async () => container.querySelector('.paper-row')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
  expect(container.querySelector('.reader-panel')?.textContent).toContain('文献不存在')
  expect(container.querySelector('.reader-panel')?.textContent).not.toContain('正在载入')
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '返回文献库')!.click())
  expect(container.querySelector('.library-main')).not.toBeNull()
})

it('retains metadata after closing a tab and protects unload without prompting on navigation', async () => {
  const confirm = vi.spyOn(window, 'confirm')
  await act(async () => container.querySelector('.paper-row')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
  const title = container.querySelector<HTMLInputElement>('.metadata-editor input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Unsaved title')
    title.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
  await act(async () => container.querySelector<HTMLButtonElement>('.tab-close')!.click())
  expect(confirm).not.toHaveBeenCalled()
  expect(container.querySelector('.unsaved-entry')).toBeNull()
  await act(async () => container.querySelector('.paper-row')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
  expect(container.querySelector<HTMLInputElement>('.metadata-editor input')?.value).toBe('Unsaved title')
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '放弃修改')!.click())
  const clean = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(clean)
  expect(clean.defaultPrevented).toBe(false)
  confirm.mockRestore()
})

it('supports menu navigation, grid sorting semantics and keyboard column resize and reorder', async () => {
  const trigger = container.querySelector<HTMLButtonElement>('.project-menu-trigger')!
  trigger.focus()
  await act(async () => trigger.click())
  const menu = document.body.querySelector('.project-menu-popup')!
  expect(document.activeElement).toBe(menu.querySelector('button'))
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
  expect(document.activeElement).toBe(menu.querySelectorAll('button')[1])
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(document.activeElement).toBe(menu.querySelector('button'))
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.activeElement).toBe(trigger)
  expect(container.querySelector('[role="grid"]')).not.toBeNull()
  const header = container.querySelector<HTMLElement>('[role="columnheader"]')!
  expect(header.getAttribute('aria-sort')).toBe('ascending')
  const separator = header.querySelector<HTMLElement>('[role="separator"]')!
  const width = Number(separator.getAttribute('aria-valuenow'))
  await act(async () => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(Number(separator.getAttribute('aria-valuenow'))).toBe(width + 10)
  await act(async () => header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true })))
  expect(container.querySelector('[role="columnheader"]')?.textContent).toContain('作者')
})
