import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeedService, crossrefAbstractText } from '../../src/main/feed-service.js'
import {
  addFeedRequestSchema,
  feedItemsRequestSchema,
  journalSearchRequestSchema,
  markFeedReadRequestSchema
} from '../../src/shared/contracts.js'

const temporaryDirectories: string[] = []
const DAY_MS = 86_400_000

function crossrefJournal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Journal of Useful Tests',
    publisher: 'Test Publisher',
    ISSN: ['2041-1723', '0034-4257'],
    ...overrides
  }
}

function journalResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({ status: 'ok', message: crossrefJournal(overrides) })
}

function work(index = 1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DOI: `10.1234/paper.${index}`,
    type: 'journal-article',
    title: [`Paper ${index}`],
    author: [{ given: 'Ada', family: 'Lovelace' }],
    abstract: '<jats:p>Useful &amp; bounded <b>summary</b>.</jats:p>',
    URL: `https://publisher.example/paper/${index}`,
    created: { 'date-time': new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
    published: { 'date-parts': [[2026, 9, 1]] },
    ...overrides
  }
}

function worksResponse(items: Record<string, unknown>[], nextCursor?: string): Response {
  return Response.json({
    status: 'ok',
    message: { items, ...(nextCursor ? { 'next-cursor': nextCursor } : {}) }
  })
}

async function serviceAndPath(): Promise<{ service: FeedService; databasePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'litroot-feeds-'))
  temporaryDirectories.push(directory)
  const databasePath = join(directory, 'feeds.sqlite3')
  return { service: new FeedService(databasePath, vi.fn()), databasePath }
}

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Crossref parsing and contracts', () => {
  it('reduces JATS/HTML abstracts to bounded plain text', () => {
    expect(crossrefAbstractText('<jats:p>A &amp; B&nbsp;<b>study</b></jats:p>')).toBe('A & B study')
    expect(crossrefAbstractText('<p>abcdef</p>', 4)).toBe('abcd')
  })

  it('normalizes request defaults and rejects invalid values', () => {
    expect(feedItemsRequestSchema.parse({})).toMatchObject({ days: 7, limit: 50, offset: 0 })
    expect(feedItemsRequestSchema.parse({ limit: 200 }).limit).toBe(200)
    expect(() => feedItemsRequestSchema.parse({ limit: 201 })).toThrow()
    for (const days of [1, 3, 7, 14, 30, 90]) expect(feedItemsRequestSchema.parse({ days }).days).toBe(days)
    expect(() => feedItemsRequestSchema.parse({ days: 2 })).toThrow()
    expect(() => feedItemsRequestSchema.parse({ subscriptionId: 'feed_bad' })).toThrow()
    expect(() => markFeedReadRequestSchema.parse({ itemIds: ['feeditem_bad'], read: true })).toThrow()
    expect(() => markFeedReadRequestSchema.parse({ read: true })).toThrow()
    expect(() => journalSearchRequestSchema.parse({ query: ' ' })).toThrow()
    expect(() => addFeedRequestSchema.parse({ requestId: randomUUID(), issn: 'not-an-issn' })).toThrow()
    expect(() => addFeedRequestSchema.parse({ requestId: 'bad-id', issn: '0034-4257' })).toThrow()
  })
})

