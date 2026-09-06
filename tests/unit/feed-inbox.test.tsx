// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  FeedItem,
  FeedSubscription,
  JournalCandidate,
  LitRootBridge,
  ProjectSummary
} from '../../src/shared/contracts.js'
import { AddFeedDialog, FeedInbox } from '../../src/renderer/src/FeedInbox.js'
import { transportFor } from '../renderer-transport.js'

const subscription: FeedSubscription = {
  id: 'feed_aaaaaaaaaaaaaaaaaaaaaaaa',
  issn: '0034-4257',
  title: 'Example Journal',
  unreadCount: 2,
  lastCheckedAt: null,
  lastSuccessfulAt: null,
  error: null
}

const items: FeedItem[] = [
  {
    id: 'feeditem_bbbbbbbbbbbbbbbbbbbbbbbb', subscriptionId: subscription.id,
    sourceTitle: subscription.title, title: 'DOI paper', authors: ['One'], summary: 'First',
    doi: '10.1234/first', url: 'https://example.org/first', publishedAt: '2026-09-01T00:00:00.000Z',
    discoveredAt: '2026-09-01T00:00:00.000Z', readAt: null
  },
  {
    id: 'feeditem_cccccccccccccccccccccccc', subscriptionId: subscription.id,
    sourceTitle: subscription.title, title: 'URL paper', authors: ['Two'], summary: 'Second',
    doi: '', url: 'https://example.org/second', publishedAt: null,
    discoveredAt: '2026-08-31T00:00:00.000Z', readAt: null
  }
]

const projects: ProjectSummary[] = [
  { id: 'project_dddddddddddddddddddddddd', name: 'Ready', path: '/ready', status: 'ready', error: null, paperCount: 0, issueCount: 0, years: [], lastScannedAt: null },
  { id: 'project_eeeeeeeeeeeeeeeeeeeeeeee', name: 'Broken', path: '/broken', status: 'error', error: 'no', paperCount: 0, issueCount: 0, years: [], lastScannedAt: null }
]

let container: HTMLDivElement
let root: Root

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

describe('Feed inbox', () => {
  it('defaults to seven days, marks opened items read, and hands selected inputs to an eligible project', async () => {
    const markRead = vi.fn(async () => undefined)
    const create = vi.fn(async () => ({ id: 'run_ffffffffffffffffffffffff' }))
    const requestItems = vi.fn(async () => ({ items, total: items.length }))
    const onFetchCreated = vi.fn()
    window.litroot = transportFor({
      feeds: {
        list: vi.fn(), add: vi.fn(), remove: vi.fn(), refresh: vi.fn(), markRead,
        items: requestItems
      },
      fetch: { create }
    } as unknown as LitRootBridge)

    await act(async () => root.render(
      <FeedInbox
        scope={subscription.id}
        feeds={[subscription]}
        projects={projects}
        event={null}
        onFetchCreated={onFetchCreated}
        onMessage={vi.fn()}
      />
    ))
    await settle()

    expect(requestItems).toHaveBeenCalledWith({
      subscriptionId: subscription.id, days: 7, limit: 50, offset: 0
    })
    const rows = container.querySelectorAll<HTMLElement>('.feed-row')
    expect(rows).toHaveLength(2)
    expect(container.querySelector('select[aria-label="目标项目"]')?.textContent).toContain('Ready')
    expect(container.querySelector('select[aria-label="目标项目"]')?.textContent).not.toContain('Broken')

    await act(async () => root.render(
      <FeedInbox
        scope={subscription.id}
        feeds={[subscription]}
        projects={[{ ...projects[0]!, status: 'scanning' }, projects[1]!]}
        event={null}
        onFetchCreated={onFetchCreated}
        onMessage={vi.fn()}
      />
    ))
    const target = container.querySelector<HTMLSelectElement>('select[aria-label="目标项目"]')
    expect(target?.value).toBe(projects[0]!.id)
    expect(target?.textContent).not.toContain('无可用项目')

    await act(async () => rows[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => rows[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })))
    expect(markRead).toHaveBeenCalledWith({ itemIds: [items[0]!.id], read: true })

    const add = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '添加到项目')
    await act(async () => add?.click())
    await settle()

    expect(create).toHaveBeenCalledWith({
      projectId: projects[0]!.id,
      inputs: ['10.1234/first', 'https://example.org/second'],
      concurrency: 4
    })
    expect(onFetchCreated).toHaveBeenCalledWith(projects[0]!.id, 'run_ffffffffffffffffffffffff')
  })

  it('shows read and unread items in the recent overview and changes the day range', async () => {
    const requestItems = vi.fn(async () => ({ items: [items[0]!, { ...items[1]!, readAt: '2026-09-01T01:00:00.000Z' }], total: 2 }))
    window.litroot = transportFor({
      feeds: { items: requestItems, markRead: vi.fn(async () => undefined) }
    } as unknown as LitRootBridge)
    await act(async () => root.render(
      <FeedInbox
        scope="recent"
        feeds={[subscription]}
        projects={[]}
        event={null}
        onFetchCreated={vi.fn()}
        onMessage={vi.fn()}
      />
    ))
    await settle()
    expect(container.textContent).toContain('最近文献')
    expect(container.querySelectorAll('.feed-row')).toHaveLength(2)
    const range = container.querySelector<HTMLSelectElement>('select[aria-label="登记时间范围"]')!
    expect(range.value).toBe('7')
    await act(async () => {
      range.value = '14'
      range.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(requestItems).toHaveBeenLastCalledWith({ subscriptionId: null, days: 14, limit: 50, offset: 0 })
  })
})

