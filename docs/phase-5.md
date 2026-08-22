# Phase 5: Hardening and release readiness

## Implementation status — first batch

The first Phase 5 implementation batch landed on 2026-08-20. Phase 5 itself is **not release-complete**.

Delivered in this batch:

- user-sidecar schema 2 with exact note/raw-tag draft recovery, stable identity reconciliation, and atomic commit-plus-draft deletion;
- a typed transition coordinator for paper/issue selection, library and Radar scope changes, root removal, paper reload, window close, and quit;
- a shared close/quit handshake between the renderer and Electron main process, with active-main-frame authorization on the response;
- corrected Radar select-versus-open behavior and independently retained summary, paper-list, load-more, and detail errors;
- Node 24.15/pnpm 11.19 pins, source/format/package-boundary checks, synthetic-fixture CI configuration, explicit ignores, an electron-builder allowlist, and a single-file relay bundle;
- regression coverage plus a production build: 269 tests pass, 2 opt-in tests skip, all TypeScript projects pass, and both the desktop and relay bundles build;
- an Electron-as-Node relay fallback test using an absolute Electron executable and an empty `PATH`; it completes an MCP handshake, exposes exactly the four read-only tools, and searches a temporary catalog successfully.

The relay spike keeps Node SEA as the preferred signed production runtime. For the unsigned Windows engineering build, the tested fallback is now wired end to end: packaged setup launches the shipped relay bundle through the absolute PaperRelay executable with `ELECTRON_RUN_AS_NODE=1`, generates matching Codex command/environment configuration, and probes that exact runtime. This removes the packaged dependency on a system `node` executable while deliberately retaining `RunAsNode` for this evaluation build.

An unsigned Windows x64 NSIS target and native Windows Server 2022 CI job are configured. The job builds `node-pty` on the target platform, verifies the packaged PTY and Agent Relay, emits a SHA-256 checksum, and uploads the engineering installer. This macOS workspace has no Git metadata, pnpm executable, Windows Electron runtime, or NSIS toolchain, so no local `.exe`, installed-package result, signed package, or Electron E2E run is claimed. Signing, a clean-profile installation pass, and the remaining release gates below stay active.

## Product outcome

PaperRelay becomes a dependable installable desktop application rather than a source-only advanced prototype. Existing research and agent workflows remain intact, unsaved personal work survives navigation and crashes, privileged Electron boundaries are consistently validated, and a signed package can run the desktop app and Agent Relay without requiring a system Node.js installation.

## Release target

Phase 5 produces the `0.3` release line.

- macOS arm64 and x64 are the first signed/notarized deliverables;
- an unsigned Windows x64 engineering installer is build-tested in native CI, while Windows signing and public distribution remain a follow-up release gate;
- no auto-update mechanism is introduced yet;
- catalog schema 2 remains readable by the existing Agent Relay throughout development;
- the Agent Relay still exposes exactly four read-only tools.

## Locked decisions

1. **Protect data before adding features.** Draft recovery, navigation correctness, scoped errors, and accessibility land before packaging work.
2. **Keep explicit Save, add a durable draft journal.** Editing a note or tags creates a debounced local draft. **Save notes** commits it to personal state; **Discard** removes it.
3. **Centralize workspace transitions.** Scope changes, paper selection, Radar entry/exit, root removal, reload, and application close all use one transition coordinator.
4. **Separate Radar selection from navigation.** Selecting a graph node remains in Radar. **Open source paper** must actually open Reader. Accessible labels describe the real action.
5. **Use resource-specific async state.** Summary, paper list, detail, Digest, Radar, root operations, relay setup, and terminal each own their loading/error/retry state.
6. **Package with the existing electron-vite architecture.** Use electron-builder first; do not migrate the build stack unless a packaging spike proves it cannot satisfy native-module and signing requirements.
7. **Do not require system Node for packaged Agent Relay.** The production preference is a platform-specific, signed single-purpose relay executable. An early spike must validate that choice against an Electron-as-Node fallback; development may continue to use `node dist/mcp/main.js`.

## Workstream 1 — Personal-work safety

### User database migration

Migrate `paperrelay-user.sqlite3` from schema 1 to schema 2 and add:

```sql
CREATE TABLE paper_user_drafts (
  paper_id TEXT PRIMARY KEY,
  canonical_key TEXT,
  preferred_document_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  tag_input TEXT NOT NULL DEFAULT '',
  base_state_updated_at TEXT,
  updated_at TEXT NOT NULL
);
```

Draft rows follow the same stable identity reconciliation rules as saved personal state. They are not removed when a source root disconnects.

### Draft lifecycle

