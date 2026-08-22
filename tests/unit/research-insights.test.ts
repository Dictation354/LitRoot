import { describe, expect, it } from 'vitest'
import {
  buildPaperDigest,
  buildResearchLandscape,
  MAX_INSIGHT_QUOTE_CHARACTERS
} from '../../src/main/analysis/research-insights.js'
import type { AnalysisPaperSnapshot } from '../../src/main/domain.js'

function snapshot(
  overrides: Partial<AnalysisPaperSnapshot> & Pick<AnalysisPaperSnapshot, 'paperId' | 'title'>
): AnalysisPaperSnapshot {
  return {
    paperId: overrides.paperId,
    documentId: overrides.documentId ?? `document-${overrides.paperId}`,
    fingerprint: overrides.fingerprint ?? `fingerprint-${overrides.paperId}`,
    rootId: overrides.rootId ?? 'root-one',
    title: overrides.title,
    doi: overrides.doi ?? null,
    year: overrides.year ?? '2026',
    contentKind: overrides.contentKind ?? 'fulltext',
    abstract: overrides.abstract ?? null,
    keywords: overrides.keywords ?? [],
    sections: overrides.sections ?? [],
    references: overrides.references ?? [],
    referenceCount: overrides.referenceCount ?? overrides.references?.length ?? 0,
    referencesTruncated: overrides.referencesTruncated ?? false
  }
}

function evidenceSource(paper: AnalysisPaperSnapshot, evidence: ReturnType<typeof buildPaperDigest>['evidence'][number]): string {
  if (evidence.source === 'abstract') return paper.abstract ?? ''
  if (evidence.source === 'section' && evidence.sectionIndex !== null) {
    return paper.sections[evidence.sectionIndex]?.text ?? ''
  }
  return ''
}

