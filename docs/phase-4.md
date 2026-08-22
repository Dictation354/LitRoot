# Phase 4: Evidence Digests and Research Radar

Phase 4 turns the indexed library into a traceable research-synthesis workspace without changing PaperRelay's local-first boundary.

## Product shape

The feature is split into two related surfaces:

1. **Paper Digest** is a per-paper tab beside Reader and Sources. It extracts a paper's purpose, method, findings, limitations, and future-work statements. Every item links to the exact abstract or section passage that produced it.
2. **Research Radar** is a library-level workspace. It connects papers, exact indexed topics, findings, limitations, future-work statements, and DOI citations in a bounded knowledge map. The adjacent paper list acts as the evidence set and the workspace can be scoped to all connected folders or one research folder.

This separation keeps quick reading and cross-paper synthesis understandable instead of mixing them into one generic AI summary.

## Evidence model

Insights are deterministic and extractive. PaperRelay does not invent prose for a paper's claims.

Each evidence record carries:

- the paper and active root scope;
- a revision derived from the selected source representation;
- the abstract or exact section index;
- start and end character offsets;
- the bounded source quotation shown in the UI.

The analyzer verifies this invariant:

```text
sourceText.slice(startOffset, endOffset) === quote
```

Opening evidence in a Paper Digest returns to Reader and focuses the cited abstract or section.

## Research signals

Radar deliberately uses three labels with different meanings:

- **Author-stated signals** quote an explicit limitation or proposed next step. They show what an indexed paper says, not whether the issue is still open.
- **Local-corpus hypotheses** require at least two papers with the same normalized indexed keyword and explicit limitation or future-work evidence. They are co-occurrence prompts for investigation, not causal or novelty claims.
- **Local coverage gaps** identify a DOI cited by at least two papers but missing from the selected PaperRelay scope. They describe library completeness, not a gap in the scientific field.

Every view states that novelty and whether a gap has already been addressed require an external literature search.

## Local execution and limits

Generation runs on demand in the Electron main process from the rebuildable catalog. It makes no network request, requires no model account, writes no generated content into source files or private notes, and does not change the catalog schema.

The first release is intentionally bounded:

- at most 200 papers per landscape;
- at most 1,600 analyzed sentences per paper, with explicit future-work and limitation sections prioritized;
- at most 600 characters per evidence excerpt;
- at most 500 graph nodes, 1,000 edges, and 500 evidence records;
- at most 12 unresolved external-reference nodes.

The UI reports omitted papers, nodes, relationships, or evidence whenever a bound is reached.

## Scope and quality controls

- Global analysis uses the catalog's preferred representation.
- Root-scoped analysis independently selects the preferred representation inside that root, so two project copies of the same DOI cannot leak text into one another.
- Metadata-only records produce a limited-coverage digest with no inferred claims.
- Abstract-only records analyze only the abstract, even if an access-gate artifact retained unusable body text.
- References, acknowledgements, availability statements, contribution statements, captions, and citation-dense fragments are excluded from sentence classification.
- Resolved phrases such as “fills a gap,” non-research uses such as “band gap,” temporal uses of “future,” and common prior-work attribution patterns are rejected.
- Citation edges require an exact normalized DOI match.

The read-only Agent Relay remains exactly four tools and does not expose the derived analysis in this phase.

## Acceptance checks

- Repeated analysis of unchanged sources is byte-for-byte deterministic.
- An unchanged rescan preserves the digest revision; a source edit and rescan changes it.
- Every displayed digest and graph assertion has source evidence.
- Root-scoped copies of the same DOI remain isolated.
- Heavy reference lists cannot overwhelm the visible graph.
- The graph has keyboard-operable nodes and a linear Evidence list alternative.
- Loading, stale-update, error, empty, partial-coverage, and truncated states remain legible.
- Catalog schema v2, source immutability, the private user database, and MCP protocol behavior remain unchanged.
