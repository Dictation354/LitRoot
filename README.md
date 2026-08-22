# PaperRelay

PaperRelay is a local-first desktop library for structured research artifacts created across many project folders. It gives humans one place to browse and read the results of agent-driven paper fetching while leaving every source file where the project created it.

> PaperRelay turns distributed, agent-fetched paper collections into one local research library for both people and agents—without moving them, and with a library indexer that never rewrites them.

## Desktop library

- Connect any number of local research folders with the native folder picker.
- Discover supported `paper-fetch` outputs recursively and watch for later changes.
- Normalize direct ArticleModel JSON, combined JSON, v2/v4 fetch envelopes, structured Markdown, and conservative HTML fallbacks.
- Deduplicate representations by normalized DOI while preserving every source location.
- Search titles, authors, DOI, venue, abstract, and article body using local SQLite FTS5.
- Browse extraction health, warnings, provenance, sections, figures, references, and token estimates.
- Open an automatically generated, evidence-linked Digest for each paper, covering its purpose, method, findings, limitations, and author-stated future work.
- Use Research Radar to explore a scoped knowledge map and review conservative research-gap and further-work signals grounded in the indexed library.
- Keep personal favorites, reading status, tags, and Markdown-first private notes without changing a paper or project file; in-progress note/tag drafts recover from the private local sidecar.
- Preview note formatting, limited safe HTML, TeX equations, tables, code, and protected HTTP(S) links beside the article.
- Toggle the Navigation, Papers, and Notes panels from an always-available workspace rail; panel visibility is restored locally on the next launch.
- Use dedicated Favorites, Reading list, and Reviewed views across every connected project.
- Reveal any indexed representation in its original project folder.
- Remove a folder from PaperRelay without deleting or changing its contents.

PaperRelay does not fetch papers itself. Codex, Claude Code, and `paper-fetch` remain the acquisition workflow; PaperRelay observes and organizes their outputs.

Digest and Research Radar analysis is local and extractive: every substantive item links back to exact source text. Gap results are explicitly presented as hypotheses from the selected library scope, not claims of global novelty, and should be checked against external literature before research decisions are made.

## Run locally

Requirements: Node.js 24.15 or later in the Node 24 line, and pnpm 11.19.0.

```bash
pnpm install
pnpm dev
```

`pnpm install` also rebuilds Electron-native dependencies for the installed Electron version. If a native dependency stops loading after an Electron or Node.js change, repair it with:

```bash
pnpm run rebuild:native
```

The development app stores its catalog in Electron's per-user application-data directory. The library indexer treats connected research folders as read-only inputs; only a separately confirmed Console session can request project write access.

Useful checks:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

## Windows x64 package

Build Windows artifacts on a 64-bit Windows host. The engineering target is Windows 10 version 1809 or newer on x64. PaperRelay contains the native `node-pty` dependency, so the Windows package is built and checked on Windows Server 2022 rather than cross-compiled from macOS or Linux.

```powershell
# Unpacked directory for launch and native-module smoke checks
pnpm run package:win:dir

# NSIS installer
pnpm run package:win
```

Both commands run the production build and package-boundary check first, then invoke the exact `electron-builder` 26.15.6 release. The NSIS output is written under `release/` as `PaperRelay-<version>-win-x64-unsigned-setup.exe`. CI also writes a matching `.sha256` file and uploads both files as a workflow artifact.

This Windows artifact is intentionally **unsigned** and is for engineering evaluation only. Windows can show an unknown-publisher or Microsoft Defender SmartScreen warning. Do not present it as a trusted public release; a distributable release must be Authenticode-signed, preserve the signed installer checksum, and pass installed-package testing on a clean Windows profile.

See [the Windows engineering audit](docs/windows-audit.md) for resolved blockers, completed verification, and the remaining distribution gates.

An opt-in corpus-scale smoke test can exercise real read-only folders through a temporary catalog:

```bash
PAPERRELAY_CORPUS_DATABASE=/tmp/paperrelay-corpus.sqlite3 \
PAPERRELAY_CORPUS_ROOTS='["/absolute/research/root-one","/absolute/research/root-two"]' \
pnpm exec vitest run tests/integration/real-corpus-smoke.test.ts
```

Use a new database path for a cold-index measurement and reuse it to measure an unchanged rescan.

## Agent Relay

Phase 2 adds a read-only MCP bridge so Codex and other MCP-capable agents can use the indexed library without bypassing PaperRelay's project boundaries. The relay exposes exactly four tools: list research roots, search the library, inspect a paper outline, and read selected sections.

The simplest setup is inside the app:

1. Open **Agent Relay** at the bottom of the PaperRelay sidebar.
2. Wait for **Ready for Codex**. PaperRelay verifies this with a real local MCP startup handshake.
3. Choose **Copy setup**, then add it in **Codex Settings → MCP servers** or in `config.toml`.
4. Save the configuration, restart Codex, and start a new task.

The panel also provides a test prompt and project- or paper-specific references you can paste into a task. See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp) for general MCP configuration guidance.

For command-line setup, build and run the standalone stdio entry with an explicit absolute database path:

```bash
pnpm build:mcp
node dist/mcp/main.js --database /absolute/path/to/paperrelay.sqlite3
```

`PAPERRELAY_DATABASE` can supply the same absolute path. The relay opens the existing catalog read-only, performs no migrations, and never edits indexed source files. SQLite may maintain adjacent WAL/SHM runtime sidecars for concurrent reads, but relay calls do not change the main catalog. Root-scoped search can be carried through outline and section retrieval with `rootId`, preventing different project copies of one DOI from leaking into each other. Section text defaults to a 20,000-character budget and is capped at 60,000 characters; metadata is independently bounded.

