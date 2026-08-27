// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  LitRootBridge,
  PaperDetail,
  ProjectSummary,
  ServiceEvent
} from '../../src/shared/contracts.js'
import App from '../../src/renderer/src/App.js'

const PROJECT_ID = 'project_aaaaaaaaaaaaaaaaaaaaaaaa'
const FIRST_PAPER_ID = 'paper_bbbbbbbbbbbbbbbbbbbbbbbb'
const SECOND_PAPER_ID = 'paper_cccccccccccccccccccccccc'

const project: ProjectSummary = {
  id: PROJECT_ID,
  name: 'Scroll test project',
  path: '/home/test/scroll-project',
  distribution: 'Ubuntu',
  status: 'ready',
  error: null,
  paperCount: 2,
  issueCount: 0,
  years: [2026],
  lastScannedAt: '2026-08-25T00:00:00.000Z'
}

function paper(id: string, title: string, revision: string): PaperDetail {
  const metadata = {
    title,
    authors: ['Ada Researcher'],
    journal: 'Journal of Stable Readers',
    year: 2026,
    doi: `10.4242/${id}`,
    url: 'https://example.test/paper',
    abstract: 'Abstract',
    keywords: ['scrolling']
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
    markdown: `# ${title}\n\n![Figure](assets/figure.png)`,
    markdownRevision: revision,
    assetPaths: ['assets/figure.png']
  }
}

const firstPaper = paper(FIRST_PAPER_ID, 'First paper', 'revision-first')
const secondPaper = paper(SECOND_PAPER_ID, 'Second paper', 'revision-second')
const details = new Map([
  [FIRST_PAPER_ID, firstPaper],
  [SECOND_PAPER_ID, secondPaper]
])

let eventListener: ((event: ServiceEvent) => void) | null = null
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
      list: async () => [project],
      add: unused,
      remove: async () => undefined,
      scan: unused
    },
    papers: {
      search: async () => ({
        items: [firstPaper, secondPaper],
        total: 2,
        years: [2026]
      }),
      get: async (_projectId, paperId) => details.get(paperId) ?? null,
      updateMetadata: unused,
      assetUrl: (_projectId, paperId, source) => `litroot-asset://${paperId}/${source}`
    },
    notes: {
      read: unused,
      write: unused
    },
    fetch: {
      create: unused,
      get: unused,
      list: async () => [],
      cancel: unused,
      resume: unused
    },
    events: {
      subscribe: (listener) => {
        eventListener = listener
        return () => { eventListener = null }
      }
    }
  }
}

async function waitForElement<T extends Element>(selector: string): Promise<T> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const element = container.querySelector<T>(selector)
    if (element) return element
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
  }
  throw new Error(`Timed out waiting for ${selector}`)
}

beforeEach(async () => {
  window.localStorage.clear()
  window.localStorage.setItem('litroot.current-project', PROJECT_ID)
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

describe('reader scroll behavior', () => {
  it('preserves the current paper during background events and resets a newly selected paper', async () => {
    const firstRow = await waitForElement<HTMLElement>(`.paper-row[data-paper-id="${FIRST_PAPER_ID}"]`)
    await act(async () => {
      firstRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    const reader = await waitForElement<HTMLElement>('.reader-panel')
    const firstImage = await waitForElement<HTMLImageElement>('.markdown-reader img')

    reader.scrollTop = 640
    await act(async () => {
      eventListener?.({
        type: 'scan.started',
        projectId: PROJECT_ID,
        at: '2026-08-25T00:00:01.000Z'
      })
    })
    expect(reader.scrollTop).toBe(640)
    expect(container.querySelector('.markdown-reader img')).toBe(firstImage)

    const homeTab = await waitForElement<HTMLButtonElement>('.home-tab')
    await act(async () => { homeTab.click() })
    const secondRow = await waitForElement<HTMLElement>(`.paper-row[data-paper-id="${SECOND_PAPER_ID}"]`)
    await act(async () => {
      secondRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    await waitForElement('.markdown-reader img')
    const secondReader = await waitForElement<HTMLElement>('.reader-panel')
    expect(secondReader.scrollTop).toBe(0)
    expect(container.querySelector('.reader-header h1')?.textContent).toBe('Second paper')

    const secondImage = container.querySelector('.markdown-reader img')
    secondReader.scrollTop = 520
    await act(async () => {
      eventListener?.({
        type: 'papers.changed',
        projectId: PROJECT_ID,
        at: '2026-08-25T00:00:02.000Z'
      })
      await Promise.resolve()
    })
    expect(secondReader.scrollTop).toBe(520)
    expect(container.querySelector('.markdown-reader img')).toBe(secondImage)
  })
})
