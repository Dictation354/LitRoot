import { opendir, realpath, stat } from 'node:fs/promises'
import * as platformPath from 'node:path'
import type { CandidateFile } from '../domain.js'
import { isSupportedCandidatePath } from './detectors.js'

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.paper-fetch-locks',
  '.venv',
  'venv',
  'node_modules',
  'http-text-get',
  '__pycache__',
  'dist',
  'out'
])

const MAX_CANDIDATE_SIZE = 64 * 1024 * 1024
// Bump whenever detector semantics change so unchanged source artifacts are
// reparsed once instead of retaining stale normalized data indefinitely.
const INDEX_FORMAT_VERSION = 5

export function isIgnoredDirectoryName(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name) || name.startsWith('.cache')
}

export async function validateRootPath(inputPath: string): Promise<string> {
  const canonical = await realpath(platformPath.resolve(inputPath))
  const info = await stat(canonical)
  if (!info.isDirectory()) throw new Error('The selected path is not a directory.')
  return canonical
}

type PathOperations = Pick<typeof platformPath, 'isAbsolute' | 'relative' | 'resolve' | 'sep'>

export function isPathInsideRoot(
  rootPath: string,
  candidatePath: string,
  path = platformPath as PathOperations
): boolean {
  const child = path.relative(path.resolve(rootPath), path.resolve(candidatePath))
  return (
    child === '' ||
    (!path.isAbsolute(child) &&
      !child.startsWith(`..${path.sep}`) &&
      child !== '..' &&
      !child.startsWith(path.sep))
  )
}

export async function walkCandidates(rootPath: string, signal?: AbortSignal): Promise<CandidateFile[]> {
  signal?.throwIfAborted()
  const root = await validateRootPath(rootPath)
  signal?.throwIfAborted()
  const candidates: CandidateFile[] = []

  const visit = async (directory: string): Promise<void> => {
    signal?.throwIfAborted()
    const entries = await opendir(directory)
    for await (const entry of entries) {
      signal?.throwIfAborted()
      if (entry.isSymbolicLink()) continue
      const path = platformPath.resolve(directory, entry.name)

      if (entry.isDirectory()) {
        if (!isIgnoredDirectoryName(entry.name)) {
          await visit(path)
        }
        continue
      }
      if (!entry.isFile() || !isSupportedCandidatePath(path)) continue

      const fileStat = await stat(path)
      signal?.throwIfAborted()
      if (fileStat.size > MAX_CANDIDATE_SIZE) continue
      const canonicalPath = await realpath(path)
      signal?.throwIfAborted()
      if (!isPathInsideRoot(root, canonicalPath)) continue

      candidates.push({
        path,
        canonicalPath,
        relativePath: platformPath.relative(root, canonicalPath),
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
        fingerprint: `v${INDEX_FORMAT_VERSION}:${fileStat.size}:${Math.trunc(fileStat.mtimeMs)}`
      })
    }
  }

  await visit(root)
  signal?.throwIfAborted()
  candidates.sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath))
  return candidates
}
