import type {
  InsightEvidence,
  ResearchLandscape,
  ResearchSignal,
  ResearchSignalBasis
} from '../../shared/contracts'
import { Icon, type IconName } from './icons'
import { KnowledgeGraph } from './KnowledgeGraph'

const SIGNAL_GROUP_COPY: Record<
  ResearchSignalBasis,
  { description: string; empty: string; icon: IconName; label: string }
> = {
  author_stated: {
    description: 'Limitations and next steps explicitly stated in the indexed papers.',
    empty: 'No explicit future-work statement was found in the analyzed papers.',
    icon: 'book-open',
    label: 'Author-stated signals'
  },
  local_corpus_hypothesis: {
    description: 'Connections suggested by patterns across this local library.',
    empty: 'No cross-paper research hypothesis met the local evidence threshold.',
    icon: 'sparkles',
    label: 'Local-corpus hypotheses'
  },
  local_coverage_gap: {
    description: 'Areas where this library has too little evidence for a reliable synthesis.',
    empty: 'No notable coverage gap was identified in this landscape.',
    icon: 'triangle-alert',
    label: 'Coverage gaps'
  }
}

function evidenceSourceLabel(evidence: InsightEvidence): string {
  if (evidence.sectionHeading) return evidence.sectionHeading
  if (evidence.source === 'abstract') return 'Abstract'
  if (evidence.source === 'keyword') return 'Keywords'
  if (evidence.source === 'reference') return 'References'
  return 'Paper section'
}

function landscapeStateCopy(error: string | null, loading: boolean): {
  body: string
  icon: IconName
  title: string
  tone: string
} {
  if (loading) {
    return {
      body: 'PaperRelay is connecting topics, findings, limitations, and author-stated next steps.',
      icon: 'refresh',
      title: 'Mapping the local evidence…',
      tone: 'insight-state-loading'
    }
  }
  if (error) {
    return {
      body: error,
      icon: 'triangle-alert',
      title: 'Research Radar unavailable',
      tone: 'insight-state-error'
    }
  }
  return {
    body: 'Connect or select a research scope to build an evidence landscape.',
    icon: 'sparkles',
    title: 'No research landscape yet',
    tone: 'insight-state-empty'
  }
}

function LandscapeState({
  error,
  loading,
  onRetry
}: {
  error: string | null
  loading: boolean
  onRetry?: (() => void) | undefined
}): React.JSX.Element {
  const copy = landscapeStateCopy(error, loading)
  return (
    <div
      aria-live={loading ? 'polite' : undefined}
      className={`insight-state radar-state ${copy.tone}`}
      role={error ? 'alert' : loading ? 'status' : undefined}
    >
      <span className="insight-state-icon">
        <Icon className={loading ? 'spin' : undefined} name={copy.icon} size={21} />
      </span>
      <strong>{copy.title}</strong>
      <p>{copy.body}</p>
      {error && onRetry && (
        <button className="secondary-button compact-button" onClick={onRetry} type="button">
          Try again
        </button>
      )}
    </div>
  )
}

function OmissionSummary({ landscape }: { landscape: ResearchLandscape }): React.JSX.Element | null {
  if (!landscape.truncation.truncated) return null
  const omissionPairs: Array<[number, string]> = [
    [landscape.truncation.omittedPaperCount, 'papers'],
    [landscape.truncation.omittedNodeCount, 'nodes'],
    [landscape.truncation.omittedEdgeCount, 'relationships'],
    [landscape.truncation.omittedEvidenceCount, 'evidence excerpts']
  ]
  const omissions = omissionPairs
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)

  return (
    <div className="radar-truncation-note" role="status">
      <Icon name="archive" size={15} />
      <span>
        This view shows the strongest bounded subgraph. Omitted: {omissions.join(', ') || 'additional records'}.
      </span>
    </div>
  )
}

function SignalEvidence({
  evidence,
  onSelectEvidence
}: {
  evidence: InsightEvidence
  onSelectEvidence?: ((evidence: InsightEvidence) => void) | undefined
}): React.JSX.Element {
  const content = (
    <>
      <span>
        <Icon name="link" size={12} />
        {evidenceSourceLabel(evidence)}
      </span>
      <q>{evidence.quote}{evidence.truncated ? '…' : ''}</q>
    </>
  )

  if (!onSelectEvidence) return <div className="radar-signal-evidence">{content}</div>
  return (
    <button
      aria-label={`Open supporting evidence in ${evidenceSourceLabel(evidence)}`}
      className="radar-signal-evidence is-actionable"
      onClick={() => onSelectEvidence(evidence)}
      type="button"
    >
      {content}
    </button>
  )
}

