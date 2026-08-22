# Phase 7: Directed acquisition and external literature checks

## Status and product outcome

Phase 7 is the C track and targets the `0.5` release line after Phases 5 and 6. It lets a researcher explicitly acquire or refetch a paper and check a Research Radar signal against an external bibliographic provider. Every operation shows what will leave the machine, where files will be written, which executor will run, and what provenance PaperRelay can actually verify.

Nothing runs autonomously. The existing scanner remains read-only. Only a new acquisition service may write, and only beneath a dedicated namespace inside a user-selected registered root.

## Locked decisions

1. **Ship two explicit execution paths with no silent fallback.**
   - **Codex handoff** handles ambiguous titles and workflows needing judgment. PaperRelay can verify detected output, but cannot attest to the agent's network requests or search completeness.
   - **Managed adapters** handle deterministic DOI fetches, refetches, and structured literature queries. They provide a queue, cancellation, bounded logs, versioned provenance, and verified publication.
2. **Handoff ships before managed `paper-fetch`.** A managed adapter is enabled only after `paper-fetch` has a stable, versioned invocation and result-manifest contract.
3. **Crossref is the first literature-check provider.** It supports DOI lookup and bibliographic queries without making a paid or credentialed provider an MVP dependency.
4. **A check returns potential related works, not a novelty verdict.** `no_hits_in_bounded_check` is never rendered as proof of absence.
5. **Refetch is immutable.** It creates a new representation and never overwrites or deletes an existing source.
6. **Agent Relay stays unchanged.** Acquisition does not add MCP mutation tools or expose private personal state.

## User workflows

### Acquire a paper

The library header gains **Acquire paper**. A managed request accepts:

- a normalized DOI;
- an HTTPS identifier URL supported by a registered adapter; or
- a DOI-bearing candidate selected from managed bibliographic search.

A raw title first goes through metadata search and user selection. Ambiguous work can instead be handed to Codex. The user must choose a registered destination root; global library scope never implies one.

Before execution, PaperRelay displays the normalized target, adapter or handoff mode, exact root-relative destination, network disclosure, credential/cost note, and the never-overwrite policy.

### Fetch full text or refetch

Paper detail and Sources gain **Fetch full text** and **Refetch…**. A request captures the paper, root, optional source location, current representation revision, normalized DOI, and one goal:

- `upgrade_full_text`
- `refresh_metadata`
- `repair_assets`
- `best_available`

A stale representation revision fails before execution and returns the user to a new preview. A poorer content class cannot displace an existing better preferred representation.

### Check a Radar signal

A signal marked `noveltyRequiresExternalChecking` gains **Check external literature**. The main process resolves the current signal and constructs a bounded, editable query:

- a coverage gap uses an exact DOI lookup;
- a local-corpus hypothesis uses the indexed term plus a bounded query seed;
- an author-stated opportunity uses the statement plus bounded source metadata.

The confirmation sheet shows the exact provider and outbound query. It does not automatically include private notes, annotations, evidence excerpts, full paper text, local paths, or internal IDs.

Results are labelled **Potential related works** and show provider identity, title, authors, year, venue, DOI/link, provider rank, and an exact-DOI local-library match. A user can mark each result `relevant`, `not_relevant`, or `unsure`, then enqueue selected DOI-bearing results for acquisition.

Allowed check summaries are:

- `unchecked`
- `checking`
- `potential_related_work_found`
- `no_hits_in_bounded_check`
- `incomplete`
- `failed`

## Architecture

```text
Renderer
  acquisition preview / queue / Radar result drawer
                         |
                 validated bounded IPC
                         |
AcquisitionService + OperationScheduler
        |                  |                   |
 managed adapters    Codex handoff       Operations DB
        |                  |
 root staging/publish namespace
                         |
                existing watcher/scanner
                         |
                rebuildable catalog + FTS
```

Add main-process services for acquisition contracts, adapter registration, scheduling, handoff construction, output verification, operations persistence, and provider implementations. The renderer can select only registered adapter IDs; it cannot supply an executable, argv, environment, output path, provider host, redirect policy, or secret.

Use separate contracts for file-producing acquisition and metadata-only search:

```ts
interface AcquisitionAdapter {
  descriptor(): AcquisitionAdapterDescriptor
  probe(signal: AbortSignal): Promise<AdapterAvailability>
  plan(request: ValidatedAcquisitionRequest, context: AcquisitionContext): Promise<AcquisitionPlan>
  execute(plan: AcquisitionPlan, context: AcquisitionExecutionContext): Promise<AcquisitionAdapterResult>
  verify(result: AcquisitionAdapterResult, context: AcquisitionContext): Promise<VerifiedAcquisitionOutput>
}

interface LiteratureSearchAdapter {
  descriptor(): LiteratureAdapterDescriptor
  search(request: ValidatedLiteratureCheckRequest, context: LiteratureExecutionContext): Promise<LiteratureSearchResult>
}
```

