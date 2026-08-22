import { describe, expect, it } from 'vitest'
import {
  collectAuthorYearAliases,
  collectReferenceNumbers,
  extractAuthorYearAliases,
  isReferenceSection,
  linkableCitationParts,
  numberStructuredReferences,
  parseNumberedReferences,
  referenceAnchorId
} from '../../src/shared/citation-crossrefs.js'

describe('citation cross-references', () => {
  it('recognizes bibliography section metadata and headings', () => {
    expect(isReferenceSection({ heading: 'Sources', kind: 'references' })).toBe(true)
    expect(isReferenceSection({ heading: 'Literature cited', kind: 'body' })).toBe(true)
    expect(isReferenceSection({ heading: 'Reference frame', kind: 'body' })).toBe(false)
  })

  it('parses common numbered reference paragraphs and continuations', () => {
    expect(parseNumberedReferences(`
1. First reference
continued title

[2] Second reference
- [4]. Fourth reference
`)).toEqual([
      { number: 1, text: 'First reference continued title' },
      { number: 2, text: 'Second reference' },
      { number: 4, text: 'Fourth reference' }
    ])
  })

  it('collects sorted unique reference numbers and exposes stable anchors', () => {
    expect(collectReferenceNumbers([
      { heading: 'Methods', kind: 'body', text: '1. Not a bibliography' },
      { heading: 'References', kind: 'body', text: '2. Second\n1. First\n2. Duplicate' }
    ])).toEqual([1, 2])
    expect(referenceAnchorId(17)).toBe('paper-reference-17')
  })

  it('numbers structured references without duplicating a matching raw marker', () => {
    const references = [
      { raw: '1. First reference' },
      { raw: '[2] Second reference' },
      { raw: 'Already marker-free' },
      { raw: '9. A nonmatching source marker is retained' }
    ]
    expect(numberStructuredReferences(references)).toEqual([
      { number: 1, text: 'First reference' },
      { number: 2, text: 'Second reference' },
      { number: 3, text: 'Already marker-free' },
      { number: 4, text: '9. A nonmatching source marker is retained' }
    ])
    expect(references[0]?.raw).toBe('1. First reference')
  })

  it('links single, grouped, ranged, and sequential bracket citations', () => {
    const parts = linkableCitationParts(
      'Prior work [1], [2, 3], [4–6], [7-9], and [17], [18].',
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 17, 18]
    )
    expect(parts.filter((part) => part.kind === 'citation')).toEqual([
      { kind: 'citation', text: '[1]', referenceNumbers: [1], targetNumber: 1 },
      { kind: 'citation', text: '[2, 3]', referenceNumbers: [2, 3], targetNumber: 2 },
      { kind: 'citation', text: '[4–6]', referenceNumbers: [4, 5, 6], targetNumber: 4 },
      { kind: 'citation', text: '[7-9]', referenceNumbers: [7, 8, 9], targetNumber: 7 },
      { kind: 'citation', text: '[17]', referenceNumbers: [17], targetNumber: 17 },
      { kind: 'citation', text: '[18]', referenceNumbers: [18], targetNumber: 18 }
    ])
    expect(parts.map((part) => part.text).join('')).toBe(
      'Prior work [1], [2, 3], [4–6], [7-9], and [17], [18].'
    )
  })

  it('does not create dead or partial citation links', () => {
    expect(linkableCitationParts('Results [1, 2] and [9].', [1, 9])).toEqual([
      { kind: 'text', text: 'Results [1, 2] and ' },
      { kind: 'citation', text: '[9]', referenceNumbers: [9], targetNumber: 9 },
      { kind: 'text', text: '.' }
    ])
  })

  it('ignores citation-like text in math, code, links, URLs, and array indices', () => {
    const text = [
      '$$A = [1, 2]$$',
      '$B[1]$',
      '\\[C=[2]\\]',
      '`values[3]`',
      '[4](https://example.test/source)',
      'https://example.test/items/[5]',
      'values[6]',
      'but cite [7]'
    ].join(' ')
    const citations = linkableCitationParts(text, [1, 2, 3, 4, 5, 6, 7])
      .filter((part) => part.kind === 'citation')
    expect(citations).toEqual([
      { kind: 'citation', text: '[7]', referenceNumbers: [7], targetNumber: 7 }
    ])
  })

  it('rejects descending and implausibly wide numeric ranges', () => {
    const available = new Set(Array.from({ length: 2500 }, (_, index) => index + 1))
    expect(linkableCitationParts('Years [1990-2020], reverse [9-1], cite [8].', available))
      .toEqual([
        { kind: 'text', text: 'Years [1990-2020], reverse [9-1], cite ' },
        { kind: 'citation', text: '[8]', referenceNumbers: [8], targetNumber: 8 },
        { kind: 'text', text: '.' }
      ])
  })

  it('extracts only explicit terminal author-year aliases from references', () => {
    expect(extractAuthorYearAliases([
      { number: 1, text: 'A complete entry [Amelung et al., 2000]' },
      { number: 2, text: 'A two-author entry [Chen and Zebker, 2001]' },
      { number: 3, text: 'No explicit alias (2024).' },
      { number: 4, text: 'A URL-like marker [https://example.test, 2020]' }
    ])).toEqual([
      {
        referenceNumber: 1,
        alias: 'Amelung et al., 2000',
        authors: 'Amelung et al.',
        year: '2000'
      },
      {
        referenceNumber: 2,
        alias: 'Chen and Zebker, 2001',
        authors: 'Chen and Zebker',
        year: '2001'
      }
    ])
  })

  it('links exact parenthetical and narrative author-year citations', () => {
    const aliases = extractAuthorYearAliases([
      { number: 2, text: 'Entry [Amelung et al., 2000]' },
      { number: 8, text: 'Entry [Ferretti et al., 2011]' }
    ])
    const citations = linkableCitationParts(
      'Earlier work (Amelung et al., 2000) was extended by Ferretti et al. (2011).',
      [2, 8],
      aliases
    ).filter((part) => part.kind === 'citation')
    expect(citations).toEqual([
      {
        kind: 'citation',
        text: 'Amelung et al., 2000',
        referenceNumbers: [2],
        targetNumber: 2
      },
      {
        kind: 'citation',
        text: 'Ferretti et al. (2011)',
        referenceNumbers: [8],
        targetNumber: 8
      }
    ])
  })

  it('matches sentence-capitalized surname particles without changing source text', () => {
    const aliases = extractAuthorYearAliases([
      { number: 16, text: 'Entry [de Luca et al., 2022]' },
      { number: 17, text: 'Entry [de Zan, 2020]' },
      { number: 19, text: 'Entry [de Zan and Rocca, 2005]' }
    ])
    const text = 'De Luca et al. (2022); De Zan (2020); (De Zan and Rocca, 2005).'
    const citations = linkableCitationParts(text, [16, 17, 19], aliases)
      .filter((part) => part.kind === 'citation')

    expect(citations.map((part) => part.text)).toEqual([
      'De Luca et al. (2022)',
      'De Zan (2020)',
      'De Zan and Rocca, 2005'
    ])
    expect(citations.map((part) => part.targetNumber)).toEqual([16, 17, 19])
  })

  it('tolerates one extraction-added period before a uniquely resolved year', () => {
    const aliases = extractAuthorYearAliases([
      { number: 18, text: 'Entry [de Zan and López-Dekker, 2011]' },
      { number: 25, text: 'Entry [Fattahi and Amelung, 2013]' }
    ])
    const text = '(De Zan & López-Dekker., 2011); Fattahi and Amelung. (2013).'
    const citations = linkableCitationParts(text, [18, 25], aliases)
      .filter((part) => part.kind === 'citation')

    expect(citations.map((part) => part.text)).toEqual([
      'De Zan & López-Dekker., 2011',
      'Fattahi and Amelung. (2013)'
    ])
    expect(citations.map((part) => part.targetNumber)).toEqual([18, 25])
  })

  it('resolves safe compressed years and two-author and/ampersand variants', () => {
    const aliases = extractAuthorYearAliases([
      { number: 3, text: 'Entry [Ansari et al., 2017]' },
      { number: 4, text: 'Entry [Ansari et al., 2018]' },
      { number: 5, text: 'Entry [Ferretti et al., 2000]' },
      { number: 6, text: 'Entry [Ferretti et al., 2001]' },
      { number: 7, text: 'Entry [Bioucas-Dias and Valadao, 2007]' }
    ])
    const citations = linkableCitationParts(
      '(Ansari et al., 2017, 2018); Ferretti et al. (2000, 2001); ' +
        '(Bioucas-Dias & Valadao, 2007).',
      [3, 4, 5, 6, 7],
      aliases
    ).filter((part) => part.kind === 'citation')
    expect(citations).toEqual([
      {
        kind: 'citation',
        text: 'Ansari et al., 2017, 2018',
        referenceNumbers: [3, 4],
        targetNumber: 3
      },
      {
        kind: 'citation',
        text: 'Ferretti et al. (2000, 2001)',
        referenceNumbers: [5, 6],
        targetNumber: 5
      },
      {
        kind: 'citation',
        text: 'Bioucas-Dias & Valadao, 2007',
        referenceNumbers: [7],
        targetNumber: 7
      }
    ])
  })

  it('keeps ambiguous aliases and unrelated years inert', () => {
    const aliases = extractAuthorYearAliases([
      { number: 1, text: 'First duplicate [Wang et al., 2023]' },
      { number: 2, text: 'Second duplicate [Wang et al., 2023]' },
      { number: 3, text: 'Unique [Dörr, 2024]' }
    ])
    const parts = linkableCitationParts(
      'Wang et al. (2023); to be launched in 2024; copyright 2024; Dörr (2025).',
      [1, 2, 3],
      aliases
    )
    expect(parts).toEqual([{ kind: 'text', text:
      'Wang et al. (2023); to be launched in 2024; copyright 2024; Dörr (2025).'
    }])
  })

  it('treats case-only alias variants as ambiguous under case-insensitive matching', () => {
    const aliases = extractAuthorYearAliases([
      { number: 1, text: 'First variant [de Zan, 2020]' },
      { number: 2, text: 'Second variant [De Zan, 2020]' }
    ])

    expect(linkableCitationParts('De Zan (2020).', [1, 2], aliases)).toEqual([
      { kind: 'text', text: 'De Zan (2020).' }
    ])
  })

  it('collects aliases only from reference sections', () => {
    expect(collectAuthorYearAliases([
      { heading: 'Body', kind: 'body', text: '1. Not a reference [Wrong, 2020]' },
      { heading: 'References (1 total)', kind: 'body', text: '1. Entry [Dörr, 2024]' }
    ])).toEqual([
      {
        referenceNumber: 1,
        alias: 'Dörr, 2024',
        authors: 'Dörr',
        year: '2024'
      }
    ])
  })
})
