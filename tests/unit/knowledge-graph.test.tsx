// @vitest-environment jsdom

import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  InsightEvidence,
  ResearchGraphEdge,
  ResearchGraphNode
} from '../../src/shared/contracts.js'
import { KnowledgeGraph } from '../../src/renderer/src/KnowledgeGraph.js'

const noOp = (): void => undefined

const evidence: InsightEvidence[] = [
  {
    id: 'e-finding',
    source: 'section',
    paperId: 'paper-a',
    rootId: 'root-a',
    revision: 'rev-a',
    sectionIndex: 2,
    sectionHeading: 'Results',
    sectionKind: 'results',
    sourceIndex: null,
    startOffset: 14,
    endOffset: 84,
    quote: 'Observed settlement was strongest beside disturbed transport corridors.',
    truncated: false
  }
]

const nodes: ResearchGraphNode[] = [
  {
    id: 'node-paper',
    kind: 'paper',
    label: 'Thaw settlement study',
    paperId: 'paper-a',
    doi: '10.1000/example',
    year: '2025',
    evidenceIds: ['e-finding']
  },
  {
    id: 'node-topic',
    kind: 'topic',
    label: 'Permafrost infrastructure',
    paperId: 'paper-a',
    doi: null,
    year: null,
    evidenceIds: ['e-finding']
  },
  {
    id: 'node-finding',
    kind: 'finding',
    label: 'Disturbance amplifies settlement',
    paperId: 'paper-a',
    doi: null,
    year: null,
    evidenceIds: ['e-finding']
  }
]

const edges: ResearchGraphEdge[] = [
  {
    id: 'edge-topic',
    kind: 'has_topic',
    sourceId: 'node-paper',
    targetId: 'node-topic',
    evidenceIds: ['e-finding']
  },
  {
    id: 'edge-finding',
    kind: 'reports_finding',
    sourceId: 'node-paper',
    targetId: 'node-finding',
    evidenceIds: ['e-finding']
  }
]

describe('KnowledgeGraph', () => {
  it('selects graph nodes in place while explicit source and evidence actions navigate', () => {
    const selectedPaperIds: string[] = []
    const openedPaperIds: string[] = []
    const openedEvidenceIds: string[] = []
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    flushSync(() => {
      root.render(
        <KnowledgeGraph
          edges={edges}
          evidence={evidence}
          nodes={nodes}
          onOpenPaper={(paperId) => openedPaperIds.push(paperId)}
          onSelectEvidence={(item) => openedEvidenceIds.push(item.id)}
          onSelectPaper={(paperId) => selectedPaperIds.push(paperId)}
          selectedPaperId={null}
        />
      )
    })

    const paperNode = container.querySelector<SVGGElement>(
      '[aria-label="Paper, Thaw settlement study, 2025. Select paper."]'
    )
    expect(paperNode).not.toBeNull()
    flushSync(() => paperNode?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(selectedPaperIds).toEqual(['paper-a'])
    expect(openedPaperIds).toEqual([])

    const openPaper = container.querySelector<HTMLButtonElement>('.knowledge-open-paper')
    expect(openPaper?.textContent).toContain('Open source paper')
    flushSync(() => openPaper?.click())
    expect(openedPaperIds).toEqual(['paper-a'])
    expect(selectedPaperIds).toEqual(['paper-a'])

    const openEvidence = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open evidence in Results"]'
    )
    flushSync(() => openEvidence?.click())
    expect(openedEvidenceIds).toEqual(['e-finding'])

    flushSync(() => root.unmount())
    container.remove()
  })

  it('renders a labelled, keyboard-focusable SVG map and selected paper state', () => {
    const markup = renderToStaticMarkup(
      <KnowledgeGraph
        edges={edges}
        evidence={evidence}
        nodes={nodes}
        onOpenPaper={noOp}
        onSelectEvidence={noOp}
        onSelectPaper={noOp}
        selectedPaperId="paper-a"
      />
    )

    expect(markup).toContain('aria-labelledby="knowledge-graph-title"')
    expect(markup).toContain('<title id="knowledge-graph-title">Research evidence knowledge map</title>')
    expect(markup).toContain('keyboard-navigable map')
    expect(markup.match(/role="button"/g)?.length).toBeGreaterThanOrEqual(3)
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('Paper, Thaw settlement study, 2025. Select paper.')
    expect(markup).toContain('is-paper-selected')
    expect(markup).toContain('Evidence list')
    expect(markup).toContain('Open source paper')
  })

  it('offers a semantic evidence-list fallback with relationships and excerpts', () => {
    const markup = renderToStaticMarkup(
      <KnowledgeGraph
        edges={edges}
        evidence={evidence}
        initialView="evidence"
        nodes={nodes}
        onOpenPaper={noOp}
        onSelectEvidence={noOp}
        onSelectPaper={noOp}
        selectedPaperId={null}
      />
    )

    expect(markup).toContain('aria-label="Knowledge map evidence list"')
    expect(markup).toContain('has topic')
    expect(markup).toContain('reports finding')
    expect(markup).toContain('Results')
    expect(markup).toContain('Observed settlement was strongest')
    expect(markup).toContain('aria-label="Open source paper for Thaw settlement study"')
  })

  it('keeps evidence-list paper selection synchronized with the app selection', () => {
    const selectedPaperIds: string[] = []
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    flushSync(() => {
      root.render(
        <KnowledgeGraph
          edges={edges}
          evidence={evidence}
          initialView="evidence"
          nodes={nodes}
          onOpenPaper={noOp}
          onSelectEvidence={noOp}
          onSelectPaper={(paperId) => selectedPaperIds.push(paperId)}
          selectedPaperId={null}
        />
      )
    })

    const paperHeading = container.querySelector<HTMLButtonElement>(
      '.knowledge-evidence-list-heading button'
    )
    flushSync(() => paperHeading?.click())
    expect(selectedPaperIds).toEqual(['paper-a'])

    flushSync(() => root.unmount())
    container.remove()
  })

  it('explains when no graph can be formed', () => {
    const markup = renderToStaticMarkup(
      <KnowledgeGraph
        edges={[]}
        evidence={[]}
        nodes={[]}
        onOpenPaper={noOp}
        onSelectPaper={noOp}
        selectedPaperId={null}
      />
    )

    expect(markup).toContain('No evidence map available')
    expect(markup).toContain('More readable papers are needed')
  })
})
