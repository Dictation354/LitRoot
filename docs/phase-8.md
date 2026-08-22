# Phase 8: Zotero and Obsidian interoperability

## Status

This is a prepared design, not an active implementation phase. Work starts only after the Phase 5 release gate, Phase 6 stable personal-artifact model, and Phase 7 acquisition/provenance model are complete.

## Product outcome

A researcher can connect PaperRelay to Zotero and one or more Obsidian vaults without changing indexed research sources or surrendering control of either external library. PaperRelay can link matching papers, preview imports or exports, and open the corresponding external record. Synchronization begins one-way and explicit; bidirectional behavior is added only where conflicts can be detected and resolved safely.

## Product decisions

1. **Zotero starts read-first.** PaperRelay first reads through Zotero's documented local API and links exact matches. Web API writes arrive later behind a separate authorization and preview flow.
2. **Obsidian starts export-first.** PaperRelay writes versioned Markdown notes into an explicitly selected vault folder. A PaperRelay-aware Obsidian plugin is optional later, not required for the first useful integration.
3. **No direct Zotero database access.** PaperRelay never reads or writes Zotero's SQLite files.
4. **No silent fuzzy matching.** A normalized DOI can produce an automatic match. Title/author/year similarities only produce suggestions that require confirmation.
5. **No silent two-way merge.** Remote edits, local edits, and deletions produce a preview or conflict record rather than last-write-wins behavior.
6. **External metadata does not enter the rebuildable catalog as if it were a fetched source.** Unmatched Zotero items remain external candidates until the user links or acquires them through Phase 7.

## Ownership boundaries

- Structured research artifacts remain authoritative in their registered research folders.
- PaperRelay favorites, statuses, notes, annotations, collections, and drafts remain authoritative in the personal sidecar.
- Acquisition and literature-check history remains authoritative in the operations sidecar introduced by Phase 7.
- Connector cursors, external identifiers, export hashes, and conflicts live in a new `paperrelay-integrations.sqlite3` sidecar.
- Zotero and Obsidian content remains authoritative in those applications unless the user explicitly accepts an import into PaperRelay.
- Agent Relay remains read-only and does not expose integration credentials or private external-library content.

## Connector architecture

The Electron main process owns an `IntegrationService` with provider adapters. The renderer receives bounded DTOs through validated IPC and never receives raw credentials.

```ts
interface IntegrationAdapter {
  kind: 'zotero' | 'obsidian'
  capabilities(connectionId: string): Promise<IntegrationCapabilities>
  discover(request: DiscoveryRequest): Promise<DiscoveryPage>
  plan(request: SyncPlanRequest): Promise<SyncPlan>
  apply(approvedPlan: ApprovedSyncPlan): Promise<SyncRun>
  cancel(runId: string): Promise<void>
}
```

`plan` is side-effect free. `apply` accepts the immutable plan identifier and exact item set the user reviewed. Plans expire when either side's revision changes.

### Integration sidecar

The initial schema contains:

- `integration_connections`: connector kind, display name, mode, non-secret configuration, health, and sync cursor;
- `external_entity_links`: stable PaperRelay entity ID to provider scope/key, provider version, and last import/export hashes;
- `external_candidates`: bounded metadata for unlinked Zotero items, never indexed as PaperRelay full text;
- `integration_outbox`: approved local changes waiting to be exported;
- `integration_runs`: start/end state, counts, provider cursor, and bounded diagnostics;
- `integration_conflicts`: local base, local current, remote current, and the user's resolution.

No table has a cascading foreign key into the rebuildable catalog. Links use stable PaperRelay IDs plus canonical identity snapshots so dormant links can recover after a root reconnect or DOI identity upgrade.

## Zotero delivery slices

### Z1 — Local discovery and exact linking

- Detect the Zotero local API on loopback only after the user chooses **Connect Zotero**.
- Explain how to enable Zotero's local API when it returns unavailable or forbidden.
- Read API version 3 records, collections, tags, notes, and attachment metadata without opening Zotero's database files.
- Match normalized DOI values automatically; show title/author/year candidates for manual confirmation.
- Show linked Zotero collection/key and an **Open in Zotero** or returned alternate-link action on PaperRelay papers.
- Present unmatched items as external candidates with **Link** and **Acquire with PaperRelay** actions.

The first slice is read-only because the currently documented stable Zotero local API is read-only. Local-write support can be feature-detected in a later Zotero release but is not a baseline dependency.

### Z2 — Explicit Web API export

- Authorize the minimum requested library permissions through Zotero OAuth or a dedicated API key.
- Store the credential only through OS-backed encrypted storage; never in logs, renderer state, configuration snippets, or plain SQLite.
- Export selected PaperRelay papers as Zotero items after a field-level preview.
- Export selected PaperRelay collections and tags only when the user maps them to Zotero collections/tags.
- Use Zotero object and library version numbers for incremental synchronization.
- Treat `412 Precondition Failed` as a conflict requiring a fresh read and re-plan.
- Respect pagination, backoff headers, group-library permissions, and partial batch failures.
- Do not upload PDFs or other attachments in this slice.

