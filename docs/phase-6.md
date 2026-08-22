# Phase 6: Research workflow depth

## Status and product outcome

Phase 6 is the B track and targets the `0.4` release line after the Phase 5 reliability gate. It turns PaperRelay's private personal layer into a durable research workspace: users can highlight source text, attach annotations, organize papers into collections, save reusable library views, and find their own research artifacts without modifying indexed source files.

The decisive constraint is anchor integrity. A highlight is meaningful only if PaperRelay can prove which source text it refers to. After a source changes, PaperRelay either re-anchors by an exact deterministic match or marks the annotation for review; it never silently chooses a fuzzy match.

## Locked decisions

1. **All personal artifacts remain in `paperrelay-user.sqlite3`.** They do not enter the rebuildable catalog, research folders, or Agent Relay.
2. **Phase 5 drafts are a prerequisite.** Annotation editing and organization reuse its durable draft, guarded-transition, scoped-error, and accessible-dialog infrastructure.
3. **Anchors target canonical source text, not rendered DOM text.** Reader rendering must preserve a reversible map from visible selection to stored `PaperSection.text` offsets.
4. **Use both position and quote selectors.** Position restores quickly on the same content revision; exact quote plus prefix/suffix supports deterministic re-anchoring after revisions.
5. **Ambiguity becomes an orphan.** No fuzzy, semantic, or AI-based automatic relocation in the first release.
6. **Manual collections precede saved views.** A saved view stores a validated filter contract, never SQL.
7. **Soft deletion and entity revisions start now.** Tombstones and optimistic concurrency make later Zotero/Obsidian export possible without coupling this phase to either application.

## User experience

### Highlights and annotations

Selecting text inside one logical reader block—an abstract paragraph, section paragraph, list item, table cell, reference, or caption—opens an accessible selection toolbar with:

- **Highlight** using a small fixed color palette;
- **Add annotation** with optional Markdown text;
- **Copy quote**;
- **Cancel**.

Selections spanning different logical blocks and formula-only selections are rejected with a clear explanation in the first slice. Whitespace-only selections are ignored. Keyboard users can create an annotation from the Reader command menu after extending a text selection.

The Notes panel gains an **Annotations** tab. Each item shows its quote, note, section, color, anchor status, and update time. Activating an anchored item opens the correct paper representation, section, and range. Orphaned annotations appear in a review group with **Reattach**, **Keep orphaned**, and **Delete**.

Editing an annotation uses optimistic concurrency. A stale editor never overwrites a newer local change; the user receives a comparison and can reload or intentionally replace it.

### Collections

The navigation rail gains user collections. A user can:

- create, rename, reorder, and delete a collection;
- add or remove papers from paper detail, search results, or a bounded multi-select action;
- view collection membership across disconnected roots;
- put one paper in multiple collections.

Deleting a collection removes only its membership records. It never deletes personal paper state, annotations, indexed records, or source files. Nested folders and smart collections are deferred until the flat model is proven.

### Saved views and personal search

A library search/filter state can be saved with a name. Version 1 supports the existing query, root scope, attention flag, user view, sort, content kind/health filters added in this phase, tags, and collection IDs. Opening a saved view resolves currently available roots and clearly reports unavailable filters rather than silently changing the query.

Private search covers saved notes, annotation quotes/bodies, collection names, and tags in the user sidecar. Results link back to their owning paper and source anchor. They remain separate from source-corpus FTS so private text cannot leak into MCP results or rebuildable database copies.

## Canonical reader model

The current `PaperSection` has heading, kind, level, and text. Phase 6 extends the detail response with a bounded representation identity and content revision. A shared `annotation-anchors.ts` module derives deterministic logical blocks from the exact same text projection used by the Reader:

```ts
interface ReaderSourceBlock {
  source: 'abstract' | 'section' | 'reference' | 'asset_caption'
  sourceIndex: number
  sectionKey: string | null
  heading: string | null
  kind: string | null
  blockKind: 'paragraph' | 'list_item' | 'table_cell' | 'reference' | 'caption'
  blockIndex: number
  text: string
  representationId: string
  contentRevision: string
}

interface RenderSpan {
  sourceStart: number
  sourceEnd: number
  renderedText: string
}
```

`sectionKey` hashes normalized section kind, heading, and duplicate-heading ordinal rather than relying on a mutable array index. Offsets are zero-based UTF-16 offsets into the exact logical-block `text` reconstructed by the main process, matching JavaScript string indexing. The selector schema and text-normalization version are stored explicitly so a future normalization change cannot reinterpret old offsets.

