import { opendir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import YAML from 'yaml'
import type {
  MetadataField,
  MetadataOverrides,
  PaperMetadata
} from '../shared/contracts.js'
import { metadataOverridesSchema } from '../shared/contracts.js'
import { canonicalHttpUrl, normalizeDoi } from './identity.js'
import { atomicWriteFile, portableRelativePath } from './safe-fs.js'

interface OverrideDocument {
  schema_version: 1
  paper_id: string
  source_path: string
  overrides: MetadataOverrides
}

export interface StoredOverrides {
  paperId: string
  sourcePath: string
  overrides: MetadataOverrides
}

const MAX_TEXT = 100_000
const MAX_LIST_ITEMS = 500
const MAX_LIST_ITEM = 2_000

function cleanText(value: string, maximum = MAX_TEXT): string {
  if (value.length > maximum) throw new Error(`字段长度不能超过 ${maximum} 个字符。`)
  return value.trim()
}

function cleanList(value: string[]): string[] {
  if (value.length > MAX_LIST_ITEMS) throw new Error(`数组字段最多包含 ${MAX_LIST_ITEMS} 项。`)
  return [...new Set(value.map((item) => cleanText(item, MAX_LIST_ITEM)).filter(Boolean))]
}

export function validateMetadataOverrides(value: MetadataOverrides): MetadataOverrides {
  const parsed = metadataOverridesSchema.parse(value)
  const result: MetadataOverrides = {}

  if (parsed.title !== undefined) result.title = cleanText(parsed.title, 2_000)
  if (parsed.authors !== undefined) result.authors = cleanList(parsed.authors)
  if (parsed.journal !== undefined) result.journal = cleanText(parsed.journal, 2_000)
  if (parsed.year !== undefined) result.year = parsed.year
  if (parsed.doi !== undefined) {
    const trimmed = cleanText(parsed.doi, 2_000)
    if (trimmed && !normalizeDoi(trimmed)) throw new Error('DOI 格式无效。')
    result.doi = trimmed ? (normalizeDoi(trimmed) ?? '') : ''
  }
  if (parsed.url !== undefined) {
    const trimmed = cleanText(parsed.url, 8_000)
    if (trimmed && !canonicalHttpUrl(trimmed)) throw new Error('URL 必须是有效的 HTTP(S) 地址。')
    result.url = trimmed ? (canonicalHttpUrl(trimmed) ?? '') : ''
  }
  if (parsed.abstract !== undefined) result.abstract = cleanText(parsed.abstract)
  if (parsed.keywords !== undefined) result.keywords = cleanList(parsed.keywords)
  return result
}

export function mergeMetadata(
  fetched: PaperMetadata,
  overrides: MetadataOverrides
): PaperMetadata {
  return {
    title: overrides.title ?? fetched.title,
    authors: overrides.authors ?? fetched.authors,
    journal: overrides.journal ?? fetched.journal,
    year: overrides.year === '' ? null : (overrides.year ?? fetched.year),
    doi: overrides.doi ?? fetched.doi,
    url: overrides.url ?? fetched.url,
    abstract: overrides.abstract ?? fetched.abstract,
    keywords: overrides.keywords ?? fetched.keywords
  }
}

export function applyMetadataPatch(
  current: MetadataOverrides,
  patch: MetadataOverrides,
  restore: MetadataField[]
): MetadataOverrides {
  const next: MetadataOverrides = { ...current, ...validateMetadataOverrides(patch) }
  for (const field of restore) delete next[field]
  return validateMetadataOverrides(next)
}

function parseOverrideDocument(value: unknown): StoredOverrides | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    record.schema_version !== 1 ||
    typeof record.paper_id !== 'string' ||
    !/^paper_[a-f0-9]{24}$/.test(record.paper_id) ||
    typeof record.source_path !== 'string'
  ) {
    return null
  }
  try {
    return {
      paperId: record.paper_id,
      sourcePath: portableRelativePath(record.source_path),
      overrides: validateMetadataOverrides(record.overrides ?? {})
    }
  } catch {
    return null
  }
}

export class MetadataStore {
  constructor(private readonly directory: string) {}

  pathFor(paperId: string): string {
    return join(this.directory, `${paperId}.yaml`)
  }

  async read(paperId: string): Promise<StoredOverrides | null> {
    let raw: string
    try {
      raw = await readFile(this.pathFor(paperId), 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
    let value: unknown
    try {
      value = YAML.parse(raw, { uniqueKeys: true })
    } catch (error) {
      throw new Error(`元数据覆盖 ${paperId}.yaml 的 YAML 无效：${error instanceof Error ? error.message : String(error)}`)
    }
    const parsed = parseOverrideDocument(value)
    if (!parsed || parsed.paperId !== paperId) throw new Error(`元数据覆盖 ${paperId}.yaml 的 schema 或 paper_id 无效。`)
    return parsed
  }

  async identitiesBySourcePath(): Promise<Map<string, StoredOverrides>> {
    const identities = new Map<string, StoredOverrides>()
    let entries
    try {
      entries = await opendir(this.directory)
    } catch {
      return identities
    }
    for await (const entry of entries) {
      if (!entry.isFile() || !/^paper_[a-f0-9]{24}\.ya?ml$/.test(entry.name)) continue
      let stored: StoredOverrides | null = null
      try {
        stored = await this.read(basename(entry.name).replace(/\.ya?ml$/, ''))
      } catch {
        continue
      }
      if (stored && !identities.has(stored.sourcePath)) identities.set(stored.sourcePath, stored)
    }
    return identities
  }

  async write(paperId: string, sourcePath: string, overrides: MetadataOverrides): Promise<void> {
    const document: OverrideDocument = {
      schema_version: 1,
      paper_id: paperId,
      source_path: portableRelativePath(sourcePath),
      overrides: validateMetadataOverrides(overrides)
    }
    const yaml = YAML.stringify(document, { lineWidth: 0 })
    await atomicWriteFile(this.pathFor(paperId), yaml)
  }
}
