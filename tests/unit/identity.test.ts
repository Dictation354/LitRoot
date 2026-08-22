import { describe, expect, it } from 'vitest'
import {
  corpusWorkIdentityKey,
  normalizeDoi,
  paperIdentityKey,
  stableId
} from '../../src/main/ingest/identity.js'

describe('normalizeDoi', () => {
  it.each([
    ['10.1234/ABC.Def', '10.1234/abc.def'],
    [' DOI: 10.1234/ABC.Def. ', '10.1234/abc.def'],
    ['https://doi.org/10.1234/ABC.Def?download=1', '10.1234/abc.def'],
    ['http://dx.doi.org/10.1234/ABC.Def#section', '10.1234/abc.def'],
    ['urn:doi:10.1234/ABC.Def', '10.1234/abc.def']
  ])('normalizes %s', (input, expected) => {
    expect(normalizeDoi(input)).toBe(expected)
  })

  it.each([null, undefined, 42, '', 'not-a-doi', '11.1234/wrong-prefix', '10.12/too-short']) (
    'rejects invalid input %j',
    (input) => {
      expect(normalizeDoi(input)).toBeNull()
    }
  )
})

describe('paper identity helpers', () => {
  it('prefers normalized DOI identity over file location', () => {
    expect(paperIdentityKey('10.1234/example', '/project-a/papers/article.json')).toBe(
      'doi:10.1234/example'
    )
  })

  it('uses location identity while a DOI is unresolved', () => {
    expect(paperIdentityKey(null, '/project-a/papers/article.json')).toBe(
      'location:/project-a/papers/article.json'
    )
  })

  it('coalesces recognized DOI-less corpus representations within one collection anchor', () => {
    const json = '/research/dl4geo/corpus/groups/library/records/work-00014.both.json'
    const markdown = '/research/dl4geo/corpus/groups/fetch/papers/work-00014/fulltext.md'
    const attempt = '/research/dl4geo/corpus/groups/fetch/papers/work-00014/attempts/record-before-retry.both.json'

    expect(corpusWorkIdentityKey(json)).toBe(corpusWorkIdentityKey(markdown))
    expect(corpusWorkIdentityKey(markdown)).toBe(corpusWorkIdentityKey(attempt))
    expect(paperIdentityKey(null, json)).toBe(paperIdentityKey(null, markdown))
  })

  it('keeps the same upstream work token separate across collection anchors', () => {
    const first = '/research/first/corpus/groups/library/records/work-00014.both.json'
    const second = '/research/second/corpus/groups/library/records/work-00014.both.json'

    expect(paperIdentityKey(null, first)).not.toBe(paperIdentityKey(null, second))
  })

  it('does not merge DOI-less papers by title-like paths outside the recognized corpus layout', () => {
    expect(corpusWorkIdentityKey('/research/papers/work-00014/fulltext.md')).toBeNull()
    expect(paperIdentityKey(null, '/research/a/same-title.md')).not.toBe(
      paperIdentityKey(null, '/research/b/same-title.md')
    )
  })

  it('generates deterministic, namespace-specific stable IDs', () => {
    const first = stableId('paper', 'doi:10.1234/example')

    expect(first).toBe(stableId('paper', 'doi:10.1234/example'))
    expect(first).toMatch(/^paper_[a-f0-9]{24}$/)
    expect(first).not.toBe(stableId('location', 'doi:10.1234/example'))
  })
})