Descriptors declare stable IDs and versions, supported targets/goals, manifest schema range, cancellation behavior, expected network origins, credentials or paid use, and result/file/byte limits.

### Managed subprocess boundary

A managed process adapter must:

- resolve only a fixed executable or bundled adapter and show its canonical path/version in preview;
- use `spawn` with `shell: false` and argv built only from validated fields;
- use a minimal environment allowlist and adapter-scoped credentials;
- bound stdout, stderr, structured events, files, and bytes;
- cancel on user action, root removal, or app shutdown;
- validate the output manifest independently before publication.

This is not an OS sandbox. An installed executable retains the user's normal OS permissions, so PaperRelay must describe it as a trusted local dependency rather than claiming filesystem confinement.

### Scheduler rules

- One active file-producing acquisition globally and one writer per root.
- One active external query per provider.
- A duplicate active request fingerprint focuses the existing job.
- Network retry is bounded to three attempts for timeout, 408, 429, and 5xx, honoring `Retry-After`.
- No automatic retry or resumed network activity after restart; a running job becomes `interrupted`.

## Filesystem publication model

Managed work uses:

```text
<root>/.paperrelay/
  acquisition-staging/<attempt-id>/       ignored by scanner
  acquisition-failed/<attempt-id>/        ignored by scanner
  acquisitions/<job-id>/<attempt-id>/     indexed
```

The walker ignores only the exact PaperRelay staging and failed prefixes. Publication:

1. re-canonicalizes the registered root and rejects a symlinked `.paperrelay` directory or containment change;
2. runs the adapter in attempt-specific staging;
3. validates schema, identity, relative paths, counts, sizes, and hashes;
4. atomically moves valid output to `acquisitions`;
5. rescans the root and links the new location by exact DOI plus published path;
6. reports success only after a catalog location is linked.

Usable partial output can be published only after validation and is marked `partial`. An identity mismatch becomes `identity_review_required`; it is never silently linked to the requested paper. Existing content outside `.paperrelay/acquisitions` remains byte-for-byte unchanged.

Initial tested bounds are 512 MiB and 2,000 files per attempt, 128 MiB per file, a 256 KiB combined log tail, 1,000 progress events, 25 literature hits, a 500-character query, and a 2,048-character DOI/URL input.

## Operations sidecar

Create `paperrelay-operations.sqlite3`, schema 1. It owns durable job/check provenance, not rebuildable catalog data or personal research state, and has no cascading foreign keys into the catalog.

### Core tables

- `operation_jobs`: kind, execution mode, adapter, root/paper/signal snapshots, request and fingerprint, state, timestamps, result/error codes;
- `operation_attempts`: attempt sequence, adapter/executable identity, lifecycle, bounded redacted log tail, manifest identity, published directory, provenance;
- `literature_hits`: provider ID/rank, DOI and bounded metadata, local exact match, and review state.

Managed state:

```text
queued -> running -> succeeded | partial | failed
queued -> cancelled
running -> cancelling -> cancelled | partial
running at process loss -> interrupted
failed | partial | interrupted | cancelled -> queued as a new attempt
```

Handoff state:

```text
handoff_ready -> handed_off -> verifying -> succeeded | partial | failed
```

Secrets never enter the database. Later keyed adapters use OS-backed credential storage with set, replace, test, and delete actions; a stored value is never returned to the renderer.

## Codex handoff contract

PaperRelay builds a prompt from validated structured fields. The UI offers **Copy prompt** and **Insert into Console**, and discloses that managed provenance guarantees do not apply.

- The terminal must belong to the same renderer and selected root.
- Workspace-write still requires the existing native confirmation.
- Text is inserted without Enter/Return; the user submits it.
- Nothing is injected into a busy or different-root session.
- The bounded prompt strips terminal control characters, treats bibliographic content as untrusted data, and names a dedicated expected output directory.
- PaperRelay stores the request and prompt-template version/hash, not the terminal transcript.

A handoff remains `handed_off` until the user chooses **Verify output**. Verification rescans the root, validates detected identity and output, and links a catalog location. Terminal exit alone is never success.

## IPC and authorization

Expose strict, unknown-field-rejecting request shapes for:

- adapter discovery, preview, start, list, detail, cancel, retry, output verification/reveal, and change events;
- literature preview/start, check detail, result review, and change events;
- same-root handoff insertion into the existing terminal.

`preview` returns a short-lived, one-use opaque token held in main. `start` consumes it only after rechecking root containment, source revision, adapter availability, network disclosure, and authorization. All privileged handlers validate the active trusted main frame.

## Network, privacy, and provenance

- Renderer code performs no direct network requests; built-in adapters use fixed HTTPS origins.
- Identifier URLs are not arbitrary fetch targets. Redirects are bounded and revalidated; private, loopback, link-local, file, data, and custom-scheme targets are rejected.
- PaperRelay does not reuse browser cookies, automate logins, bypass paywalls/CAPTCHAs/access controls, or imply that metadata links grant full-text rights.
- The query preview warns that search terms may disclose an unpublished idea to the provider.
- External metadata is escaped as untrusted data and is never interpolated into a shell or treated as agent instruction.
- Credentials and authorization values are redacted from IPC, errors, logs, events, databases, and manifests.

Managed provenance records the request fingerprint, execution/adapter identity, declared/observed origins, upstream manifest hash, output paths/sizes/roles/hashes, identity decision, warnings, rescan, and resulting catalog IDs. Handoff provenance records only what PaperRelay directly verifies; it never reconstructs the agent's search process.

## Delivery slices

### 7.0 — Operations foundation

Operations DB and migrations, state machine, scheduler, adapter registry, preview-token IPC, queue UI, root staging/publication, shutdown coordination, and deterministic fake adapters.

**Gate:** a fake job survives restart, cancels cleanly, publishes safely, triggers a scan, and links to the indexed paper.

### 7.1 — Codex handoff

Acquire/refetch sheets, structured prompt builder, same-root no-submit insertion, verify/rescan/link flow, and bounded provenance display.

**Gate:** a DOI handoff can be verified and opened without PaperRelay implying it managed the run.

### 7.2 — Managed `paper-fetch`

This slice is blocked until a versioned contract defines probe, structured input, progress, cancellation, exit codes, manifest location/schema, and secret handling. Then add fixed executable resolution, bounded runner, manifest validation, atomic publication, and refetch comparison.

**Gate:** unsupported tool versions fail before network or writes; a supported DOI fetch/refetch completes without touching prior artifacts.

### 7.3 — Radar external checks

Crossref adapter, deterministic query builder, exact outbound preview, rate limiting/cache/backoff, result drawer, DOI matching, review states, **Acquire selected**, and optional **Deep check in Codex**.

**Gate:** all Radar signal bases can run an approved, bounded, timestamped check and no result is framed as a novelty conclusion.

### 7.4 — Reliability gate

Interrupted-job recovery, root-removal coordination, offline/partial/malformed/rate-limit handling, packaged-app E2E, adversarial tests, and network/privacy documentation.

## Acceptance criteria

- No acquisition or literature request starts without direct user action and an exact preview.
- Refetch never replaces, modifies, or deletes an existing artifact.
- Managed success requires validated output and a linked catalog location.
- A DOI mismatch cannot be silently attached; staging and failed attempts are never indexed.
- Root paths are re-canonicalized before execution and publication; symlink escapes fail closed.
- Cancellation and shutdown settle child processes before database/root teardown.
- Managed processes use fixed executables, `shell: false`, bounded output, and a minimal environment.
- Private notes, annotations, paths, excerpts, and full text are absent from mock outbound literature requests.
- Results are bounded, cached, timestamped, and explicitly truncated/incomplete when appropriate.
- Provider and network failures remain typed and local to their job without corrupting prior results.
- Signal scope and fingerprint prevent a stale check from attaching to another signal.
- Secrets never appear in renderer payloads after storage, logs, database rows, manifests, or errors.
- Existing scanner immutability, user-sidecar privacy, and the four-tool Agent Relay boundary remain intact.

## Explicitly deferred

- Autonomous or scheduled acquisition/search/update alerts
- Systematic-review completeness or automated novelty validation
- Publisher-login automation, cookie reuse, CAPTCHA handling, or paywall circumvention
- Direct PDF parsing in PaperRelay
- Arbitrary third-party executables or plugins
- New MCP mutation tools or private-state exposure
- Cloud accounts, collaboration, or queue synchronization
- Zotero/Obsidian synchronization, covered by Phase 8

## Primary technical references

- [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)
- [Crossref access and rate-limit guidance](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/)
- [Crossref query and cursor guidance](https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/)
- [Crossref full-text access guidance](https://www.crossref.org/documentation/retrieve-metadata/text-and-data-mining/)