function SignalCard({
  evidenceById,
  onOpenPaper,
  onSelectEvidence,
  paperLabelById,
  signal
}: {
  evidenceById: Map<string, InsightEvidence>
  onOpenPaper(paperId: string): void
  onSelectEvidence?: ((evidence: InsightEvidence) => void) | undefined
  paperLabelById: Map<string, string>
  signal: ResearchSignal
}): React.JSX.Element {
  const evidence = signal.evidenceIds
    .map((id) => evidenceById.get(id))
    .filter((item): item is InsightEvidence => Boolean(item))
    .slice(0, 2)
  const isHypothesis = signal.basis === 'local_corpus_hypothesis'

  return (
    <article className={`radar-signal-card signal-${signal.basis}`}>
      <div className="radar-signal-card-topline">
        <span>
          {signal.basis === 'author_stated'
            ? 'Author stated'
            : signal.basis === 'local_coverage_gap'
              ? 'Coverage gap'
              : 'Local synthesis'}
        </span>
        {(isHypothesis || signal.noveltyRequiresExternalChecking) && (
          <span className="radar-external-check-badge">External check needed</span>
        )}
      </div>
      <h3>{signal.title}</h3>
      <p className="radar-signal-statement">{signal.statement}</p>
      <p className="radar-signal-rationale">{signal.rationale}</p>

      {evidence.length > 0 && (
        <div className="radar-signal-evidence-list">
          {evidence.map((item) => (
            <SignalEvidence
              evidence={item}
              key={item.id}
              onSelectEvidence={onSelectEvidence}
            />
          ))}
        </div>
      )}

      <footer className="radar-signal-footer">
        <span>{signal.evidenceIds.length} evidence link{signal.evidenceIds.length === 1 ? '' : 's'}</span>
        <div>
          {signal.paperIds.slice(0, 3).map((paperId) => (
            <button
              key={paperId}
              onClick={() => onOpenPaper(paperId)}
              title={paperLabelById.get(paperId) ?? 'Open source paper'}
              type="button"
            >
              <Icon name="book-open" size={12} />
              {paperLabelById.get(paperId) ?? 'Open paper'}
            </button>
          ))}
          {signal.paperIds.length > 3 && <span>+{signal.paperIds.length - 3} papers</span>}
        </div>
      </footer>
    </article>
  )
}

function SignalGroup({
  basis,
  evidenceById,
  onOpenPaper,
  onSelectEvidence,
  paperLabelById,
  signals
}: {
  basis: ResearchSignalBasis
  evidenceById: Map<string, InsightEvidence>
  onOpenPaper(paperId: string): void
  onSelectEvidence?: ((evidence: InsightEvidence) => void) | undefined
  paperLabelById: Map<string, string>
  signals: ResearchSignal[]
}): React.JSX.Element {
  const copy = SIGNAL_GROUP_COPY[basis]
  const headingId = `radar-${basis}-heading`
  return (
    <section aria-labelledby={headingId} className={`radar-signal-group radar-group-${basis}`}>
      <div className="radar-section-heading">
        <span aria-hidden="true">
          <Icon name={copy.icon} size={17} />
        </span>
        <div>
          <h2 id={headingId}>{copy.label}</h2>
          <p>{copy.description}</p>
        </div>
        <strong>{signals.length}</strong>
      </div>
      {signals.length === 0 ? (
        <p className="radar-signal-empty">{copy.empty}</p>
      ) : (
        <div className="radar-signal-grid">
          {signals.map((signal) => (
            <SignalCard
              evidenceById={evidenceById}
              key={signal.id}
              onOpenPaper={onOpenPaper}
              onSelectEvidence={onSelectEvidence}
              paperLabelById={paperLabelById}
              signal={signal}
            />
          ))}
        </div>
      )}
    </section>
  )
}

