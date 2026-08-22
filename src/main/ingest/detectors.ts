import { existsSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import YAML from 'yaml'
import type { ContentKind, PaperAsset, PaperSection } from '../../shared/contracts.js'
import type { DetectionResult, NormalizedDocument } from '../domain.js'
import { normalizeDoi } from './identity.js'

const TRUSTED_FRONTMATTER_KEYS = new Set([
  'doi',
  'source',
  'has_fulltext',
  'content_kind',
  'has_abstract',
  'token_estimate'
])

const CANDIDATE_JSON_NAMES = /(?:^article\.json$|\.both\.json$|\.fetch-envelope\.json$)/i
const CANDIDATE_HTML_NAMES = /(?:^article\.html?$|^original\.html?$|_original\.html?$|\.paper\.html?$)/i
const MARKDOWN_SAVED_WARNING = /^Markdown full text was saved to .+\.(?:md|markdown)\.?$/
const SPRINGER_ACCESS_GATE = 'access via your institution'
const ACCESS_LIMITED_WARNING =
  'Full text is access-limited; the extracted sections contain the Springer "access via your institution" gate.'
const MARKDOWN_PROVENANCE_FIELDS = [
  'source',
  'extraction_method',
  'source_pdf_sha256',
  'source_record_url',
  'source_pdf_url',
  'publisher_url',
  'license_url',
  'paperrelay_paper_id',
  'paperrelay_source_document_id',
  'paperrelay_source_root_id',
  'paperrelay_source_path'
] as const

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function stringArray(value: unknown, splitScalar = false): string[] {
  if (Array.isArray(value)) {
    return value.map(stringValue).filter((item): item is string => item !== null)
  }
  const scalar = stringValue(value)
  if (!scalar) return []
  if (!splitScalar) return [scalar]
  return scalar
    .split(/\s*(?:;|,(?=\s*[A-Z\p{L}]))\s*/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function numberValue(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

function booleanValue(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true
    if (value.toLowerCase() === 'false') return false
  }
  return fallback
}

function stripMarkup(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|li|tr|h[1-6])\s*>/gi, '\n\n')
    .replace(/<\/?(?:sub|sup|em|strong|i|b|span)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripMarkdownFormatting(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    // Underscore emphasis needs delimiter boundaries. Treating every pair of
    // underscores as emphasis corrupts scientific notation such as
    // `t_{IE_m}` and `\alpha_{x_i}` while preparing searchable section text.
    .replace(
      /(^|[\s([{>'"“‘])_([^_\n{}\\]+?)_(?=$|[\s)\]},.!?:;>'"”’])/gmu,
      '$1$2'
    )
    .replace(/^>\s?/gm, '')
    .trim()
}

function cleanDisplayText(value: string): string {
  return stripMarkdownFormatting(stripMarkup(value))
}

function cleanOptionalString(value: unknown): string | null {
  const text = stringValue(value)
  return text ? cleanDisplayText(text) : null
}

function inferYear(published: string | null): string | null {
  return published?.match(/(?:19|20)\d{2}/)?.[0] ?? null
}

function normalizeContentKind(value: unknown, hasFulltext: boolean, hasAbstract: boolean): ContentKind {
  if (value === 'fulltext' || value === 'abstract_only' || value === 'metadata_only') return value
  if (hasFulltext) return 'fulltext'
  if (hasAbstract) return 'abstract_only'
  return 'metadata_only'
}

function structuredWarnings(value: unknown): string[] {
  return stringArray(value).filter((warning) => !MARKDOWN_SAVED_WARNING.test(warning))
}

function containsSpringerAccessGate(sections: PaperSection[]): boolean {
  return sections.some((section) => section.text.toLowerCase().includes(SPRINGER_ACCESS_GATE))
}

function hasAccessLimitedWarning(warnings: string[]): boolean {
  return warnings.some((warning) =>
    /(?:access[ -]?limited|access via your institution|institution(?:al)? access)/i.test(warning)
  )
}

function normalizeDetectedDocument(document: NormalizedDocument): NormalizedDocument {
  const warnings = structuredWarnings(document.warnings)
  if (!containsSpringerAccessGate(document.sections)) return { ...document, warnings }

  if (!hasAccessLimitedWarning(warnings)) warnings.push(ACCESS_LIMITED_WARNING)
  return {
    ...document,
    contentKind: document.abstract ? 'abstract_only' : 'metadata_only',
    hasFulltext: false,
    confidence: 'low',
    warnings
  }
}

function normalizeDetectionResult(result: DetectionResult): DetectionResult {
  return result.kind === 'document'
    ? { kind: 'document', document: normalizeDetectedDocument(result.document) }
    : result
}

function resolveAssetPath(articlePath: string, value: string | null): { path: string | null; available: boolean } {
  if (!value) return { path: null, available: false }
  const candidates = isAbsolute(value)
    ? [value]
    : [resolve(dirname(articlePath), value), resolve(dirname(dirname(articlePath)), value)]
  const found = candidates.find((candidate) => existsSync(candidate))
  return { path: found ?? value, available: Boolean(found) }
}

function sectionsFromUnknown(value: unknown): PaperSection[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): PaperSection[] => {
    if (!isRecord(item)) return []
    const text = stringValue(item.text)
    if (!text) return []
    return [
      {
        heading: cleanDisplayText(stringValue(item.heading) ?? 'Untitled section'),
        level: Math.min(6, Math.max(1, numberValue(item.level, 2))),
        kind: stringValue(item.kind) ?? 'body',
        text: cleanDisplayText(text)
      }
    ]
  })
}

function assetsFromUnknown(articlePath: string, value: unknown): PaperAsset[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): PaperAsset[] => {
    if (!isRecord(item)) return []
    const rawPath = stringValue(item.path) ?? stringValue(item.source_path)
    const local = resolveAssetPath(articlePath, rawPath)
    const rawCaption = stringValue(item.caption)
    return [
      {
        kind: stringValue(item.kind) ?? 'asset',
        heading: cleanDisplayText(stringValue(item.heading) ?? rawCaption ?? 'Untitled asset'),
        caption: rawCaption ? cleanDisplayText(rawCaption) : null,
        path: local.path,
        url: stringValue(item.url) ?? stringValue(item.download_url),
        section: stringValue(item.section),
        available: local.available
      }
    ]
  })
}

function isArticleModel(value: unknown): value is UnknownRecord {
  if (!isRecord(value) || !isRecord(value.metadata)) return false
  return (
    Array.isArray(value.sections) &&
    Array.isArray(value.references) &&
    Array.isArray(value.assets) &&
    (typeof value.source === 'string' || typeof value.doi === 'string')
  )
}

function unwrapArticle(value: unknown): { article: UnknownRecord; detector: string; envelopeRevision?: number } | null {
  if (isArticleModel(value)) return { article: value, detector: 'article-json' }
  if (!isRecord(value)) return null

  if (isArticleModel(value.article)) {
    return { article: value.article, detector: 'combined-json' }
  }

  if (isRecord(value.payload) && isArticleModel(value.payload.article)) {
    return {
      article: value.payload.article,
      detector: 'fetch-envelope',
      envelopeRevision: numberValue(value.extraction_revision)
    }
  }
  return null
}

function normalizeArticle(
  articlePath: string,
  article: UnknownRecord,
  detector: string,
  envelopeRevision?: number
): NormalizedDocument {
  const metadata = isRecord(article.metadata) ? article.metadata : {}
  const quality = isRecord(article.quality) ? article.quality : {}
  const sections = sectionsFromUnknown(article.sections)
  const rawAbstract = stringValue(metadata.abstract)
  const abstract = rawAbstract
    ? cleanDisplayText(rawAbstract)
    : (sections.find((section) => section.kind === 'abstract')?.text ?? null)
  const hasFulltext = booleanValue(
    quality.has_fulltext,
    sections.some((section) => section.kind !== 'abstract')
  )
  const hasAbstract = booleanValue(quality.has_abstract, Boolean(abstract))
  const published = stringValue(metadata.published)
  const title = cleanOptionalString(metadata.title) ?? basename(dirname(articlePath))

  return {
    doi: normalizeDoi(article.doi),
    title,
    authors: stringArray(metadata.authors).map(cleanDisplayText).filter(Boolean),
    abstract,
    journal: cleanOptionalString(metadata.journal),
    published,
    year: inferYear(published),
    keywords: stringArray(metadata.keywords).map(cleanDisplayText).filter(Boolean),
    source: stringValue(article.source),
    contentKind: normalizeContentKind(quality.content_kind, hasFulltext, hasAbstract),
    hasFulltext,
    confidence: stringValue(quality.confidence),
    warnings: stringArray(quality.warnings),
    flags: stringArray(quality.flags),
    sourceTrail: stringArray(quality.source_trail),
    tokenEstimate: numberValue(quality.token_estimate),
    extractionRevision: numberValue(quality.extraction_revision, envelopeRevision ?? 0),
    sections,
    assets: assetsFromUnknown(articlePath, article.assets),
    references: Array.isArray(article.references) ? article.references : [],
    bodyText: sections.map((section) => `${section.heading}\n${section.text}`).join('\n\n'),
    detector
  }
}

function parseMarkdownSections(body: string): PaperSection[] {
  const lines = body.split(/\r?\n/)
  const sections: PaperSection[] = []
  let heading = 'Article'
  let level = 1
  let kind = 'body'
  let content: string[] = []

  const flush = (): void => {
    const text = cleanDisplayText(content.join('\n').trim())
    if (text) sections.push({ heading, level, kind, text })
    content = []
  }

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!match) {
      content.push(line)
      continue
    }
    flush()
    level = match[1]?.length ?? 2
    heading = cleanDisplayText(match[2]?.replace(/\s+#+$/, '').trim() || 'Untitled section')
    kind = /abstract/i.test(heading) ? 'abstract' : 'body'
  }
  flush()
  return sections
}

function markdownAssets(articlePath: string, body: string): PaperAsset[] {
  const assets: PaperAsset[] = []
  let section: string | null = null

  for (const line of body.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      section = cleanDisplayText(heading[2]?.replace(/\s+#+$/, '').trim() || 'Untitled section')
    }

    for (const asset of line.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const rawPath = asset[2] ?? ''
      const local = resolveAssetPath(articlePath, rawPath)
      assets.push({
        kind: 'figure',
        heading: asset[1]?.trim() || basename(rawPath),
        caption: asset[1]?.trim() || null,
        path: local.path,
        url: /^https?:\/\//i.test(rawPath) ? rawPath : null,
        section,
        available: local.available
      })
    }
  }

  return assets
}

function markdownReferences(sections: PaperSection[]): unknown[] {
  const section = sections.find((candidate) =>
    /^(?:references|bibliography|works cited|literature cited)\b/i.test(candidate.heading.trim())
  )
  if (!section) return []

  const references: Array<{ raw: string; doi?: string }> = []
  let current: string[] = []
  const flush = (): void => {
    const raw = current.join(' ').replace(/\s+/g, ' ').trim()
    current = []
    if (!raw) return
    const doiMatch = raw.match(/(?:https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/[^\s\])}]+/i)?.[0]
    const doi = normalizeDoi(doiMatch)
    references.push(doi ? { raw, doi } : { raw })
  }

  for (const line of section.text.split(/\r?\n/)) {
    const item = /^\s*(?:\[\d+\]|\d+[.)]|[-*•])\s+(.+?)\s*$/.exec(line)
    if (item) {
      flush()
      current.push(item[1] ?? '')
    } else if (line.trim() && current.length > 0) {
      current.push(line.trim())
    } else if (!line.trim()) {
      flush()
    }
  }
  flush()
  return references
}

function markdownSourceTrail(metadata: UnknownRecord): string[] {
  const sourceTrail = stringArray(metadata.source_trail)
    .map((entry) => entry.slice(0, 2_048))
    .slice(0, 32)

  for (const field of MARKDOWN_PROVENANCE_FIELDS) {
    const value = stringValue(metadata[field])
    if (value) sourceTrail.push(`${field}:${value.slice(0, 2_048)}`)
  }

  return [...new Set(sourceTrail)].slice(0, 32)
}

function detectMarkdown(articlePath: string, raw: string): DetectionResult {
  if (!raw.startsWith('---')) return { kind: 'ignore' }
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/m.exec(raw)
  if (!match) return { kind: 'ignore' }

  let metadata: unknown
  try {
    metadata = YAML.parse(match[1] ?? '')
  } catch (error) {
    return { kind: 'issue', message: `Invalid Markdown frontmatter: ${errorMessage(error)}` }
  }
  if (!isRecord(metadata)) return { kind: 'ignore' }
  const trustedKeyCount = Object.keys(metadata).filter((key) => TRUSTED_FRONTMATTER_KEYS.has(key)).length
  if (trustedKeyCount < 2) return { kind: 'ignore' }

  const body = match[2] ?? ''
  const sections = parseMarkdownSections(body)
  const references = markdownReferences(sections)
  const published = stringValue(metadata.published)
  const abstract = sections.find((section) => section.kind === 'abstract')?.text ?? null
  const hasFulltext = booleanValue(metadata.has_fulltext, sections.length > 1)
  const hasAbstract = booleanValue(metadata.has_abstract, Boolean(abstract))
  const contentKind = normalizeContentKind(metadata.content_kind, hasFulltext, hasAbstract)
  const headingTitle = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const title = cleanOptionalString(metadata.title) ??
    (headingTitle ? cleanDisplayText(headingTitle) : basename(articlePath, extname(articlePath)))
  const assets = markdownAssets(articlePath, body)

  return {
    kind: 'document',
    document: {
      doi: normalizeDoi(metadata.doi),
      title,
      authors: stringArray(metadata.authors, true).map(cleanDisplayText).filter(Boolean),
      abstract,
      journal: cleanOptionalString(metadata.journal),
      published,
      year: inferYear(published),
      keywords: stringArray(metadata.keywords, true).map(cleanDisplayText).filter(Boolean),
      source: stringValue(metadata.source),
      contentKind,
      hasFulltext,
      confidence: null,
      warnings: [],
      flags: [],
      sourceTrail: markdownSourceTrail(metadata),
      tokenEstimate: numberValue(metadata.token_estimate),
      extractionRevision: numberValue(metadata.extraction_revision),
      sections,
      assets,
      references,
      bodyText: stripMarkdownFormatting(stripMarkup(body.replace(/!\[[^\]]*\]\([^)]+\)/g, ' '))),
      detector: 'article-markdown'
    }
  }
}

