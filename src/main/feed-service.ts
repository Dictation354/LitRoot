import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type {
  AddFeedRequest,
  FeedItem,
  FeedItemsRequest,
  FeedItemsResult,
  FeedSubscription,
  JournalCandidate,
  JournalSearchRequest,
  JournalSearchResult,
  MarkFeedReadRequest
} from '../shared/contracts.js'

const CROSSREF_ORIGIN = 'https://api.crossref.org'
const CROSSREF_CONTACT = 'clancycthern@proton.me'
const CROSSREF_USER_AGENT = `LitRoot/1.0 (https://github.com/Dictation354/LitRoot; mailto:${CROSSREF_CONTACT})`
const MAX_BODY_BYTES = 5 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000
const TIMER_INTERVAL_MS = 60 * 60 * 1000
const WORK_PAGE_SIZE = 100
const DATABASE_VERSION = 3

const crossrefIssnSchema = z.string().regex(/^\d{4}-\d{3}[\dX]$/i)
  .transform((value) => value.toUpperCase())
const crossrefJournalSchema = z.object({
  title: z.string().trim().min(1).max(1_000),
  publisher: z.string().max(1_000).optional(),
  ISSN: z.array(crossrefIssnSchema).min(1).max(100)
}).passthrough()
const crossrefJournalSearchSchema = crossrefJournalSchema.extend({
  ISSN: z.array(crossrefIssnSchema).max(100)
})
const crossrefJournalResultSchema = z.object({
  status: z.literal('ok'),
  message: crossrefJournalSchema
})
const crossrefJournalListSchema = z.object({
  status: z.literal('ok'),
  message: z.object({ items: z.array(crossrefJournalSearchSchema).max(100) }).passthrough()
})
const crossrefDatePartsSchema = z.object({
  'date-parts': z.array(z.array(z.number().int()).min(1).max(3)).min(1).max(10)
})
const crossrefWorkSchema = z.object({
  DOI: z.string().trim().min(1).max(2_000),
  type: z.literal('journal-article'),
  title: z.array(z.string().max(20_000)).max(20).optional(),
  author: z.array(z.object({
    given: z.string().max(1_000).optional(),
    family: z.string().max(1_000).optional(),
    name: z.string().max(2_000).optional()
  }).passthrough()).max(1_000).optional(),
  abstract: z.string().max(1_000_000).optional(),
  URL: z.string().max(8_000).optional(),
  created: z.object({ 'date-time': z.string().max(100) }).passthrough(),
  published: crossrefDatePartsSchema.optional(),
  'published-print': crossrefDatePartsSchema.optional(),
  'published-online': crossrefDatePartsSchema.optional(),
  issued: crossrefDatePartsSchema.optional()
}).passthrough()
const crossrefWorksResultSchema = z.object({
  status: z.literal('ok'),
  message: z.object({
    items: z.array(crossrefWorkSchema).max(WORK_PAGE_SIZE),
    'next-cursor': z.string().max(20_000).optional()
  }).passthrough()
})

type Row = Record<string, unknown>
type CrossrefJournal = z.infer<typeof crossrefJournalSchema>
type CrossrefWork = z.infer<typeof crossrefWorkSchema>

interface ParsedWork {
  doi: string
  title: string
  authors: string[]
  summary: string
  url: string
  publishedAt: string | null
  discoveredAt: string
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number {
  return Number(value ?? 0)
}

function now(): string {
  return new Date().toISOString()
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeIssn(value: string): string | null {
  const compact = value.trim().replace('-', '').toUpperCase()
  if (!/^\d{7}[\dX]$/.test(compact)) return null
  const sum = compact.slice(0, 7).split('').reduce(
    (total, digit, index) => total + Number(digit) * (8 - index),
    0
  )
  const check = (11 - (sum % 11)) % 11
  const expected = check === 10 ? 'X' : String(check)
  if (compact[7] !== expected) return null
  return `${compact.slice(0, 4)}-${compact.slice(4)}`
}

function normalizeDoi(value: string): string {
  return value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase()
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|nbsp|#(\d+)|#x([\da-f]+));/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) return String.fromCodePoint(Number(decimal))
      if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16))
      return ({
        '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' '
      } as Record<string, string>)[entity.toLowerCase()] ?? entity
    })
}

