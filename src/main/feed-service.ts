import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { FEED_RETENTION_DAYS } from '../shared/contracts.js'
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
const DAY_MS = 24 * 60 * 60 * 1000
const REFRESH_AFTER_MS = DAY_MS
const TIMER_INTERVAL_MS = 60 * 60 * 1000
const REQUEST_SPACING_MS = 350
const MAX_IN_FLIGHT = 3
const WORK_PAGE_SIZE = 100
const DATABASE_VERSION = 4

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
  }).passthrough()).optional(),
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
  const [year] = parts
  const month = parts[1] ?? 1
  const day = parts[2] ?? 1
  if (!year || year < 1 || year > 9999) return null
  const result = new Date(0)
  result.setUTCFullYear(year, month - 1, day)
  if (result.getUTCFullYear() !== year || result.getUTCMonth() !== month - 1 || result.getUTCDate() !== day) return null
  return result.toISOString().slice(0, [4, 7, 10][parts.length - 1])
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

function cutoff(days = FEED_RETENTION_DAYS, timestamp = Date.now()): string {
  return new Date(timestamp - days * DAY_MS).toISOString()
}

function candidate(journal: CrossrefJournal, preferredIssn?: string): JournalCandidate {
  const issns = [...new Set(preferredIssn ? [...journal.ISSN, preferredIssn] : journal.ISSN)]
  return {
    displayName: journal.title,
    publisher: journal.publisher?.trim() || null,
    issn: preferredIssn ?? issns[0]!,
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

function retryAfterMs(header: string | null): number {
  const value = header?.trim() ?? ''
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    if (Number.isFinite(delay)) return delay
  }
  const httpDate = /^[a-z]{3,9}, .+ GMT$/i.test(value) ? value
    : /^[a-z]{3} [a-z]{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/i.test(value) ? `${value} GMT` : ''
  const timestamp = Date.parse(httpDate)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 1_000
}

interface CrossrefRequest {
  start(): void
}

class CrossrefQueue {
  private readonly pending: CrossrefRequest[] = []
  private inFlight = 0
  private nextStart = 0
  private pausedUntil = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  request(path: string, signal: AbortSignal, notFoundIsNull = false): Promise<unknown> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted()
      const cancel = (): void => {
        this.pending.splice(this.pending.indexOf(job), 1)
        reject(signal.reason)
        this.pump()
      }
      const job: CrossrefRequest = {
        start: () => {
          signal.removeEventListener('abort', cancel)
          void requestCrossref(path, signal, notFoundIsNull, (delay) => {
            this.pausedUntil = Math.max(this.pausedUntil, performance.now() + delay)
          }).then(resolve, reject).finally(() => {
            this.inFlight -= 1
            this.pump()
          })
        }
      }
      signal.addEventListener('abort', cancel, { once: true })
      this.pending.push(job)
      this.pump()
    })
  }

  private pump(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.pending.length === 0 || this.inFlight >= MAX_IN_FLIGHT) return
    const current = performance.now()
    const delay = Math.max(this.nextStart, this.pausedUntil) - current
    if (delay > 0) {
      this.timer = setTimeout(() => this.pump(), Math.min(Math.ceil(delay), 2_147_483_647))
      return
    }
    this.nextStart = current + REQUEST_SPACING_MS
    this.inFlight += 1
    this.pending.shift()!.start()
    this.pump()
  }
}

