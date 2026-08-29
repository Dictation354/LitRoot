# LitRoot

[中文](README.md)

LitRoot is a project-scoped, local literature manager for Markdown produced by paper-fetch. It supports native Windows 11 x64 or WSL2, Linux x64, and macOS 15+ on Apple Silicon, and ships a Chinese user interface.

It deliberately provides only five capabilities:

- edit core bibliographic metadata and run project-local FTS5 search with a year filter;
- safely render paper-fetch Markdown, local body images, GFM tables, code, and KaTeX math;
- invoke the official `paper-fetch fetch` command for one paper or batches of up to 50;
- register multiple projects while strictly scoping every browse, search, fetch, and note operation to the active project;
- store project and per-paper notes as ordinary Markdown inside the project.

Favorites, reading status, tags, AI summaries/Q&A, Digest, Radar, PDF annotation, knowledge graphs, cloud sync, collaboration, Agent Relay, and embedded terminals are intentionally out of scope.

## Runtime architecture

Electron owns only the desktop windows, runtime selection, narrow IPC, and a restricted image protocol. A bundled single-file service owns SQLite, scanning, file watching, note writes, and paper-fetch jobs. Native mode runs it with Electron's bundled Node; WSL mode retains the fixed Bash login-shell trampoline and uses Node and paper-fetch inside the selected distribution. The service listens on a random `127.0.0.1` port and requires a 256-bit session token on every request.

Prerequisites are diagnosed but never installed automatically:

- Windows 11 x64, Linux x64, or macOS 15+ on Apple Silicon;
- the official platform build of `paper-fetch` for native mode; Node.js is bundled with LitRoot;
- WSL2 plus Node.js 24.15+ (24.x) and official `paper-fetch` inside the selected distribution for WSL mode.

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
- Child processes use argument arrays with `shell=false`; the WSL login shell runs only the fixed `exec "$@"` program. The official Windows `paper-fetch.cmd` is resolved to its bundled Python module entry instead of sending user input through `cmd.exe`.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run build
pnpm dev
```

Build release artifacts with `pnpm run package:win`, `pnpm run package:linux`, or `pnpm run package:mac`. Windows packaging uses electron-builder for the x64 `win-unpacked` directory and Inno Setup for the unsigned `LitRoot-<version>-windows-x64-unsigned-setup.exe`; local builds require Inno Setup 6 `ISCC.exe` on `PATH`, while the GitHub `windows-2022` runner uses its [preinstalled Inno Setup](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md?plain=1). Manually uninstall an older NSIS build before installing this version; it is not detected, removed, or migrated automatically. Linux outputs x64 AppImage and deb packages, and macOS outputs an unsigned/unnotarized macOS 15+ arm64 DMG that may trigger Gatekeeper. See [docs/architecture.md](docs/architecture.md) for internals and [docs/windows-acceptance.md](docs/windows-acceptance.md) for native Windows and WSL2 acceptance.

The current release artifacts are unsigned and do not include one-click environment provisioning.
