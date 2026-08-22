import { describe, expect, it } from 'vitest'
import type { PaperSection } from '../../src/shared/contracts.js'
import { visibleReaderSections } from '../../src/shared/reader-sections.js'

const abstractSection: PaperSection = {
  heading: 'Abstract',
  level: 2,
  kind: 'abstract',
  text: 'The same abstract text.'
}

describe('visibleReaderSections', () => {
  it('filters an abstract section already rendered from paper metadata', () => {
    const body: PaperSection = { heading: 'Results', level: 2, kind: 'body', text: 'Evidence.' }
    expect(visibleReaderSections([abstractSection, body], ' The same  abstract\ntext. ')).toEqual([
      { section: body, index: 1 }
    ])
  })

  it('retains a materially different abstract section', () => {
    expect(visibleReaderSections([abstractSection], 'A shorter metadata abstract.')).toHaveLength(1)
  })

  it('retains the abstract section when metadata has no abstract', () => {
    expect(visibleReaderSections([abstractSection], null)).toHaveLength(1)
  })
})
