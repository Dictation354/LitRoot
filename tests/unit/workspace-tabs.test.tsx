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

const projects: ProjectSummary[] = [
  {
    id: PROJECT_ONE,
    name: 'Project One',
    path: '/projects/one',
    distribution: 'Ubuntu',
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
    distribution: 'Ubuntu',
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
const requests: PaperSearchRequest[] = []
let container: HTMLDivElement
let root: Root

function bridgeMock(): LitRootBridge {
  const unused = async (): Promise<never> => { throw new Error('Unexpected bridge call') }
  return {
    system: {
      listDistributions: unused,
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
        const item = request.projectId === PROJECT_ONE ? firstPaper : secondPaper
        return { items: [item], total: 1, years: [item.year ?? 2025] }
      },
      get: async (projectId, paperId) => {
        if (projectId === PROJECT_ONE && paperId === PAPER_ONE) return firstPaper
        if (projectId === PROJECT_TWO && paperId === PAPER_TWO) return secondPaper
        return null
      },
      updateMetadata: unused,
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
})
