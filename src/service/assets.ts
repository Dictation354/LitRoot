import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ProjectDatabase } from './project-database.js'
import type { ProjectLayout } from './project-layout.js'
import { candidateAssetPath } from './paper-markdown.js'
import { canonicalFileInside } from './safe-fs.js'

const MAX_ASSET_BYTES = 32 * 1024 * 1024

export interface AssetPayload {
  data: Uint8Array
  contentType: string
  sha256?: string
}

export function detectedImageContentType(data: Uint8Array): string | null {
  const ascii = (start: number, end: number): string =>
    String.fromCharCode(...data.subarray(start, end))
  if (data.length >= 8 && data[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif'
  if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (data.length >= 12 && ascii(4, 8) === 'ftyp' && /^(?:avif|avis)$/.test(ascii(8, 12))) return 'image/avif'
  return null
}

export async function validatedImageFileInside(
  rootPath: string,
  candidatePath: string
): Promise<string | null> {
  const canonical = await canonicalFileInside(rootPath, candidatePath)
  if (!canonical) return null
  let handle = null
  try {
    handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0 || info.size > MAX_ASSET_BYTES) return null
    const header = Buffer.alloc(32)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return detectedImageContentType(header.subarray(0, bytesRead)) ? canonical : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function readPaperAsset(
  layout: ProjectLayout,
  database: ProjectDatabase,
  paperId: string,
  source: string
): Promise<AssetPayload | null> {
  const paper = database.get(paperId)
  const markdownPath = database.filePath(paperId)
  if (!paper || !markdownPath || !paper.assetPaths.includes(source)) return null
  const candidate = candidateAssetPath(markdownPath, source)
  if (!candidate) return null
  const canonical = await validatedImageFileInside(layout.root, candidate)
  if (!canonical) return null

  let handle = null
  try {
    handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_ASSET_BYTES) return null
    const buffer = await handle.readFile()
    const data = new Uint8Array(buffer.byteLength)
    data.set(buffer)
    const contentType = detectedImageContentType(data)
    return contentType ? { data, contentType } : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
