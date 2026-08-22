import { realpathSync, statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isPathInsideRoot } from './walk.js'

// Asset paths are untrusted corpus data. Resolve every symlink component before
// applying containment so a lexically in-root path cannot authorize an
// out-of-root target. Returning the canonical target also lets safe in-root
// symlinks remain previewable without asking the reader to follow the link.
export async function canonicalAssetPath(rootPath: string, candidatePath: string): Promise<string | null> {
  if (!isAbsolute(candidatePath)) return null
  try {
    const canonicalPath = await realpath(candidatePath)
    if (!isPathInsideRoot(rootPath, canonicalPath)) return null
    return (await stat(canonicalPath)).isFile() ? canonicalPath : null
  } catch {
    return null
  }
}

export function canonicalAssetPathSync(rootPath: string, candidatePath: string): string | null {
  if (!isAbsolute(candidatePath)) return null
  try {
    const canonicalPath = realpathSync(candidatePath)
    if (!isPathInsideRoot(rootPath, canonicalPath)) return null
    return statSync(canonicalPath).isFile() ? canonicalPath : null
  } catch {
    return null
  }
}
