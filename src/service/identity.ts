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

export function doiFromInput(value: unknown): string | null {
  const direct = normalizeDoi(value)
  if (direct || typeof value !== 'string') return direct
  const embedded = value.match(/10\.\d{4,9}\/[^\s"'<>]+/i)?.[0]
  return embedded ? normalizeDoi(embedded) : null
}

export function canonicalHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    url.protocol = url.protocol.toLowerCase()
    url.hostname = url.hostname.toLowerCase()
    url.hash = ''
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = ''
    }
    const kept = [...url.searchParams.entries()]
      .filter(([key]) => !/^utm_/i.test(key) && !['fbclid', 'gclid'].includes(key.toLowerCase()))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        `${leftKey}\0${leftValue}`.localeCompare(`${rightKey}\0${rightValue}`)
      )
    url.search = ''
    for (const [key, item] of kept) url.searchParams.append(key, item)
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch {
    return null
  }
}

export function stableId(prefix: string, identity: string): string {
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24)
  return `${prefix}_${digest}`
}

export function paperIdFor(
  doi: string | null,
  sourceUrl: string | null,
  relativePath: string
): string {
  const identity = doi
    ? `doi:${doi}`
    : sourceUrl
      ? `url:${sourceUrl}`
      : `path:${relativePath.replaceAll('\\', '/')}`
  return stableId('paper', identity)
}

export function safeFtsQuery(value: string): string | null {
  const terms = value
    .normalize('NFKC')
    .trim()
    .split(/\s+/u)
    .map((term) => term.replace(/["'*:^(){}\[\]<>~+\-]/g, '').trim())
    .filter(Boolean)
    .slice(0, 16)
  if (terms.length === 0) return null
  return terms.map((term) => `"${term}"*`).join(' AND ')
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}
