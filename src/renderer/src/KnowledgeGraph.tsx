import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type {
  InsightEvidence,
  ResearchGraphEdge,
  ResearchGraphEdgeKind,
  ResearchGraphNode,
  ResearchGraphNodeKind
} from '../../shared/contracts'
import { Icon } from './icons'

type KnowledgeGraphView = 'graph' | 'evidence'
type GraphColumn = 'sources' | 'topics' | 'findings' | 'limitations' | 'future'

interface PositionedNode {
  node: ResearchGraphNode
  x: number
  y: number
}

const MAX_VISIBLE_GRAPH_NODES = 30
const GRAPH_WIDTH = 960
const GRAPH_HEIGHT = 510

const NODE_KIND_LABEL: Record<ResearchGraphNodeKind, string> = {
  paper: 'Paper',
  topic: 'Topic',
  finding: 'Finding',
  limitation: 'Limitation',
  future_work: 'Future work',
  external_reference: 'External reference'
}

const EDGE_KIND_LABEL: Record<ResearchGraphEdgeKind, string> = {
  has_topic: 'has topic',
  reports_finding: 'reports finding',
  states_limitation: 'states limitation',
  proposes_future_work: 'proposes future work',
  cites: 'cites'
}

const COLUMN_X: Record<GraphColumn, number> = {
  sources: 96,
  topics: 288,
  findings: 480,
  limitations: 672,
  future: 864
}

function nodeColumn(kind: ResearchGraphNodeKind): GraphColumn {
  if (kind === 'paper' || kind === 'external_reference') return 'sources'
  if (kind === 'topic') return 'topics'
  if (kind === 'finding') return 'findings'
  if (kind === 'limitation') return 'limitations'
  return 'future'
}

function shortenedLabel(label: string): string {
  const normalized = label.replace(/\s+/g, ' ').trim()
  return normalized.length > 27 ? `${normalized.slice(0, 26)}…` : normalized
}

function visibleNodes(
  nodes: ResearchGraphNode[],
  edges: ResearchGraphEdge[],
  selectedPaperId: string | null
): ResearchGraphNode[] {
  if (nodes.length <= MAX_VISIBLE_GRAPH_NODES) return nodes

  const degrees = new Map<string, number>()
  const selectedNodeIds = new Set(
    nodes.filter((node) => node.paperId === selectedPaperId).map((node) => node.id)
  )
  const neighboringNodeIds = new Set<string>()

  for (const edge of edges) {
    degrees.set(edge.sourceId, (degrees.get(edge.sourceId) ?? 0) + 1)
    degrees.set(edge.targetId, (degrees.get(edge.targetId) ?? 0) + 1)
    if (selectedNodeIds.has(edge.sourceId)) neighboringNodeIds.add(edge.targetId)
    if (selectedNodeIds.has(edge.targetId)) neighboringNodeIds.add(edge.sourceId)
  }

  return [...nodes]
    .sort((left, right) => {
      const leftSelected = selectedNodeIds.has(left.id) ? 1 : 0
      const rightSelected = selectedNodeIds.has(right.id) ? 1 : 0
      if (leftSelected !== rightSelected) return rightSelected - leftSelected
      const leftNeighbor = neighboringNodeIds.has(left.id) ? 1 : 0
      const rightNeighbor = neighboringNodeIds.has(right.id) ? 1 : 0
      if (leftNeighbor !== rightNeighbor) return rightNeighbor - leftNeighbor
      const degreeDelta = (degrees.get(right.id) ?? 0) - (degrees.get(left.id) ?? 0)
      if (degreeDelta !== 0) return degreeDelta
      return left.label.localeCompare(right.label)
    })
    .slice(0, MAX_VISIBLE_GRAPH_NODES)
}

function positionNodes(nodes: ResearchGraphNode[]): PositionedNode[] {
  const byColumn = new Map<GraphColumn, ResearchGraphNode[]>([
    ['sources', []],
    ['topics', []],
    ['findings', []],
    ['limitations', []],
    ['future', []]
  ])

  for (const node of nodes) byColumn.get(nodeColumn(node.kind))?.push(node)

  const positioned: PositionedNode[] = []
  for (const [column, columnNodes] of byColumn) {
    columnNodes.forEach((node, index) => {
      positioned.push({
        node,
        x: COLUMN_X[column],
        y: ((index + 1) * GRAPH_HEIGHT) / (columnNodes.length + 1)
      })
    })
  }
  return positioned
}

function evidenceLabel(evidence: InsightEvidence): string {
  if (evidence.sectionHeading) return evidence.sectionHeading
  if (evidence.source === 'abstract') return 'Abstract'
  if (evidence.source === 'keyword') return 'Keywords'
  if (evidence.source === 'reference') return 'References'
  return 'Paper section'
}

