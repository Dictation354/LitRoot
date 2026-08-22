import type { DigestItem, InsightEvidence, InsightKind, PaperDigest } from '../../shared/contracts'
import { Icon, type IconName } from './icons'

const DIGEST_ORDER: InsightKind[] = [
  'purpose',
  'method',
  'finding',
  'limitation',
  'future_work'
]

const DIGEST_KIND_COPY: Record<
  InsightKind,
  { empty: string; icon: IconName; label: string }
> = {
  purpose: {
    empty: 'No clear purpose statement was found in the indexed text.',
    icon: 'search',
    label: 'Purpose'
  },
  method: {
    empty: 'No reliable method summary was found in the indexed text.',
    icon: 'layers',
    label: 'Method'
  },
  finding: {
    empty: 'No distinct finding was found in the indexed text.',
    icon: 'check',
    label: 'Findings'
  },
  limitation: {
    empty: 'No author-stated limitation was found in the indexed text.',
    icon: 'triangle-alert',
    label: 'Limitations'
  },
  future_work: {
    empty: 'No author-stated future-work signal was found in the indexed text.',
    icon: 'sparkles',
    label: 'Future work'
  }
}

function contentKindLabel(contentKind: PaperDigest['coverage']['contentKind']): string {
  if (contentKind === 'fulltext') return 'Full-text evidence'
  if (contentKind === 'abstract_only') return 'Abstract-only evidence'
  return 'Metadata-only evidence'
}

function evidenceSourceLabel(evidence: InsightEvidence): string {
  if (evidence.sectionHeading) return evidence.sectionHeading
  if (evidence.source === 'abstract') return 'Abstract'
  if (evidence.source === 'keyword') return 'Keywords'
  if (evidence.source === 'reference') return 'References'
  return 'Paper section'
}

function DigestEvidenceButton({
  evidence,
  item,
  onSelectEvidence
}: {
  evidence: InsightEvidence | undefined
  item: DigestItem
  onSelectEvidence(evidence: InsightEvidence): void
}): React.JSX.Element {
  if (!evidence) {
    return <span className="digest-evidence-missing">Evidence location unavailable</span>
  }

  const sourceLabel = evidenceSourceLabel(evidence)
  return (
    <button
      aria-label={`Open evidence for ${DIGEST_KIND_COPY[item.kind].label}: ${sourceLabel}`}
      className="digest-evidence-button"
      onClick={() => onSelectEvidence(evidence)}
      type="button"
    >
      <span className="digest-evidence-source">
        <Icon name="link" size={13} />
        {sourceLabel}
      </span>
      <span className="digest-evidence-quote">
        “{evidence.quote}”{evidence.truncated ? '…' : ''}
      </span>
    </button>
  )
}

function DigestState({
  error,
  loading,
  onRetry
}: {
  error: string | null
  loading: boolean
  onRetry?: (() => void) | undefined
}): React.JSX.Element {
  if (loading) {
    return (
      <div aria-live="polite" className="insight-state insight-state-loading" role="status">
        <span className="insight-state-icon">
          <Icon className="spin" name="refresh" size={19} />
        </span>
        <strong>Building the evidence digest…</strong>
        <p>PaperRelay is tracing purpose, methods, findings, and author-stated next steps.</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="insight-state insight-state-error" role="alert">
        <span className="insight-state-icon">
          <Icon name="triangle-alert" size={19} />
        </span>
        <strong>Digest unavailable</strong>
        <p>{error}</p>
        {onRetry && (
          <button className="secondary-button compact-button" onClick={onRetry} type="button">
            Try again
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="insight-state insight-state-empty">
      <span className="insight-state-icon">
        <Icon name="sparkles" size={19} />
      </span>
      <strong>No digest yet</strong>
      <p>Select a readable paper to build an evidence-linked digest.</p>
    </div>
  )
}

export function PaperDigestContent({
  digest,
  error = null,
  loading = false,
  onRetry,
  onSelectEvidence
}: {
  digest: PaperDigest | null
  error?: string | null
  loading?: boolean
  onRetry?: (() => void) | undefined
  onSelectEvidence(evidence: InsightEvidence): void
}): React.JSX.Element {
  if (!digest) return <DigestState error={error} loading={loading} onRetry={onRetry} />

  const evidenceById = new Map(digest.evidence.map((evidence) => [evidence.id, evidence]))
  const itemsByKind = new Map<InsightKind, DigestItem[]>(
    DIGEST_ORDER.map((kind) => [
      kind,
      digest.items.filter((item) => item.kind === kind)
    ])
  )
  const coverageCount = digest.coverage.availableKinds.length

  return (
    <div aria-busy={loading} className="paper-digest-scroll">
      <article className="paper-digest">
        <header className="paper-digest-header">
          <span className="paper-digest-mark" aria-hidden="true">
            <Icon name="sparkles" size={20} />
          </span>
          <div className="paper-digest-heading-copy">
            <div className="insight-eyebrow">Evidence digest</div>
            <h2>{digest.title}</h2>
            <p>
              A structured reading aid linked back to the indexed source. It is not a substitute
              for reading the paper.
            </p>
          </div>
          <div className="paper-digest-coverage" title={digest.coverage.message ?? undefined}>
            <strong>{coverageCount}/{DIGEST_ORDER.length}</strong>
            <span>signals found</span>
          </div>
        </header>

        <div className="paper-digest-meta" role="status">
          <span className={`digest-source-kind kind-${digest.coverage.contentKind}`}>
            {contentKindLabel(digest.coverage.contentKind)}
          </span>
          {digest.coverage.limited && (
            <span className="digest-limited-note">
              <Icon name="triangle-alert" size={13} />
              {digest.coverage.message ?? 'Coverage is limited by the available source text.'}
            </span>
          )}
          {loading && (
            <span aria-live="polite" className="digest-updating-note">
              <Icon className="spin" name="refresh" size={12} />
              Updating
            </span>
          )}
          {error && (
            <span className="digest-update-error">
              <Icon name="triangle-alert" size={12} />
              Update failed · showing the previous digest
            </span>
          )}
        </div>

        <div className="paper-digest-sections">
          {DIGEST_ORDER.map((kind) => {
            const copy = DIGEST_KIND_COPY[kind]
            const items = itemsByKind.get(kind) ?? []
            const headingId = `paper-digest-${kind}-heading`
            return (
              <section aria-labelledby={headingId} className={`digest-section digest-${kind}`} key={kind}>
                <div className="digest-section-heading">
                  <span aria-hidden="true">
                    <Icon name={copy.icon} size={16} />
                  </span>
                  <h3 id={headingId}>{copy.label}</h3>
                  {kind === 'future_work' && items.length > 0 && (
                    <span className="digest-author-badge">Author stated</span>
                  )}
                </div>
                {items.length === 0 ? (
                  <p className="digest-section-empty">{copy.empty}</p>
                ) : (
                  <ul className="digest-item-list">
                    {items.map((item) => (
                      <li key={item.id}>
                        <p>{item.text}</p>
                        <DigestEvidenceButton
                          evidence={evidenceById.get(item.evidenceId)}
                          item={item}
                          onSelectEvidence={onSelectEvidence}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>

        <footer className="insight-disclaimer">
          <Icon name="shield" size={15} />
          <span>{digest.disclaimer}</span>
        </footer>
      </article>
    </div>
  )
}
