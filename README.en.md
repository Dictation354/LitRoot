# LitRoot

[中文](README.md)

LitRoot is a project-scoped, local literature manager for Markdown produced by paper-fetch. The first MVP officially targets Windows 11 with WSL2 and ships a Chinese user interface.

It deliberately provides only five capabilities:

- edit core bibliographic metadata and run project-local FTS5 search with a year filter;
- safely render paper-fetch Markdown, local body images, GFM tables, code, and KaTeX math;
- invoke the official `paper-fetch fetch` command for one paper or batches of up to 50;
- register multiple projects while strictly scoping every browse, search, fetch, and note operation to the active project;
- store project and per-paper notes as ordinary Markdown inside the project.

Favorites, reading status, tags, AI summaries/Q&A, Digest, Radar, PDF annotation, knowledge graphs, cloud sync, collaboration, Agent Relay, and embedded terminals are intentionally out of scope.

## Runtime architecture

The Windows Electron process owns only the desktop window, WSL distribution selection, narrow IPC, and a restricted image protocol. A Node.js service inside WSL owns SQLite, scanning, file watching, note writes, and paper-fetch jobs. Electron enters a fixed Bash login-shell trampoline through `wsl.exe`, loads the user's `nvm` and paper-fetch environment, and then replaces the shell with the bundled CJS service via `exec`. The service listens on a random `127.0.0.1` port and requires a 256-bit session token on every request.

Prerequisites are diagnosed but never installed automatically:

- Windows 11 with WSL2;
- Node.js 24.15+ (24.x) inside WSL;
- an executable official `paper-fetch` inside WSL;
- Git inside WSL.

## Project layout

Connecting a project creates only missing directories:

```text
<project>/
├── papers/
├── notes/
│   ├── project.md
│   └── papers/<paper-id>.md
└── .litroot/
    ├── project.yaml
    ├── metadata/<paper-id>.yaml
    ├── cache/index.sqlite3
    ├── runs/
    └── tmp/
```

The nested `.litroot/.gitignore` excludes only rebuildable cache, run, and temporary data. Project identity, metadata overrides, and notes are Git-friendly. Disconnecting a project unregisters it without deleting files.

Metadata merges as “project override > fetched value.” A missing key inherits, while an empty string or array explicitly clears a value. The persisted paper ID does not change when a DOI is corrected, preserving note links.

## Fetch and acceptance

LitRoot never reimplements retrieval. It calls `paper-fetch fetch --query` for one input and uses a UTF-8 query file, JSONL results, and a run manifest for batches. Every archive explicitly requests:

```text
--artifact-mode markdown-assets
--asset-profile body
--include-refs all
--max-tokens full_text
```

Each item reports identity, candidates, provider, attempts, stages, and the final `complete / degraded / limited / failed / action_required` acceptance state. A top-level `status=ok` is not full-text proof; abstract-only and metadata-only results are at most `limited`.

New results first land in `.litroot/tmp/`. Identity, trusted front matter, content level, asset containment, real paths, and SHA-256 are checked before archival. A refresh that is not full text or fails asset validation leaves the old full text untouched. Notes and metadata overrides are never part of refresh replacement.

## Security boundary

- The renderer has no Node, filesystem, or process access and receives only a narrow typed bridge.
- The localhost API returns 401 without the session token and rejects direct browser origins.
- Only trusted Markdown under `papers/` is indexed.
- HTML is allowlist-sanitized; scripts, event attributes, dangerous URLs, and automatic remote images are blocked.
- Local images must be explicitly referenced relative assets whose real path stays inside the active project.
- Windows child processes use argument arrays with `shell=false`; the WSL login shell runs only the fixed `exec "$@"` program, with every dynamic value passed as a positional argument instead of shell source text.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run build
pnpm dev
```

Build an unsigned Windows installer with `pnpm run package:win`. See [docs/architecture.md](docs/architecture.md) for internals and [docs/windows-acceptance.md](docs/windows-acceptance.md) for the physical Windows + WSL2 acceptance checklist.

The MVP repository may remain private. Public licensing, signed installers, and one-click environment provisioning are not part of this iteration.
