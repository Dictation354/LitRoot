import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { InsightEvidence, PaperDigest } from '../../src/shared/contracts.js'
import { PaperDigestContent } from '../../src/renderer/src/PaperDigestContent.js'

const noOp = (): void => undefined

const evidence: InsightEvidence[] = [
  {
    id: 'e-purpose',
    source: 'abstract',
    paperId: 'paper-a',
    rootId: 'root-a',
    revision: 'rev-a',
    sectionIndex: null,
    sectionHeading: null,
    sectionKind: null,
    sourceIndex: null,
    startOffset: 0,
    endOffset: 52,
    quote: 'We investigate thaw settlement across Arctic infrastructure.',
    truncated: false
  },
  ...(['method', 'finding', 'limitation', 'future'] as const).map((name, index) => ({
    id: `e-${name}`,
    source: 'section' as const,
    paperId: 'paper-a',
    rootId: 'root-a',
    revision: 'rev-a',
    sectionIndex: index + 1,
    sectionHeading: name === 'future' ? 'Discussion and outlook' : `${name} section`,
    sectionKind: name,
    sourceIndex: null,
    startOffset: 10,
    endOffset: 70,
    quote: `Grounded ${name} evidence from the indexed paper.`,
    truncated: false
  }))
]

const digest: PaperDigest = {
  paperId: 'paper-a',
  rootId: 'root-a',
  revision: 'rev-a',
  title: 'A grounded paper digest',
  items: [
    { id: 'i-purpose', kind: 'purpose', text: 'Tests how infrastructure responds to thaw.', evidenceId: 'e-purpose' },
    { id: 'i-method', kind: 'method', text: 'Combines field observations with InSAR.', evidenceId: 'e-method' },
    { id: 'i-finding', kind: 'finding', text: 'Settlement increases near disturbed terrain.', evidenceId: 'e-finding' },
    { id: 'i-limitation', kind: 'limitation', text: 'Coverage is limited to two regions.', evidenceId: 'e-limitation' },
    { id: 'i-future', kind: 'future_work', text: 'Future work should validate other climates.', evidenceId: 'e-future' }
  ],
  evidence,
  coverage: {
    contentKind: 'fulltext',
    availableKinds: ['purpose', 'method', 'finding', 'limitation', 'future_work'],
    missingKinds: [],
    limited: false,
    message: null
  },
  disclaimer: 'Digest statements are extracts from indexed local evidence.'
}

describe('PaperDigestContent', () => {
  it('renders every digest category with a traceable evidence action', () => {
    const markup = renderToStaticMarkup(
      <PaperDigestContent digest={digest} onSelectEvidence={noOp} />
    )

    expect(markup).toContain('Evidence digest')
    expect(markup).toContain('Purpose')
    expect(markup).toContain('Method')
    expect(markup).toContain('Findings')
    expect(markup).toContain('Limitations')
    expect(markup).toContain('Future work')
    expect(markup).toContain('Author stated')
    expect(markup.match(/class="digest-evidence-button"/g)).toHaveLength(5)
    expect(markup).toContain('aria-label="Open evidence for Purpose: Abstract"')
    expect(markup).toContain('Discussion and outlook')
    expect(markup).toContain('Digest statements are extracts from indexed local evidence.')
  })

  it('keeps missing categories explicit when source coverage is limited', () => {
    const limited: PaperDigest = {
      ...digest,
      items: digest.items.filter((item) => item.kind === 'purpose'),
      coverage: {
        contentKind: 'abstract_only',
        availableKinds: ['purpose'],
        missingKinds: ['method', 'finding', 'limitation', 'future_work'],
        limited: true,
        message: 'Only the abstract was available.'
      }
    }
    const markup = renderToStaticMarkup(
      <PaperDigestContent digest={limited} onSelectEvidence={noOp} />
    )

    expect(markup).toContain('Abstract-only evidence')
    expect(markup).toContain('Only the abstract was available.')
    expect(markup).toContain('No reliable method summary was found')
    expect(markup).toContain('No author-stated future-work signal was found')
  })

  it('provides distinct loading, error, and empty states', () => {
    const loading = renderToStaticMarkup(
      <PaperDigestContent digest={null} loading onSelectEvidence={noOp} />
    )
    const error = renderToStaticMarkup(
      <PaperDigestContent digest={null} error="Analysis failed" onRetry={noOp} onSelectEvidence={noOp} />
    )
    const empty = renderToStaticMarkup(
      <PaperDigestContent digest={null} onSelectEvidence={noOp} />
    )

    expect(loading).toContain('role="status"')
    expect(loading).toContain('Building the evidence digest')
    expect(error).toContain('role="alert"')
    expect(error).toContain('Analysis failed')
    expect(error).toContain('Try again')
    expect(empty).toContain('No digest yet')
  })
})