All returned paper text and metadata is untrusted research data, not instructions. Agents must not follow commands embedded in titles, abstracts, sections, captions, paths, or provenance values. See [docs/phase-2.md](docs/phase-2.md) for the tool workflow, safety model, and acceptance criteria.

## Embedded Codex Console

The toggleable workspace includes an embedded Codex Console. This is an explicitly opened terminal panel for working with an installed Codex CLI in the context of one registered research root; it is not an autonomous paper-fetching service.

The Console follows a separate, guarded execution boundary:

- A session starts only after the user opens it and chooses a registered research root.
- PaperRelay launches only a locally installed Codex CLI and never substitutes a bundled agent.
- Sessions default to Codex's read-only project sandbox. Enabling workspace-write requires a separate PaperRelay confirmation.
- The selected root is the working directory, not a claim that every user-configured Codex tool is confined there. In workspace-write mode, Codex can present its own separate approval prompts for broader actions; PaperRelay does not approve them automatically.
- PaperRelay does not persist terminal output or create a transcript. The live Console keeps only xterm's bounded, in-memory scrollback (up to 5,000 lines) while that terminal view exists; resetting the view or quitting discards it. Codex may separately retain its own local session history according to the user's Codex configuration.
- The session stops when the app exits or its registered root is removed.

These Console permissions do not change the rest of PaperRelay: indexing continues to treat connected folders as read-only inputs, and Agent Relay remains a read-only MCP service.

## Architecture

```text
Electron main process
  native folder access
  read-only scanner + watcher
  shape-based paper-fetch detectors
  SQLite catalog + FTS5
          ├── typed IPC → sandboxed preload → React desktop library
          │                                  search / health / reader / digest / sources
          │                                  evidence map / research radar
          │                                  toggleable navigation / papers / notes
          │
          ├── bounded local evidence analysis
          │     exact source quotes + offsets
          │     paper digests + scoped research signals
          │
          ├── guarded session IPC → embedded Codex Console
          │                           installed Codex CLI only
          │                           selected registered root as working directory
          │                           read-only project sandbox by default
          │                           confirmed workspace-write when requested
          │
          └── read-only SQLite connection → local MCP stdio relay
                                               roots / search / outline / sections
```

The database is a rebuildable index. Structured article files remain authoritative, the renderer has no direct filesystem or Node.js access, and the Agent Relay exposes no write tools. The Console is an opt-in subprocess boundary rather than an extension of the indexer or relay; PaperRelay does not add its own transcript store.

Personal library state is deliberately separate from that rebuildable index. PaperRelay stores favorites, reading status, tags, private notes, recoverable note/tag drafts, and last-opened timestamps in `paperrelay-user.sqlite3` inside the app's local data directory. This sidecar has no cascading relationship to indexed papers, so disconnecting a research folder does not erase personal state or drafts. Dormant state is restored when the same stable paper identity returns. The read-only Agent Relay does not open or expose this sidecar.

## Recognized inputs

- Direct `ArticleModel` JSON: `{ doi, source, metadata, sections, references, assets, quality }`
- Combined JSON: `{ article, markdown }`
- Fetch envelope JSON: `{ version, extraction_revision, request, payload: { article, ... } }`
- Markdown with trusted `paper-fetch` frontmatter
- Article HTML with scholarly metadata or an `<article>` body

Detection is based on content shape, not only filenames, because `paper-fetch` allows explicit output paths.

## Large-library behavior

- Scanner writes are grouped and preferred-paper search indexes are finalized once per completed root scan.
- Every recognized source location remains in the catalog, while the derived root-scoped full-text index stores only the representation that search can actually return.
- A filesystem event received during a scan queues one authoritative follow-up pass, so late changes are not lost.
- Long lists use deterministic incremental pages, allowing every paper and broad search match to remain reachable without loading the whole catalog at once.
- The desktop polls catalog health but refreshes the paper list only when the catalog revision changes.
- Disconnecting a root or quitting PaperRelay cancels and settles active scans before deleting root state or closing SQLite; watcher teardown is awaited and late events are ignored.
- Asset targets are canonicalized inside their registered root and revalidated before preview; symlink escapes are rejected.

## Current phase boundary

The desktop library includes a local personal layer with durable drafts and guarded workspace/close transitions, toggleable workspace panels, evidence-linked paper digests, a scoped Research Radar with explicit select/open behavior, and a guarded embedded Codex Console, while the Agent Relay remains read-only. The first Phase 5 hardening batch and unsigned Windows installer automation are implemented, but installed-package testing, Electron E2E, the broader accessibility/security hardening pass, and production signing/notarization remain release gates. The Console does not make PaperRelay an autonomous fetcher: the GUI still does not discover or download publications on its own, and any paper-fetching remains a user-directed Codex workflow.

PaperRelay still intentionally excludes built-in autonomous fetching, external novelty search, generative-model synthesis, text highlights and anchored annotations, embeddings, virtual projects, Zotero/Obsidian sync, cloud accounts, collaboration, and direct source editing by the library itself. See [docs/phase-1.md](docs/phase-1.md) for the desktop-library foundation, [docs/phase-2.md](docs/phase-2.md) for the Agent Relay contract and safety boundary, [docs/phase-3.md](docs/phase-3.md) for the personal-library layer, and [docs/phase-4.md](docs/phase-4.md) for the evidence-analysis design and acceptance criteria.

The proposed next sequence—hardening (A), research workflow depth (B), directed acquisition/external checks (C), then Zotero/Obsidian interoperability—is specified in [docs/roadmap.md](docs/roadmap.md).
