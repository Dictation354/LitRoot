import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { extname } from 'node:path'

const MAX_ASSET_BYTES = 64 * 1024 * 1024

export type AssetPreviewResult =
  | { ok: true; data: Uint8Array<ArrayBuffer>; contentType: string }
  | { ok: false; status: 403 | 404 | 413 | 500; message: string }

function assetContentType(path: string): string {
  const extension = extname(path).toLowerCase()
  return (
    {
      '.avif': 'image/avif',
      '.gif': 'image/gif',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp'
    }[extension] ?? 'application/octet-stream'
  )
}

function assetReadError(error: unknown): Extract<AssetPreviewResult, { ok: false }> {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : null
  if (code === 'EACCES' || code === 'EPERM') {
    return { ok: false, status: 403, message: 'Asset is not readable.' }
  }
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    return { ok: false, status: 404, message: 'Asset not found.' }
  }
  return { ok: false, status: 500, message: 'Asset could not be read.' }
}

export async function readAssetPreview(path: string): Promise<AssetPreviewResult> {
  let handle: FileHandle | null = null
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_ASSET_BYTES) {
      return { ok: false, status: 413, message: 'Asset is not previewable.' }
    }
    const data = await handle.readFile()
    if (data.byteLength > MAX_ASSET_BYTES) {
      return { ok: false, status: 413, message: 'Asset is not previewable.' }
    }
    const bytes = new Uint8Array(data.byteLength)
    bytes.set(data)
    return { ok: true, data: bytes, contentType: assetContentType(path) }
  } catch (error) {
    return assetReadError(error)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