describe('Crossref journal lookup', () => {
  it('searches names through /journals, validates exact ISSNs, and filters duplicate journals', async () => {
    const { service, databasePath } = await serviceAndPath()
    const database = new DatabaseSync(databasePath)
    database.prepare(`INSERT INTO subscriptions (
      id, issn, issns_json, title, publisher
    ) VALUES (?, ?, ?, ?, ?)`).run(
      'feed_aaaaaaaaaaaaaaaaaaaaaaaa', '2041-1723', '["2041-1723"]', 'Existing', 'Publisher'
    )
    database.close()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/journals/0034-4257')) {
        return journalResponse({ title: 'Remote Sensing of Environment', ISSN: ['0034-4257', '1879-0704'] })
      }
      return Response.json({
        status: 'ok',
        message: {
          items: [
            crossrefJournal({ title: 'Result without an ISSN', ISSN: [] }),
            crossrefJournal({ title: 'Already added', ISSN: ['2041-1723'] }),
            crossrefJournal({ title: 'Remote Sensing of Environment', ISSN: ['0034-4257', '1879-0704'] }),
            crossrefJournal({ title: 'Duplicate record', ISSN: ['1879-0704', '0034-4257'] })
          ]
        }
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const named = await service.searchJournals({ query: 'remote sensing' })
    expect(named.candidates).toEqual([expect.objectContaining({
      displayName: 'Remote Sensing of Environment',
      publisher: 'Test Publisher',
      issn: '0034-4257',
      issns: ['0034-4257', '1879-0704']
    })])
    const nameUrl = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(nameUrl.origin).toBe('https://api.crossref.org')
    expect(nameUrl.pathname).toBe('/journals')
    expect(nameUrl.searchParams.get('query')).toBe('remote sensing')
    expect(nameUrl.searchParams.get('rows')).toBe('100')
    expect(nameUrl.searchParams.get('mailto')).toContain('@')

    const exact = await service.searchJournals({ query: '00344257' })
    expect(exact.candidates[0]?.issn).toBe('0034-4257')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/journals/0034-4257')
    service.close()
  })

  it('prioritizes an exact journal title from the expanded candidate set', async () => {
    const { service } = await serviceAndPath()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      status: 'ok',
      message: {
        items: [
          crossrefJournal({ title: 'ScienceAsia', ISSN: ['1513-1874'] }),
          crossrefJournal({ title: 'Science', ISSN: ['0036-8075', '1095-9203'] })
        ]
      }
    })))

    const result = await service.searchJournals({ query: 'science' })

    expect(result.candidates.map((item) => item.displayName)).toEqual(['Science', 'ScienceAsia'])
    service.close()
  })

  it('reports rate limits, missing ISSNs, and malformed responses', async () => {
    const { service } = await serviceAndPath()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })))
    await expect(service.searchJournals({ query: 'journal' })).rejects.toThrow(/429|受限/)

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok', message: { items: [{ title: 42 }] } })))
    await expect(service.searchJournals({ query: 'journal' })).rejects.toThrow(/无法识别/)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    await expect(service.searchJournals({ query: '0034-4257' })).resolves.toEqual({ candidates: [] })
    service.close()
  })
})

