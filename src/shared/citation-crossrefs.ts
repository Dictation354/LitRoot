import type { PaperSection } from './contracts.js'

export interface NumberedReference {
  number: number
  text: string
}

export interface AuthorYearReferenceAlias {
  referenceNumber: number
  alias: string
  authors: string
  year: string
}

export type CitationTextPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'citation'
      text: string
      referenceNumbers: number[]
      targetNumber: number
    }

const REFERENCE_HEADING = /^(?:references|bibliography|works cited|literature cited)\b/i
const NUMBERED_REFERENCE =
  /^\s*(?:[-*\u2022]\s+)?(?:\[(\d{1,4})\](?:[.)])?|(\d{1,4})[.)])\s+(.+?)\s*$/
const CITATION = /\[(\d{1,4}(?:(?:\s*[,;]\s*|\s*[\u2013\u2014-]\s*)\d{1,4})*)\]/g

export function isReferenceSection(
  section: Pick<PaperSection, 'heading' | 'kind'>
): boolean {
  return /^(?:reference|references|bibliography)$/i.test(section.kind.trim()) ||
    REFERENCE_HEADING.test(section.heading.trim())
}

export function referenceAnchorId(referenceNumber: number): string {
  return `paper-reference-${referenceNumber}`
}

export function parseNumberedReferences(text: string): NumberedReference[] {
  const references: NumberedReference[] = []
  let current: NumberedReference | null = null

  const flush = (): void => {
    if (!current) return
    current.text = current.text.replace(/\s+/g, ' ').trim()
    if (current.text) references.push(current)
    current = null
  }

  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    const match = NUMBERED_REFERENCE.exec(line)
    if (match) {
      flush()
      current = {
        number: Number(match[1] ?? match[2]),
        text: match[3]?.trim() ?? ''
      }
      continue
    }

    if (line && current) current.text += ` ${line}`
  }

  flush()
  return references
}

export function numberStructuredReferences(
  references: ReadonlyArray<{ raw: string }>
): NumberedReference[] {
  return references.map((reference, index) => {
    const number = index + 1
    const matchingMarker = new RegExp(
      `^\\s*(?:\\[${number}\\](?:[.)])?|${number}[.)])\\s+`,
      'u'
    )
    return {
      number,
      text: reference.raw.replace(matchingMarker, '').trim()
    }
  })
}

export function collectReferenceNumbers(
  sections: ReadonlyArray<Pick<PaperSection, 'heading' | 'kind' | 'text'>>
): number[] {
  const numbers = new Set<number>()
  for (const section of sections) {
    if (!isReferenceSection(section)) continue
    for (const reference of parseNumberedReferences(section.text)) numbers.add(reference.number)
  }
  return [...numbers].sort((left, right) => left - right)
}

export function extractAuthorYearAliases(
  references: readonly NumberedReference[]
): AuthorYearReferenceAlias[] {
  const aliases: AuthorYearReferenceAlias[] = []
  const seen = new Set<string>()

  for (const reference of references) {
    const match = /\[([^\[\]\n]{1,120}?),\s*((?:19|20)\d{2}[a-z]?)\]\s*$/u.exec(
      reference.text
    )
    const authors = match?.[1]?.trim() ?? ''
    const year = match?.[2] ?? ''
    if (
      !authors ||
      !year ||
      !/\p{L}/u.test(authors) ||
      /https?:|[()[\]{}]|\d/u.test(authors)
    ) {
      continue
    }

    const alias = `${authors}, ${year}`
    const key = `${reference.number}\u0000${alias}`
    if (seen.has(key)) continue
    seen.add(key)
    aliases.push({ referenceNumber: reference.number, alias, authors, year })
  }

  return aliases
}

export function collectAuthorYearAliases(
  sections: ReadonlyArray<Pick<PaperSection, 'heading' | 'kind' | 'text'>>
): AuthorYearReferenceAlias[] {
  return extractAuthorYearAliases(
    sections.flatMap((section) =>
      isReferenceSection(section) ? parseNumberedReferences(section.text) : []
    )
  )
}

