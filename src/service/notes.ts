import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'yaml'
import type { NoteDocument, NoteKind } from '../shared/contracts.js'
import { NOTE_SCHEMA_VERSION } from '../shared/contracts.js'
import type { ProjectDatabase } from './project-database.js'
import type { ProjectLayout } from './project-layout.js'
import { NoteConflictError } from './errors.js'
import { sha256 } from './identity.js'
import { atomicWriteFile } from './safe-fs.js'

function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/u.exec(raw)
  if (!match) return { frontmatter: null, body: raw }
  try {
    const value: unknown = YAML.parse(match[1] ?? '', { uniqueKeys: true })
    return {
      frontmatter: typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null,
      body: match[2] ?? ''
    }
  } catch {
    return { frontmatter: null, body: match[2] ?? '' }
  }
}

export class NoteStore {
  constructor(
    private readonly layout: ProjectLayout,
    private readonly database: ProjectDatabase
  ) {}

  private path(kind: NoteKind, paperId?: string): string {
    if (kind === 'project') return join(this.layout.notes, 'project.md')
    if (!paperId || !/^paper_[a-f0-9]{24}$/.test(paperId)) throw new Error('论文 ID 无效。')
    return join(this.layout.paperNotes, `${paperId}.md`)
  }

  private frontmatter(kind: NoteKind, paperId?: string): Record<string, unknown> {
    if (kind === 'project') {
      return { schema_version: NOTE_SCHEMA_VERSION, project_id: this.layout.id }
    }
    const paper = paperId ? this.database.get(paperId) : null
    if (!paper || !paperId) throw new Error('论文不存在。')
    return {
      schema_version: NOTE_SCHEMA_VERSION,
      paper_id: paperId,
      doi: paper.doi,
      title_on_create: paper.title
    }
  }

  private noteFrontmatter(
    kind: NoteKind,
    paperId?: string,
    existing?: Record<string, unknown> | null
  ): Record<string, unknown> {
    if (
      kind === 'project' && existing?.schema_version === NOTE_SCHEMA_VERSION &&
      existing.project_id === this.layout.id
    ) {
      return { schema_version: NOTE_SCHEMA_VERSION, project_id: this.layout.id }
    }
    if (
      kind === 'paper' && paperId && existing?.schema_version === NOTE_SCHEMA_VERSION &&
      existing.paper_id === paperId
    ) {
      return {
        schema_version: NOTE_SCHEMA_VERSION,
        paper_id: paperId,
        doi: typeof existing.doi === 'string' ? existing.doi : '',
        title_on_create: typeof existing.title_on_create === 'string' ? existing.title_on_create : ''
      }
    }
    return this.frontmatter(kind, paperId)
  }

  private serialize(
    kind: NoteKind,
    content: string,
    paperId?: string,
    existing?: Record<string, unknown> | null
  ): string {
    const normalized = content.replace(/\r\n?/g, '\n')
    return `---\n${YAML.stringify(this.noteFrontmatter(kind, paperId, existing), { lineWidth: 0 }).trim()}\n---\n\n${normalized}`
  }

  async read(kind: NoteKind, paperId?: string): Promise<NoteDocument> {
    const path = this.path(kind, paperId)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
      raw = this.serialize(kind, '', paperId)
      await atomicWriteFile(path, raw)
    }
    const info = await stat(path)
    return {
      projectId: this.layout.id,
      kind,
      paperId: kind === 'paper' ? (paperId ?? null) : null,
      content: splitFrontmatter(raw).body,
      revision: sha256(raw),
      modifiedAt: info.mtime.toISOString(),
      path
    }
  }

  async write(
    kind: NoteKind,
    content: string,
    expectedRevision: string,
    paperId?: string
  ): Promise<NoteDocument> {
    await this.read(kind, paperId)
    const raw = await readFile(this.path(kind, paperId), 'utf8')
    if (sha256(raw) !== expectedRevision) {
      throw new NoteConflictError({ disk: await this.read(kind, paperId), draft: content })
    }
    await atomicWriteFile(
      this.path(kind, paperId),
      this.serialize(kind, content, paperId, splitFrontmatter(raw).frontmatter)
    )
    return this.read(kind, paperId)
  }
}
