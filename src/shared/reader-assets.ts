import type { PaperAsset } from './contracts.js'

function normalizedIdentityPart(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function assetIdentity(asset: PaperAsset, index: number): string {
  const kind = normalizedIdentityPart(asset.kind)
  const heading = normalizedIdentityPart(asset.heading)

  // A missing heading cannot safely identify an asset. Keep those records distinct.
  return heading ? `${kind}\u0000${heading}` : `${kind}\u0000unnamed-${index}`
}

function hasLocalPath(asset: PaperAsset): boolean {
  return Boolean(asset.path?.trim())
}

function displayQuality(asset: PaperAsset): number {
  const localPath = hasLocalPath(asset)
  return (
    (asset.available && localPath ? 16 : 0) +
    (asset.previewUrl ? 8 : 0) +
    (localPath ? 4 : 0) +
    (asset.available ? 2 : 0) +
    (asset.url ? 1 : 0)
  )
}

/**
 * Produces the assets the reader can use without changing the indexed paper.
 * Duplicate metadata records are collapsed in favor of the best local preview,
 * and tables without a local artifact are left to the article text.
 */
export function readerAssets(assets: PaperAsset[]): PaperAsset[] {
  const selected = new Map<string, PaperAsset>()

  assets.forEach((asset, index) => {
    if (normalizedIdentityPart(asset.kind) === 'table' && !hasLocalPath(asset)) return

    const identity = assetIdentity(asset, index)
    const existing = selected.get(identity)
    if (!existing || displayQuality(asset) > displayQuality(existing)) {
      selected.set(identity, asset)
    }
  })

  return [...selected.values()]
}