async function requestCrossref(
  path: string, parentSignal: AbortSignal, notFoundIsNull: boolean, pause: (delay: number) => void
): Promise<unknown> {
  const url = new URL(path, CROSSREF_ORIGIN)
  if (url.origin !== CROSSREF_ORIGIN) throw new Error('Crossref 请求地址无效。')
  url.searchParams.set('mailto', CROSSREF_CONTACT)
  const abort = new AbortController()
  const signal = AbortSignal.any([abort.signal, parentSignal])
  const timeout = setTimeout(() => abort.abort(new Error('Crossref 请求超过 15 秒。')), REQUEST_TIMEOUT_MS)
  try {
    signal.throwIfAborted()
    const response = await fetch(url, {
      redirect: 'error',
      signal,
      headers: { accept: 'application/json', 'user-agent': CROSSREF_USER_AGENT }
    })
    if (response.status === 404 && notFoundIsNull) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok) {
      if (response.status === 429) pause(retryAfterMs(response.headers.get('retry-after')))
      await response.body?.cancel()
      if (response.status === 429) throw new Error('Crossref 请求受限（HTTP 429），请稍后重试。')
      throw new Error(`Crossref 请求失败（HTTP ${response.status}）。`)
    }
    return await readJson(response)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof Error && error.message.startsWith('Crossref ')) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Crossref 暂时不可用：${message}`)
  } finally {
    clearTimeout(timeout)
  }
}

function refreshCancelled(): Error {
  return new Error('Crossref 刷新已取消。')
}

export class FeedService {
  private readonly database: DatabaseSync
  private readonly active = new Map<string, AbortController>()
  private readonly additions = new Map<string, AbortController>()
  private readonly crossref = new CrossrefQueue()
  private readonly shutdown = new AbortController()
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
      this.transaction(() => this.migrate(version))
    }
    this.cleanup()
  }

  private migrate(version: number): void {
    if (version < 3) {
      this.database.exec(`
        DROP TABLE IF EXISTS journal_feed_mappings;
        DROP TABLE IF EXISTS items;
        DROP TABLE IF EXISTS subscriptions;
        CREATE TABLE subscriptions (
          id TEXT PRIMARY KEY, issn TEXT NOT NULL UNIQUE, issns_json TEXT NOT NULL,
          title TEXT NOT NULL, publisher TEXT NOT NULL DEFAULT '',
          last_checked_at TEXT, last_successful_at TEXT, error TEXT,
          backfill_from_at TEXT, index_checkpoint_at TEXT
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
      `)
    } else {
      this.database.exec(`
        ALTER TABLE subscriptions ADD COLUMN backfill_from_at TEXT;
        ALTER TABLE subscriptions ADD COLUMN index_checkpoint_at TEXT;
        UPDATE items SET published_at = CASE
          WHEN substr(published_at, 6, 5) = '01-01' THEN substr(published_at, 1, 4)
          WHEN substr(published_at, 9, 2) = '01' THEN substr(published_at, 1, 7)
          ELSE substr(published_at, 1, 10)
        END WHERE published_at IS NOT NULL;
      `)
      this.database.prepare('UPDATE subscriptions SET backfill_from_at = ?').run(cutoff())
    }
    this.database.exec(`PRAGMA user_version = ${DATABASE_VERSION}`)
  }

  start(): void {
    if (this.closed || this.timer) return
    void this.refreshDue()
    this.timer = setInterval(() => { void this.refreshDue() }, TIMER_INTERVAL_MS)
  }

  list(): FeedSubscription[] {
    return (this.database.prepare(`
      SELECT s.*, count(i.id) unread_count
      FROM subscriptions s LEFT JOIN items i
        ON i.subscription_id = s.id AND i.read_at IS NULL AND i.discovered_at >= ?
      GROUP BY s.id ORDER BY lower(s.title), s.id
    `).all(cutoff()) as Row[]).map((row) => this.subscription(row))
  }

  async searchJournals(request: JournalSearchRequest): Promise<JournalSearchResult> {
    const query = request.query.trim()
    const exactIssn = normalizeIssn(query)
    try {
      const journals = exactIssn
        ? await this.fetchJournal(exactIssn, this.shutdown.signal).then((value) => value ? [value] : [])
        : await this.searchJournalNames(query)
      this.shutdown.signal.throwIfAborted()
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
    this.shutdown.signal.throwIfAborted()
    if (this.additions.has(request.requestId)) throw new Error('该添加请求正在处理。')
    const abort = new AbortController()
    this.additions.set(request.requestId, abort)
    try {
      this.assertNewJournal([issn])
      const journal = await this.fetchJournal(issn, abort.signal)
      if (!journal) throw new Error('Crossref 中没有找到该期刊。')
      this.assertNewJournal(journal.issns)
      const upperBound = now()
      const backfillFrom = cutoff(FEED_RETENTION_DAYS, Date.parse(upperBound))
      const works = await this.fetchWorks(journal.issns, { createdFrom: backfillFrom, until: upperBound }, abort.signal)
      abort.signal.throwIfAborted()
      const id = `feed_${hash(journal.issn).slice(0, 24)}`
      this.transaction(() => {
        this.assertNewJournal(journal.issns)
        this.database.prepare(`
          INSERT INTO subscriptions (id, issn, issns_json, title, publisher, backfill_from_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, journal.issn, JSON.stringify(journal.issns), request.title?.trim() || journal.displayName,
          journal.publisher ?? '', backfillFrom)
        this.saveRefresh(id, works, upperBound)
      })
      this.emitChanged()
      return this.getSubscription(id)
    } finally {
      this.additions.delete(request.requestId)
      this.finishCloseIfIdle()
    }
  }

  cancelAdd(requestId: string): boolean {
    const abort = this.additions.get(requestId)
    if (!abort) return false
    abort.abort(new Error('添加期刊已取消。'))
    return true
  }

  private assertNewJournal(issns: string[]): void {
    const subscribed = this.subscribedIssns()
    if (issns.some((issn) => subscribed.has(issn))) throw new Error('该期刊已经添加。')
  }

  remove(subscriptionId: string): void {
    this.active.get(subscriptionId)?.abort(refreshCancelled())
    this.database.prepare('DELETE FROM subscriptions WHERE id = ?').run(subscriptionId)
    this.emitChanged()
  }

  async refresh(subscriptionId: string): Promise<FeedSubscription> {
    this.shutdown.signal.throwIfAborted()
    if (this.active.has(subscriptionId)) return this.getSubscription(subscriptionId)
    const row = this.database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId) as Row | undefined
    if (!row) throw new Error('期刊不存在。')
    const abort = new AbortController()
    this.active.set(subscriptionId, abort)
    try {
      const checkpoint = stringValue(row.index_checkpoint_at)
      const upperBound = now()
      const oldest = cutoff(FEED_RETENTION_DAYS, Date.parse(upperBound))
      const savedFrom = checkpoint || stringValue(row.backfill_from_at)
      const from = savedFrom > oldest ? savedFrom : oldest
      const window = checkpoint
        ? { createdFrom: oldest, indexFrom: from, until: upperBound }
        : { createdFrom: from, until: upperBound }
      const works = await this.fetchWorks(this.subscriptionIssns(row), window, abort.signal)
      abort.signal.throwIfAborted()
      this.transaction(() => this.saveRefresh(subscriptionId, works, upperBound))
      this.emitChanged()
      return this.getSubscription(subscriptionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!abort.signal.aborted) {
        this.database.prepare('UPDATE subscriptions SET last_checked_at = ?, error = ? WHERE id = ?')
          .run(now(), message.slice(0, 1_000), subscriptionId)
        this.emitChanged()
      }
      throw new Error(message)
    } finally {
      this.active.delete(subscriptionId)
      this.finishCloseIfIdle()
    }
  }

  items(request: FeedItemsRequest): FeedItemsResult {
    const clauses = ['i.discovered_at >= ?']
    const values: Array<string | number> = [cutoff(request.days ?? 7)]
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
    this.shutdown.abort(refreshCancelled())
    for (const abort of this.active.values()) abort.abort(refreshCancelled())
    for (const requestId of this.additions.keys()) this.cancelAdd(requestId)
    this.finishCloseIfIdle()
    if (this.databaseClosed) return
    await new Promise<void>((resolve) => this.closeWaiters.add(resolve))
  }

  private finishCloseIfIdle(): void {
    if (!this.closed || this.active.size > 0 || this.additions.size > 0 || this.databaseClosed) return
    this.databaseClosed = true
    this.database.close()
    for (const resolve of this.closeWaiters) resolve()
    this.closeWaiters.clear()
  }

  private async fetchJournal(issn: string, signal: AbortSignal): Promise<JournalCandidate | null> {
    const value = await this.crossref.request(`/journals/${encodeURIComponent(issn)}`, signal, true)
    if (value === null) return null
    try {
      return candidate(crossrefJournalResultSchema.parse(value).message, issn)
    } catch (error) {
      if (error instanceof z.ZodError) throw new Error('Crossref 返回了无法识别的数据。')
      throw error
    }
  }

  private async searchJournalNames(query: string): Promise<JournalCandidate[]> {
    const params = new URLSearchParams({ query, rows: '100' })
    const value = crossrefJournalListSchema.parse(await this.crossref.request(`/journals?${params}`, this.shutdown.signal))
    const exactTitle = query.toLowerCase()
    return value.message.items
      .filter((journal): journal is CrossrefJournal => journal.ISSN.length > 0)
      .map((journal) => candidate(journal))
      .sort((left, right) =>
        Number(right.displayName.toLowerCase() === exactTitle) - Number(left.displayName.toLowerCase() === exactTitle))
  }

  private async fetchWorks(
    issns: string[], { createdFrom, indexFrom, until }: { createdFrom: string; indexFrom?: string; until: string },
    signal: AbortSignal
  ): Promise<Map<string, ParsedWork>> {
    // Crossref interprets these timestamps as UTC and accepts seconds without a time zone suffix.
    const filter = [
      ...issns.map((issn) => `issn:${issn}`),
      `from-created-date:${createdFrom.slice(0, 19)}`,
      `until-created-date:${until.slice(0, 19)}`,
      ...(indexFrom ? [`from-index-date:${indexFrom.slice(0, 19)}`, `until-index-date:${until.slice(0, 19)}`] : []),
      'type:journal-article'
    ].join(',')
    const works = new Map<string, ParsedWork>()
    const cursors = new Set<string>()
    let cursor = '*'
    while (true) {
      if (cursors.has(cursor)) throw new Error('Crossref 返回了重复的分页游标。')
      cursors.add(cursor)
      const params = new URLSearchParams({ filter, rows: String(WORK_PAGE_SIZE), cursor })
      let page: z.infer<typeof crossrefWorksResultSchema>
      try {
        page = crossrefWorksResultSchema.parse(await this.crossref.request(`/works?${params}`, signal))
      } catch (error) {
        if (error instanceof z.ZodError) throw new Error('Crossref 返回了无法识别的数据。')
        throw error
      }
      for (const item of page.message.items) {
        const work = parseWork(item)
        if (work.discoveredAt >= createdFrom && work.discoveredAt <= until) works.set(work.doi, work)
      }
      if (page.message.items.length < WORK_PAGE_SIZE || !page.message['next-cursor']) break
      cursor = page.message['next-cursor']
    }
    return works
  }

  private subscriptionIssns(row: Row): string[] {
    const primary = stringValue(row.issn)
    try {
      const saved = z.array(crossrefIssnSchema).parse(JSON.parse(stringValue(row.issns_json)))
      return [...new Set([...saved, primary])]
    } catch {
      return [primary]
    }
  }

  private subscribedIssns(): Set<string> {
    const result = new Set<string>()
    for (const row of this.database.prepare('SELECT issn, issns_json FROM subscriptions').all() as Row[]) {
      for (const issn of this.subscriptionIssns(row)) result.add(issn)
    }
    return result
  }

  private async refreshDue(): Promise<void> {
    if (this.closed) return
    if (this.cleanup()) this.emitChanged()
    const dueBefore = new Date(Date.now() - REFRESH_AFTER_MS).toISOString()
    const ids = (this.database.prepare(`
      SELECT id FROM subscriptions WHERE index_checkpoint_at IS NULL OR error IS NOT NULL OR last_successful_at <= ?
      ORDER BY last_checked_at, id
    `).all(dueBefore) as Row[]).map((row) => stringValue(row.id))
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (!this.closed) {
        const id = ids[cursor++]
        if (!id) return
        await this.refresh(id).catch(() => undefined)
      }
    }))
  }

  private transaction(write: () => void): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      write()
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private saveRefresh(id: string, works: Map<string, ParsedWork>, upperBound: string): void {
    for (const work of works.values()) this.upsertItem(id, work)
    const checkedAt = now()
    this.database.prepare(`
      UPDATE subscriptions SET last_checked_at = ?, last_successful_at = ?, index_checkpoint_at = ?, error = NULL
      WHERE id = ?
    `).run(checkedAt, checkedAt, `${upperBound.slice(0, 19)}.000Z`, id)
    this.cleanup()
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

  private cleanup(): boolean {
    return this.database.prepare('DELETE FROM items WHERE discovered_at < ?').run(cutoff()).changes > 0
  }

  private getSubscription(id: string): FeedSubscription {
    const row = this.database.prepare(`
      SELECT s.*, count(i.id) unread_count
      FROM subscriptions s LEFT JOIN items i
        ON i.subscription_id = s.id AND i.read_at IS NULL AND i.discovered_at >= ?
      WHERE s.id = ? GROUP BY s.id
    `).get(cutoff(), id) as Row | undefined
    if (!row) throw new Error('期刊不存在。')
    return this.subscription(row)
  }

  private subscription(row: Row): FeedSubscription {
    return {
      id: stringValue(row.id),
      issn: stringValue(row.issn),
      issns: this.subscriptionIssns(row),
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
