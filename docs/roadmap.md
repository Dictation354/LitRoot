# PaperRelay roadmap: A, B, C, then interoperability

## Recommendation

Implement the selected tracks in this order:

```text
Phase 5 / A              Phase 6 / B                 Phase 7 / C
reliable release   ->    research artifacts    ->    directed acquisition
drafts + tests           anchors + collections       jobs + provenance
packaging + security     private search               external checks
        \_____________________|_____________________________/
                              |
                              v
                     Phase 8 / interoperability
                     Zotero read-first
                     Obsidian export-first
```

The order is a data-integrity dependency, not just product preference. B needs A's durable drafts, lifecycle coordination, test harness, and packaged runtime. C needs the same trusted execution and error boundaries. Zotero/Obsidian interoperability should consume B's stable personal-artifact IDs and C's normalized identities/provenance rather than inventing a competing sync model early.

Use release gates rather than calendar estimates until Phase 5 establishes CI, packaging, corpus benchmarks, and a clean repository baseline.

## Current implementation status

The recommended first Phase 5 batch was implemented on 2026-08-20:

1. ignore/package boundaries, pinned tooling, CI/check configuration, and packaging allowlists are present; local Git initialization remains blocked because this execution sandbox forbids creating `.git`;
2. regression tests cover draft transition policy, close/quit coordination and authorization, durable-draft storage/recovery, and Radar navigation;
3. user-schema 2, durable note/raw-tag drafts, atomic commit/discard, and the typed transition coordinator are wired through database, service, IPC, preload, and renderer;
4. Radar selection stays in Radar while explicit open/evidence actions enter Reader, and summary/list/load-more/detail errors no longer clear one another;
5. the relay is bundled and the Electron-as-Node fallback passes an exact four-tool MCP handshake with no Node executable available through `PATH`; SEA remains preferred but unvalidated, and the chosen runtime still needs to be wired into packaged Agent Relay setup.