Citation links, Markdown emphasis, math, safe HTML, tables, and syntax markup may create nested DOM nodes, but their text-selection mapping must round-trip to source offsets. UI-only labels, citation popovers, hidden accessibility text, and decorative characters are never part of the selectable source map.

## Annotation selector and lifecycle

Each annotation stores:

- stable annotation and paper IDs plus canonical identity snapshot;
- root, representation, and content revision at creation;
- source kind/index, section key/heading/kind, logical block kind/index, and block-text hash;
- start/end offsets;
- exact selected quote;
- bounded prefix and suffix context;
- selector and normalization versions;
- current color, optional annotation body, entity revision, timestamps, and tombstone;
- resolution status (`exact`, `reanchored`, `ambiguous`, or `orphaned`) and last resolution metadata.

Creation verifies in the main process that `text.slice(start, end) === exactQuote` for the supplied current representation revision. A stale revision or invalid range returns a typed conflict and writes nothing.

### Deterministic re-anchoring

On Reader load or a relevant scan update:

1. If representation/content revision, block key, exact slice, and context still match, return `exact`.
2. Search for the exact quote in the same block, then blocks under the same section key/heading/kind, then other blocks of the same container kind in the same displayed representation.
3. Rank duplicate exact matches only by deterministic prefix/suffix, section identity, block kind, and original-position proximity. Accept only a unique winner and return `reanchored`.
4. Repeat with NFKC and collapsed Unicode whitespace only when an offset map back to the current exact text can be retained. This is normalization, not edit-distance matching.
5. A tied/weak duplicate is `ambiguous`; changed or missing text is `orphaned`. Preserve the original selector and annotation body in both cases.

No edit is made when multiple candidates tie. Case folding, edit distance, embedding similarity, and generated guesses are not automatic evidence. Candidates from another root representation are never considered. Manual reattachment creates a new resolved selector under the same annotation ID and archives the prior selector for provenance.

Overlapping highlights remain independent annotation records. Rendering computes deterministic non-destructive mark segments from all active ranges; it does not mutate article text or merge annotation ownership.

## User-sidecar schema

After the Phase 5 schema-2 draft migration, Phase 6 migrates `paperrelay-user.sqlite3` to schema 3 in one transaction. A newer unsupported schema is rejected unchanged.

### `paper_annotations`

```sql
CREATE TABLE paper_annotations (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  canonical_key TEXT,
  representation_id TEXT NOT NULL,
  root_id TEXT,
  content_revision TEXT NOT NULL,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('abstract', 'section', 'reference', 'asset_caption')),
  source_index INTEGER NOT NULL,
  section_key TEXT,
  source_heading TEXT,
  source_section_kind TEXT,
  block_kind TEXT NOT NULL,
  block_index_hint INTEGER NOT NULL,
  block_text_hash TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  exact_quote TEXT NOT NULL,
  prefix_text TEXT NOT NULL DEFAULT '',
  suffix_text TEXT NOT NULL DEFAULT '',
  selector_version INTEGER NOT NULL,
  normalization_version INTEGER NOT NULL,
  current_selector_json TEXT NOT NULL,
  original_selector_json TEXT NOT NULL,
  color TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  resolution_status TEXT NOT NULL
    CHECK (resolution_status IN ('exact', 'reanchored', 'ambiguous', 'orphaned')),
  last_resolution_json TEXT,
  entity_revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
```

Indexes cover paper/status, representation/revision, and update time. Paper identity has no foreign key into the rebuildable catalog; it follows the same reconciliation rules as existing personal state and drafts.

`paper_annotation_anchor_history` stores annotation ID, monotonically increasing anchor version, the replaced selector JSON, resolution metadata, and replacement time. Manual reattachment appends history and updates the current selector in one transaction.

### Collections and membership

- `paper_collections`: stable ID, name, normalized name, optional color/description, explicit sort position, entity revision, timestamps, tombstone;
- `paper_collection_items`: collection ID, paper/canonical identity snapshot, sort position, added time, entity revision, tombstone;
- uniqueness prevents two active memberships for the same collection/paper while preserving deletion history.

A collection may cascade its own membership inside the user database after a confirmed delete. It never cascades into paper state or catalog rows.

### Saved views

`paper_saved_views` stores a stable ID, name, versioned validated `filter_json`, entity revision, sort position, timestamps, and tombstone. On load, JSON is parsed through the current allowlisted filter schema with bounded strings/arrays; unknown executable expressions are rejected.

### Private FTS

Add a contentless or trigger-maintained FTS5 index over committed annotation quote/body plus existing committed note, tags, and collection name data. Drafts are intentionally excluded. Queries and snippets are bounded. Rebuilding private FTS reads only the user sidecar and never the source catalog.