export function crossrefAbstractText(value: string, limit = 20_000): string {
  return decodeEntities(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function isoDate(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error('Crossref 返回了无效的登记时间。')
  return new Date(timestamp).toISOString()
}

function publicationDate(work: CrossrefWork): string | null {
  const date = work['published-print'] ?? work['published-online'] ?? work.published ?? work.issued
  const parts = date?.['date-parts'][0]
  if (!parts) return null
  const year = parts[0]
  const month = parts[1] ?? 1
  const day = parts[2] ?? 1
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null
  const timestamp = Date.UTC(year, month - 1, day)
  const result = new Date(timestamp)
  if (result.getUTCFullYear() !== year || result.getUTCMonth() !== month - 1 || result.getUTCDate() !== day) return null
  return result.toISOString()
}

function parseWork(work: CrossrefWork): ParsedWork {
  const doi = normalizeDoi(work.DOI)
  if (!doi) throw new Error('Crossref 返回了缺少 DOI 的文献。')
  const authors = (work.author ?? []).map((author) => {
    if (author.name?.trim()) return author.name.trim()
    return [author.given?.trim(), author.family?.trim()].filter(Boolean).join(' ')
  }).filter(Boolean).slice(0, 50)
  return {
    doi,
    title: crossrefAbstractText(work.title?.[0] ?? doi, 1_000) || doi,
    authors: [...new Set(authors)],
    summary: crossrefAbstractText(work.abstract ?? ''),
    url: `https://doi.org/${doi}`,
    publishedAt: publicationDate(work),
    discoveredAt: isoDate(work.created['date-time'])
  }
}

function dateOnly(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function candidate(journal: CrossrefJournal, preferredIssn?: string): JournalCandidate {
  const issns = [...new Set(journal.ISSN)]
  return {
    displayName: journal.title,
    publisher: journal.publisher?.trim() || null,
    issn: preferredIssn && issns.includes(preferredIssn) ? preferredIssn : issns[0]!,
    issns
  }
}

async function readJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_BODY_BYTES) {
    await response.body?.cancel()
    throw new Error('Crossref 响应超过 5 MiB 限制。')
  }
  if (!response.body) throw new Error('Crossref 响应没有内容。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ''
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new Error('Crossref 响应超过 5 MiB 限制。')
    }
    body += decoder.decode(value, { stream: true })
  }
  body += decoder.decode()
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new Error('Crossref 返回了无法识别的数据。')
  }
}

