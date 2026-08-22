import type {
  AgentPaperLocation,
  AgentPaperOutline,
  AgentPaperSelector,
  AgentReadSectionsRequest,
  AgentRootListResult,
  AgentSearchRequest,
  AgentSearchResult,
  AgentSectionContent,
  AgentSectionReadResult
} from './contracts.js'
import {
  DEFAULT_SECTION_CHARACTER_BUDGET,
  MAX_SECTION_CHARACTER_BUDGET
} from './contracts.js'
import { AgentRelayError } from './errors.js'
import { LibraryReader, type PaperSnapshot } from './library-reader.js'

const MAX_READ_METADATA_CHARACTERS = 12_000
const MAX_READ_SOURCE_TRAIL = 20
const MAX_READ_LOCATIONS = 10
const MAX_READ_SECTION_SELECTION = 50

interface MetadataLimiter {
  remaining: number
  truncated: boolean
}

function boundedMetadataText(value: string | null, limit: number, limiter: MetadataLimiter): string | null {
  if (value === null) return null
  const allowed = Math.max(0, Math.min(limit, limiter.remaining))
  const result = value.slice(0, allowed)
  if (result.length < value.length) limiter.truncated = true
  limiter.remaining -= result.length
  return result
}

function queryTerms(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .split(/[\s"'*:^(){}\[\]<>~+\-]+/u)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 12)
}

function countOccurrences(value: string, term: string): number {
  let count = 0
  let offset = 0
  while (offset < value.length) {
    const found = value.indexOf(term, offset)
    if (found < 0) break
    count += 1
    offset = found + Math.max(1, term.length)
  }
  return count
}

export class AgentLibraryService {
  constructor(readonly reader: LibraryReader) {}

  close(): void {
    this.reader.close()
  }

  listResearchRoots(): AgentRootListResult {
    return this.reader.listRoots()
  }

  searchLibrary(request: AgentSearchRequest): AgentSearchResult {
    return this.reader.search(request)
  }

  getPaperOutline(selector: AgentPaperSelector): AgentPaperOutline {
    return this.reader.getOutline(selector)
  }

  readPaperSections(request: AgentReadSectionsRequest): AgentSectionReadResult {
    const snapshot = this.reader.getSnapshot(request)
    if (request.revision && request.revision !== snapshot.revision) {
      throw new AgentRelayError(
        'STALE_REVISION',
        'The preferred paper representation changed after this outline was read.',
        { suppliedRevision: request.revision, currentRevision: snapshot.revision, paperId: snapshot.paperId }
      )
    }

    const requestedBudget = request.maxCharacters ?? DEFAULT_SECTION_CHARACTER_BUDGET
    if (!Number.isInteger(requestedBudget)) {
      throw new AgentRelayError('INVALID_ARGUMENT', 'maxCharacters must be an integer.', {
        maxCharacters: requestedBudget
      })
    }
    const maxCharacters = requestedBudget
    if (maxCharacters < 1 || maxCharacters > MAX_SECTION_CHARACTER_BUDGET) {
      throw new AgentRelayError(
        'INVALID_ARGUMENT',
        `maxCharacters must be between 1 and ${MAX_SECTION_CHARACTER_BUDGET}.`,
        { maxCharacters }
      )
    }

    if (request.sectionIndexes && request.sectionIndexes.length > MAX_READ_SECTION_SELECTION) {
      throw new AgentRelayError(
        'INVALID_ARGUMENT',
        `At most ${MAX_READ_SECTION_SELECTION} section indexes may be requested at once.`,
        { sectionIndexCount: request.sectionIndexes.length }
      )
    }
    if (request.sectionIndexes?.some((index) => !Number.isInteger(index) || index < 0)) {
      throw new AgentRelayError('INVALID_ARGUMENT', 'Section indexes must be non-negative integers.', null)
    }
    const requestedIndexes = request.sectionIndexes
      ? [...new Set(request.sectionIndexes)].sort((left, right) => left - right)
      : null
    const query = request.query?.trim() || null
    if (query && query.length > 500) {
      throw new AgentRelayError('INVALID_ARGUMENT', 'Section query must be 500 characters or fewer.', null)
    }
    if (requestedIndexes && requestedIndexes.length > 0 && query) {
      throw new AgentRelayError(
        'INVALID_ARGUMENT',
        'Choose sectionIndexes or query, but do not supply both.',
        null
      )
    }
    if ((!requestedIndexes || requestedIndexes.length === 0) && !query) {
      throw new AgentRelayError(
        'INVALID_ARGUMENT',
        'Choose at least one section index or provide a section query.',
        null
      )
    }

    const selected = requestedIndexes?.length
      ? this.sectionsByIndex(snapshot, requestedIndexes)
      : this.sectionsByQuery(snapshot, query ?? '')
    const sections: AgentSectionContent[] = []
    let remaining = maxCharacters
    let partiallyTruncated = false
    const metadata: MetadataLimiter = {
      remaining: MAX_READ_METADATA_CHARACTERS,
      truncated: snapshot.truncatedFields.length > 0 || snapshot.omittedLocationCount > 0
    }
    // Preserve paper identity before lower-priority provenance metadata consumes
    // the aggregate metadata allowance.
    const paperTitle = boundedMetadataText(
      typeof snapshot.row.title === 'string' ? snapshot.row.title : 'Untitled paper',
      500,
      metadata
    ) ?? 'Untitled paper'
    const paperDoi = boundedMetadataText(
      typeof snapshot.row.doi === 'string' ? snapshot.row.doi : null,
      500,
      metadata
    )
    const paperSource = boundedMetadataText(
      typeof snapshot.row.source === 'string' ? snapshot.row.source : null,
      200,
      metadata
    )

    for (const candidate of selected) {
      if (remaining <= 0) break
      const sectionText = candidate.text.slice(0, remaining)
      const truncated = sectionText.length < candidate.text.length
      sections.push({
        index: candidate.index,
        heading: boundedMetadataText(candidate.heading, 300, metadata) ?? '',
        level: candidate.level,
        kind: boundedMetadataText(candidate.kind, 100, metadata) ?? 'body',
        text: sectionText,
        characterCount: sectionText.length,
        truncated
      })
      remaining -= sectionText.length
      partiallyTruncated ||= truncated
    }

    const returnedCharacters = maxCharacters - remaining
    const omittedSectionCount = selected.length - sections.length
    const rawSourceTrail = this.stringArray(snapshot.row.source_trail_json)
    const selectedSourceTrail = rawSourceTrail.slice(0, MAX_READ_SOURCE_TRAIL)
    if (rawSourceTrail.length > selectedSourceTrail.length) metadata.truncated = true
    const sourceTrail = selectedSourceTrail.map(
      (item) => boundedMetadataText(item, 500, metadata) ?? ''
    )
    const selectedLocations = snapshot.locations.slice(0, MAX_READ_LOCATIONS)
    if (snapshot.locations.length > selectedLocations.length) metadata.truncated = true
    const locations = selectedLocations.map((location) => this.boundLocation(location, metadata))
    const omittedLocationCount =
      snapshot.omittedLocationCount + Math.max(0, snapshot.locations.length - selectedLocations.length)
    return {
      paper: {
        paperId: snapshot.paperId,
        rootId: snapshot.rootId,
        revision: snapshot.revision,
        doi: paperDoi,
        title: paperTitle,
        source: paperSource,
        contentKind:
          snapshot.row.content_kind === 'fulltext' || snapshot.row.content_kind === 'abstract_only'
            ? snapshot.row.content_kind
            : 'metadata_only'
      },
      provenance: {
        sourceTrail,
        locations,
        omittedSourceTrailCount: rawSourceTrail.length - selectedSourceTrail.length,
        omittedLocationCount
      },
      selection: {
        query,
        requestedIndexes,
        selectedSectionCount: selected.length,
        returnedSectionCount: sections.length,
        omittedSectionCount
      },
      budget: {
        maxCharacters,
        returnedCharacters,
        truncated: partiallyTruncated || omittedSectionCount > 0,
        metadataTruncated: metadata.truncated
      },
      sections
    }
  }

  private boundLocation(location: AgentPaperLocation, limiter: MetadataLimiter): AgentPaperLocation {
    return {
      rootId: boundedMetadataText(location.rootId, 200, limiter) ?? '',
      rootLabel: boundedMetadataText(location.rootLabel, 300, limiter) ?? '',
      rootPath: boundedMetadataText(location.rootPath, 1_024, limiter) ?? '',
      rootStatus: location.rootStatus,
      artifactPath: boundedMetadataText(location.artifactPath, 1_024, limiter) ?? '',
      relativePath: boundedMetadataText(location.relativePath, 1_024, limiter) ?? '',
      detector: boundedMetadataText(location.detector, 100, limiter) ?? '',
      modifiedAt: boundedMetadataText(location.modifiedAt, 100, limiter) ?? '',
      parseStatus: boundedMetadataText(location.parseStatus, 100, limiter) ?? ''
    }
  }

  private sectionsByIndex(
    snapshot: PaperSnapshot,
    indexes: number[]
  ): Array<PaperSnapshot['sections'][number] & { index: number }> {
    const invalid = indexes.filter((index) => index < 0 || index >= snapshot.sections.length)
    if (invalid.length > 0) {
      throw new AgentRelayError('SECTION_NOT_FOUND', 'One or more requested section indexes do not exist.', {
        paperId: snapshot.paperId,
        invalidIndexes: invalid,
        sectionCount: snapshot.sections.length
      })
    }
    return indexes.map((index) => ({ ...snapshot.sections[index]!, index }))
  }

  private sectionsByQuery(
    snapshot: PaperSnapshot,
    query: string
  ): Array<PaperSnapshot['sections'][number] & { index: number }> {
    const terms = queryTerms(query)
    if (terms.length === 0) {
      throw new AgentRelayError('INVALID_ARGUMENT', 'Section query must contain a searchable term.', null)
    }
    const ranked = snapshot.sections.flatMap((section, index) => {
      const heading = section.heading.toLocaleLowerCase()
      const body = section.text.toLocaleLowerCase()
      const combined = `${heading}\n${body}`
      if (!terms.every((term) => combined.includes(term))) return []
      const score = terms.reduce(
        (total, term) => total + countOccurrences(heading, term) * 20 + countOccurrences(body, term),
        0
      )
      return [{ ...section, index, score }]
    })
    if (ranked.length === 0) {
      throw new AgentRelayError('SECTION_NOT_FOUND', 'No section matches the supplied query.', {
        paperId: snapshot.paperId,
        query
      })
    }
    return ranked
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, 50)
      .sort((left, right) => left.index - right.index)
      .map(({ score: _score, ...section }) => section)
  }

  private stringArray(value: unknown): string[] {
    if (typeof value !== 'string') return []
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }
}
