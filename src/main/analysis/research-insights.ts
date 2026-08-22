import type {
  DigestItem,
  InsightEvidence,
  InsightEvidenceSource,
  InsightKind,
  PaperDigest,
  ResearchGraphEdge,
  ResearchGraphEdgeKind,
  ResearchGraphNode,
  ResearchGraphNodeKind,
  ResearchLandscape,
  ResearchSignal
} from '../../shared/contracts.js'
import { isReferenceSection } from '../../shared/citation-crossrefs.js'
import type { AnalysisPaperSnapshot } from '../domain.js'
import { normalizeDoi, stableId } from '../ingest/identity.js'

export const MAX_LANDSCAPE_PAPERS = 200
export const MAX_INSIGHT_QUOTE_CHARACTERS = 600

const MAX_GRAPH_NODES = 500
const MAX_GRAPH_EDGES = 1_000
const MAX_GRAPH_EVIDENCE = 500
const MAX_RESEARCH_SIGNALS = 200
const MAX_EXTERNAL_REFERENCE_NODES = 12
const MAX_SECTIONS_PER_PAPER = 300
const MAX_SENTENCES_PER_SOURCE = 120
const MAX_SENTENCES_PER_PAPER = 1_600

const DIGEST_DISCLAIMER =
  'This is a deterministic extractive digest of the indexed representation. It does not establish novelty, consensus, or truth; verify important claims in the source and check the external literature.'
const LANDSCAPE_DISCLAIMER =
  'Author-stated items quote indexed papers. Local-corpus hypotheses and coverage gaps describe only this selected PaperRelay scope. Novelty and whether a proposed gap remains open require external literature checking.'

const KIND_ORDER: InsightKind[] = ['purpose', 'method', 'finding', 'limitation', 'future_work']
const KIND_LIMIT: Record<InsightKind, number> = {
  purpose: 1,
  method: 1,
  finding: 2,
  limitation: 2,
  future_work: 2
}

const EXCLUDED_SECTION =
  /(?:references?|bibliograph|acknowledg|author contributions?|conflicts?|competing interests?|declarations?|funding|data availability|code availability|supplement|peer review|glossar)/iu
const ABSTRACT_SECTION = /(?:abstract|summary)/iu
const PURPOSE_SECTION = /(?:abstract|introduction|background|objective|aim|research question)/iu
const METHOD_SECTION = /(?:methods?|materials?|study design|experimental|implementation|approach|data and methods)/iu
const FINDING_SECTION = /(?:results?|findings?|discussion|conclusions?|summary)/iu
const LIMITATION_SECTION = /(?:limitations?|constraints?|caveats?|threats? to validity)/iu
const FUTURE_SECTION = /(?:future|outlook|further work|research agenda|next steps?)/iu

const PURPOSE_CUE =
  /\b(?:we (?:aim|aimed|seek|sought|investigate|investigated|examine|examined|evaluate|evaluated|assess|assessed|study|studied|test|tested)|this (?:study|paper|work|research) (?:aims?|investigates?|examines?|evaluates?|assesses?|tests?|presents?|proposes?)|our (?:aim|goal|objective)|the (?:aim|goal|objective) (?:is|was))\b/iu
const METHOD_CUE =
  /\b(?:we (?:use|used|apply|applied|develop|developed|analy[sz]e|analy[sz]ed|measure|measured|estimate|estimated)|this (?:study|paper|work) (?:uses?|applies?|develops?)|our (?:method|approach|analysis|model)|data (?:were|was) (?:collected|analy[sz]ed)|participants? (?:were|was)|using (?:a|an|the)\b)/iu
const FINDING_CUE =
  /\b(?:we (?:find|found|show|showed|observe|observed|demonstrate|demonstrated|report|reported)|(?:the |our )?results? (?:show|showed|indicate|indicated|demonstrate|demonstrated|suggest|suggested)|our findings?|we conclude|this (?:study|work) (?:shows?|demonstrates?|finds?))\b/iu
const LIMITATION_CUE =
  /\b(?:limitations?|limited by|constraints?|caveats?|shortcomings?|uncertaint(?:y|ies)|potential bias|lack(?:s|ed|ing)?|remain(?:s|ed)? (?:unclear|unknown|unresolved)|has not yet been studied|have not yet been studied|not yet (?:been )?(?:studied|examined|investigated|evaluated|understood))\b/iu