describe('Crossref refresh and database', () => {
  it('aborts an active refresh and closes the database once after it exits', async () => {
    const { service, databasePath } = await serviceAndPath()
    const database = new DatabaseSync(databasePath)
    const subscriptionId = 'feed_aaaaaaaaaaaaaaaaaaaaaaaa'
    database.prepare(`INSERT INTO subscriptions (
      id, issn, issns_json, title, publisher
    ) VALUES (?, ?, ?, ?, '')`).run(
      subscriptionId, '0034-4257', '["0034-4257"]', 'Journal'
    )
    database.close()
    const close = vi.spyOn(Reflect.get(service, 'database') as DatabaseSync, 'close')
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('refresh aborted')), { once: true })
      })
    ))
    vi.stubGlobal('fetch', fetchMock)

    const refresh = service.refresh(subscriptionId)
    const rejected = expect(refresh).rejects.toThrow('Crossref 刷新已取消。')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await service.close()
    await rejected
    await service.close()

    expect(close).toHaveBeenCalledOnce()
  })

  it('backfills 30 days across both ISSNs, deduplicates across pages, and sends the LitRoot user agent', async () => {
    const { service } = await serviceAndPath()
    const startedAt = new Date().toISOString().slice(0, 19)
    const firstPage = [work(1, { ISSN: ['0034-4257', '2041-1723'] }), work(2, { ISSN: ['0034-4257'] }),
      ...Array.from({ length: 98 }, (_, index) => work(index + 3))]
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/journals/0034-4257') return journalResponse()
      expect(url.pathname).toBe('/works')
      const filters = url.searchParams.get('filter')!.split(',')
      expect(filters.filter((filter) => filter.startsWith('issn:'))).toEqual(['issn:2041-1723', 'issn:0034-4257'])
      if (url.searchParams.get('cursor') === '*') return worksResponse(firstPage, 'next cursor = value')
      return worksResponse([work(101, { ISSN: ['2041-1723'] }), work(1, { DOI: 'https://doi.org/10.1234/PAPER.1' })])
    })
    vi.stubGlobal('fetch', fetchMock)

    const requestId = randomUUID()
    const subscription = await service.add({ requestId, issn: '00344257' })
    expect(service.cancelAdd(requestId)).toBe(false)
    expect(subscription).toMatchObject({ issn: '0034-4257', issns: ['2041-1723', '0034-4257'], title: 'Journal of Useful Tests', unreadCount: 101 })
    expect(service.items({ limit: 200 }).items.map(({ doi }) => doi)).toEqual(expect.arrayContaining([
      '10.1234/paper.1', '10.1234/paper.2', '10.1234/paper.101'
    ]))
    await expect(service.add({ requestId: randomUUID(), issn: '2041-1723' })).rejects.toThrow('已经添加')
    const worksCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/works'))
    expect(worksCalls).toHaveLength(2)
    const firstUrl = new URL(String(worksCalls[0]?.[0]))
    const filter = firstUrl.searchParams.get('filter') ?? ''
    const until = /until-created-date:([^,]+)/.exec(filter)?.[1] ?? ''
    expect(until).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    expect(until >= startedAt).toBe(true)
    expect(filter).toContain(`from-created-date:${new Date(Date.parse(`${until}Z`) - 30 * DAY_MS).toISOString().slice(0, 19)},`)
    expect(filter).toContain('type:journal-article')
    expect(new URL(String(worksCalls[1]?.[0])).searchParams.get('cursor')).toBe('next cursor = value')
    expect(worksCalls[0]?.[1]?.headers).toMatchObject({
      accept: 'application/json',
      'user-agent': expect.stringContaining('LitRoot/1.0')
    })
    service.close()
  })

  it('deduplicates by DOI, updates metadata, and preserves read state across incremental refreshes', async () => {
    const { service } = await serviceAndPath()
    let worksCall = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/works')) return journalResponse({ ISSN: ['0034-4257'] })
      worksCall += 1
      return worksCall === 1
        ? worksResponse([work(1, { DOI: '10.1234/SAME', title: ['Old title'] })])
        : worksResponse([work(1, { DOI: '10.1234/same', title: ['New title'] })])
    })
    vi.stubGlobal('fetch', fetchMock)

    const subscription = await service.add({ requestId: randomUUID(), issn: '0034-4257' })
    const request = { subscriptionId: subscription.id, days: 7 as const, limit: 50, offset: 0 }
    const item = service.items(request).items[0]!
    service.markRead({ itemIds: [item.id], read: true })
    await service.refresh(subscription.id)

    const result = service.items(request)
    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({ doi: '10.1234/same', title: 'New title' })
    expect(result.items[0]?.readAt).not.toBeNull()
    const refreshUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]))
    const backfillUrl = new URL(String(fetchMock.mock.calls[1]?.[0]))
    const checkpoint = /until-created-date:([^,]+)/.exec(backfillUrl.searchParams.get('filter')!)?.[1]
    expect(refreshUrl.searchParams.get('filter')).toContain(`from-index-date:${checkpoint},`)
    service.close()
  })

  it('uses Crossref created time for ranges even when the publication date is in the future', async () => {
    const { service } = await serviceAndPath()
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (!String(input).includes('/works')) return journalResponse({
        title: 'Remote Sensing of Environment', ISSN: ['0034-4257']
      })
      return worksResponse([work(1, {
        created: { 'date-time': new Date(Date.now() - 2 * 86_400_000).toISOString() },
        published: { 'date-parts': [[2027, 1, 15]] }
      }), work(2, { published: { 'date-parts': [[2027, 1]] } }), work(3, { published: { 'date-parts': [[2027]] } }),
      work(4, { published: undefined })])
    }))

    const subscription = await service.add({ requestId: randomUUID(), issn: '0034-4257' })
    const { items } = service.items({ subscriptionId: subscription.id, days: 7, limit: 50, offset: 0 })
    const item = items.find(({ doi }) => doi === '10.1234/paper.1')
    expect(item?.publishedAt).toBe('2027-01-15')
    expect(item?.discoveredAt).not.toBe(item?.publishedAt)
    expect(items.map(({ publishedAt }) => publishedAt)).toEqual(expect.arrayContaining(['2027-01', '2027', null]))
    service.close()
  })

  it('applies each date range and shares the 90-day boundary with the unread counts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'))
    const { service, databasePath } = await serviceAndPath()
    const database = new DatabaseSync(databasePath)
    for (const [id, issn] of [['a', '0034-4257'], ['b', '2041-1723']] as const) {
      database.prepare(`INSERT INTO subscriptions (
        id, issn, issns_json, title, publisher
      ) VALUES (?, ?, ?, ?, '')`).run(`feed_${id.repeat(24)}`, issn, JSON.stringify([issn]), `Journal ${id}`)
    }
    const ages = [1, 3, 7, 14, 30, 31, 90, 91]
    ages.forEach((age, index) => {
      database.prepare(`INSERT INTO items (
        id, subscription_id, doi, title, authors_json, summary, url, published_at, discovered_at, read_at
      ) VALUES (?, ?, ?, ?, '[]', '', '', NULL, ?, ?)`).run(
        `feeditem_${String(index).padStart(24, '0')}`,
        index === 0 ? `feed_${'b'.repeat(24)}` : `feed_${'a'.repeat(24)}`,
        `10.1234/boundary.${index}`,
        `Boundary ${age}`,
        new Date(Date.now() - age * 86_400_000).toISOString(),
        index < 6 && index % 2 === 0 ? new Date().toISOString() : null
      )
    })
    database.close()

    const counts = [1, 3, 7, 14, 30].map((days) => service.items({
      subscriptionId: null, days: days as 1 | 3 | 7 | 14 | 30, limit: 50, offset: 0
    }).total)
    expect(counts).toEqual([1, 2, 3, 4, 5])
    const retained = service.items({ days: 90 })
    expect(retained.total).toBe(7)
    expect(retained.items.filter((item) => !item.readAt).map((item) => item.title))
      .toEqual(['Boundary 3', 'Boundary 14', 'Boundary 31', 'Boundary 90'])
    expect(service.list().map(({ unreadCount }) => unreadCount)).toEqual([4, 0])
    const overview = service.items({ subscriptionId: null, days: 7, limit: 50, offset: 0 })
    expect(overview.items.some((item) => item.readAt)).toBe(true)
    expect(overview.items.some((item) => !item.readAt)).toBe(true)
    expect(service.items({ subscriptionId: `feed_${'b'.repeat(24)}`, days: 7, limit: 50, offset: 0 }).total).toBe(1)
    service.close()
  })

  it('paginates up to 200 items with stable offsets and totals', async () => {
    const { service, databasePath } = await serviceAndPath()
    const database = new DatabaseSync(databasePath)
    const subscriptionId = `feed_${'a'.repeat(24)}`
    database.prepare(`INSERT INTO subscriptions (
      id, issn, issns_json, title, publisher
    ) VALUES (?, '0034-4257', '["0034-4257"]', 'Journal', '')`).run(subscriptionId)
    const insert = database.prepare(`INSERT INTO items (
      id, subscription_id, doi, title, authors_json, summary, url, published_at, discovered_at, read_at
    ) VALUES (?, ?, ?, ?, '[]', '', '', NULL, ?, NULL)`)
    const discoveredAt = new Date().toISOString()
    for (let index = 0; index < 205; index += 1) {
      insert.run(`feeditem_${String(index).padStart(24, '0')}`, subscriptionId,
        `10.1234/${String(index).padStart(3, '0')}`, `Paper ${index}`, discoveredAt)
    }
    database.close()

    for (const limit of [20, 50, 100, 200]) {
      const first = service.items(feedItemsRequestSchema.parse({ subscriptionId, limit }))
      const next = service.items(feedItemsRequestSchema.parse({ subscriptionId, limit, offset: limit }))
      expect(first.total).toBe(205)
      expect(first.items).toHaveLength(limit)
      expect(first.items[0]?.title).toBe('Paper 0')
      expect(next.total).toBe(205)
      expect(next.items).toHaveLength(Math.min(limit, 205 - limit))
      expect(next.items[0]?.title).toBe(`Paper ${limit}`)
    }
    expect(service.items(feedItemsRequestSchema.parse({ limit: 200, offset: 205 })))
      .toEqual({ items: [], total: 205 })
    service.close()
  })

  it('clears legacy RSS data while migrating to v4 and removes the mapping table', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'litroot-feeds-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'feeds.sqlite3')
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        etag TEXT NOT NULL DEFAULT '', last_modified TEXT NOT NULL DEFAULT '',
        last_checked_at TEXT, last_successful_at TEXT, error TEXT
      );
      CREATE TABLE items (
        id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL,
        stable_key TEXT NOT NULL, title TEXT NOT NULL, authors_json TEXT NOT NULL,
        summary TEXT NOT NULL, doi TEXT NOT NULL, url TEXT NOT NULL,
        published_at TEXT, discovered_at TEXT NOT NULL, read_at TEXT
      );
      CREATE TABLE journal_feed_mappings (issn_l TEXT PRIMARY KEY, feed_url TEXT NOT NULL);
      INSERT INTO subscriptions (id, url, title) VALUES ('feed_aaaaaaaaaaaaaaaaaaaaaaaa', 'https://example.org/rss', 'Legacy');
      INSERT INTO items VALUES (
        'feeditem_bbbbbbbbbbbbbbbbbbbbbbbb', 'feed_aaaaaaaaaaaaaaaaaaaaaaaa', 'key', 'Old', '[]', '',
        '10.1234/old', '', NULL, '2026-08-31T00:00:00.000Z', '2026-08-31T01:00:00.000Z'
      );
      PRAGMA user_version = 2;
    `)
    legacy.close()

    const service = new FeedService(databasePath, vi.fn())
    expect(service.list()).toEqual([])
    const migrated = new DatabaseSync(databasePath)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4)
    expect(migrated.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_feed_mappings'`).get()).toBeUndefined()
    expect((migrated.prepare('PRAGMA table_info(subscriptions)').all() as Array<{ name: string }>).map((column) => column.name))
      .toContain('issn')
    expect((migrated.prepare('PRAGMA table_info(subscriptions)').all() as Array<{ name: string }>).map((column) => column.name))
      .not.toContain('url')
    migrated.close()
    service.close()
  })

  it('upgrades v3 in place and restarts an interrupted 90-day backfill on the next hourly check', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T12:34:56.123Z'))
    const from = new Date(Date.now() - 90 * DAY_MS).toISOString().slice(0, 19)
    const directory = await mkdtemp(join(tmpdir(), 'litroot-feeds-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'feeds.sqlite3')
    const legacy = new DatabaseSync(databasePath)
    const subscriptionId = 'feed_aaaaaaaaaaaaaaaaaaaaaaaa'
    const oldItemId = 'feeditem_bbbbbbbbbbbbbbbbbbbbbbbb'
    const readAt = '2026-11-10T12:00:00.000Z'
    legacy.exec(`
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY, issn TEXT NOT NULL UNIQUE, issns_json TEXT NOT NULL,
        title TEXT NOT NULL, publisher TEXT NOT NULL DEFAULT '',
        last_checked_at TEXT, last_successful_at TEXT, error TEXT
      );
      CREATE TABLE items (
        id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        doi TEXT NOT NULL, title TEXT NOT NULL, authors_json TEXT NOT NULL, summary TEXT NOT NULL,
        url TEXT NOT NULL, published_at TEXT, discovered_at TEXT NOT NULL, read_at TEXT,
        UNIQUE(subscription_id, doi)
      );
      PRAGMA user_version = 3;
    `)
    legacy.prepare(`INSERT INTO subscriptions VALUES (?, '0034-4257', '["0034-4257","2041-1723"]',
      'My saved name', '', ?, ?, NULL)`).run(subscriptionId, new Date().toISOString(), new Date().toISOString())
    const insertItem = legacy.prepare(`INSERT INTO items VALUES (?, ?, ?, 'Old title', '[]', '', '', ?, ?, ?)`)
    insertItem.run(oldItemId, subscriptionId, '10.1234/paper.1', '2026-01-01T00:00:00.000Z', readAt, readAt)
    insertItem.run('feeditem_cccccccccccccccccccccccc', subscriptionId, '10.1234/paper.2', '2026-08-01T00:00:00.000Z', readAt, null)
    legacy.close()

    const service = new FeedService(databasePath, vi.fn())
    const query = { days: 90 as const, subscriptionId }
    expect(service.items(query).items.map(({ publishedAt }) => publishedAt)).toEqual(['2026', '2026-08'])
    const fetchMock = vi.fn(async (input: URL) => {
      expect(input.pathname).toBe('/works')
      expect(input.searchParams.get('filter')).toContain(`issn:0034-4257,issn:2041-1723,from-created-date:${from},`)
      if (input.searchParams.get('cursor') !== '*') return new Response('{}', { status: 503 })
      if (fetchMock.mock.calls.length === 1) {
        return worksResponse(Array.from({ length: 100 }, (_, index) => work(index + 10)), 'fail-next-page')
      }
      return worksResponse([
        work(1, { published: { 'date-parts': [[2026, 1, 1]] } }),
        work(3, { created: { 'date-time': new Date(Date.now() - 89 * DAY_MS).toISOString() } })
      ])
    })
    vi.stubGlobal('fetch', fetchMock)
    service.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(service.list()[0]?.error).toContain('503')
    expect(service.items(query).total).toBe(2)
    const migrated = new DatabaseSync(databasePath)
    expect(migrated.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 4 })
    const checkpoint = migrated.prepare('SELECT index_checkpoint_at FROM subscriptions WHERE id = ?')
    expect(checkpoint.get(subscriptionId)).toMatchObject({ index_checkpoint_at: null })

    await vi.advanceTimersByTimeAsync(3_600_000 - 1_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(service.list()[0]).toMatchObject({ id: subscriptionId, title: 'My saved name', unreadCount: 2, error: null })
    expect(service.items(query).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: oldItemId, title: 'Paper 1', readAt, publishedAt: '2026-01-01' }),
      expect.objectContaining({ doi: '10.1234/paper.3' })
    ]))
    expect(checkpoint.get(subscriptionId)).toMatchObject({ index_checkpoint_at: '2026-11-20T13:34:56.000Z' })
    migrated.close()
    await service.close()
  })

  it('uses the inclusive index checkpoint to find an earlier deposit indexed after UTC midnight', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T23:59:59.100Z'))
    const { service } = await serviceAndPath()
    const indexedAt = '2026-11-21T00:00:00'
    const createdAt = '2026-11-20T23:58:00.000Z'
    const fetchMock = vi.fn(async (input: URL) => {
      if (input.pathname.startsWith('/journals/')) return journalResponse()
      if (Date.now() < Date.parse(`${indexedAt}Z`)) return worksResponse([])
      const filter = input.searchParams.get('filter') ?? ''
      const from = /from-index-date:([^,]+)/.exec(filter)?.[1] ?? ''
      const until = /until-index-date:([^,]+)/.exec(filter)?.[1] ?? ''
      return worksResponse(from && from <= indexedAt && indexedAt <= until
        ? [work(1, { created: { 'date-time': createdAt } })] : [])
    })
    vi.stubGlobal('fetch', fetchMock)
    const adding = service.add({ requestId: randomUUID(), issn: '0034-4257' })
    await vi.advanceTimersByTimeAsync(350)
    const subscription = await adding
    expect(service.items({}).total).toBe(0)
    vi.setSystemTime(new Date('2026-11-21T00:00:00.400Z'))
    const refreshing = service.refresh(subscription.id)
    await vi.advanceTimersByTimeAsync(350)
    await refreshing
    expect(fetchMock.mock.lastCall?.[0].searchParams.get('filter')).toContain(
      'from-index-date:2026-11-20T23:59:59,until-index-date:2026-11-21T00:00:00,'
    )
    expect(service.items({}).items[0]).toMatchObject({ discoveredAt: createdAt })
    await service.close()
  })

  it.each([
    ['2', 2_750],
    ['Fri, 20 Nov 2026 12:00:03 GMT', 3_000],
    [null, 1_750]
  ])('limits four due journals and honors Retry-After %s before starting the next request', async (retryAfter, resumesAt) => {
    vi.useFakeTimers()
    const start = Date.parse('2026-11-20T12:00:00.000Z')
    vi.setSystemTime(start)
    const checkpoint = '2026-11-19T11:00:00.000Z'
    const { service, databasePath } = await serviceAndPath()
    const database = new DatabaseSync(databasePath)
    const insert = database.prepare(`INSERT INTO subscriptions (id, issn, issns_json, title, last_checked_at,
      last_successful_at, index_checkpoint_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    const journalIssns = ['0034-4257', '2041-1723', '1879-0704', '1095-9203']
    for (const [index, issn] of journalIssns.entries()) {
      insert.run(`feed_${String(index).repeat(24)}`, issn, JSON.stringify([issn]), issn, checkpoint, checkpoint, checkpoint)
    }

    const launches: Array<{ at: number; filter: string }> = []
    let inFlight = 0
    let peak = 0
    vi.stubGlobal('fetch', vi.fn(async (input: URL) => {
      launches.push({ at: Date.now() - start, filter: input.searchParams.get('filter') ?? '' })
      inFlight += 1
      peak = Math.max(peak, inFlight)
      const first = launches.length === 1
      await new Promise((resolve) => setTimeout(resolve, first ? 750 : 2_000))
      inFlight -= 1
      return first
        ? new Response('{}', { status: 429, ...(retryAfter === null ? {} : { headers: { 'Retry-After': retryAfter } }) })
        : worksResponse([])
    }))
    service.start()
    await vi.advanceTimersByTimeAsync(resumesAt - 1)
    expect(launches.map(({ at }) => at)).toEqual([0, 350, 700])
    expect(peak).toBe(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(launches[3]?.at).toBe(resumesAt)
    expect(service.list().find(({ issn }) => issn === journalIssns[0])?.error).toContain('429')
    expect(database.prepare('SELECT index_checkpoint_at FROM subscriptions WHERE issn = ?').get(journalIssns[0]!))
      .toMatchObject({ index_checkpoint_at: checkpoint })

    await vi.advanceTimersByTimeAsync(3_600_000 - resumesAt)
    expect(launches).toHaveLength(5)
    expect(launches[4]).toMatchObject({ at: 3_600_000, filter: expect.stringContaining(
      'issn:0034-4257,from-index-date:2026-11-19T11:00:00,until-index-date:2026-11-20T13:00:00'
    ) })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(service.list().every(({ error }) => error === null)).toBe(true)
    database.close()
    await service.close()
  })

  it.each(['queued', 'in flight'])('cancels a %s backfill without committing a subscription or a partial page', async (state) => {
    vi.useFakeTimers()
    const { service, databasePath } = await serviceAndPath()
    let backfillSignal: AbortSignal | undefined
    const fetchMock = vi.fn(async (input: URL, init: RequestInit) => {
      if (input.pathname.startsWith('/journals/')) return journalResponse()
      if (input.searchParams.get('cursor') === '*') {
        return worksResponse(Array.from({ length: 100 }, (_, index) => work(index + 1)), 'next-page')
      }
      backfillSignal = init.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        backfillSignal?.addEventListener('abort', () => reject(backfillSignal?.reason), { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const requestId = randomUUID()
    const result = service.add({ requestId, issn: '0034-4257' })
    const rejected = expect(result).rejects.toThrow('添加期刊已取消。')
    await vi.advanceTimersByTimeAsync(state === 'queued' ? 0 : 700)
    const expectedCalls = state === 'queued' ? 1 : 3
    expect(fetchMock).toHaveBeenCalledTimes(expectedCalls)
    expect(service.list()).toEqual([])
    expect(service.cancelAdd(requestId)).toBe(true)
    await rejected
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).toHaveBeenCalledTimes(expectedCalls)
    if (state === 'in flight') expect(backfillSignal?.aborted).toBe(true)
    const database = new DatabaseSync(databasePath)
    expect(database.prepare('SELECT count(*) total FROM subscriptions').get()).toMatchObject({ total: 0 })
    expect(database.prepare('SELECT count(*) total FROM items').get()).toMatchObject({ total: 0 })
    database.close()
    await service.close()
  })

  it('cascades temporary items when a journal is removed', async () => {
    const { service, databasePath } = await serviceAndPath()
    const changed = vi.fn()
    Reflect.set(service, 'onChanged', changed)
    const database = new DatabaseSync(databasePath)
    database.prepare(`INSERT INTO subscriptions (
      id, issn, issns_json, title, publisher
    ) VALUES (?, ?, ?, ?, '')`).run('feed_aaaaaaaaaaaaaaaaaaaaaaaa', '0034-4257', '["0034-4257"]', 'Journal')
    database.prepare(`INSERT INTO items (
      id, subscription_id, doi, title, authors_json, summary, url, discovered_at
    ) VALUES (?, ?, ?, ?, '[]', '', '', ?)`).run(
      'feeditem_bbbbbbbbbbbbbbbbbbbbbbbb', 'feed_aaaaaaaaaaaaaaaaaaaaaaaa', '10.1234/remove', 'Paper', new Date().toISOString()
    )
    database.close()
    service.remove('feed_aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(service.items({ subscriptionId: null, days: 7, limit: 50, offset: 0 }).total).toBe(0)
    expect(changed).toHaveBeenCalledOnce()
    service.close()
  })

  it('preserves existing items on refresh failure and enforces response size and timeout limits', async () => {
    vi.useFakeTimers()
    const { service, databasePath } = await serviceAndPath()
    const database = new DatabaseSync(databasePath)
    database.prepare(`INSERT INTO subscriptions (
      id, issn, issns_json, title, publisher
    ) VALUES (?, ?, ?, ?, '')`).run('feed_aaaaaaaaaaaaaaaaaaaaaaaa', '0034-4257', '["0034-4257"]', 'Journal')
    database.prepare(`INSERT INTO items (
      id, subscription_id, doi, title, authors_json, summary, url, discovered_at
    ) VALUES (?, ?, ?, ?, '[]', '', '', ?)`).run(
      'feeditem_bbbbbbbbbbbbbbbbbbbbbbbb', 'feed_aaaaaaaaaaaaaaaaaaaaaaaa', '10.1234/keep', 'Keep', new Date().toISOString()
    )
    database.close()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    await expect(service.refresh('feed_aaaaaaaaaaaaaaaaaaaaaaaa')).rejects.toThrow(/HTTP 503/)
    expect(service.items({ subscriptionId: null, days: 7, limit: 50, offset: 0 }).total).toBe(1)
    expect(service.list()[0]?.error).toMatch(/HTTP 503/)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1))))
    const oversized = expect(service.searchJournals({ query: 'journal' })).rejects.toThrow(/5 MiB/)
    await vi.advanceTimersByTimeAsync(350)
    await oversized

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })))
    const pending = service.searchJournals({ query: 'journal' })
    const rejected = expect(pending).rejects.toThrow(/15 秒/)
    await vi.advanceTimersByTimeAsync(15_500)
    await rejected
    service.close()
  })
})
