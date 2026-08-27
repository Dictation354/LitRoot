# LitRoot architecture

## Trust boundaries

```text
React renderer
  │ narrow Electron IPC (Zod validation)
  ▼
Windows Electron main
  │ authenticated HTTP/SSE over random localhost port
  ▼
single-file Node 24 service in selected WSL distribution
  ├── one ProjectDatabase per project
  ├── papers/ scanner + watcher
  ├── YAML metadata sidecars
  ├── atomic Markdown note store
  ├── restricted asset reader
  └── paper-fetch process runner + acceptance/import gate
```

The renderer never receives a session token, raw filesystem handle, or process primitive. Asset URLs contain only a project ID, paper ID, and Markdown-relative source. Electron authenticates the matching WSL request; the service checks the paper reference and canonical realpath again.

## Identity and metadata

On first indexing, identity precedence is normalized DOI, canonical HTTP(S) source URL, then project-relative Markdown path. The resulting ID is written to `.litroot/metadata/<paper-id>.yaml` with its source path. Future scans reuse it before recalculating identity, so a DOI correction changes effective metadata and FTS but not the paper ID.

Sidecars contain required bookkeeping and an `overrides` map. Missing override keys inherit. Empty strings and arrays are values, not missing keys. Writes are temp-file + fsync + rename and the corresponding FTS row is rebuilt in the same SQLite transaction.

## Notes and conflicts

The application owns only minimal YAML frontmatter. Everything after it is the user's Markdown body. Each read returns a SHA-256 revision. Autosave supplies that revision; a mismatch returns HTTP 409 with the disk snapshot and never writes. The UI pauses and offers reload or draft copy.

## Fetch state

Each app run persists an app-facing manifest next to the official paper-fetch run manifest and append-only JSONL. Results are projected by original input index; completion order is separate. Structured acceptance is used when present. Local verification can lower a result but never raise a limited result to full-text complete.

New files are staged per run. Imports are safe only when the returned path is canonical and inside the stage, Markdown provenance is trusted, identities match, any reported hash matches, and referenced local assets remain contained. Refresh copies validated assets first and atomically replaces the Markdown last.