describe('deterministic research insights', () => {
  it('extracts bounded evidence with exact offsets while rejecting common false positives', () => {
    const paper = snapshot({
      paperId: 'paper-extractive',
      title: 'Extractive Research Signals',
      abstract:
        'This study investigates reliable local evidence maps. We found that exact provenance improves review quality.',
      keywords: ['research maps'],
      sections: [
        {
          heading: 'Abstract',
          level: 1,
          kind: 'abstract',
          text:
            'This study investigates reliable local evidence maps. We found that exact provenance improves review quality.'
        },
        {
          heading: 'Introduction',
          level: 1,
          kind: 'body',
          text: 'Smith et al. used a remote classifier in earlier work.'
        },
        {
          heading: 'Methods',
          level: 1,
          kind: 'methods',
          text: 'We used deterministic sentence scoring and exact character offsets for every selected passage.'
        },
        {
          heading: 'Results',
          level: 1,
          kind: 'results',
          text: 'Our results show that every displayed quote resolves to the indexed source representation.'
        },
        {
          heading: 'Limitations',
          level: 1,
          kind: 'body',
          text:
            'A limitation is the small local corpus used for this evaluation. The workflow fills a gap in landscape coverage.'
        },
        {
          heading: 'Future perspectives',
          level: 1,
          kind: 'body',
          text:
            'Patch-wise processing is planned for a future release. Future infrastructure design needs adaptive foundations.'
        },
        {
          heading: 'References',
          level: 1,
          kind: 'references',
          text: 'Limitations and openings in evidence graphs. Journal of Examples (2024).'
        }
      ]
    })

    const first = buildPaperDigest(paper)
    const second = buildPaperDigest(paper)

    expect(second).toEqual(first)
    expect(new Set(first.items.map((item) => item.kind))).toEqual(
      new Set(['purpose', 'method', 'finding', 'limitation', 'future_work'])
    )
    expect(first.items.some((item) => item.text.includes('Smith et al.'))).toBe(false)
    expect(first.items.some((item) => item.text.includes('fills a gap in landscape'))).toBe(false)
    expect(first.items.some((item) => item.text.includes('Future infrastructure design'))).toBe(false)
    expect(first.items.some((item) => item.text.includes('Limitations and openings'))).toBe(false)
    expect(first.items.some((item) => item.text.includes('future release'))).toBe(true)

    for (const evidence of first.evidence) {
      const source = evidenceSource(paper, evidence)
      expect(evidence.quote).toBe(source.slice(evidence.startOffset, evidence.endOffset))
      expect(evidence.quote.length).toBeLessThanOrEqual(MAX_INSIGHT_QUOTE_CHARACTERS)
    }
    expect(first.evidence.filter((evidence) => evidence.quote.includes('This study investigates'))).toHaveLength(1)
  })

  it('strictly gates metadata-only and abstract-only representations', () => {
    const inaccessibleBody = {
      heading: 'Future work',
      level: 1,
      kind: 'body',
      text: 'Future research should investigate a hidden access-gate body section.'
    }
    const metadataOnly = buildPaperDigest(snapshot({
      paperId: 'paper-metadata',
      title: 'Metadata only',
      contentKind: 'metadata_only',
      abstract: 'This study investigates metadata leakage.',
      sections: [inaccessibleBody]
    }))
    expect(metadataOnly.items).toEqual([])
    expect(metadataOnly.coverage).toMatchObject({ limited: true, availableKinds: [] })

    const abstractOnly = buildPaperDigest(snapshot({
      paperId: 'paper-abstract',
      title: 'Abstract only',
      contentKind: 'abstract_only',
      abstract: 'This study investigates abstract-only indexing with explicit provenance.',
      sections: [
        {
          heading: 'Abstract',
          level: 1,
          kind: 'abstract',
          text: 'This study investigates abstract-only indexing with explicit provenance.'
        },
        inaccessibleBody
      ]
    }))
    expect(abstractOnly.items.map((item) => item.kind)).toEqual(['purpose'])
    expect(abstractOnly.items.some((item) => item.text.includes('access-gate'))).toBe(false)
    expect(buildResearchLandscape([
      snapshot({
        paperId: 'paper-readable',
        title: 'Readable abstract',
        contentKind: 'abstract_only',
        abstract: 'This study investigates readable landscape evidence.'
      }),
      snapshot({
        paperId: 'paper-landscape-metadata',
        title: 'Landscape metadata',
        contentKind: 'metadata_only'
      })
    ])).toMatchObject({ paperCount: 2, analyzedPaperCount: 1 })
  })

  it('keeps long and multilingual evidence bounded without breaking offset provenance', () => {
    const longSentence = `We found that ${'bounded evidence '.repeat(80)}remains auditable.`
    const paper = snapshot({
      paperId: 'paper-long',
      title: 'Long evidence',
      sections: [
        { heading: 'Results', level: 1, kind: 'results', text: longSentence },
        {
          heading: 'Limitations',
          level: 1,
          kind: 'body',
          text: '该区域变化尚未被系统研究，因此目前的证据仍存在局限。'
        },
        {
          heading: 'Discussion',
          level: 1,
          kind: 'body',
          text: 'Thermokarst lagoon area change has not yet been studied across multiple decades.'
        }
      ]
    })
    const digest = buildPaperDigest(paper)
    const longEvidence = digest.evidence.find((evidence) => evidence.quote.startsWith('We found'))
    if (!longEvidence) throw new Error('Expected bounded finding evidence.')
    expect(longEvidence).toMatchObject({ truncated: true })
    expect(longEvidence.quote.length).toBeLessThanOrEqual(MAX_INSIGHT_QUOTE_CHARACTERS)
    expect(longEvidence.quote).toBe(longSentence.slice(longEvidence.startOffset, longEvidence.endOffset))
    expect(digest.items.some((item) => item.text.includes('has not yet been studied'))).toBe(true)
  })

  it('builds a stable exact-DOI graph and separates sourced statements from local hypotheses', () => {
    const first = snapshot({
      paperId: 'paper-alpha',
      title: 'Alpha evidence graph',
      doi: '10.5555/alpha',
      keywords: ['Evidence Maps'],
      sections: [
        {
          heading: 'Results',
          level: 1,
          kind: 'results',
          text: 'We found that evidence maps preserve local provenance across projects.'
        },
        {
          heading: 'Limitations',
          level: 1,
          kind: 'body',
          text: 'A limitation is that only a small set of projects was evaluated.'
        }
      ],
      references: [
        { raw: 'Beta paper.', doi: '10.5555/beta', title: 'Beta paper', year: '2025' },
        { raw: 'Missing paper.', doi: '10.5555/missing', title: 'Missing paper', year: '2024' }
      ]
    })
    const second = snapshot({
      paperId: 'paper-beta',
      title: 'Beta evidence graph',
      doi: '10.5555/beta',
      keywords: [' evidence   maps '],
      sections: [
        {
          heading: 'Future work',
          level: 1,
          kind: 'body',
          text: 'Future research should evaluate evidence maps in larger multilingual collections.'
        }
      ],
      references: [
        { raw: 'The same missing paper.', doi: '10.5555/missing', title: 'Missing paper', year: '2024' }
      ]
    })

    const landscape = buildResearchLandscape([first, second], { paperCount: 2, rootId: 'root-one' })
    const reversed = buildResearchLandscape([second, first], { paperCount: 2, rootId: 'root-one' })

    expect(reversed).toEqual(landscape)
    expect(landscape.rootId).toBe('root-one')
    expect(landscape.edges.filter((edge) => edge.kind === 'cites')).toHaveLength(3)
    expect(landscape.nodes.filter((node) => node.kind === 'external_reference')).toHaveLength(1)
    expect(landscape.nodes.filter((node) => node.kind === 'topic')).toHaveLength(1)
    expect(new Set(landscape.signals.map((signal) => signal.basis))).toEqual(
      new Set(['author_stated', 'local_corpus_hypothesis', 'local_coverage_gap'])
    )
    expect(landscape.signals.find((signal) => signal.basis === 'local_coverage_gap')?.statement)
      .toContain('not indexed in this selected PaperRelay scope')
    expect(landscape.signals.find((signal) => signal.basis === 'local_corpus_hypothesis')?.rationale)
      .toContain('not evidence of novelty')
    expect(landscape.noveltyRequiresExternalChecking).toBe(true)
    expect(landscape.disclaimer).toContain('external literature checking')
    expect(landscape.truncation.truncated).toBe(false)
  })

  it('caps ordinary external-reference neighbors without dropping later internal DOI links', () => {
    const target = snapshot({
      paperId: 'paper-internal-target',
      title: 'Internal target',
      doi: '10.9999/internal-target'
    })
    const externalReferences = Array.from({ length: 15 }, (_, index) => ({
      raw: `External reference ${index}.`,
      doi: `10.9999/external-${index}`,
      title: `External reference ${index}`,
      year: '2025'
    }))
    const source = snapshot({
      paperId: 'paper-many-references',
      title: 'Many references',
      doi: '10.9999/many-references',
      references: [
        ...externalReferences,
        {
          raw: 'Internal target reference.',
          doi: '10.9999/internal-target',
          title: 'Internal target',
          year: '2026'
        }
      ]
    })

    const landscape = buildResearchLandscape([source, target])

    expect(landscape.nodes.filter((node) => node.kind === 'external_reference')).toHaveLength(12)
    const paperNodeByPaper = new Map(
      landscape.nodes.filter((node) => node.kind === 'paper').map((node) => [node.paperId, node.id])
    )
    expect(landscape.edges).toContainEqual(expect.objectContaining({
      kind: 'cites',
      sourceId: paperNodeByPaper.get(source.paperId),
      targetId: paperNodeByPaper.get(target.paperId)
    }))
    expect(landscape.signals.some((signal) => signal.basis === 'local_coverage_gap')).toBe(false)
    expect(landscape.truncation).toMatchObject({
      truncated: true,
      omittedNodeCount: 3,
      omittedEdgeCount: 3,
      omittedEvidenceCount: 3
    })
  })
})