### Z3 — Notes and annotations

- Export a private note or annotation set only after per-item confirmation.
- Begin with a clearly marked Zotero child note that PaperRelay can update idempotently.
- Preserve user-written Zotero content outside PaperRelay-managed blocks.
- Defer conversion into Zotero native PDF annotations: PaperRelay text anchors do not contain PDF page geometry and cannot be mapped safely without a separate alignment model.

## Obsidian delivery slices

### O1 — Versioned Markdown export

- Let the user select a vault root and destination folder with a native folder picker.
- Canonicalize the vault and every target on each write; reject symlink or traversal escapes.
- Export one note per paper with a configurable filename template and a versioned frontmatter contract.
- Default properties include `paperrelay_id`, normalized `doi`, title, authors, year, reading status, tags, source scopes, optional Zotero key, and `paperrelay_schema`.
- Use explicit managed blocks for digest, private note, annotations, and provenance. Content outside those blocks belongs to the user and is never rewritten.
- Store a hash of every last exported managed block. If the file changed on both sides, create a conflict instead of overwriting it.
- Write through a temporary sibling and atomic rename, then offer an `obsidian://open` action.

Example contract:

```markdown
---
paperrelay_schema: 1
paperrelay_id: paper_...
doi: 10.xxxx/example
tags: [methods, to-cite]
---

<!-- paperrelay:begin digest revision="..." -->
...
<!-- paperrelay:end digest -->
```

### O2 — Selective import

- Import only explicitly selected notes containing a recognized `paperrelay_id` or confirmed DOI match.
- Show a field-level preview before changing a PaperRelay note, tags, reading status, or collection membership.
- Never interpret vault Markdown as commands.
- Never crawl unrelated vault folders or import arbitrary notes by default.

### O3 — Optional Obsidian plugin

Build a small companion plugin only after the file contract is stable. It can add PaperRelay commands, backlink-aware navigation, and conflict UI inside Obsidian. It must use Obsidian's official Vault APIs and race-safe file processing rather than raw unsynchronized writes.

## Conflict rules

- A link is unique by connector, external scope, external key, local entity type, and local entity ID.
- Each side stores a last-synced version/hash. A single-sided change can be planned automatically; two-sided changes create a conflict.
- Deletions never propagate automatically in the first release.
- Resolving a conflict creates a new immutable plan and audit record.
- Metadata imported from Zotero is an overlay or a user-approved personal field update; it never silently rewrites indexed source metadata.
- Obsidian user prose outside managed blocks always wins because PaperRelay does not own it.

## Security and privacy

- Network access is provider-specific, visible, cancellable, and limited to documented HTTPS origins.
- Zotero local traffic is restricted to loopback and is never proxied or exposed remotely.
- Secrets are encrypted in the main process with Electron `safeStorage` when its platform backend is available. If secure storage is unavailable or reports a weak backend, PaperRelay offers session-only credentials rather than persisting them weakly.
- Every integration IPC handler validates the active main frame and validates bounded input independently.
- External titles, notes, tags, paths, and annotations are untrusted data.
- Connector logs contain operation IDs and typed failures, not credentials or full private note bodies.

## Acceptance criteria

- Disconnecting an integration never deletes PaperRelay personal state, source artifacts, Zotero objects, or Obsidian files.
- A Zotero local-library scan leaves Zotero's database and items unchanged.
- An exact DOI links deterministically; an ambiguous metadata match cannot write until confirmed.
- A Web API conflict cannot be overwritten by a stale PaperRelay plan.
- An Obsidian export modifies only approved frontmatter keys and PaperRelay-managed blocks.
- External edits to an Obsidian managed block create a visible conflict rather than data loss.
- Repeating an unchanged export is byte-for-byte idempotent.
- Revoking credentials makes the connector unavailable without corrupting cached links.
- Integration credentials and private external-library content are absent from Agent Relay responses.
- All connector tests run against deterministic local fakes; opt-in contract tests exercise real user-authorized accounts or vaults without destructive writes.

## Explicitly deferred

- Automatic bidirectional synchronization
- Background sync while PaperRelay is closed
- Zotero attachment upload/download and file-storage synchronization
- Conversion between PaperRelay text anchors and Zotero PDF-coordinate annotations
- Better BibTeX-specific citekey behavior
- Obsidian community-plugin publication before the file contract stabilizes
- Mobile/cloud sync provided by PaperRelay itself

## Primary technical references

- [Zotero Web API v3](https://www.zotero.org/support/dev/web_api/v3/)
- [Zotero local API](https://www.zotero.org/support/dev/web_api/v3/local_api)
- [Zotero synchronization and versioning](https://www.zotero.org/support/dev/web_api/v3/syncing)
- [Obsidian URI](https://help.obsidian.md/Extending%2BObsidian/Obsidian%2BURI)
- [Obsidian Vault API](https://docs.obsidian.md/Plugins/Vault)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
