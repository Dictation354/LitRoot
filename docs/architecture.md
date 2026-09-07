# LitRoot architecture

## Trust boundaries

```text
React renderer
  │ narrow Electron IPC (Zod validation)
  ▼
Electron main on Windows / Linux / macOS
  ├── global feeds.sqlite3 + bounded Crossref journal refresher
  │ authenticated HTTP/SSE over random localhost port
  ▼
single-file service
  ├── native: Electron bundled Node
  └── Windows WSL: Node 24 in selected distribution
  ├── one ProjectDatabase per project
  ├── papers/ scanner + watcher
  ├── YAML metadata sidecars
  ├── atomic Markdown note store
  ├── restricted asset reader
  └── paper-fetch process runner + acceptance/import gate
```

The renderer never receives a session token, raw filesystem handle, or process primitive. Asset URLs contain only a project ID, paper ID, and Markdown-relative source. Electron authenticates the matching runtime request; the service checks the paper reference and canonical realpath again. Native projects use host paths directly, while WSL projects cross the host boundary only through validated `wslpath` conversions.

Journal Radar forms a separate application-level trust boundary. Electron main connects only to `api.crossref.org`, identifies LitRoot and its maintainer in the User-Agent, and limits request duration and response size. Crossref JSON is validated with Zod; JATS/HTML abstracts are reduced to bounded plain text. ISSN subscriptions and 90-day temporary works live only in `feeds.sqlite3` under Electron `userData`. Crossref `created` time drives recent-work ranges and DOI uniqueness preserves read state during refresh. The renderer receives this data through validated IPC and has no Crossref network or database access.

Native Windows resolves the official `paper-fetch.cmd` installation to its private Python executable and fixed module prefix. Linux and macOS resolve the executable from the user's login shell. Fetch queries remain direct subprocess arguments with `shell=false`; only WSL uses the fixed `exec "$@"` login-shell trampoline.

## Identity and metadata

On first indexing, identity precedence is normalized DOI, canonical HTTP(S) source URL, then project-relative Markdown path. The resulting ID is written to `.litroot/metadata/<paper-id>.yaml` with its source path. Future scans reuse it before recalculating identity, so a DOI correction changes effective metadata and FTS but not the paper ID.

Sidecars contain required bookkeeping and an `overrides` map. Missing override keys inherit. Empty strings and arrays are values, not missing keys. Writes are temp-file + fsync + rename and the corresponding FTS row is rebuilt in the same SQLite transaction.

## Notes and conflicts

The application owns only minimal YAML frontmatter. Everything after it is the user's Markdown body. Each read returns a SHA-256 revision. Autosave supplies that revision; a mismatch returns HTTP 409 with the disk snapshot and never writes. The UI pauses and offers reload or draft copy.

## Fetch state

Each app run persists an app-facing manifest alongside the single-paper engine manifest or the final batch JSONL. The engine writes batch JSONL once; it is used for exit reconciliation, never watched for live progress. Results are projected by original input index; completion order is separate. Structured acceptance is used when present. Local verification can lower a result but never raise a limited result to full-text complete.

The runner validates protocol-1 stderr lines marked `paper_fetch_progress: true`, binds the first `run_started.run_id` to that process, and maps 1-based engine indexes through `executionIndexes`. Ordinary stderr diagnostics remain available. Terminal events enqueue archival in arrival order; already terminal items are not imported again at exit. The UI shows `acceptance` until archival completes. Older app manifests default `stageStartedAt` and `assetProgress` to null.

`POST /api/v1/projects/:projectId/fetch/:runId/items/:index/cancel` maps to `fetch.cancelItem(projectId, runId, index)` through service client, IPC and preload. Whole-run cancellation retains the existing `/cancel` endpoint. Both send `{protocol_version: 1, run_id, command: "cancel", index}` on stdin (null index cancels the run). Normal cancellation does not kill the process; service shutdown retains process termination safeguards. Duplicate inputs remain separate indexes and are deduplicated by the engine, preserving independent cancellation.

New files are staged per run. Imports are safe only when the returned path is canonical and inside the stage, Markdown provenance is trusted, identities match, any reported hash matches, and referenced local assets remain contained. Refresh copies validated assets first and atomically replaces the Markdown last.
