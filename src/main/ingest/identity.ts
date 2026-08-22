import { createHash } from 'node:crypto'

export function normalizeDoi(value: unknown): string | null {
  if (typeof value !== 'string') return null

  let doi = value.trim().toLowerCase()
  doi = doi
    .replace(/^doi\s*:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^urn:doi:/i, '')
    .split(/[?#]/, 1)[0] ?? ''
  doi = doi.replace(/[\s.,;:)}\]]+$/g, '').trim()

  return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi : null
}

export function stableId(prefix: string, value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 24)
  return `${prefix}_${digest}`
}

export function corpusWorkIdentityKey(canonicalPath: string): string | null {
  const normalizedPath = canonicalPath.replaceAll('\\', '/')
  const match = /^(.*\/corpus\/groups)\/(?:fetch|library)\/(?:records\/work-(\d{5})\.both\.json|papers\/work-(\d{5})(?:\/|$))/.exec(
    normalizedPath
  )
  const workNumber = match?.[2] ?? match?.[3]
  if (!match?.[1] || !workNumber) return null
  return `corpus-work:${match[1]}:work:${workNumber}`
}

export function paperIdentityKey(doi: string | null, canonicalPath: string): string {
  if (doi) return `doi:${doi}`
  return corpusWorkIdentityKey(canonicalPath) ?? `location:${canonicalPath}`
}

export function normalizeSearchQuery(value: string): string | null {
  const terms = value
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/["'*:^(){}\[\]<>~+\-]/g, '').trim())
    .filter(Boolean)
    .slice(0, 12)

  if (terms.length === 0) return null
  return terms.map((term) => `"${term}"*`).join(' AND ')
}
