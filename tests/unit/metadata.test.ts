import { describe, expect, it } from 'vitest'
import { applyMetadataPatch, mergeMetadata, validateMetadataOverrides } from '../../src/service/metadata.js'
import type { PaperMetadata } from '../../src/shared/contracts.js'

const fetched: PaperMetadata = {
  title: 'Fetched title', authors: ['Ada'], journal: 'Journal', year: 2024,
  doi: '10.4242/fetched', url: 'https://example.test/paper', abstract: 'Abstract', keywords: ['one']
}

describe('metadata overrides', () => {
  it('distinguishes inheritance from explicit clearing', () => {
    expect(mergeMetadata(fetched, {})).toEqual(fetched)
    expect(mergeMetadata(fetched, { title: '', authors: [], year: '', keywords: [] })).toMatchObject({
      title: '', authors: [], year: null, keywords: []
    })
  })

  it('restores fetched values by removing an override key', () => {
    expect(applyMetadataPatch({ title: 'Edited', doi: '' }, {}, ['title'])).toEqual({ doi: '' })
  })

  it('normalizes DOI and URL and rejects unsafe values', () => {
    expect(validateMetadataOverrides({ doi: 'DOI: 10.4242/ABC', url: 'HTTPS://EXAMPLE.TEST/a#x' })).toEqual({
      doi: '10.4242/abc', url: 'https://example.test/a'
    })
    expect(() => validateMetadataOverrides({ doi: 'not a doi' })).toThrow('DOI')
    expect(() => validateMetadataOverrides({ url: 'javascript:alert(1)' })).toThrow('HTTP')
  })
})