function nodeAccessibleLabel(node: ResearchGraphNode): string {
  const details = [NODE_KIND_LABEL[node.kind], node.label, node.year].filter(Boolean).join(', ')
  return node.kind === 'paper' ? `${details}. Select paper.` : `${details}. Inspect connections.`
}

function relatedEdges(nodeId: string, edges: ResearchGraphEdge[]): ResearchGraphEdge[] {
  return edges.filter((edge) => edge.sourceId === nodeId || edge.targetId === nodeId)
}

function NodeEvidence({
  evidence,
  onSelectEvidence
}: {
  evidence: InsightEvidence
  onSelectEvidence?: ((evidence: InsightEvidence) => void) | undefined
}): React.JSX.Element {
  const content = (
    <>
      <span>{evidenceLabel(evidence)}</span>
      <q>{evidence.quote}{evidence.truncated ? '…' : ''}</q>
    </>
  )

  if (!onSelectEvidence) return <div className="knowledge-node-evidence">{content}</div>
  return (
    <button
      aria-label={`Open evidence in ${evidenceLabel(evidence)}`}
      className="knowledge-node-evidence is-actionable"
      onClick={() => onSelectEvidence(evidence)}
      type="button"
    >
      {content}
    </button>
  )
}

function GraphInspector({
  activeNode,
  edges,
  evidenceById,
  nodeById,
  onOpenPaper,
  onSelectEvidence
}: {
  activeNode: ResearchGraphNode | null
  edges: ResearchGraphEdge[]
  evidenceById: Map<string, InsightEvidence>
  nodeById: Map<string, ResearchGraphNode>
  onOpenPaper(paperId: string): void
  onSelectEvidence?: ((evidence: InsightEvidence) => void) | undefined
}): React.JSX.Element {
  if (!activeNode) {
    return (
      <aside className="knowledge-graph-inspector">
        <div className="knowledge-inspector-empty">
          <Icon name="layers" size={18} />
          <strong>Select a node</strong>
          <span>Inspect its relationships and supporting source text.</span>
        </div>
      </aside>
    )
  }

  const connections = relatedEdges(activeNode.id, edges)
  const nodeEvidence = activeNode.evidenceIds
    .map((id) => evidenceById.get(id))
    .filter((evidence): evidence is InsightEvidence => Boolean(evidence))
    .slice(0, 3)

  return (
    <aside aria-label="Selected knowledge node" className="knowledge-graph-inspector">
      <div className={`knowledge-inspector-kind graph-kind-${activeNode.kind}`}>
        {NODE_KIND_LABEL[activeNode.kind]}
      </div>
      <h4>{activeNode.label}</h4>
      {(activeNode.year || activeNode.doi) && (
        <p className="knowledge-inspector-meta">
          {[activeNode.year, activeNode.doi].filter(Boolean).join(' · ')}
        </p>
      )}
      {activeNode.paperId && (
        <button
          className="secondary-button compact-button knowledge-open-paper"
          onClick={() => onOpenPaper(activeNode.paperId as string)}
          type="button"
        >
          <Icon name="book-open" size={14} />
          Open source paper
        </button>
      )}

      <div className="knowledge-inspector-section">
        <span>Connections · {connections.length}</span>
        {connections.length === 0 ? (
          <p>No visible connections in this map.</p>
        ) : (
          <ul>
            {connections.slice(0, 7).map((edge) => {
              const neighborId = edge.sourceId === activeNode.id ? edge.targetId : edge.sourceId
              const neighbor = nodeById.get(neighborId)
              return (
                <li key={edge.id}>
                  <span>{EDGE_KIND_LABEL[edge.kind]}</span>
                  <strong>{neighbor?.label ?? 'Unavailable node'}</strong>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="knowledge-inspector-section">
        <span>Evidence · {activeNode.evidenceIds.length}</span>
        {nodeEvidence.length === 0 ? (
          <p>No direct excerpt is available for this node.</p>
        ) : (
          <div className="knowledge-inspector-evidence-list">
            {nodeEvidence.map((evidence) => (
              <NodeEvidence
                evidence={evidence}
                key={evidence.id}
                onSelectEvidence={onSelectEvidence}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

function EvidenceList({
  activeNodeId,
  edges,
  evidenceById,
  nodeById,
  nodes,
  onActivateNode,
  onOpenPaper,
  onSelectEvidence,
  selectedPaperId
}: {
  activeNodeId: string | null
  edges: ResearchGraphEdge[]
  evidenceById: Map<string, InsightEvidence>
  nodeById: Map<string, ResearchGraphNode>
  nodes: ResearchGraphNode[]
  onActivateNode(node: ResearchGraphNode): void
  onOpenPaper(paperId: string): void
  onSelectEvidence?: ((evidence: InsightEvidence) => void) | undefined
  selectedPaperId: string | null
}): React.JSX.Element {
  return (
    <ul aria-label="Knowledge map evidence list" className="knowledge-evidence-list">
      {nodes.map((node) => {
        const connections = relatedEdges(node.id, edges)
        const directEvidence = node.evidenceIds
          .map((id) => evidenceById.get(id))
          .filter((evidence): evidence is InsightEvidence => Boolean(evidence))
          .slice(0, 2)
        return (
          <li
            className={`${activeNodeId === node.id ? 'is-active' : ''} ${
              node.paperId === selectedPaperId ? 'is-paper-selected' : ''
            }`}
            key={node.id}
          >
            <article>
              <div className="knowledge-evidence-list-heading">
                <button onClick={() => onActivateNode(node)} type="button">
                  <span className={`graph-kind-${node.kind}`}>{NODE_KIND_LABEL[node.kind]}</span>
                  <strong>{node.label}</strong>
                </button>
                {node.paperId && (
                  <button
                    aria-label={`Open source paper for ${node.label}`}
                    className="knowledge-list-paper-button"
                    onClick={() => onOpenPaper(node.paperId as string)}
                    type="button"
                  >
                    <Icon name="book-open" size={14} />
                  </button>
                )}
              </div>
              {connections.length > 0 && (
                <ul className="knowledge-relation-list">
                  {connections.slice(0, 5).map((edge) => {
                    const neighborId = edge.sourceId === node.id ? edge.targetId : edge.sourceId
                    return (
                      <li key={edge.id}>
                        <span>{EDGE_KIND_LABEL[edge.kind]}</span>
                        {nodeById.get(neighborId)?.label ?? 'Unavailable node'}
                      </li>
                    )
                  })}
                </ul>
              )}
              {directEvidence.map((evidence) => (
                <NodeEvidence
                  evidence={evidence}
                  key={evidence.id}
                  onSelectEvidence={onSelectEvidence}
                />
              ))}
            </article>
          </li>
        )
      })}
    </ul>
  )
}

export function KnowledgeGraph({
  edges,
  evidence,
  initialView = 'graph',
  nodes,
  onOpenPaper,
  onSelectEvidence,
  onSelectPaper,
  selectedPaperId
}: {
  edges: ResearchGraphEdge[]
  evidence: InsightEvidence[]
  initialView?: KnowledgeGraphView
  nodes: ResearchGraphNode[]
  onOpenPaper(paperId: string): void
  onSelectEvidence?: ((evidence: InsightEvidence) => void) | undefined
  onSelectPaper(paperId: string): void
  selectedPaperId: string | null
}): React.JSX.Element {
  const [view, setView] = useState<KnowledgeGraphView>(initialView)
  const shownNodes = useMemo(
    () => visibleNodes(nodes, edges, selectedPaperId),
    [edges, nodes, selectedPaperId]
  )
  const shownNodeIds = useMemo(() => new Set(shownNodes.map((node) => node.id)), [shownNodes])
  const shownEdges = useMemo(
    () => edges.filter((edge) => shownNodeIds.has(edge.sourceId) && shownNodeIds.has(edge.targetId)),
    [edges, shownNodeIds]
  )
  const positionedNodes = useMemo(() => positionNodes(shownNodes), [shownNodes])
  const positionById = useMemo(
    () => new Map(positionedNodes.map((positioned) => [positioned.node.id, positioned])),
    [positionedNodes]
  )
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const evidenceById = useMemo(
    () => new Map(evidence.map((item) => [item.id, item])),
    [evidence]
  )
  const selectedNode =
    shownNodes.find((node) => node.paperId === selectedPaperId && node.kind === 'paper') ??
    shownNodes.find((node) => node.paperId === selectedPaperId) ??
    shownNodes[0] ??
    null
  const [activeNodeId, setActiveNodeId] = useState<string | null>(selectedNode?.id ?? null)

  useEffect(() => {
    const matchingNode =
      shownNodes.find((node) => node.paperId === selectedPaperId && node.kind === 'paper') ??
      shownNodes.find((node) => node.paperId === selectedPaperId)
    if (matchingNode) setActiveNodeId(matchingNode.id)
  }, [selectedPaperId, shownNodes])

  const activeNode = nodeById.get(activeNodeId ?? '') ?? selectedNode
  const activateNode = (node: ResearchGraphNode): void => {
    setActiveNodeId(node.id)
    if (node.kind === 'paper' && node.paperId) onSelectPaper(node.paperId)
  }
  const handleNodeKeyDown = (
    event: KeyboardEvent<SVGGElement>,
    node: ResearchGraphNode
  ): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    activateNode(node)
  }

  if (nodes.length === 0) {
    return (
      <div className="knowledge-graph-empty">
        <Icon name="layers" size={20} />
        <strong>No evidence map available</strong>
        <span>More readable papers are needed to connect topics, findings, and next steps.</span>
      </div>
    )
  }

  const locallyOmitted = nodes.length - shownNodes.length

  return (
    <div className="knowledge-graph">
      <div className="knowledge-graph-toolbar">
        <div>
          <strong>Knowledge map</strong>
          <span>{shownNodes.length} nodes · {shownEdges.length} visible relationships</span>
        </div>
        <div aria-label="Knowledge map view" className="knowledge-view-toggle" role="group">
          <button
            aria-pressed={view === 'graph'}
            className={view === 'graph' ? 'is-active' : ''}
            onClick={() => setView('graph')}
            type="button"
          >
            Map
          </button>
          <button
            aria-pressed={view === 'evidence'}
            className={view === 'evidence' ? 'is-active' : ''}
            onClick={() => setView('evidence')}
            type="button"
          >
            Evidence list
          </button>
        </div>
      </div>

      {locallyOmitted > 0 && (
        <p className="knowledge-graph-local-limit" role="status">
          Showing the {shownNodes.length} most connected nodes; {locallyOmitted} less-connected
          nodes are hidden here to keep the map readable.
        </p>
      )}

      {view === 'graph' ? (
        <div className="knowledge-graph-layout">
          <div className="knowledge-graph-canvas">
            <svg
              aria-describedby="knowledge-graph-description"
              aria-labelledby="knowledge-graph-title"
              preserveAspectRatio="xMidYMid meet"
              role="group"
              viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
            >
              <title id="knowledge-graph-title">Research evidence knowledge map</title>
              <desc id="knowledge-graph-description">
                A keyboard-navigable map connecting papers, topics, findings, limitations, future
                work, and external references. Use the Evidence list view for a linear alternative.
              </desc>
              <defs>
                <marker id="knowledge-edge-arrow" markerHeight="6" markerWidth="6" orient="auto" refX="5" refY="3">
                  <path d="M0,0 L0,6 L6,3 z" />
                </marker>
              </defs>
              <g aria-hidden="true" className="knowledge-graph-edges">
                {shownEdges.map((edge) => {
                  const source = positionById.get(edge.sourceId)
                  const target = positionById.get(edge.targetId)
                  if (!source || !target) return null
                  return (
                    <line
                      className={`graph-edge graph-edge-${edge.kind}`}
                      key={edge.id}
                      markerEnd="url(#knowledge-edge-arrow)"
                      x1={source.x}
                      x2={target.x}
                      y1={source.y}
                      y2={target.y}
                    />
                  )
                })}
              </g>
              <g className="knowledge-graph-nodes">
                {positionedNodes.map(({ node, x, y }) => {
                  const active = activeNode?.id === node.id
                  const paperSelected = Boolean(selectedPaperId && node.paperId === selectedPaperId)
                  return (
                    <g
                      aria-label={nodeAccessibleLabel(node)}
                      aria-pressed={active}
                      className={`graph-node graph-node-${node.kind} ${active ? 'is-active' : ''} ${
                        paperSelected ? 'is-paper-selected' : ''
                      }`}
                      key={node.id}
                      onClick={() => activateNode(node)}
                      onKeyDown={(event) => handleNodeKeyDown(event, node)}
                      role="button"
                      tabIndex={0}
                      transform={`translate(${x - 73} ${y - 22})`}
                    >
                      <title>{nodeAccessibleLabel(node)}</title>
                      <rect height="44" rx="9" width="146" />
                      <text textAnchor="middle" x="73" y="19">
                        {shortenedLabel(node.label)}
                      </text>
                      <text className="graph-node-kind" textAnchor="middle" x="73" y="33">
                        {NODE_KIND_LABEL[node.kind]}
                      </text>
                    </g>
                  )
                })}
              </g>
            </svg>
            <ul aria-label="Knowledge map legend" className="knowledge-graph-legend">
              {(['paper', 'topic', 'finding', 'limitation', 'future_work', 'external_reference'] as const).map((kind) => (
                <li key={kind}>
                  <span className={`graph-kind-${kind}`} />
                  {NODE_KIND_LABEL[kind]}
                </li>
              ))}
            </ul>
          </div>
          <GraphInspector
            activeNode={activeNode}
            edges={edges}
            evidenceById={evidenceById}
            nodeById={nodeById}
            onOpenPaper={onOpenPaper}
            onSelectEvidence={onSelectEvidence}
          />
        </div>
      ) : (
        <EvidenceList
          activeNodeId={activeNode?.id ?? null}
          edges={edges}
          evidenceById={evidenceById}
          nodeById={nodeById}
          nodes={shownNodes}
          onActivateNode={activateNode}
          onOpenPaper={onOpenPaper}
          onSelectEvidence={onSelectEvidence}
          selectedPaperId={selectedPaperId}
        />
      )}
    </div>
  )

}