This is a completed implementation batch, not the Phase 5 release gate. The next batch should add the reusable accessible dialog/menu primitives and Electron E2E harness, then finish scanner/content revisions, bounded desktop responses, MCP cursors, universal privileged-IPC validation, and installed-package/signing checks. See [Phase 5 implementation status](phase-5.md#implementation-status--first-batch) for evidence and limitations.

## Release sequence

| Phase | Target | User-visible outcome | Exit gate |
|---|---|---|---|
| 5 — A | `0.3` | Dependable, accessible, packaged PaperRelay with recoverable drafts | Signed macOS build, packaged relay, CI/E2E, no silent draft loss |
| 6 — B | `0.4` | Highlights, annotations, collections, saved views, private search | Exact anchors survive normal change; ambiguous anchors visibly orphan; private data stays private |
| 7 — C | `0.5` | Explicit acquisition/refetch queue and bounded Radar literature checks | Immutable verified publication, cancellable jobs, honest provider provenance |
| 8 — D | `0.6` beta candidate | Safe Zotero linking/export and Obsidian Markdown interoperability | Previewed one-way sync, deterministic links, conflicts instead of overwrite |

Detailed specifications:

- [Phase 5: Hardening and release readiness](phase-5.md)
- [Phase 6: Research workflow depth](phase-6.md)
- [Phase 7: Directed acquisition and external literature checks](phase-7.md)
- [Phase 8: Zotero and Obsidian interoperability](phase-8.md)

## Cross-phase invariants

These rules are release blockers in every phase:

1. Connected research artifacts are immutable inputs. Only Phase 7's explicitly approved acquisition namespace may receive PaperRelay-managed files.
2. The rebuildable catalog contains source-derived data; private user artifacts, operations, and connector state use separate sidecars.
3. Every renderer-to-main mutation is strictly validated and authorized to the active trusted main frame.
4. Source or remote revisions are checked before writes. Stale work returns a typed conflict.
5. Exact normalized DOI is the only automatic cross-system identity match. Fuzzy metadata creates a suggestion, never a write.
6. External paper content and metadata are untrusted data, not instructions.
7. Agent Relay stays catalog-only, read-only, bounded, and at four tools through this roadmap.
8. No autonomous network work, background acquisition, or silent bidirectional sync is introduced.

## Storage ownership

| Store | Authority | Rebuildable | Exposed to Agent Relay |
|---|---|---:|---:|
| `paperrelay.sqlite3` | Indexed source metadata/text and FTS | Yes | Yes, bounded read-only |
| `paperrelay-user.sqlite3` | State, drafts, annotations, collections, saved views, private FTS | No | No |
| `paperrelay-operations.sqlite3` | Acquisition attempts, checks, hits, verified provenance | No | No |
| `paperrelay-integrations.sqlite3` | Connections, external links/cursors, outbox, runs, conflicts | No | No |
| Registered research roots | Original artifacts plus approved Phase 7 acquisition output | Source-authoritative | Indirectly through catalog |

No sidecar uses a cascading foreign key into the rebuildable catalog. Stable IDs plus canonical identity snapshots allow state to become dormant when a root disconnects and return when the identity is indexed again.

## Phase 5 / A execution plan

### 5.1 — Establish a safe development baseline

- Protect local corpora, databases, credentials, build output, and test artifacts in ignore/package allowlists before initializing Git.
- Pin Node/pnpm, add lint/format/coverage/check commands, and create CI with synthetic fixtures only.
- Add serial Playwright Electron smoke tests and an isolated `PAPERRELAY_DATA_DIR`.
- Run an early packaged-relay spike so signing/runtime risk is known before the final release sprint.

### 5.2 — Fix data-loss and navigation risks

- Add durable note/tag recovery drafts in user-schema 2.
- Route paper, scope, Radar, root removal, reload, close, and quit through one guarded transition coordinator.
- Correct Radar's select-versus-open behavior.
- Split global async/error state by resource and give every visible failure its own retry.

### 5.3 — Accessibility, indexing, and relay robustness

- Introduce accessible dialog/menu primitives and repair tiny controls, focus, keyboard, zoom, and contrast behavior.
- Strengthen scanner identity/content revisions and add a deliberate deep rescan.
- Bound desktop detail responses and add opaque MCP search cursors without a fifth tool.
- Validate every privileged IPC sender and production security setting.

### 5.4 — Package and release

- Package native modules and the relay, verify operation without a system Node installation, and remove hard-coded version drift.
- Sign/notarize separate macOS arm64/x64 artifacts and test an installed build on a clean profile.
- Release only when migrations, relay handshake, corpus immutability, E2E, and rollback-safe failure behavior pass.

## Phase 6 / B execution plan

### 6.0–6.1 — Anchor foundation and annotations

- Add representation/content revisions and a shared logical reader-block projection.
- Migrate the user sidecar to schema 3 with stable annotation UUIDs, versioned position/quote selectors, entity revisions, tombstones, and anchor history.
- Validate every new selection against current canonical source text in main.
- Render highlights and annotation cards; re-anchor only on a unique exact/context match and surface ambiguous/orphaned items for review.

### 6.2–6.3 — Organization and discovery

- Add flat manual collections and bounded bulk membership actions.
- Add versioned saved views whose definitions are validated filter data, never SQL.
- Add private FTS for committed notes/tags/annotations/collections and combine candidate IDs with catalog search before stable pagination.

### 6.4 — Release gate

- Prove root disconnect/reconnect and identity reconciliation preserve personal artifacts.
- Exercise overlapping anchors, source revisions, ambiguity, stale edits, private-search isolation, keyboard flows, and high-volume fixtures in packaged E2E.

## Phase 7 / C execution plan

### 7.0–7.1 — Operations foundation and Codex handoff

- Add an operations sidecar, job/attempt state machine, scheduler, preview tokens, queue UI, and verified staging/publication namespace.
- Ship the structured Codex handoff first. It inserts a bounded prompt into the correct root session without submitting it and considers the job complete only after explicit output verification.

### 7.2 — Managed acquisition

- Require a frozen `paper-fetch` invocation/manifest contract before enabling its adapter.
- Use a fixed executable, `shell: false`, minimal environment, bounded output, cancellation, independent manifest validation, atomic publication, and exact identity reconciliation.
- Refetch always produces a new representation; existing sources remain unchanged.

### 7.3 — External Radar checks

- Start with a bounded Crossref adapter and show the exact outbound provider/query.
- Store query, time, provider/version, truncation, hits, local exact matches, and user relevance review.
- Render results as potential related work and distinguish `no_hits_in_bounded_check` from proof of novelty.

### 7.4 — Release gate

- Prove cancellation, interrupted-process recovery, offline/rate-limit/malformed results, symlink containment, secret redaction, and packaged-app behavior.

## Phase 8 / Zotero and Obsidian

Start with deliberately asymmetric integrations:

### Zotero

1. **Z1: local discovery and exact linking.** Use Zotero's documented loopback API read-only, never its SQLite files. Exact DOI links automatically; metadata similarity requires confirmation.
2. **Z2: explicit Web API export.** Authorize minimal permissions, preview fields, use library/object versions and preconditions, and turn `412` responses into conflicts. Do not upload attachments initially.
3. **Z3: selected note/annotation export.** Write a clearly marked child note idempotently. Defer native PDF annotation mapping because PaperRelay text anchors lack PDF page geometry.

### Obsidian

1. **O1: versioned Markdown export.** Export one note per paper into an approved vault folder with stable frontmatter and PaperRelay-owned blocks. Hash prior exports and use atomic writes.
2. **O2: selective import.** Import only recognized/confirmed notes after a field-level preview; never crawl or interpret arbitrary vault Markdown as commands.
3. **O3: optional plugin.** Build against Obsidian's official Vault API only after the file contract is stable; use it for commands, navigation, and conflict UI rather than making it a prerequisite.

The first integration beta is one-way and user-triggered. Deletions do not propagate automatically. Two-sided changes create a durable conflict record; there is no last-write-wins mode.

## Parallel work that is safe

Parallelize research and contract tests without weakening the sequence:

- During Phase 5 implementation, prototype Phase 6 source-span fixtures and the packaged relay runtime in isolated branches.
- During late Phase 6, build read-only Zotero and temporary-vault Obsidian contract fakes, but do not add connector writes.
- During Phase 7, validate the Phase 8 event envelope (`paper indexed`, `representation changed`, `personal artifact changed`) and export fixtures.
- Signing, accessibility review, adversarial IPC tests, and deterministic provider/connector fakes can proceed alongside feature work.

Database migrations, public contracts, and release branches remain serial: a later schema must be based on the released prior schema, not a parallel draft.

## Decision gates before implementation

The recommended defaults are already reflected in the phase specs. Only these gates should pause work:

1. **Release identity:** macOS application ID, Developer ID team, product icon/name, and release-channel naming before signing automation.
2. **Relay runtime spike:** prefer a signed single-purpose sidecar so production Electron fuses can disable general Node modes; accept an Electron-as-Node fallback only after an explicit threat-model and packaging review.
3. **Managed `paper-fetch` contract:** do not infer a CLI protocol from existing output files; require version/probe/input/progress/cancel/result documentation.
4. **Integration permissions:** decide whether Zotero Web API export is personal-library only at first and which Obsidian fields/blocks PaperRelay is allowed to own.

## First implementation batch — implemented

The first batch stayed within Phase 5:

1. harden ignore/package boundaries and initialize the repository baseline;
2. add regression tests for draft-loss transitions and Radar navigation;
3. implement user-schema 2, durable drafts, and the transition coordinator;
4. repair Radar actions and resource-scoped errors;
5. run the relay packaging spike while UX hardening continues.

This batch removes the two highest-risk user-facing defects and narrows the largest release uncertainty before Phase 6 expands the personal data model. Repository initialization remains the environment-blocked exception documented above.