function citationNumbers(value: string): number[] | null {
  const numbers: number[] = []
  for (const item of value.split(/\s*[,;]\s*/)) {
    const range = /^(\d{1,4})\s*[\u2013\u2014-]\s*(\d{1,4})$/.exec(item)
    if (!range) {
      if (!/^\d{1,4}$/.test(item)) return null
      numbers.push(Number(item))
      continue
    }

    const start = Number(range[1])
    const end = Number(range[2])
    // Very wide numeric ranges are overwhelmingly likely to be years, array
    // bounds, or other data rather than a compact bibliography citation.
    if (end < start || end - start > 250 || (start >= 1000 && end >= 1000)) return null
    for (let number = start; number <= end; number += 1) numbers.push(number)
  }

  return [...new Set(numbers)]
}

interface ProtectedRange {
  start: number
  end: number
}

interface CitationCandidate {
  start: number
  end: number
  text: string
  referenceNumbers: number[]
  targetNumber: number
}

function protectedRanges(text: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = []
  const patterns = [
    /\$\$[\s\S]*?\$\$/g,
    /(?<!\\)\$(?!\$)(?:\\.|[^$\n])*?(?<!\\)\$/g,
    /\\\[[\s\S]*?\\\]/g,
    /\\\([\s\S]*?\\\)/g,
    /`+[^`\n]*?`+/g,
    /!?\[[^\]\n]*\]\([^\s)]+(?:\s+["'][^"']*["'])?\)/g,
    /<https?:\/\/[^>\s]+>/gi,
    /https?:\/\/[^\s<>]+/gi
  ]

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue
      ranges.push({ start: match.index, end: match.index + match[0].length })
    }
  }
  return ranges.sort((left, right) => left.start - right.start)
}

function intersectsProtectedRange(start: number, end: number, ranges: ProtectedRange[]): boolean {
  return ranges.some((range) => range.start < end && range.end > start)
}

function hasCitationBoundary(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] ?? '' : ''
  const after = end < text.length ? text[end] ?? '' : ''
  // This intentionally favors precision: bracketed array indices and path
  // components are left as prose instead of becoming misleading links.
  return !/[\p{L}\p{N}_\\/]/u.test(before) && !/[\p{L}\p{N}_/(]/u.test(after)
}

function numericCitationCandidates(
  text: string,
  available: ReadonlySet<number>,
  protectedTextRanges: ProtectedRange[]
): CitationCandidate[] {
  const candidates: CitationCandidate[] = []
  for (const match of text.matchAll(CITATION)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const numbers = citationNumbers(match[1] ?? '')
    if (
      !numbers ||
      numbers.length === 0 ||
      !numbers.every((number) => available.has(number)) ||
      !hasCitationBoundary(text, start, end) ||
      intersectsProtectedRange(start, end, protectedTextRanges)
    ) {
      continue
    }
    candidates.push({
      start,
      end,
      text: match[0],
      referenceNumbers: numbers,
      targetNumber: numbers[0]!
    })
  }
  return candidates
}

function aliasAuthorVariants(authors: string): string[] {
  const variants = new Set([authors])
  if (authors.includes(' and ')) variants.add(authors.replace(/ and /g, ' & '))
  if (authors.includes(' & ')) variants.add(authors.replace(/ & /g, ' and '))
  return [...variants]
}

function authorOccurrenceBoundary(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] ?? '' : ''
  const after = end < text.length ? text[end] ?? '' : ''
  return !/[\p{L}\p{N}_-]/u.test(before) && !/[\p{L}\p{N}_-]/u.test(after)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function referenceNumbersForYears(
  years: readonly string[],
  targetsByYear: ReadonlyMap<string, ReadonlySet<number>>
): number[] | null {
  const targets: number[] = []
  for (const year of years) {
    const candidates = targetsByYear.get(year)
    if (!candidates || candidates.size !== 1) return null
    targets.push([...candidates][0]!)
  }
  return [...new Set(targets)]
}

function authorYearCitationCandidates(
  text: string,
  available: ReadonlySet<number>,
  aliases: readonly AuthorYearReferenceAlias[],
  protectedTextRanges: ProtectedRange[]
): CitationCandidate[] {
  const byAuthors = new Map<string, {
    pattern: string
    targetsByYear: Map<string, Set<number>>
  }>()
  for (const alias of aliases) {
    if (!available.has(alias.referenceNumber)) continue
    for (const authors of aliasAuthorVariants(alias.authors)) {
      const canonicalAuthors = authors.normalize('NFKC').toLocaleLowerCase('en-US')
      let authorTargets = byAuthors.get(canonicalAuthors)
      if (!authorTargets) {
        authorTargets = { pattern: authors, targetsByYear: new Map() }
        byAuthors.set(canonicalAuthors, authorTargets)
      }
      let targets = authorTargets.targetsByYear.get(alias.year)
      if (!targets) {
        targets = new Set()
        authorTargets.targetsByYear.set(alias.year, targets)
      }
      targets.add(alias.referenceNumber)
    }
  }

  const candidates: CitationCandidate[] = []
  const yearsPattern = '((?:19|20)\\d{2}[a-z]?(?:\\s*,\\s*(?:19|20)\\d{2}[a-z]?)*)'
  for (const { pattern: authors, targetsByYear } of byAuthors.values()) {
    const authorPattern = new RegExp(escapeRegExp(authors), 'giu')
    for (const authorMatch of text.matchAll(authorPattern)) {
      const start = authorMatch.index ?? 0
      const authorEnd = start + authors.length
      if (!authorOccurrenceBoundary(text, start, authorEnd)) continue

      const tail = text.slice(authorEnd)
      // Some PDF extractions insert a sentence period between an otherwise
      // exact author alias and its year. Accept that one benign artifact only
      // after the alias has resolved to a unique stored reference.
      const parenthetical = new RegExp(`^\\.?\\s*,\\s*${yearsPattern}`, 'u').exec(tail)
      const narrative = new RegExp(`^\\.?\\s*\\(\\s*${yearsPattern}`, 'u').exec(tail)
      const match = parenthetical ?? narrative
      const rawYears = match?.[1]
      if (!match || !rawYears) continue

      const years = rawYears.split(/\s*,\s*/u)
      const referenceNumbers = referenceNumbersForYears(years, targetsByYear)
      if (!referenceNumbers || referenceNumbers.length === 0) continue

      let end = authorEnd + match[0].length
      if (narrative) {
        const close = /^\s*\)/u.exec(text.slice(end))
        if (close) end += close[0].length
        else if (!/^\s*[,)]/u.test(text.slice(end))) continue
      }
      if (intersectsProtectedRange(start, end, protectedTextRanges)) continue

      candidates.push({
        start,
        end,
        text: text.slice(start, end),
        referenceNumbers,
        targetNumber: referenceNumbers[0]!
      })
    }
  }
  return candidates
}

export function linkableCitationParts(
  text: string,
  referenceNumbers: ReadonlySet<number> | readonly number[],
  authorYearAliases: readonly AuthorYearReferenceAlias[] = [],
  options: { numeric?: boolean } = {}
): CitationTextPart[] {
  const available = referenceNumbers instanceof Set
    ? referenceNumbers
    : new Set(referenceNumbers)
  if (available.size === 0) return [{ kind: 'text', text }]

  const protectedTextRanges = protectedRanges(text)
  const candidates = [
    ...(options.numeric === false
      ? []
      : numericCitationCandidates(text, available, protectedTextRanges)),
    ...authorYearCitationCandidates(text, available, authorYearAliases, protectedTextRanges)
  ].sort((left, right) => left.start - right.start || right.end - left.end)
  const parts: CitationTextPart[] = []
  let cursor = 0

  for (const candidate of candidates) {
    if (candidate.start < cursor) continue
    if (candidate.start > cursor) {
      parts.push({ kind: 'text', text: text.slice(cursor, candidate.start) })
    }
    parts.push({
      kind: 'citation',
      text: candidate.text,
      referenceNumbers: candidate.referenceNumbers,
      targetNumber: candidate.targetNumber
    })
    cursor = candidate.end
  }

  if (cursor === 0) return [{ kind: 'text', text }]
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) })
  return parts
}
