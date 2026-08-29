// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  LitRootBridge,
  PaperDetail,
  PaperSearchRequest,
  ProjectSummary
} from '../../src/shared/contracts.js'
import App from '../../src/renderer/src/App.js'

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
      list: async () => projects,
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
      get: async (projectId, paperId) => {
        if (projectId === PROJECT_ONE && paperId === PAPER_ONE) return firstPaper
        if (projectId === PROJECT_ONE && paperId === PAPER_THREE) return thirdPaper
        if (projectId === PROJECT_TWO && paperId === PAPER_TWO) return secondPaper
        return null
      },
      updateMetadata: unused,
      markOpened: async () => '2026-08-29T00:00:00.000Z',
      openWindow: async () => undefined,
      reveal: async () => undefined,
      export: async (_projectId, paperIds) => {
        exports.push(paperIds)
        return { papers: paperIds.length, images: 0, files: paperIds.length, failures: [] }
      },
      copyImage: async () => undefined,
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
    events: { subscribe: () => () => undefined }
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
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 })
  window.localStorage.clear()
  window.localStorage.setItem('litroot.current-project', PROJECT_ONE)
  window.litroot = bridgeMock()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(<App />) })
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  window.localStorage.clear()
  delete window.litroot
})

describe('workspace tabs', () => {
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
    expect(thirdRow.style.gridTemplateColumns).toContain('minmax(64px')
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
