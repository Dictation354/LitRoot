import { describe, expect, it } from 'vitest'
import {
  canonicalHttpUrl,
  doiFromInput,
  normalizeDoi,
  paperIdFor,
  safeFtsQuery
} from '../../src/service/identity.js'

describe('paper identity', () => {
  it.each([
    ['DOI: 10.1234/ABC.7.', '10.1234/abc.7'],
    ['https://doi.org/10.1234/ABC.7?download=1', '10.1234/abc.7'],
    ['urn:doi:10.1234/ABC.7', '10.1234/abc.7']
  ])('normalizes DOI %s', (input, expected) => {
    expect(normalizeDoi(input)).toBe(expected)
  })

  it('extracts a DOI from a pasted citation before duplicate checks', () => {
    expect(doiFromInput('Smith et al. (2025). Result. DOI: 10.1234/ABC.7.')).toBe('10.1234/abc.7')
  })

  it('canonicalizes source URLs before stable identity', () => {
    const first = canonicalHttpUrl('HTTPS://Example.TEST:443/paper/?utm_source=x&b=2&a=1#part')
    const second = canonicalHttpUrl('https://example.test/paper?a=1&b=2')
    expect(first).toBe(second)
    expect(paperIdFor(null, first, 'papers/one.md')).toBe(paperIdFor(null, second, 'papers/two.md'))
  })

  it('uses DOI, then URL, then relative path and neutralizes FTS operators', () => {
    expect(paperIdFor('10.1234/test', null, 'papers/a.md')).toBe(paperIdFor('10.1234/test', 'https://other.test', 'papers/b.md'))
    expect(paperIdFor(null, null, 'papers/a.md')).not.toBe(paperIdFor(null, null, 'papers/b.md'))
    expect(safeFtsQuery('title" OR * ^ (body)')).toBe('"title"* AND "OR"* AND "body"*')
  })
})
