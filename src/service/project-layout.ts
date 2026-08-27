import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import YAML from 'yaml'
import { PROJECT_SCHEMA_VERSION } from '../shared/contracts.js'
import { stableId } from './identity.js'
import { atomicWriteFile, canonicalDirectory } from './safe-fs.js'

export interface ProjectLayout {
  id: string
  name: string
  root: string
  papers: string
  notes: string
  paperNotes: string
  litroot: string
  metadata: string
  cache: string
  runs: string
  temporary: string
  database: string
  projectFile: string
}

interface ProjectDocument {
  schema_version: 1
  project_id: string
  name: string
}

function parseProjectDocument(value: unknown): ProjectDocument | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    record.schema_version !== PROJECT_SCHEMA_VERSION ||
    typeof record.project_id !== 'string' ||
    !/^project_[a-f0-9]{24}$/.test(record.project_id) ||
    typeof record.name !== 'string' ||
    !record.name.trim()
  ) {
    return null
  }
  return {
    schema_version: PROJECT_SCHEMA_VERSION,
    project_id: record.project_id,
    name: record.name.trim()
  }
}

async function readProjectDocument(path: string): Promise<ProjectDocument | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  let value: unknown
  try {
    value = YAML.parse(raw, { uniqueKeys: true })
  } catch (error) {
    throw new Error(`现有 .litroot/project.yaml 无法解析：${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = parseProjectDocument(value)
  if (!parsed) throw new Error('现有 .litroot/project.yaml 的 schema、项目 ID 或名称无效。')
  return parsed
}

async function ensureLitRootIgnore(path: string): Promise<void> {
  const expected = ['/cache/', '/runs/', '/tmp/']
  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch {
    // The application owns this nested ignore file and creates it when absent.
  }
  const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
  for (const line of expected) lines.add(line)
  await atomicWriteFile(path, `${[...lines].join('\n')}\n`)
}

export async function initializeProject(inputPath: string, preferredName?: string): Promise<ProjectLayout> {
  const root = await canonicalDirectory(inputPath)
  const litroot = join(root, '.litroot')
  const projectFile = join(litroot, 'project.yaml')
  const existing = await readProjectDocument(projectFile)
  const project: ProjectDocument = existing ?? {
    schema_version: PROJECT_SCHEMA_VERSION,
    project_id: stableId('project', randomUUID()),
    name: preferredName?.trim() || basename(root)
  }
  if (!existing) await atomicWriteFile(projectFile, YAML.stringify(project, { lineWidth: 0 }))

  const layout: ProjectLayout = {
    id: project.project_id,
    name: project.name,
    root,
    papers: join(root, 'papers'),
    notes: join(root, 'notes'),
    paperNotes: join(root, 'notes', 'papers'),
    litroot,
    metadata: join(litroot, 'metadata'),
    cache: join(litroot, 'cache'),
    runs: join(litroot, 'runs'),
    temporary: join(litroot, 'tmp'),
    database: join(litroot, 'cache', 'index.sqlite3'),
    projectFile
  }
  await Promise.all(
    [
      layout.papers,
      layout.notes,
      layout.paperNotes,
      layout.metadata,
      layout.cache,
      layout.runs,
      layout.temporary
    ].map((directory) => mkdir(directory, { recursive: true }))
  )
  await ensureLitRootIgnore(join(layout.litroot, '.gitignore'))
  const projectNotePath = join(layout.notes, 'project.md')
  try {
    await readFile(projectNotePath, 'utf8')
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
    await atomicWriteFile(
      projectNotePath,
      `---\n${YAML.stringify({ schema_version: 1, project_id: layout.id }, { lineWidth: 0 }).trim()}\n---\n\n`
    )
  }
  return layout
}
