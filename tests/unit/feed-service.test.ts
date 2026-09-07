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
    for (const days of [1, 3, 7, 14, 30]) expect(feedItemsRequestSchema.parse({ days }).days).toBe(days)
    expect(() => feedItemsRequestSchema.parse({ days: 2 })).toThrow()
    expect(() => feedItemsRequestSchema.parse({ subscriptionId: 'feed_bad' })).toThrow()
    expect(() => markFeedReadRequestSchema.parse({ itemIds: ['feeditem_bad'], read: true })).toThrow()
    expect(() => markFeedReadRequestSchema.parse({ read: true })).toThrow()
    expect(() => journalSearchRequestSchema.parse({ query: ' ' })).toThrow()
    expect(() => addFeedRequestSchema.parse({ issn: 'not-an-issn' })).toThrow()
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

  it('backfills 30 days, paginates with cursors, and sends the LitRoot user agent', async () => {
    const { service } = await serviceAndPath()
    const firstPage = Array.from({ length: 100 }, (_, index) => work(index + 1))
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/journals/0034-4257') return journalResponse({ ISSN: ['0034-4257'] })
      if (url.searchParams.get('cursor') === '*') return worksResponse(firstPage, 'next cursor = value')
      return worksResponse([work(101)])
    })
    vi.stubGlobal('fetch', fetchMock)

    const subscription = await service.add({ issn: '00344257' })
    expect(subscription).toMatchObject({ issn: '0034-4257', title: 'Journal of Useful Tests', unreadCount: 101 })
    const worksCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/works'))
    expect(worksCalls).toHaveLength(2)
    const firstUrl = new URL(String(worksCalls[0]?.[0]))
    const filter = firstUrl.searchParams.get('filter') ?? ''
    expect(filter).toContain(`from-created-date:${new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)}`)
    expect(filter).toContain('until-created-date:')
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

    const subscription = await service.add({ issn: '0034-4257' })
    const request = { subscriptionId: subscription.id, days: 7 as const, limit: 50, offset: 0 }
    const item = service.items(request).items[0]!
    service.markRead({ itemIds: [item.id], read: true })
    await service.refresh(subscription.id)

    const result = service.items(request)
    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({ doi: '10.1234/same', title: 'New title' })
    expect(result.items[0]?.readAt).not.toBeNull()
    const refreshUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]))
    expect(refreshUrl.searchParams.get('filter')).toContain(`from-created-date:${new Date().toISOString().slice(0, 10)}`)
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
      })])
    }))

    const subscription = await service.add({ issn: '0034-4257' })
    const item = service.items({ subscriptionId: subscription.id, days: 7, limit: 50, offset: 0 }).items[0]
    expect(item?.publishedAt).toBe('2027-01-15T00:00:00.000Z')
    expect(item?.discoveredAt).not.toBe(item?.publishedAt)
    service.close()
  })

  it('applies 1/3/7/14/30-day boundaries to all read and unread items and supports journal filtering', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'))
    const { service, databasePath } = await serviceAndPath()
    const database = new DatabaseSync(databasePath)
    for (const [id, issn] of [['a', '0034-4257'], ['b', '2041-1723']] as const) {
      database.prepare(`INSERT INTO subscriptions (
        id, issn, issns_json, title, publisher
      ) VALUES (?, ?, ?, ?, '')`).run(`feed_${id.repeat(24)}`, issn, JSON.stringify([issn]), `Journal ${id}`)
    }
    const ages = [1, 3, 7, 14, 30, 31]
    ages.forEach((age, index) => {
      database.prepare(`INSERT INTO items (
        id, subscription_id, doi, title, authors_json, summary, url, published_at, discovered_at, read_at
      ) VALUES (?, ?, ?, ?, '[]', '', '', NULL, ?, ?)`).run(
        `feeditem_${String(index).padStart(24, '0')}`,
        index === 0 ? `feed_${'b'.repeat(24)}` : `feed_${'a'.repeat(24)}`,
        `10.1234/boundary.${index}`,
        `Boundary ${age}`,
        new Date(Date.now() - age * 86_400_000).toISOString(),
        index % 2 === 0 ? new Date().toISOString() : null
      )
    })
    database.close()

    const counts = [1, 3, 7, 14, 30].map((days) => service.items({
      subscriptionId: null, days: days as 1 | 3 | 7 | 14 | 30, limit: 50, offset: 0
    }).total)
    expect(counts).toEqual([1, 2, 3, 4, 5])
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

  it('clears legacy RSS data while migrating to v3 and removes the mapping table', async () => {
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
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
    expect(migrated.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_feed_mappings'`).get()).toBeUndefined()
    expect((migrated.prepare('PRAGMA table_info(subscriptions)').all() as Array<{ name: string }>).map((column) => column.name))
      .toContain('issn')
    expect((migrated.prepare('PRAGMA table_info(subscriptions)').all() as Array<{ name: string }>).map((column) => column.name))
      .not.toContain('url')
    migrated.close()
    service.close()
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
    await expect(service.searchJournals({ query: 'journal' })).rejects.toThrow(/5 MiB/)

    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })))
    const pending = service.searchJournals({ query: 'journal' })
    const rejected = expect(pending).rejects.toThrow(/15 秒/)
    await vi.advanceTimersByTimeAsync(15_001)
    await rejected
    service.close()
  })
})
