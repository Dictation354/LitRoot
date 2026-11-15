import { basename, dirname, extname, resolve } from 'node:path'
import YAML from 'yaml'
import type { ContentKind, PaperMetadata } from '../shared/contracts.js'
import { canonicalHttpUrl, normalizeDoi, sha256 } from './identity.js'

type UnknownRecord = Record<string, unknown>

// Bump when parsing changes require existing cached papers to be reindexed.
export const PAPER_MARKDOWN_PARSE_VERSION = 2

export interface ParsedPaperMarkdown {
  frontmatter: UnknownRecord
  body: string
  searchableBody: string
  metadata: PaperMetadata
  source: string
  contentKind: ContentKind
  hasFulltext: boolean
  assetSources: string[]
  remoteAssetSources: string[]
  revision: string
}

export type PaperMarkdownResult =
  | { kind: 'paper'; paper: ParsedPaperMarkdown }
  | { kind: 'ignore'; reason: string }
  | { kind: 'issue'; reason: string }

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function strings(value: unknown, splitScalar = false): string[] {
  if (Array.isArray(value)) {
    return value.map(scalar).filter(Boolean)
  }
  const valueString = scalar(value)
  if (!valueString) return []
  return splitScalar
    ? valueString.split(/\s*(?:;|,(?=\s*[A-Z\p{L}]))\s*/u).filter(Boolean)
    : [valueString]
}

function yearFromValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1000 && value <= 9999 ? value : null
  }
  const matched = scalar(value).match(/(?<!\d)[1-9]\d{3}(?!\d)/)?.[0]
  return matched ? Number(matched) : null
}

function inferYear(metadata: UnknownRecord): number | null {
  const direct = yearFromValue(metadata.year)
  if (direct !== null) return direct

  if (Array.isArray(metadata.publication_dates)) {
    for (const kind of ['print', 'online', 'issued', 'unspecified']) {
      for (const entry of metadata.publication_dates) {
        if (!isRecord(entry) || entry.kind !== kind) continue
        const year = yearFromValue(entry.value)
        if (year !== null) return year
      }
    }
  }

  return yearFromValue(metadata.published) ?? yearFromValue(metadata.date)
}

function abstractFromBody(body: string): string {
  const match = /^#{1,6}\s+abstract\s*$([\s\S]*?)(?=^#{1,6}\s+|\s*$)/imu.exec(body)
  return match?.[1]?.trim() ?? ''
}

function stripForSearch(markdown: string): string {
  return markdown
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~>#|]/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function imageSources(body: string): string[] {
  const sources: string[] = []
  for (const match of body.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)) {
    const source = (match[1] ?? match[2] ?? '').trim()
    if (source) sources.push(source)
  }
  for (const match of body.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const source = (match[1] ?? '').trim()
    if (source) sources.push(source)
  }
  return [...new Set(sources)]
}

function trustedFrontmatter(metadata: UnknownRecord): boolean {
  return (
    Object.hasOwn(metadata, 'doi') &&
    typeof metadata.source === 'string' &&
    metadata.source.trim() !== '' &&
    typeof metadata.has_fulltext === 'boolean' &&
    ['fulltext', 'abstract_only', 'metadata_only'].includes(String(metadata.content_kind))
  )
}

export function parsePaperMarkdown(raw: string, fallbackName = 'Untitled paper'): PaperMarkdownResult {
  if (!raw.startsWith('---')) return { kind: 'ignore', reason: '缺少 YAML frontmatter。' }
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/u.exec(raw)
  if (!match) return { kind: 'issue', reason: 'YAML frontmatter 未闭合。' }

  let frontmatter: unknown
  try {
    frontmatter = YAML.parse(match[1] ?? '', { uniqueKeys: true })
  } catch (error) {
    return {
      kind: 'issue',
      reason: `YAML frontmatter 无效：${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!isRecord(frontmatter) || !trustedFrontmatter(frontmatter)) {
    return { kind: 'ignore', reason: '不是可信的 paper-fetch Markdown。' }
  }

  const body = match[2] ?? ''
  const headingTitle = body.match(/^#\s+(.+?)\s*$/mu)?.[1]?.trim() ?? ''
  const sourceUrl = [
    frontmatter.url,
    frontmatter.source_record_url,
    frontmatter.publisher_url,
    frontmatter.source_url
  ].map(canonicalHttpUrl).find((value): value is string => value !== null) ?? ''
  const sources = imageSources(body)
  const contentKind = String(frontmatter.content_kind) as ContentKind

  return {
    kind: 'paper',
    paper: {
      frontmatter,
      body,
      searchableBody: stripForSearch(body),
      metadata: {
        title: scalar(frontmatter.title) || headingTitle || fallbackName,
        authors: strings(frontmatter.authors, true),
        journal: scalar(frontmatter.journal || frontmatter.venue),
        year: inferYear(frontmatter),
        doi: normalizeDoi(frontmatter.doi) ?? '',
        url: sourceUrl,
        abstract: scalar(frontmatter.abstract) || abstractFromBody(body),
        keywords: strings(frontmatter.keywords, true)
      },
      source: scalar(frontmatter.source),
      contentKind,
      hasFulltext: frontmatter.has_fulltext === true && contentKind === 'fulltext',
      assetSources: sources.filter((source) => !/^(?:https?:|data:|blob:)/i.test(source)),
      remoteAssetSources: sources.filter((source) => /^https?:/i.test(source)),
      revision: sha256(raw)
    }
  }
}

export function candidateAssetPath(markdownPath: string, source: string): string | null {
  if (!source || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source)) return null
  try {
    const decoded = decodeURIComponent(source.split(/[?#]/, 1)[0] ?? '')
    if (!decoded || decoded.split(/[\\/]/).includes('..') || /^[\\/]/.test(decoded) || decoded.includes('\0')) {
      return null
    }
    return resolve(dirname(markdownPath), decoded)
  } catch {
    return null
  }
}

export function fallbackMarkdownName(path: string): string {
  return basename(path, extname(path))
}
