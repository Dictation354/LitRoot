// @vitest-environment jsdom

import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { InsightEvidence, ResearchLandscape } from '../../src/shared/contracts.js'
import { ResearchRadarWorkspace } from '../../src/renderer/src/ResearchRadarWorkspace.js'

const noOp = (): void => undefined

const evidence: InsightEvidence[] = [
  {
    id: 'e-future',
    source: 'section',
    paperId: 'paper-a',
    rootId: 'root-a',
    revision: 'rev-a',
    sectionIndex: 4,
    sectionHeading: 'Future directions',
    sectionKind: 'discussion',
    sourceIndex: null,
    startOffset: 30,
    endOffset: 100,
    quote: 'Future work should compare settlement across additional climate zones.',
    truncated: false
  },
  {
    id: 'e-finding',
    source: 'abstract',
    paperId: 'paper-b',
    rootId: 'root-a',
    revision: 'rev-b',
    sectionIndex: null,
    sectionHeading: null,
    sectionKind: null,
    sourceIndex: null,
    startOffset: 0,
    endOffset: 70,
    quote: 'Remote sensing captured regional change but lacked field validation.',
    truncated: false
  }
]

const landscape: ResearchLandscape = {
  rootId: 'root-a',
  paperCount: 8,
  analyzedPaperCount: 6,
  nodes: [
    {
      id: 'paper-node-a',
      kind: 'paper',
      label: 'Field settlement evidence',
      paperId: 'paper-a',
      doi: null,
      year: '2025',
      evidenceIds: ['e-future']
    },
    {
      id: 'paper-node-b',
      kind: 'paper',
      label: 'Regional remote sensing',
      paperId: 'paper-b',
      doi: null,
      year: '2024',
      evidenceIds: ['e-finding']
    },
    {
      id: 'future-node',
      kind: 'future_work',
      label: 'Cross-climate validation',
      paperId: 'paper-a',
      doi: null,
      year: null,
      evidenceIds: ['e-future']
    }
  ],
  edges: [
    {
      id: 'future-edge',
      kind: 'proposes_future_work',
      sourceId: 'paper-node-a',
      targetId: 'future-node',
      evidenceIds: ['e-future']
    }
  ],
  evidence,
  signals: [
    {
      id: 'author-signal',
      basis: 'author_stated',
      title: 'Validate across climate zones',
      statement: 'The authors explicitly request broader geographic validation.',
      rationale: 'This language appears in the paper’s future-directions section.',
      paperIds: ['paper-a'],
      evidenceIds: ['e-future'],
      noveltyRequiresExternalChecking: false
    },
    {
      id: 'hypothesis-signal',
      basis: 'local_corpus_hypothesis',
      title: 'Join regional sensing with field validation',
      statement: 'The local corpus suggests a useful cross-scale validation study.',
      rationale: 'One paper supplies field evidence while another identifies regional change.',
      paperIds: ['paper-a', 'paper-b'],
      evidenceIds: ['e-future', 'e-finding'],
      noveltyRequiresExternalChecking: true
    },
    {
      id: 'coverage-signal',
      basis: 'local_coverage_gap',
      title: 'Sparse tropical highland coverage',
      statement: 'This library contains no readable paper for tropical highland permafrost.',
      rationale: 'The observation describes local library coverage, not the external literature.',
      paperIds: [],
      evidenceIds: [],
      noveltyRequiresExternalChecking: true
    }
  ],
  truncation: {
    truncated: true,
    omittedPaperCount: 2,
    omittedNodeCount: 4,
    omittedEdgeCount: 3,
    omittedEvidenceCount: 5
  },
  noveltyRequiresExternalChecking: true,
  disclaimer: 'Landscape results are bounded to indexed local evidence.'
}

describe('ResearchRadarWorkspace', () => {
  it('routes signal paper chips through the explicit open-paper action', () => {
    const openedPaperIds: string[] = []
    const selectedPaperIds: string[] = []
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    flushSync(() => {
      root.render(
        <ResearchRadarWorkspace
          landscape={landscape}
          onOpenPaper={(paperId) => openedPaperIds.push(paperId)}
          onSelectPaper={(paperId) => selectedPaperIds.push(paperId)}
          selectedPaperId={null}
        />
      )
    })

    const signalPaper = container.querySelector<HTMLButtonElement>(
      '.radar-signal-footer button'
    )
    expect(signalPaper?.textContent).toContain('Field settlement evidence')
    flushSync(() => signalPaper?.click())
    expect(openedPaperIds).toEqual(['paper-a'])
    expect(selectedPaperIds).toEqual([])

    flushSync(() => root.unmount())
    container.remove()
  })

  it('separates author statements, local hypotheses, and coverage gaps', () => {
    const markup = renderToStaticMarkup(
      <ResearchRadarWorkspace
        landscape={landscape}
        onOpenPaper={noOp}
        onSelectEvidence={noOp}
        onSelectPaper={noOp}
        scopeLabel="Permafrost folder"
        selectedPaperId="paper-a"
      />
    )

    expect(markup).toContain('Research Radar')
    expect(markup).toContain('Local evidence synthesis · Permafrost folder')
    expect(markup).toContain('Author-stated signals')
    expect(markup).toContain('Local-corpus hypotheses')
    expect(markup).toContain('Coverage gaps')
    expect(markup).toContain('Validate across climate zones')
    expect(markup).toContain('Join regional sensing with field validation')
    expect(markup).toContain('External check needed')
    expect(markup).toContain('Research opportunities, not novelty claims')
    expect(markup).toContain('require an external literature check')
  })

  it('shows exact analysis coverage, truncation, and evidence provenance', () => {
    const markup = renderToStaticMarkup(
      <ResearchRadarWorkspace
        landscape={landscape}
        onOpenPaper={noOp}
        onSelectEvidence={noOp}
        onSelectPaper={noOp}
        selectedPaperId={null}
      />
    )

    expect(markup).toContain('75%')
    expect(markup).toContain('6 of 8 papers contributed readable evidence')
    expect(markup).toContain('Omitted: 2 papers, 4 nodes, 3 relationships, 5 evidence excerpts')
    expect(markup).toContain('Future directions')
    expect(markup).toContain('Field settlement evidence')
    expect(markup).toContain('Landscape results are bounded to indexed local evidence.')
  })

  it('provides loading, error, no-paper, and unreadable-corpus states', () => {
    const loading = renderToStaticMarkup(
      <ResearchRadarWorkspace landscape={null} loading onOpenPaper={noOp} onSelectPaper={noOp} selectedPaperId={null} />
    )
    const error = renderToStaticMarkup(
      <ResearchRadarWorkspace landscape={null} error="Landscape failed" onOpenPaper={noOp} onRetry={noOp} onSelectPaper={noOp} selectedPaperId={null} />
    )
    const noPapers = renderToStaticMarkup(
      <ResearchRadarWorkspace
        landscape={{ ...landscape, paperCount: 0, analyzedPaperCount: 0 }}
        onOpenPaper={noOp}
        onSelectPaper={noOp}
        selectedPaperId={null}
      />
    )
    const unreadable = renderToStaticMarkup(
      <ResearchRadarWorkspace
        landscape={{ ...landscape, analyzedPaperCount: 0 }}
        onOpenPaper={noOp}
        onSelectPaper={noOp}
        selectedPaperId={null}
      />
    )

    expect(loading).toContain('role="status"')
    expect(loading).toContain('Mapping the local evidence')
    expect(error).toContain('role="alert"')
    expect(error).toContain('Landscape failed')
    expect(noPapers).toContain('No papers in this research scope')
    expect(unreadable).toContain('Not enough readable evidence')
  })
})