export function ResearchRadarWorkspace({
  error = null,
  landscape,
  loading = false,
  onOpenPaper,
  onRefresh,
  onRetry,
  onSelectEvidence,
  onSelectPaper,
  scopeLabel = 'Local library',
  selectedPaperId
}: {
  error?: string | null
  landscape: ResearchLandscape | null
  loading?: boolean
  onOpenPaper(paperId: string): void
  onRefresh?: (() => void) | undefined
  onRetry?: (() => void) | undefined
  onSelectEvidence?: ((evidence: InsightEvidence) => void) | undefined
  onSelectPaper(paperId: string): void
  scopeLabel?: string | undefined
  selectedPaperId: string | null
}): React.JSX.Element {
  if (!landscape) return <LandscapeState error={error} loading={loading} onRetry={onRetry} />

  const evidenceById = new Map(landscape.evidence.map((evidence) => [evidence.id, evidence]))
  const paperLabelById = new Map(
    landscape.nodes
      .filter((node) => node.kind === 'paper' && node.paperId)
      .map((node) => [node.paperId as string, node.label])
  )
  const coveragePercent =
    landscape.paperCount === 0
      ? 0
      : Math.round((landscape.analyzedPaperCount / landscape.paperCount) * 100)

  if (landscape.paperCount === 0) {
    return (
      <div className="insight-state radar-state insight-state-empty">
        <span className="insight-state-icon">
          <Icon name="layers" size={21} />
        </span>
        <strong>No papers in this research scope</strong>
        <p>Add readable papers or choose a different folder before building a landscape.</p>
      </div>
    )
  }

  if (landscape.analyzedPaperCount === 0) {
    return (
      <div className="insight-state radar-state insight-state-empty">
        <span className="insight-state-icon">
          <Icon name="triangle-alert" size={21} />
        </span>
        <strong>Not enough readable evidence</strong>
        <p>{landscape.paperCount} indexed paper{landscape.paperCount === 1 ? '' : 's'} were found, but none contain enough structured text for a landscape.</p>
      </div>
    )
  }

  return (
    <div aria-busy={loading} className="research-radar-scroll">
      <section aria-labelledby="research-radar-heading" className="research-radar-workspace">
        <header className="radar-hero">
          <div className="radar-hero-heading">
            <span className="radar-hero-mark" aria-hidden="true">
              <Icon name="sparkles" size={23} />
            </span>
            <div>
              <div className="insight-eyebrow">Local evidence synthesis · {scopeLabel}</div>
              <h1 id="research-radar-heading">Research Radar</h1>
              <p>
                Trace what the library says, where evidence connects, and which questions may
                deserve closer investigation.
              </p>
            </div>
          </div>
          {onRefresh && (
            <button
              className="secondary-button compact-button radar-refresh-button"
              disabled={loading}
              onClick={onRefresh}
              type="button"
            >
              <Icon className={loading ? 'spin' : undefined} name="refresh" size={14} />
              {loading ? 'Updating…' : 'Refresh analysis'}
            </button>
          )}
        </header>

        {(loading || error) && (
          <div
            aria-live={loading ? 'polite' : undefined}
            className={`radar-update-banner ${error ? 'has-error' : ''}`}
            role={error ? 'alert' : 'status'}
          >
            <Icon className={loading && !error ? 'spin' : undefined} name={error ? 'triangle-alert' : 'refresh'} size={14} />
            <span>
              {error
                ? 'Update failed. The last complete landscape is still shown.'
                : 'Updating the landscape while the last complete analysis remains available.'}
            </span>
            {error && onRetry && (
              <button onClick={onRetry} type="button">Try again</button>
            )}
          </div>
        )}

        <section aria-label="Landscape coverage" className="radar-overview-grid">
          <div className="radar-coverage-card">
            <div>
              <span>Analysis coverage</span>
              <strong>{coveragePercent}%</strong>
            </div>
            <progress max={landscape.paperCount} value={landscape.analyzedPaperCount}>
              {coveragePercent}%
            </progress>
            <p>{landscape.analyzedPaperCount} of {landscape.paperCount} papers contributed readable evidence</p>
          </div>
          <div className="radar-stat-card">
            <span>Knowledge nodes</span>
            <strong>{landscape.nodes.length}</strong>
            <small>papers, topics, claims, and next steps</small>
          </div>
          <div className="radar-stat-card">
            <span>Evidence links</span>
            <strong>{landscape.evidence.length}</strong>
            <small>traceable excerpts in this view</small>
          </div>
          <div className="radar-stat-card is-hypothesis">
            <span>Research signals</span>
            <strong>{landscape.signals.length}</strong>
            <small>author statements and local hypotheses</small>
          </div>
        </section>

        <OmissionSummary landscape={landscape} />

        <aside className="radar-novelty-caveat">
          <span aria-hidden="true"><Icon name="triangle-alert" size={17} /></span>
          <div>
            <strong>Research opportunities, not novelty claims</strong>
            <p>
              These hypotheses are derived only from the indexed local corpus. Novelty and whether
              a gap has already been addressed require an external literature check.
            </p>
          </div>
        </aside>

        <section aria-labelledby="radar-map-heading" className="radar-map-section">
          <div className="radar-section-heading">
            <span aria-hidden="true"><Icon name="layers" size={17} /></span>
            <div>
              <h2 id="radar-map-heading">Evidence landscape</h2>
              <p>Select a node to inspect its relationships and source excerpts.</p>
            </div>
          </div>
          <KnowledgeGraph
            edges={landscape.edges}
            evidence={landscape.evidence}
            nodes={landscape.nodes}
            onOpenPaper={onOpenPaper}
            onSelectEvidence={onSelectEvidence}
            onSelectPaper={onSelectPaper}
            selectedPaperId={selectedPaperId}
          />
        </section>

        {(['author_stated', 'local_corpus_hypothesis', 'local_coverage_gap'] as const).map((basis) => (
          <SignalGroup
            basis={basis}
            evidenceById={evidenceById}
            key={basis}
            onOpenPaper={onOpenPaper}
            onSelectEvidence={onSelectEvidence}
            paperLabelById={paperLabelById}
            signals={landscape.signals.filter((signal) => signal.basis === basis)}
          />
        ))}

        <footer className="insight-disclaimer radar-disclaimer">
          <Icon name="shield" size={15} />
          <span>{landscape.disclaimer}</span>
        </footer>
      </section>
    </div>
  )
}