async function requestCrossref(path: string, parentSignal?: AbortSignal, notFoundIsNull = false): Promise<unknown | null> {
  const url = new URL(path, CROSSREF_ORIGIN)
  if (url.origin !== CROSSREF_ORIGIN) throw new Error('Crossref 请求地址无效。')
  url.searchParams.set('mailto', CROSSREF_CONTACT)
  const abort = new AbortController()
  const forwardAbort = (): void => abort.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', forwardAbort, { once: true })
  const timeout = setTimeout(() => abort.abort(new Error('Crossref 请求超过 15 秒。')), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: abort.signal,
      headers: { accept: 'application/json', 'user-agent': CROSSREF_USER_AGENT }
    })
    if (response.status === 404 && notFoundIsNull) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 429) throw new Error('Crossref 请求受限（HTTP 429），请稍后重试。')
      throw new Error(`Crossref 请求失败（HTTP ${response.status}）。`)
    }
    return await readJson(response)
  } catch (error) {
    if (abort.signal.aborted) {
      if (parentSignal?.aborted) throw new Error('Crossref 刷新已取消。')
      throw new Error('Crossref 请求超过 15 秒。')
    }
    if (error instanceof Error && error.message.startsWith('Crossref ')) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Crossref 暂时不可用：${message}`)
  } finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener('abort', forwardAbort)
  }
}

async function fetchJournal(issn: string, signal?: AbortSignal): Promise<JournalCandidate | null> {
  const value = await requestCrossref(`/journals/${encodeURIComponent(issn)}`, signal, true)
  if (value === null) return null
  try {
    return candidate(crossrefJournalResultSchema.parse(value).message, issn)
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error('Crossref 返回了无法识别的数据。')
    throw error
  }
}

export class FeedService {
  private readonly database: DatabaseSync
  private readonly active = new Map<string, AbortController>()
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false
  private databaseClosed = false
  private readonly closeWaiters = new Set<() => void>()

  constructor(databasePath: string, private readonly onChanged: () => void) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new DatabaseSync(databasePath)
    const version = numberValue((this.database.prepare('PRAGMA user_version').get() as Row).user_version)
    if (version < 0 || version > DATABASE_VERSION) {
      throw new Error(`期刊雷达数据库版本 ${version} 高于当前支持的版本。`)
    }
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    if (version < DATABASE_VERSION) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS journal_feed_mappings;
        DROP TABLE IF EXISTS items;
        DROP TABLE IF EXISTS subscriptions;
        CREATE TABLE subscriptions (
          id TEXT PRIMARY KEY, issn TEXT NOT NULL UNIQUE, issns_json TEXT NOT NULL,
          title TEXT NOT NULL, publisher TEXT NOT NULL DEFAULT '',
          last_checked_at TEXT, last_successful_at TEXT, error TEXT
        );
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
          doi TEXT NOT NULL, title TEXT NOT NULL, authors_json TEXT NOT NULL,
          summary TEXT NOT NULL, url TEXT NOT NULL, published_at TEXT,
          discovered_at TEXT NOT NULL, read_at TEXT,
          UNIQUE(subscription_id, doi)
        );
        CREATE INDEX idx_feed_items_order ON items(discovered_at DESC);
        CREATE INDEX idx_feed_items_unread ON items(subscription_id, read_at);
        PRAGMA user_version = ${DATABASE_VERSION};
        COMMIT;
      `)
    }
    this.cleanup()
  }

  start(): void {
    void this.refreshDue()
    this.timer = setInterval(() => { void this.refreshDue() }, TIMER_INTERVAL_MS)
  }

  list(): FeedSubscription[] {
    return (this.database.prepare(`
      SELECT s.*, count(CASE WHEN i.id IS NOT NULL AND i.read_at IS NULL THEN 1 END) unread_count
      FROM subscriptions s LEFT JOIN items i ON i.subscription_id = s.id
      GROUP BY s.id ORDER BY lower(s.title), s.id
    `).all() as Row[]).map((row) => this.subscription(row))
  }

  async searchJournals(request: JournalSearchRequest): Promise<JournalSearchResult> {
    const query = request.query.trim()
    const exactIssn = normalizeIssn(query)
    try {
      const journals = exactIssn
        ? await fetchJournal(exactIssn).then((value) => value ? [value] : [])
        : await this.searchJournalNames(query)
      const subscribed = this.subscribedIssns()
      const seenIssns = new Set<string>()
      return {
        candidates: journals.filter((item) => {
          if (item.issns.some((issn) => subscribed.has(issn))) return false
          if (item.issns.some((issn) => seenIssns.has(issn))) return false
          for (const issn of item.issns) seenIssns.add(issn)
          return true
        }).slice(0, 10)
      }
    } catch (error) {
      if (error instanceof z.ZodError) throw new Error('Crossref 返回了无法识别的数据。')
      throw error
    }
  }

  async add(request: AddFeedRequest): Promise<FeedSubscription> {
    const issn = normalizeIssn(request.issn)
    if (!issn) throw new Error('请输入有效的 ISSN。')
    const journal = await fetchJournal(issn)
    if (!journal) throw new Error('Crossref 中没有找到该期刊。')
    const subscribed = this.subscribedIssns()
    if (journal.issns.some((value) => subscribed.has(value))) throw new Error('该期刊已经添加。')
    const id = `feed_${hash(journal.issn).slice(0, 24)}`
    this.database.prepare(`
      INSERT INTO subscriptions (id, issn, issns_json, title, publisher) VALUES (?, ?, ?, ?, ?)
    `).run(id, journal.issn, JSON.stringify(journal.issns), request.title?.trim() || journal.displayName, journal.publisher ?? '')
    try {
      await this.refresh(id, 30)
      return this.getSubscription(id)
    } catch (error) {
      this.database.prepare('DELETE FROM subscriptions WHERE id = ?').run(id)
      throw error
    }
  }

  remove(subscriptionId: string): void {
    this.active.get(subscriptionId)?.abort()
    this.database.prepare('DELETE FROM subscriptions WHERE id = ?').run(subscriptionId)
    this.emitChanged()
  }

  async refresh(subscriptionId: string, initialDays?: 30): Promise<FeedSubscription> {
    if (this.active.has(subscriptionId)) return this.getSubscription(subscriptionId)
    const row = this.database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId) as Row | undefined
    if (!row) throw new Error('期刊不存在。')
    const abort = new AbortController()
    this.active.set(subscriptionId, abort)
    try {
      const startTimestamp = initialDays
        ? Date.now() - initialDays * 24 * 60 * 60 * 1000
        : Date.parse(stringValue(row.last_successful_at)) || Date.now() - 30 * 24 * 60 * 60 * 1000
      const works = await this.fetchWorks(stringValue(row.issn), dateOnly(startTimestamp), dateOnly(Date.now()), abort.signal)
      const checkedAt = now()
      this.database.exec('BEGIN IMMEDIATE')
      try {
        for (const work of works) this.upsertItem(subscriptionId, work)
        this.database.prepare(`
          UPDATE subscriptions SET last_checked_at = ?, last_successful_at = ?, error = NULL WHERE id = ?
        `).run(checkedAt, checkedAt, subscriptionId)
        this.cleanup()
        this.database.exec('COMMIT')
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
      this.emitChanged()
      return this.getSubscription(subscriptionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.database.prepare('UPDATE subscriptions SET last_checked_at = ?, error = ? WHERE id = ?')
        .run(now(), message.slice(0, 1_000), subscriptionId)
      this.emitChanged()
      throw new Error(message)
    } finally {
      this.active.delete(subscriptionId)
      this.finishCloseIfIdle()
    }
  }

  items(request: FeedItemsRequest): FeedItemsResult {
    const clauses = ['i.discovered_at >= ?']
    const days = request.days ?? 7
    const values: Array<string | number> = [new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()]
    if (request.subscriptionId) {
      clauses.push('i.subscription_id = ?')
      values.push(request.subscriptionId)
    }
    const where = `WHERE ${clauses.join(' AND ')}`
    const total = numberValue((this.database.prepare(`SELECT count(*) total FROM items i ${where}`).get(...values) as Row).total)
    const rows = this.database.prepare(`
      SELECT i.*, s.title source_title FROM items i JOIN subscriptions s ON s.id = i.subscription_id
      ${where} ORDER BY i.discovered_at DESC, i.doi LIMIT ? OFFSET ?
    `).all(...values, request.limit ?? 50, request.offset ?? 0) as Row[]
    return { items: rows.map((row) => this.item(row)), total }
  }

  markRead(request: MarkFeedReadRequest): void {
    const value = request.read ? now() : null
    if (request.itemIds?.length) {
      const placeholders = request.itemIds.map(() => '?').join(', ')
      this.database.prepare(`UPDATE items SET read_at = ? WHERE id IN (${placeholders})`).run(value, ...request.itemIds)
    } else if (request.allUnread) {
      if (request.subscriptionId) {
        this.database.prepare('UPDATE items SET read_at = ? WHERE subscription_id = ? AND read_at IS NULL')
          .run(value, request.subscriptionId)
      } else {
        this.database.prepare('UPDATE items SET read_at = ? WHERE read_at IS NULL').run(value)
      }
    }
    this.emitChanged()
  }

  async close(): Promise<void> {
    if (this.databaseClosed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const abort of this.active.values()) abort.abort()
    if (this.active.size === 0) {
      this.finishCloseIfIdle()
      return
    }
    await new Promise<void>((resolve) => this.closeWaiters.add(resolve))
  }

  private finishCloseIfIdle(): void {
    if (!this.closed || this.active.size > 0 || this.databaseClosed) return
    this.databaseClosed = true
    this.database.close()
    for (const resolve of this.closeWaiters) resolve()
    this.closeWaiters.clear()
  }

  private async searchJournalNames(query: string): Promise<JournalCandidate[]> {
    const url = new URL('/journals', CROSSREF_ORIGIN)
    url.searchParams.set('query', query)
    url.searchParams.set('rows', '100')
    const value = crossrefJournalListSchema.parse(await requestCrossref(`${url.pathname}${url.search}`))
    const exactTitle = query.toLowerCase()
    return value.message.items
      .filter((journal): journal is CrossrefJournal => journal.ISSN.length > 0)
      .map((journal) => candidate(journal))
      .sort((left, right) =>
        Number(right.displayName.toLowerCase() === exactTitle) - Number(left.displayName.toLowerCase() === exactTitle))
  }

  private async fetchWorks(issn: string, fromDate: string, untilDate: string, signal: AbortSignal): Promise<ParsedWork[]> {
    const works: ParsedWork[] = []
    const cursors = new Set<string>()
    let cursor = '*'
    while (true) {
      if (cursors.has(cursor)) throw new Error('Crossref 返回了重复的分页游标。')
      cursors.add(cursor)
      const url = new URL(`/journals/${encodeURIComponent(issn)}/works`, CROSSREF_ORIGIN)
      url.searchParams.set('filter', `from-created-date:${fromDate},until-created-date:${untilDate},type:journal-article`)
      url.searchParams.set('rows', String(WORK_PAGE_SIZE))
      url.searchParams.set('cursor', cursor)
      let page: z.infer<typeof crossrefWorksResultSchema>
      try {
        page = crossrefWorksResultSchema.parse(await requestCrossref(`${url.pathname}${url.search}`, signal))
      } catch (error) {
        if (error instanceof z.ZodError) throw new Error('Crossref 返回了无法识别的数据。')
        throw error
      }
      works.push(...page.message.items.map(parseWork))
      if (page.message.items.length === 0 || page.message.items.length < WORK_PAGE_SIZE || !page.message['next-cursor']) break
      cursor = page.message['next-cursor']
    }
    return works
  }

  private subscribedIssns(): Set<string> {
    const result = new Set<string>()
    for (const row of this.database.prepare('SELECT issn, issns_json FROM subscriptions').all() as Row[]) {
      result.add(stringValue(row.issn))
      try {
        for (const value of JSON.parse(stringValue(row.issns_json)) as unknown[]) {
          if (typeof value === 'string') result.add(value)
        }
      } catch {
        // The primary ISSN still protects duplicate additions if stored JSON is damaged.
      }
    }
    return result
  }

  private async refreshDue(): Promise<void> {
    if (this.closed) return
    const cutoff = new Date(Date.now() - REFRESH_AFTER_MS).toISOString()
    const ids = (this.database.prepare(`
      SELECT id FROM subscriptions WHERE last_checked_at IS NULL OR last_checked_at < ? ORDER BY last_checked_at
    `).all(cutoff) as Row[]).map((row) => stringValue(row.id))
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (!this.closed) {
        const id = ids[cursor++]
        if (!id) return
        await this.refresh(id).catch(() => undefined)
      }
    }))
  }

  private upsertItem(subscriptionId: string, work: ParsedWork): void {
    const id = `feeditem_${hash(`${subscriptionId}:${work.doi}`).slice(0, 24)}`
    this.database.prepare(`
      INSERT INTO items (
        id, subscription_id, doi, title, authors_json, summary, url, published_at, discovered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subscription_id, doi) DO UPDATE SET
        title = excluded.title, authors_json = excluded.authors_json, summary = excluded.summary,
        url = excluded.url, published_at = excluded.published_at, discovered_at = excluded.discovered_at
    `).run(
      id, subscriptionId, work.doi, work.title, JSON.stringify(work.authors), work.summary,
      work.url, work.publishedAt, work.discoveredAt
    )
  }

  private cleanup(): void {
    this.database.prepare('DELETE FROM items WHERE discovered_at < ?')
      .run(new Date(Date.now() - RETENTION_MS).toISOString())
  }

  private getSubscription(id: string): FeedSubscription {
    const row = this.database.prepare(`
      SELECT s.*, count(CASE WHEN i.id IS NOT NULL AND i.read_at IS NULL THEN 1 END) unread_count
      FROM subscriptions s LEFT JOIN items i ON i.subscription_id = s.id WHERE s.id = ? GROUP BY s.id
    `).get(id) as Row | undefined
    if (!row) throw new Error('期刊不存在。')
    return this.subscription(row)
  }

  private subscription(row: Row): FeedSubscription {
    return {
      id: stringValue(row.id),
      issn: stringValue(row.issn),
      title: stringValue(row.title),
      unreadCount: numberValue(row.unread_count),
      lastCheckedAt: stringValue(row.last_checked_at) || null,
      lastSuccessfulAt: stringValue(row.last_successful_at) || null,
      error: stringValue(row.error) || null
    }
  }

  private item(row: Row): FeedItem {
    let authors: string[] = []
    try { authors = JSON.parse(stringValue(row.authors_json)) as string[] } catch { authors = [] }
    return {
      id: stringValue(row.id),
      subscriptionId: stringValue(row.subscription_id),
      sourceTitle: stringValue(row.source_title),
      title: stringValue(row.title),
      authors,
      summary: stringValue(row.summary),
      doi: stringValue(row.doi),
      url: stringValue(row.url),
      publishedAt: stringValue(row.published_at) || null,
      discoveredAt: stringValue(row.discovered_at),
      readAt: stringValue(row.read_at) || null
    }
  }

  private emitChanged(): void {
    this.onChanged()
  }
}