describe('Add journal dialog', () => {
  const candidate: JournalCandidate = {
    displayName: 'Journal of Useful Tests',
    publisher: 'Test Publisher',
    issn: '2041-1723',
    issns: ['2041-1723']
  }

  it('searches by journal name and adds the selected Crossref result directly', async () => {
    const searchJournals = vi.fn(async () => ({ candidates: [candidate] }))
    const add = vi.fn(async () => subscription)
    const onAdded = vi.fn()
    window.litroot = transportFor({
      feeds: { searchJournals, add }
    } as unknown as LitRootBridge)
    await act(async () => root.render(<AddFeedDialog open onClose={vi.fn()} onAdded={onAdded} />))

    const input = container.querySelector<HTMLInputElement>('input')!
    await enter(input, 'Useful Tests')
    const search = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '搜索期刊')
    await act(async () => search?.click())
    await settle()
    expect(searchJournals).toHaveBeenCalledWith({ query: 'Useful Tests' })
    expect(container.textContent).toContain('Test Publisher')

    const result = container.querySelector<HTMLButtonElement>('.journal-result')
    await act(async () => result?.click())
    await settle()
    expect(add).toHaveBeenCalledWith({ issn: candidate.issn, title: candidate.displayName })
    expect(onAdded).toHaveBeenCalledWith(subscription)
  })

  it('treats URL-like text only as a Crossref journal search and never adds it directly', async () => {
    const add = vi.fn()
    const searchJournals = vi.fn(async () => ({ candidates: [] }))
    window.litroot = transportFor({
      feeds: { add, searchJournals }
    } as unknown as LitRootBridge)
    await act(async () => root.render(<AddFeedDialog open onClose={vi.fn()} onAdded={vi.fn()} />))

    const input = container.querySelector<HTMLInputElement>('input')!
    await enter(input, 'https://example.org/feed')
    const search = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '搜索期刊')
    await act(async () => search?.click())
    await settle()
    expect(searchJournals).toHaveBeenCalledWith({ query: 'https://example.org/feed' })
    expect(add).not.toHaveBeenCalled()
  })

  it('preserves the query and candidates when Crossref validation or backfill fails', async () => {
    window.litroot = transportFor({
      feeds: {
        searchJournals: vi.fn(async () => ({ candidates: [candidate] })),
        add: vi.fn(async () => { throw new Error('Crossref 暂时不可用') })
      }
    } as unknown as LitRootBridge)
    await act(async () => root.render(<AddFeedDialog open onClose={vi.fn()} onAdded={vi.fn()} />))
    const input = container.querySelector<HTMLInputElement>('input')!
    await enter(input, 'Useful Tests')
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '搜索期刊')?.click())
    await settle()
    await act(async () => container.querySelector<HTMLButtonElement>('.journal-result')?.click())
    await settle()
    expect(input.value).toBe('Useful Tests')
    expect(container.querySelector('.journal-result')).not.toBeNull()
    expect(container.textContent).toContain('Crossref 暂时不可用')
  })
})