function metaContent(raw: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const forward = new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i')
  const reverse = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, 'i')
  return stringValue(forward.exec(raw)?.[1] ?? reverse.exec(raw)?.[1])
}

function detectHtml(articlePath: string, raw: string): DetectionResult {
  const title = metaContent(raw, 'citation_title') ?? stringValue(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1])
  const doi = normalizeDoi(metaContent(raw, 'citation_doi') ?? metaContent(raw, 'dc.identifier'))
  if ((!title || !doi) && !/<article\b/i.test(raw)) return { kind: 'ignore' }

  const bodyMatch = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(raw)
  const body = bodyMatch?.[1] ?? /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(raw)?.[1] ?? raw
  const text = stripMarkup(body)
  const published = metaContent(raw, 'citation_publication_date') ?? metaContent(raw, 'citation_date')
  const authors = [...raw.matchAll(/<meta[^>]+name=["']citation_author["'][^>]+content=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => stripMarkup(match[1] ?? ''))
    .filter(Boolean)
  const section: PaperSection = { heading: 'Article', level: 1, kind: 'body', text }

  return {
    kind: 'document',
    document: {
      doi,
      title: cleanDisplayText(title ?? basename(articlePath, extname(articlePath))),
      authors,
      abstract: (() => {
        const value = metaContent(raw, 'description') ?? metaContent(raw, 'citation_abstract')
        return value ? cleanDisplayText(value) : null
      })(),
      journal: cleanOptionalString(metaContent(raw, 'citation_journal_title')),
      published,
      year: inferYear(published),
      keywords: [],
      source: 'html',
      contentKind: text.length > 2_000 ? 'fulltext' : 'metadata_only',
      hasFulltext: text.length > 2_000,
      confidence: null,
      warnings: ['Indexed from HTML fallback; structured article JSON was not available.'],
      flags: [],
      sourceTrail: [],
      tokenEstimate: Math.ceil(text.length / 4),
      extractionRevision: 0,
      sections: [section],
      assets: [],
      references: [],
      bodyText: text,
      detector: 'article-html'
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function detectDocument(articlePath: string, raw: string): DetectionResult {
  const extension = extname(articlePath).toLowerCase()
  if (extension === '.md' || extension === '.markdown') {
    return normalizeDetectionResult(detectMarkdown(articlePath, raw))
  }
  if (extension === '.html' || extension === '.htm') {
    if (!CANDIDATE_HTML_NAMES.test(basename(articlePath))) return { kind: 'ignore' }
    return normalizeDetectionResult(detectHtml(articlePath, raw))
  }
  if (extension !== '.json') return { kind: 'ignore' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return CANDIDATE_JSON_NAMES.test(basename(articlePath))
      ? { kind: 'issue', message: `Invalid paper JSON: ${errorMessage(error)}` }
      : { kind: 'ignore' }
  }

  const unwrapped = unwrapArticle(parsed)
  if (!unwrapped) return { kind: 'ignore' }
  return normalizeDetectionResult({
    kind: 'document',
    document: normalizeArticle(
      articlePath,
      unwrapped.article,
      unwrapped.detector,
      unwrapped.envelopeRevision
    )
  })
}

export function isSupportedCandidatePath(path: string): boolean {
  const name = basename(path)
  if (name.endsWith('.part') || name === '.paper-fetch-mcp-cache.json') return false
  const extension = extname(name).toLowerCase()
  return ['.json', '.md', '.markdown', '.html', '.htm'].includes(extension)
}