- Debounce note/tag draft writes locally; flush the renderer's pending write through the validating main-process boundary before a transition completes.
- Loading a paper returns saved state plus an optional newer draft.
- Saving validates the complete note/tag payload, updates `paper_user_state`, and deletes the draft in one transaction.
- Discarding deletes only the draft.
- A recovered draft displays a persistent **Recovered unsaved draft** message until saved or discarded.
- A failed draft write blocks destructive navigation and shows a local retry action.
- Application close first flushes the draft. If flushing cannot complete, show **Retry**, **Discard draft and quit**, and **Cancel**.

### Transition coordinator

Represent pending navigation as a typed intent:

```ts
type WorkspaceIntent =
  | { kind: 'select-paper'; paperId: string }
  | { kind: 'select-issue'; issue: IndexIssue }
  | { kind: 'change-scope'; scope: Scope }
  | { kind: 'open-radar' }
  | { kind: 'change-radar-scope'; scope: Scope }
  | { kind: 'remove-root'; rootId: string }
  | { kind: 'reload-paper' }
  | { kind: 'close-window'; requestId: string }
  | { kind: 'quit'; requestId: string }
```

Only the coordinator commits an intent. When a dirty draft exists it offers **Save and continue**, **Discard and continue**, and **Cancel**. Root removal performs draft resolution before the native removal confirmation.

## Workstream 2 — UX and accessibility correctness

### Radar actions

- Graph-node activation selects/inspects a node and stays in Radar.
- Inspector **Open source paper**, evidence excerpts, and the top-level **Open selected digest** use explicit navigation callbacks.
- Keyboard and screen-reader labels distinguish **Select node**, **Open evidence**, **Open Reader**, and **Open Digest**.

### Reusable interaction primitives

Introduce shared `Dialog`, `Menu`, and `AsyncBoundary` components.

- Dialogs trap focus, make the background inert, close on Escape when safe, restore the trigger focus, and choose an intentional initial focus.
- Root actions use menu semantics, `aria-expanded`, `aria-controls`, arrow-key navigation, Escape, outside-click dismissal, and focus restoration.
- Destructive actions never receive initial focus.
- All icon-only controls have stable accessible names.

### Legibility

- Raise functional chrome below 11 px to a minimum 12 px default, with exceptions documented for non-essential decorative text.
- Interactive targets are at least 32 by 32 CSS pixels on desktop.
- Recheck light-theme contrast, focus visibility, truncation, and 200% zoom at the 1120 by 720 minimum window size.
- Show complete authors, keywords, extraction confidence, quality flags, and last-opened state in a progressive metadata panel.
- DOI values gain safe **Copy DOI** and **Open DOI** actions.
- Figure previews gain a keyboard-operable lightbox, open-source action, alt/caption display, and failure state.

### Error model

Each independent request has `{ status, data, error, requestId }`. A successful summary poll cannot clear a detail error. Every failed visible resource has a local retry. Stale successful data may remain visible with a refresh warning, but must never be presented as newly refreshed.

## Workstream 3 — Index and Agent Relay robustness

### Scanner identity

- Advance the scanner fingerprint format to include nanosecond mtime/ctime and file identity where the platform supplies them.
- Compute and store a normalized content revision whenever a candidate is parsed. Digest, annotation, and later integration revisions use this content revision rather than only the fast scanner fingerprint.
- Add a **Deep rescan** action that bypasses unchanged/ignored fingerprints and reparses every supported candidate.
- Preserve the normal fast rescan for large libraries.
- Report skipped oversized candidates as bounded indexing issues rather than silently ignoring them.

### Desktop response bounds

Apply explicit limits and truncation metadata to paper detail responses, mirroring the Agent Relay philosophy. Bounds cover authors, keywords, warnings, provenance, sections, assets, references, per-field text, and aggregate response size. The UI shows that content was truncated and provides source reveal rather than allocating unbounded renderer state.

### MCP search pagination

Keep the four-tool contract and extend `search_library` with an opaque cursor.

- The first call supplies query/scope/attention/limit.
- A response supplies `nextCursor` when more results exist.
- A cursor binds the normalized request, offset, and catalog revision.
- Reusing it with different filters fails as `INVALID_ARGUMENT`.
- A changed catalog fails as `STALE_CURSOR`, prompting a fresh search.
- No call returns more than 25 results.

### Electron boundary hardening

- Reuse the existing active-main-frame validation for every privileged IPC handler, not only the terminal.
- Keep strict input validation at the handler boundary even when TypeScript types exist.
- Add a restrictive permission-request handler and regression checks for the existing CSP, navigation denial, window-open denial, sandbox, context isolation, and disabled Node integration.
- Apply production Electron fuses after the packaged-relay spike. The preferred SEA design disables RunAsNode, Node options, and inspector arguments and enables embedded-ASAR integrity/load-only-from-ASAR where compatible. An Electron-as-Node fallback must document why RunAsNode remains enabled and still disable every unrelated capability.

## Workstream 4 — Test and development infrastructure

### Repository prerequisite

Initialize version control before CI work, preserving the current workspace as the reviewed initial baseline. No remote repository or publishing action is implied by this phase document.