## Service and IPC boundaries

Introduce an `ArtifactService` in the main process with repository modules for annotations, collections, saved views, and private search. Renderer requests are strict, bounded DTOs with unknown fields rejected.

Core operations include:

- list/create/update/delete/reanchor annotations;
- list/create/update/delete/reorder collections and update bounded membership batches;
- list/create/update/delete/reorder saved views;
- private artifact search with cursor pagination;
- artifact change events scoped by paper/entity.

Every mutation includes the current `entityRevision` where an entity already exists. All handlers validate the active trusted main frame. Annotation quote/body, saved notes, collection membership, and private search results are never added to Agent Relay contracts.

Desktop library search combines catalog matches with candidate paper IDs and privacy-labelled snippets from private FTS before applying filters, stable ordering, and pagination. Private text itself is never copied into catalog FTS.

Initial limits are constants shared by validation and tests: 4,000 selected characters, 20,000 annotation-body characters, 128 characters each of prefix/suffix, 100 annotations per page, 1,000 collections, 500 collection changes per mutation, and 200 saved views. Performance fixtures cover at least 10,000 annotations.

## Delivery slices

### 6.0 — Source-span and persistence foundation

- representation/content revision in paper detail;
- canonical source-block renderer and DOM-to-source range mapping;
- schema-3 migration, repositories, IPC, optimistic concurrency, and fake data builders;
- source-span tests for paragraphs, citations, math, tables, code, and nested markup.

**Gate:** every supported Reader rendering round-trips selected visible text to the exact main-process source slice, and stale revisions cannot create an annotation.

### 6.1 — Highlights and annotation review

- selection toolbar, fixed colors, optional Markdown body;
- Reader marks, annotation panel, jump-to-anchor, update/delete;
- deterministic re-anchoring and orphan review/reattach UI;
- overlapping-mark rendering and keyboard/screen-reader flows.

**Gate:** an annotation survives reload, app restart, source reindex, root disconnect/reconnect, and exact deterministic relocation; ambiguous relocation visibly orphans it.

### 6.2 — Manual collections

- collection rail and management dialog;
- add/remove actions on detail and search results;
- bounded multi-select membership changes;
- ordering, dormant members, counts, and empty states.

**Gate:** collection operations never change catalog/source content and remain intact through identity reconciliation and root removal.

### 6.3 — Saved views and private search

- versioned filter contract and saved-view management;
- private FTS migration/rebuild;
- bounded artifact results and source navigation;
- unavailable-root/filter and stale-result handling.

**Gate:** private terms are searchable in the desktop UI and provably absent from catalog FTS, MCP results, and research-folder writes.

### 6.4 — Reliability and release gate

- migration rollback/newer-schema tests;
- high-volume pagination/performance fixtures;
- concurrent edit and stale-revision tests;
- packaged Electron E2E for mouse, keyboard, restart, re-anchor, orphan, collections, and private search;
- data export fixture reserved for Phase 8 connector contract tests.

## Acceptance criteria

- Creating an annotation stores the exact selected source slice and refuses a stale or mismatched selector.
- Every supported Reader transformation maps selections to stable canonical offsets.
- Same-revision anchors restore exactly; changed sources re-anchor only on a unique exact quote/context match.
- Duplicate or ambiguous candidates produce an orphan, never an invisible guessed move.
- Manual reattachment preserves annotation identity, body, timestamps/provenance, and original selector.
- Overlapping highlights render independently and never alter the source text.
- Root removal makes representation-bound anchors dormant without deleting them; reconnect restores eligible artifacts.
- Paper identity reconciliation preserves annotations, collection membership, saved personal state, and drafts.
- A stale annotation or collection edit cannot overwrite a newer entity revision.
- Collection deletion affects only that collection and its memberships.
- Saved views cannot inject SQL, arbitrary code, paths, or unsupported filters.
- Source files and the rebuildable catalog remain untouched by every personal-artifact mutation.
- Private content is absent from Agent Relay, source-corpus FTS, logs, errors, and telemetry.
- Schema migration is transactional and an unsupported newer user database remains unmodified.
- Keyboard-only and screen-reader users can create, inspect, jump to, edit, reattach, and delete annotations.

## Explicitly deferred

- Cross-block and cross-paper annotations
- Freehand drawing, PDF-coordinate highlights, OCR, and direct PDF annotation
- Fuzzy, semantic, or AI-generated automatic re-anchoring
- Nested collections, rule-driven smart collections, and citation graphs based on personal artifacts
- Collaboration, cloud sync, encryption, and mobile clients
- Making private artifacts available to the read-only Agent Relay
- Zotero/Obsidian synchronization, covered by Phase 8
