import { describe, expect, it } from 'vitest'
import type { InsightEvidence, PaperDetail } from '../../src/shared/contracts.js'
import { evidenceTargetId } from '../../src/renderer/src/App.js'

const paper: Pick<PaperDetail, 'abstract' | 'references' | 'sections'> = {
  abstract: null,
  references: [],
  sections: [
    { heading: 'Introduction', kind: 'introduction', level: 1, text: 'Opening context.' },
    {
      heading: 'Results & Discussion',
      kind: 'results',
      level: 1,
      text: 'The supporting passage.'
    }
  ]
}

function evidence(
  overrides: Partial<InsightEvidence> = {}
): InsightEvidence {
  return {
    id: 'evidence-a',
    source: 'section',
    paperId: 'paper-a',
    rootId: 'root-a',
    revision: 'revision-a',
    sectionIndex: 1,
    sectionHeading: 'Results & Discussion',
    sectionKind: 'results',
    sourceIndex: null,
    startOffset: 4,
    endOffset: 22,
    quote: 'supporting passage',
    truncated: false,
    ...overrides
  }
}

describe('Reader evidence navigation', () => {
  it('resolves Radar and Digest evidence to the matching Reader landmark', () => {
    expect(evidenceTargetId(evidence(), paper)).toBe('results-discussion-1')
    expect(
      evidenceTargetId(
        evidence({ source: 'abstract', sectionIndex: null, sectionHeading: null }),
        { ...paper, abstract: 'A metadata abstract.' }
      )
    ).toBe('paper-abstract')
    expect(
      evidenceTargetId(
        evidence({ source: 'reference', sectionIndex: null, sectionHeading: null }),
        {
          ...paper,
          references: [{ raw: 'A structured citation.', doi: null, title: null, year: null }]
        }
      )
    ).toBe('paper-references')
  })

  it('targets rendered abstract and reference sections when fallback landmarks are absent', () => {
    const sectionPaper = {
      abstract: null,
      references: [],
      sections: [
        ...paper.sections,
        { heading: 'Abstract', kind: 'abstract', level: 1, text: 'Section abstract.' },
        { heading: 'References', kind: 'references', level: 1, text: '1. A citation.' }
      ]
    }

    expect(
      evidenceTargetId(
        evidence({ source: 'abstract', sectionIndex: 2, sectionKind: 'abstract' }),
        sectionPaper
      )
    ).toBe('abstract-2')
    expect(
      evidenceTargetId(
        evidence({ source: 'reference', sectionIndex: 3, sectionKind: 'references' }),
        sectionPaper
      )
    ).toBe('references-3')
  })

  it('targets the structured-reference fallback when unnumbered source references are hidden', () => {
    const fallbackPaper = {
      abstract: null,
      references: [{ raw: 'A structured citation.', doi: null, title: null, year: null }],
      sections: [
        ...paper.sections,
        { heading: 'References', kind: 'references', level: 1, text: 'An unnumbered citation.' }
      ]
    }

    expect(
      evidenceTargetId(
        evidence({ source: 'reference', sectionIndex: 2, sectionKind: 'references' }),
        fallbackPaper
      )
    ).toBe('paper-references')
  })

  it('falls back to the article header when the indexed section no longer exists', () => {
    expect(evidenceTargetId(evidence({ sectionIndex: 12 }), paper)).toBe(
      'paper-article-header'
    )
  })
})