const FUTURE_CUE =
  /\b(?:future (?:work|research|studies|study|release|development)|further (?:work|research|studies|study|investigation|analysis)|future versions?|future releases?|remains? to be (?:studied|examined|investigated|evaluated|validated|understood)|should be (?:studied|examined|investigated|evaluated|validated|explored|tested)|warrants? (?:further|additional)|need(?:s|ed)? (?:further|additional) (?:research|study|investigation|analysis|validation|testing)|open (?:research )?questions?|we (?:plan|propose) to|planned for (?:a )?future release)\b/iu

const RESOLVED_GAP =
  /\b(?:fill|fills|filled|close|closes|closed|address|addresses|addressed|bridge|bridges|bridged)\s+(?:this |the |a )?(?:knowledge |research )?gap\b/iu
const NEGATED_GAP =
  /\b(?:not (?:a |an |the )?limitation|no further research (?:is|was) needed|not an open question)\b/iu
const NON_RESEARCH_GAP =
  /\b(?:band gap|air gap|time gap|temporal gap|spatial gap|gap in (?:the )?(?:landscape|record|series|coverage))\b/iu
const CAPTION_LIKE = /^(?:fig(?:ure)?|table|box|scheme|equation|appendix)\s*[.:#\d]/iu

interface TextSource {
  source: 'section' | 'abstract'
  sourceIndex: number | null
  sectionIndex: number | null
  heading: string | null
  kind: string | null
  text: string
  sourceOrder: number
}

interface Candidate {
  source: TextSource
  sentenceOrder: number
  start: number
  end: number
  score: number
}

interface SentenceSpan {
  start: number
  end: number
}

interface LandscapeOptions {
  paperCount?: number
  rootId?: string | null
}

function comparable(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

function idKey(...parts: Array<string | number | null | undefined>): string {
  return parts.map((part) => part == null ? '' : String(part)).join('\0')
}

function analysisRevision(paper: AnalysisPaperSnapshot): string {
  return stableId(
    'revision',
    idKey(paper.paperId, paper.documentId, paper.fingerprint, paper.rootId ?? 'global')
  )
}

function trimSpan(text: string, startValue: number, endValue: number): SentenceSpan | null {
  let start = startValue
  let end = endValue
  while (start < end && /\s/u.test(text[start] ?? '')) start += 1
  while (end > start && /\s/u.test(text[end - 1] ?? '')) end -= 1
  return end > start ? { start, end } : null
}

function sentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = []
  const boundary = /(?:[.!?。！？]+["'”’）)\]]*|\n{2,})/gu
  let start = 0
  for (const match of text.matchAll(boundary)) {
    const end = (match.index ?? 0) + match[0].length
    const span = trimSpan(text, start, end)
    if (span) spans.push(span)
    start = end
    if (spans.length >= MAX_SENTENCES_PER_SOURCE) return spans
  }
  const finalSpan = trimSpan(text, start, text.length)
  if (finalSpan && spans.length < MAX_SENTENCES_PER_SOURCE) spans.push(finalSpan)
  return spans
}

function isCitationDenseOrReferenceShaped(text: string): boolean {
  if (/\bdoi\s*:\s*10\.|https?:\/\/doi\.org\/10\./iu.test(text)) return true
  const numericCitations = text.match(/\[\s*\d{1,4}(?:\s*[,;–—-]\s*\d{1,4})*\s*\]/gu)?.length ?? 0
  const authorYearCitations = text.match(/\([^)]{0,100}(?:19|20)\d{2}[a-z]?[^)]*\)/gu)?.length ?? 0
  return numericCitations + authorYearCitations >= 3
}

function sourceLabel(source: TextSource): string {
  return `${source.heading ?? ''} ${source.kind ?? ''}`.trim()
}

function sourceAnalysisPriority(source: TextSource): number {
  if (source.source === 'abstract') return 0
  const label = sourceLabel(source)
  if (FUTURE_SECTION.test(label) || LIMITATION_SECTION.test(label)) return 1
  if (PURPOSE_SECTION.test(label) || METHOD_SECTION.test(label) || FINDING_SECTION.test(label)) {
    return 2
  }
  return 3
}

function textSources(paper: AnalysisPaperSnapshot): TextSource[] {
  if (paper.contentKind === 'metadata_only') return []

  const sources: TextSource[] = []
  for (const [sectionIndex, section] of paper.sections.slice(0, MAX_SECTIONS_PER_PAPER).entries()) {
    const label = `${section.heading} ${section.kind}`
    if (isReferenceSection(section) || EXCLUDED_SECTION.test(label)) continue
    if (paper.contentKind === 'abstract_only' && !ABSTRACT_SECTION.test(label)) continue
    sources.push({
      source: 'section',
      sourceIndex: sectionIndex,
      sectionIndex,
      heading: section.heading,
      kind: section.kind,
      text: section.text,
      sourceOrder: sectionIndex
    })
  }

  if (paper.abstract) {
    const abstractKey = comparable(paper.abstract)
    const duplicate = sources.some(
      (source) => ABSTRACT_SECTION.test(sourceLabel(source)) && comparable(source.text) === abstractKey
    )
    if (!duplicate) {
      sources.unshift({
        source: 'abstract',
        sourceIndex: null,
        sectionIndex: null,
        heading: 'Abstract',
        kind: 'abstract',
        text: paper.abstract,
        sourceOrder: -1
      })
    }
  }
  return sources
}

function candidateScore(kind: InsightKind, source: TextSource, span: SentenceSpan, order: number): number {
  const sentence = source.text.slice(span.start, span.end)
  const label = sourceLabel(source)
  if (sentence.length < 24 || CAPTION_LIKE.test(sentence) || isCitationDenseOrReferenceShaped(sentence)) {
    return Number.NEGATIVE_INFINITY
  }
  if ((kind === 'limitation' || kind === 'future_work') &&
      (RESOLVED_GAP.test(sentence) || NEGATED_GAP.test(sentence) || NON_RESEARCH_GAP.test(sentence))) {
    return Number.NEGATIVE_INFINITY
  }

  let score = Math.max(0, 3 - order * 0.05)
  if (source.source === 'abstract') score += 2
  switch (kind) {
    case 'purpose': {
      const cue = PURPOSE_CUE.test(sentence)
      const section = PURPOSE_SECTION.test(label)
      if (!cue && !(section && order === 0)) return Number.NEGATIVE_INFINITY
      return score + (cue ? 8 : 0) + (section ? 4 : 0)
    }
    case 'method': {
      const cue = METHOD_CUE.test(sentence)
      const section = METHOD_SECTION.test(label)
      if (!cue && !section) return Number.NEGATIVE_INFINITY
      if (
        /\bet al\.?\s+(?:use|used|apply|applied|develop|developed)\b/iu.test(sentence) &&
        !/\b(?:we|our|this (?:study|paper|work))\b/iu.test(sentence)
      ) {
        return Number.NEGATIVE_INFINITY
      }
      return score + (cue ? 8 : 0) + (section ? 5 : 0)
    }
    case 'finding': {
      const cue = FINDING_CUE.test(sentence)
      const section = FINDING_SECTION.test(label)
      if (!cue && !section) return Number.NEGATIVE_INFINITY
      return score + (cue ? 8 : 0) + (section ? 5 : 0)
    }
    case 'limitation': {
      const cue = LIMITATION_CUE.test(sentence)
      const section = LIMITATION_SECTION.test(label)
      if (!cue && !section) return Number.NEGATIVE_INFINITY
      return score + (cue ? 9 : 0) + (section ? 6 : 0)
    }
    case 'future_work': {
      const cue = FUTURE_CUE.test(sentence)
      if (!cue) return Number.NEGATIVE_INFINITY
      return score + 10 + (FUTURE_SECTION.test(label) ? 6 : 0)
    }
  }
}

function boundedSpan(source: TextSource, span: SentenceSpan): SentenceSpan & { truncated: boolean } {
  if (span.end - span.start <= MAX_INSIGHT_QUOTE_CHARACTERS) {
    return { ...span, truncated: false }
  }
  const maximumEnd = span.start + MAX_INSIGHT_QUOTE_CHARACTERS
  const candidate = source.text.slice(span.start, maximumEnd)
  const finalWhitespace = candidate.lastIndexOf(' ')
  const end = finalWhitespace >= 360 ? span.start + finalWhitespace : maximumEnd
  return { start: span.start, end, truncated: true }
}

function evidenceForSpan(
  paper: AnalysisPaperSnapshot,
  source: TextSource,
  span: SentenceSpan
): InsightEvidence {
  const bounded = boundedSpan(source, span)
  const quote = source.text.slice(bounded.start, bounded.end)
  const revision = analysisRevision(paper)
  const id = stableId(
    'evidence',
    idKey(
      paper.paperId,
      paper.rootId ?? 'global',
      revision,
      source.source,
      source.sourceIndex,
      bounded.start,
      bounded.end
    )
  )
  return {
    id,
    source: source.source,
    paperId: paper.paperId,
    rootId: paper.rootId,
    revision,
    sectionIndex: source.sectionIndex,
    sectionHeading: source.heading,
    sectionKind: source.kind,
    sourceIndex: source.sourceIndex,
    startOffset: bounded.start,
    endOffset: bounded.end,
    quote,
    truncated: bounded.truncated
  }
}

function scalarEvidence(
  paper: AnalysisPaperSnapshot,
  source: Exclude<InsightEvidenceSource, 'section' | 'abstract'>,
  sourceIndex: number,
  value: string
): InsightEvidence {
  const end = Math.min(value.length, MAX_INSIGHT_QUOTE_CHARACTERS)
  const revision = analysisRevision(paper)
  return {
    id: stableId(
      'evidence',
      idKey(paper.paperId, paper.rootId ?? 'global', revision, source, sourceIndex, 0, end)
    ),
    source,
    paperId: paper.paperId,
    rootId: paper.rootId,
    revision,
    sectionIndex: null,
    sectionHeading: null,
    sectionKind: null,
    sourceIndex,
    startOffset: 0,
    endOffset: end,
    quote: value.slice(0, end),
    truncated: end < value.length
  }
}

export function buildPaperDigest(paper: AnalysisPaperSnapshot): PaperDigest {
  const sources = textSources(paper)
  const candidates = new Map<InsightKind, Candidate[]>(KIND_ORDER.map((kind) => [kind, []]))
  const prioritizedSources = [...sources].sort(
    (left, right) =>
      sourceAnalysisPriority(left) - sourceAnalysisPriority(right) ||
      left.sourceOrder - right.sourceOrder
  )
  let remainingSentenceBudget = MAX_SENTENCES_PER_PAPER
  for (const source of prioritizedSources) {
    for (const [sentenceOrder, span] of sentenceSpans(source.text).entries()) {
      if (remainingSentenceBudget <= 0) break
      remainingSentenceBudget -= 1
      for (const kind of KIND_ORDER) {
        const score = candidateScore(kind, source, span, sentenceOrder)
        if (Number.isFinite(score)) {
          candidates.get(kind)?.push({ source, sentenceOrder, ...span, score })
        }
      }
    }
    if (remainingSentenceBudget <= 0) break
  }

  const items: DigestItem[] = []
  const evidence: InsightEvidence[] = []
  const usedText = new Set<string>()
  for (const kind of KIND_ORDER) {
    const ranked = [...(candidates.get(kind) ?? [])].sort(
      (left, right) =>
        right.score - left.score ||
        left.source.sourceOrder - right.source.sourceOrder ||
        left.start - right.start
    )
    for (const candidate of ranked) {
      if (items.filter((item) => item.kind === kind).length >= KIND_LIMIT[kind]) break
      const selectedEvidence = evidenceForSpan(paper, candidate.source, candidate)
      const key = comparable(selectedEvidence.quote)
      if (!key || usedText.has(key)) continue
      usedText.add(key)
      evidence.push(selectedEvidence)
      items.push({
        id: stableId('digest', idKey(kind, selectedEvidence.id)),
        kind,
        text: selectedEvidence.quote,
        evidenceId: selectedEvidence.id
      })
    }
  }

  const availableKinds = KIND_ORDER.filter((kind) => items.some((item) => item.kind === kind))
  const missingKinds = KIND_ORDER.filter((kind) => !availableKinds.includes(kind))
  const limited = paper.contentKind !== 'fulltext' || missingKinds.length > 0
  let message: string | null = null
  if (paper.contentKind === 'metadata_only') {
    message = 'No readable abstract or full text is available, so PaperRelay did not infer a digest.'
  } else if (paper.contentKind === 'abstract_only') {
    message = 'Only abstract evidence was analyzed; methods, limitations, and future work may be absent.'
  } else if (missingKinds.length > 0) {
    message = `No explicit extractive evidence was detected for: ${missingKinds.join(', ')}.`
  }

  return {
    paperId: paper.paperId,
    rootId: paper.rootId,
    revision: analysisRevision(paper),
    title: paper.title,
    items,
    evidence,
    coverage: {
      contentKind: paper.contentKind,
      availableKinds,
      missingKinds,
      limited,
      message
    },
    disclaimer: DIGEST_DISCLAIMER
  }
}

function graphNodeId(kind: ResearchGraphNodeKind, key: string): string {
  return stableId('node', idKey(kind, key))
}

function graphEdgeId(kind: ResearchGraphEdgeKind, sourceId: string, targetId: string): string {
  return stableId('edge', idKey(kind, sourceId, targetId))
}

function normalizedKeyword(value: string): string | null {
  const normalized = value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .trim()
    .toLocaleLowerCase()
  return normalized && normalized.length <= 120 ? normalized : null
}

export function buildResearchLandscape(
  paperValues: readonly AnalysisPaperSnapshot[],
  options: LandscapeOptions = {}
): ResearchLandscape {
  const papers = [...paperValues]
    .sort((left, right) => left.paperId.localeCompare(right.paperId))
    .slice(0, MAX_LANDSCAPE_PAPERS)
  const paperCount = Math.max(options.paperCount ?? paperValues.length, papers.length)
  const nodes = new Map<string, ResearchGraphNode>()
  const edges = new Map<string, ResearchGraphEdge>()
  const evidence = new Map<string, InsightEvidence>()
  const signals = new Map<string, ResearchSignal>()
  let omittedNodeCount = 0
  let omittedEdgeCount = 0
  let omittedEvidenceCount = papers.reduce(
    (total, paper) => total + Math.max(0, paper.referenceCount - paper.references.length),
    0
  )

  const addEvidence = (value: InsightEvidence): boolean => {
    if (evidence.has(value.id)) return true
    if (evidence.size >= MAX_GRAPH_EVIDENCE) {
      omittedEvidenceCount += 1
      return false
    }
    evidence.set(value.id, value)
    return true
  }
  const addNode = (value: ResearchGraphNode): boolean => {
    const existing = nodes.get(value.id)
    if (existing) {
      existing.evidenceIds = [...new Set([...existing.evidenceIds, ...value.evidenceIds])].sort()
      return true
    }
    if (nodes.size >= MAX_GRAPH_NODES) {
      omittedNodeCount += 1
      return false
    }
    nodes.set(value.id, value)
    return true
  }
  const addEdge = (value: ResearchGraphEdge): boolean => {
    const existing = edges.get(value.id)
    if (existing) {
      existing.evidenceIds = [...new Set([...existing.evidenceIds, ...value.evidenceIds])].sort()
      return true
    }
    if (edges.size >= MAX_GRAPH_EDGES) {
      omittedEdgeCount += 1
      return false
    }
    edges.set(value.id, value)
    return true
  }
  const addSignal = (value: ResearchSignal): void => {
    if (signals.has(value.id)) return
    if (signals.size >= MAX_RESEARCH_SIGNALS) {
      omittedEvidenceCount += Math.max(1, value.evidenceIds.length)
      return
    }
    signals.set(value.id, value)
  }

  const paperNodeIds = new Map<string, string>()
  const papersByDoi = new Map<string, AnalysisPaperSnapshot>()
  const topicPapers = new Map<string, Set<string>>()
  const topicEvidence = new Map<string, Set<string>>()
  const topicLabels = new Map<string, string>()
  const opportunityEvidenceByPaper = new Map<string, Set<string>>()
  const includedExternalDois = new Set<string>()
  const externalCoverage = new Map<
    string,
    { label: string; paperIds: Set<string>; evidenceIds: Set<string> }
  >()

  for (const paper of papers) {
    const paperNodeId = graphNodeId('paper', paper.paperId)
    paperNodeIds.set(paper.paperId, paperNodeId)
    addNode({
      id: paperNodeId,
      kind: 'paper',
      label: paper.title,
      paperId: paper.paperId,
      doi: paper.doi,
      year: paper.year,
      evidenceIds: []
    })
    const doi = normalizeDoi(paper.doi)
    if (doi) papersByDoi.set(doi, paper)

    const digest = buildPaperDigest(paper)
    for (const item of digest.items) {
      if (item.kind !== 'finding' && item.kind !== 'limitation' && item.kind !== 'future_work') continue
      const itemEvidence = digest.evidence.find((candidate) => candidate.id === item.evidenceId)
      if (!itemEvidence || !addEvidence(itemEvidence)) continue
      const nodeKind: ResearchGraphNodeKind = item.kind
      const nodeId = graphNodeId(nodeKind, idKey(paper.paperId, item.id))
      if (!addNode({
        id: nodeId,
        kind: nodeKind,
        label: item.text,
        paperId: paper.paperId,
        doi: null,
        year: paper.year,
        evidenceIds: [item.evidenceId]
      })) continue
      const edgeKind: ResearchGraphEdgeKind =
        item.kind === 'finding'
          ? 'reports_finding'
          : item.kind === 'limitation'
            ? 'states_limitation'
            : 'proposes_future_work'
      addEdge({
        id: graphEdgeId(edgeKind, paperNodeId, nodeId),
        kind: edgeKind,
        sourceId: paperNodeId,
        targetId: nodeId,
        evidenceIds: [item.evidenceId]
      })

      if (item.kind === 'limitation' || item.kind === 'future_work') {
        const related = opportunityEvidenceByPaper.get(paper.paperId) ?? new Set<string>()
        related.add(item.evidenceId)
        opportunityEvidenceByPaper.set(paper.paperId, related)
        const label = item.kind === 'limitation' ? 'Author-stated limitation' : 'Author-stated future work'
        addSignal({
          id: stableId('signal', idKey('author_stated', paper.paperId, item.id)),
          basis: 'author_stated',
          title: label,
          statement: item.text,
          rationale:
            'This wording is quoted from the indexed paper. It does not prove that the limitation or proposed direction remains unresolved.',
          paperIds: [paper.paperId],
          evidenceIds: [item.evidenceId],
          noveltyRequiresExternalChecking: true
        })
      }
    }

    for (const [keywordIndex, rawKeyword] of paper.keywords.entries()) {
      const keyword = normalizedKeyword(rawKeyword)
      if (!keyword) continue
      const keywordEvidence = scalarEvidence(paper, 'keyword', keywordIndex, rawKeyword)
      if (!addEvidence(keywordEvidence)) continue
      const topicNodeId = graphNodeId('topic', keyword)
      topicLabels.set(keyword, rawKeyword.trim())
      const linkedPapers = topicPapers.get(keyword) ?? new Set<string>()
      linkedPapers.add(paper.paperId)
      topicPapers.set(keyword, linkedPapers)
      const linkedEvidence = topicEvidence.get(keyword) ?? new Set<string>()
      linkedEvidence.add(keywordEvidence.id)
      topicEvidence.set(keyword, linkedEvidence)
      if (!addNode({
        id: topicNodeId,
        kind: 'topic',
        label: rawKeyword.trim(),
        paperId: null,
        doi: null,
        year: null,
        evidenceIds: [keywordEvidence.id]
      })) continue
      addEdge({
        id: graphEdgeId('has_topic', paperNodeId, topicNodeId),
        kind: 'has_topic',
        sourceId: paperNodeId,
        targetId: topicNodeId,
        evidenceIds: [keywordEvidence.id]
      })
    }
  }

  for (const paper of papers) {
    const sourceNodeId = paperNodeIds.get(paper.paperId)
    if (!sourceNodeId) continue
    for (const [referenceIndex, reference] of paper.references.entries()) {
      const doi = normalizeDoi(reference.doi)
      if (!doi) continue
      const targetPaper = papersByDoi.get(doi)
      if (
        !targetPaper &&
        !includedExternalDois.has(doi) &&
        includedExternalDois.size >= MAX_EXTERNAL_REFERENCE_NODES
      ) {
        omittedNodeCount += 1
        omittedEdgeCount += 1
        omittedEvidenceCount += 1
        continue
      }
      const referenceEvidence = scalarEvidence(paper, 'reference', referenceIndex, reference.raw)
      if (!addEvidence(referenceEvidence)) continue
      const targetNodeId = targetPaper
        ? paperNodeIds.get(targetPaper.paperId)
        : graphNodeId('external_reference', doi)
      if (!targetNodeId) continue
      if (!targetPaper && !addNode({
        id: targetNodeId,
        kind: 'external_reference',
        label: reference.title?.trim() || doi,
        paperId: null,
        doi,
        year: reference.year,
        evidenceIds: [referenceEvidence.id]
      })) continue
      if (!targetPaper) includedExternalDois.add(doi)
      addEdge({
        id: graphEdgeId('cites', sourceNodeId, targetNodeId),
        kind: 'cites',
        sourceId: sourceNodeId,
        targetId: targetNodeId,
        evidenceIds: [referenceEvidence.id]
      })
      if (!targetPaper) {
        const coverage = externalCoverage.get(doi) ?? {
          label: reference.title?.trim() || doi,
          paperIds: new Set<string>(),
          evidenceIds: new Set<string>()
        }
        coverage.paperIds.add(paper.paperId)
        coverage.evidenceIds.add(referenceEvidence.id)
        externalCoverage.set(doi, coverage)
      }
    }
  }

  for (const [doi, coverage] of [...externalCoverage.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const paperIds = [...coverage.paperIds].sort()
    if (paperIds.length < 2) continue
    const evidenceIds = [...coverage.evidenceIds].sort()
    addSignal({
      id: stableId('signal', idKey('local_coverage_gap', doi, ...paperIds)),
      basis: 'local_coverage_gap',
      title: 'Cited paper missing from this local scope',
      statement:
        `${coverage.label} (${doi}) is cited by ${paperIds.length} indexed ` +
        `${paperIds.length === 1 ? 'paper' : 'papers'}, but that DOI is not indexed in this selected PaperRelay scope.`,
      rationale:
        'This is only a local library coverage gap. Reading the cited work may change any apparent research opportunity.',
      paperIds,
      evidenceIds,
      noveltyRequiresExternalChecking: true
    })
  }

  for (const [topic, linkedPapersValue] of [...topicPapers.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const linkedPapers = [...linkedPapersValue].sort()
    if (linkedPapers.length < 2) continue
    const opportunityEvidence = linkedPapers.flatMap((paperId) => [
      ...(opportunityEvidenceByPaper.get(paperId) ?? [])
    ])
    if (opportunityEvidence.length === 0) continue
    const evidenceIds = [
      ...(topicEvidence.get(topic) ?? []),
      ...opportunityEvidence
    ].filter((id, index, values) => values.indexOf(id) === index).sort()
    addSignal({
      id: stableId('signal', idKey('local_corpus_hypothesis', topic, ...linkedPapers)),
      basis: 'local_corpus_hypothesis',
      title: `Local research signal around ${topicLabels.get(topic) ?? topic}`,
      statement:
        `${linkedPapers.length} papers in this selected scope share the exact indexed keyword ` +
        `“${topicLabels.get(topic) ?? topic}”, and at least one contains an explicit limitation or future-work statement.`,
      rationale:
        'This deterministic co-occurrence is a hypothesis from the local indexed corpus, not evidence of novelty, consensus, or an unresolved global research gap.',
      paperIds: linkedPapers,
      evidenceIds,
      noveltyRequiresExternalChecking: true
    })
  }

  const omittedPaperCount = Math.max(0, paperCount - papers.length)
  const truncation = {
    truncated:
      omittedPaperCount > 0 ||
      omittedNodeCount > 0 ||
      omittedEdgeCount > 0 ||
      omittedEvidenceCount > 0,
    omittedPaperCount,
    omittedNodeCount,
    omittedEdgeCount,
    omittedEvidenceCount
  }
  return {
    rootId: options.rootId ?? papers[0]?.rootId ?? null,
    paperCount,
    analyzedPaperCount: papers.filter((paper) => paper.contentKind !== 'metadata_only').length,
    nodes: [...nodes.values()].sort(
      (left, right) => left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
    ),
    edges: [...edges.values()].sort(
      (left, right) => left.kind.localeCompare(right.kind) || left.sourceId.localeCompare(right.sourceId) || left.targetId.localeCompare(right.targetId)
    ),
    evidence: [...evidence.values()].sort((left, right) => left.id.localeCompare(right.id)),
    signals: [...signals.values()].sort(
      (left, right) => left.basis.localeCompare(right.basis) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
    ),
    truncation,
    noveltyRequiresExternalChecking: true,
    disclaimer: LANDSCAPE_DISCLAIMER
  }
}