### Reproducible toolchain

- Pin the supported Node 24 release line and pnpm 11.19 in machine-readable config and documentation.
- Make CI use `pnpm install --frozen-lockfile` and rebuild `node-pty` for the target Electron ABI.
- Add lint, formatting check, unit/integration coverage, license audit, and dependency audit commands to `pnpm check` or a clearly documented release superset.
- Keep generated `out/`, `dist/`, packages, credentials, and corpus databases out of source control unless intentionally tracked as release artifacts.

### Electron end-to-end tests

Use Playwright's Electron support with a temporary `PAPERRELAY_DATA_DIR` and fixture research roots. Stub native dialogs in the Electron main process for deterministic tests.

Required flows:

1. launch, connect a folder, wait for scan, search, and read a paper;
2. create a note draft, attempt every destructive transition, cancel, recover, save, and relaunch;
3. enter Radar, select a node, open evidence, and open a source paper;
4. exercise remove/discard dialogs entirely by keyboard;
5. verify unavailable-root, detail-error, stale-data, and retry states;
6. verify Agent Relay setup against the packaged relay executable;
7. start/stop a terminal against a deterministic fake Codex executable, with a separate opt-in installed-Codex smoke test.

The real-corpus test runs on a scheduled or manually authorized job and publishes timing/count metrics without uploading the corpus.

## Workstream 5 — Packaging and release

### Desktop package

- Add electron-builder configuration for macOS DMG/ZIP first.
- Unpack `node-pty`, its native binary, the relay executable, and other process-spawned resources from ASAR.
- Validate package contents against an allowlist; exclude source corpora, development caches, tests, maps where unnecessary, and local databases.
- Define a stable application ID, executable name, icons, entitlements, privacy descriptions, and version metadata.
- Produce separate arm64 and x64 artifacts until a universal native-module build is proven.

### Packaged Agent Relay

Bundle the MCP entry and dependencies into a single script, then test two installed-build runtime descriptors:

1. a platform-specific single-purpose Node single-executable application (SEA), the preferred production design; and
2. the signed Electron executable with `ELECTRON_RUN_AS_NODE=1`, kept only as a fallback if SEA cannot meet signing, compatibility, size, or maintenance gates.

Both descriptors open only the catalog path supplied by the generated PaperRelay configuration and expose the existing stdio protocol. The decision record must compare notarization, native architecture support, launch latency, artifact size, update burden, fuse posture, and abuse surface.

Release acceptance requires:

- no dependency on `node` in the user's PATH;
- a signed relay executable adjacent to packaged resources;
- a setup probe executed against the exact packaged binary;
- generated Codex configuration using an absolute executable path and database path;
- protocol-clean stdout and bounded stderr;
- successful concurrent reads while the desktop writes WAL state;
- the same four read-only tools and schema checks as development.

Node SEA remains an actively developed platform feature, so this spike happens before signing automation. Choose SEA when it passes the acceptance checks. Electron-as-Node may be selected only through the explicit security/release decision above; neither option may require a system Node installation.

### Signing and release gate

- Sign and notarize macOS artifacts with credentials held only in the release environment.
- Verify the signature, notarization ticket, entitlements, hardened runtime, app launch, native PTY load, asset preview, source reveal, and relay handshake on a clean machine/user profile.
- Generate checksums and a concise release manifest.
- Do not implement auto-update until rollback, signature verification, and migration recovery are specified separately.

## Acceptance criteria

- No normal navigation, root removal, reload, or quit path can silently lose a note/tag draft.
- A crash after a successful draft journal write restores the exact draft.
- Radar labels, focus behavior, and navigation outcomes agree.
- Dialogs and menus pass keyboard-only and screen-reader interaction checks.
- Independent failures remain visible until their own retry/success supersedes them.
- Fast and deep scans both preserve source immutability and reconcile the catalog correctly.
- Agent search can page through every reachable match without adding a fifth tool.
- Every privileged IPC handler rejects a non-main-frame sender.
- Typecheck, unit/integration tests, Electron E2E, production build, packaged-app smoke, and relay handshake pass in CI.
- A signed macOS package works without Node.js or pnpm installed.
- Upgrading existing catalog/user databases preserves all indexed and personal data; unsupported newer schemas are still rejected without replacement.

## Explicitly deferred

- New research workflow features covered by Phase 6
- Built-in fetching or external search covered by Phase 7
- Zotero and Obsidian connectors covered by Phase 8
- Auto-update and in-app rollback
- Windows/Linux signing and store submission
- Cloud accounts, telemetry, and collaboration

## Primary technical references

- [electron-vite distribution guidance](https://electron-vite.org/guide/distribution)
- [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Playwright Electron automation](https://playwright.dev/docs/api/class-electron)
- [Node.js single executable applications](https://nodejs.org/download/release/v24.15.0/docs/api/single-executable-applications.html)
