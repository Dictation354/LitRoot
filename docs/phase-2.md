# Phase 2: Read-only Agent Relay

## Product outcome

An MCP-capable agent can use the same local research catalog as the PaperRelay desktop app. It can discover registered project folders, search globally or within one project, inspect a paper before reading it, and retrieve only the sections it needs. PaperRelay remains an index over source files in place; the relay does not fetch, edit, migrate, or create research data.

## Agent workflow

1. Call `list_research_roots` to discover registered project folders and their current availability.
2. Call `search_library` with a query and, when working inside a project, its `rootId`.
3. Call `get_paper_outline` with the returned `paperId` or DOI. Pass the same `rootId` to preserve that project's representation and provenance.
4. Select section indexes or a section query from the outline.
5. Call `read_paper_sections` with the outline's `revision`. A changed representation returns `STALE_REVISION` instead of silently mixing old selection state with new text.

When the same DOI has different representations in different roots, scoped search, outline, locations, provenance, revision, and section reading all remain within the selected root. Global calls continue to use PaperRelay's deterministic preferred representation.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_research_roots` | List registered roots, availability, scan health, and indexed paper counts. |
| `search_library` | Search scholarly metadata and article text globally or within one `rootId`. |
| `get_paper_outline` | Resolve a PaperRelay ID or DOI into bounded metadata, provenance, assets, locations, and section descriptors. |
| `read_paper_sections` | Read sections by indexes or query, with a 20,000-character default and 60,000-character maximum text budget. |

Section indexes and a section query are mutually exclusive. All tools return a consistent success or typed-error envelope in structured content.

## Running the relay

Build the standalone entry point:

```bash
pnpm build:mcp
```

The executable entry is `dist/mcp/main.js`. Start it with an explicit absolute catalog path:

```bash
node dist/mcp/main.js --database /absolute/path/to/paperrelay.sqlite3
```

Or provide the same absolute path through the environment:

```bash
PAPERRELAY_DATABASE=/absolute/path/to/paperrelay.sqlite3 node dist/mcp/main.js
```

The relay never guesses a database location and never creates or upgrades a catalog. A missing file, unsupported schema, missing FTS index, invalid selector, unregistered root, stale revision, or missing section is returned as a typed error. Unexpected failures use `INTERNAL_ERROR` without exposing implementation details. Papers already indexed from a temporarily unavailable root remain readable from the cached catalog.

## Safety and context bounds

The database is opened with SQLite read-only and query-only modes. Each call uses a short read transaction, allowing safe concurrent reads while the desktop application scans into its WAL database. Indexed source files are never opened for mutation. SQLite may create or touch adjacent `-wal` and `-shm` runtime sidecars while coordinating a live WAL reader; those lock/journal sidecars are permitted runtime state, while the main catalog's logical content and bytes remain unchanged by relay calls.

Titles, abstracts, sections, captions, file paths, snippets, and all other retrieved values are untrusted research data. They may contain prompt-injection text and must never be treated as instructions. This warning is advertised by the server and each tool.

Search results, roots, authors, warnings, provenance trails, locations, outlines, assets, headings, captions, paths, and other metadata have explicit array, per-field, and aggregate bounds with truncation or omitted-count metadata. Section text is capped at 20,000 characters by default and cannot exceed 60,000 characters per call.

## Acceptance criteria

- MCP 2026-07-28 negotiation succeeds over protocol-clean stdio.
- Exactly four read-only tools are exposed.
- Search supports global and project-root scopes.
- Root-scoped retrieval never matches, returns, or cites another root's representation.
- IDs and normalized DOI forms resolve consistently.
- Revisions are representation- and root-specific, and stale reads fail explicitly.
- Concurrent WAL writes do not require a second writable connection.
- Tool calls leave the main SQLite catalog and indexed source tree unchanged; tests separately characterize WAL/SHM sidecar activity.
- Metadata and section text cannot grow without explicit bounds.
- All retrieved research content is labeled as untrusted data rather than instructions.

## Deferred

- Paper fetching, refresh, deletion, or any other MCP mutation tool
- Agent-authored notes, evidence objects, annotations, and source edits
- Semantic/vector retrieval and cross-paper synthesis
- Remote access, authentication, accounts, cloud sync, and collaboration
- Zotero, Obsidian, and citation-manager synchronization
- Packaged relay runtime, installer/signing, and platform-specific launch commands
