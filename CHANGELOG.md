# Changelog

[中文](CHANGELOG_CN.md)

## [1.3.3](https://github.com/Dictation354/LitRoot/releases/tag/v1.3.3) — 2026-11-27

### Fixed

- Fixed a Journal Radar refresh failure in Nature and other journals when a page contains a paper with more than 1,000 authors. LitRoot keeps the first 50 nonempty names in byline order and removes duplicates from that selection.
- Fetches, unread counts, and cache retention now use the same 30-day window based on when a DOI was first registered with Crossref. Existing subscriptions pick up the new window automatically.
- Browse the past 1, 3, 7, 14, or 30 days, with 7 days selected by default. Startup and hourly cleanup remove expired radar entries even when a refresh fails. Read status within the window and papers already added to projects are preserved.

[Full changes](https://github.com/Dictation354/LitRoot/compare/v1.3.2...v1.3.3)

## [1.3.2](https://github.com/Dictation354/LitRoot/releases/tag/v1.3.2) — 2026-11-20

### Improved

- Journal Radar backfills 30 days of Crossref records across a journal's ISSNs when adding a subscription, deduplicates by DOI, and lets you cancel the initial fetch.
- Added a 90-day view and retention window, preserved partial publication dates, and used Crossref indexing dates to pick up records indexed after the previous refresh.
- The feed database upgrade keeps existing Crossref subscriptions and clears legacy RSS subscriptions and entries.

### Fixed

- Recovered single-paper results from paper-fetch 8.0.0 receipts using the detailed manifest or the receipt's Markdown paths, with artifact validation.
- Distinguished unscheduled batch items from cancellations and failures, and displayed formula and table quality counts in task details.

[Full changes](https://github.com/Dictation354/LitRoot/compare/v1.3.1...v1.3.2)

## [1.3.1](https://github.com/Dictation354/LitRoot/releases/tag/v1.3.1) — 2026-11-18

### Fixed

- Restore the option to continue unfinished fetches after an unexpected shutdown, including AMS fetches retried after manual authentication.

[Full changes](https://github.com/Dictation354/LitRoot/compare/v1.3.0...v1.3.1)

## [1.3.0](https://github.com/Dictation354/LitRoot/releases/tag/v1.3.0) — 2026-11-17

### Improved

- Support paper-fetch 7.7 browser profile waiting, execution, and completion stages throughout progress persistence and the task dialog.
- Recover single-paper results from schema-v1 stdout receipts, preferring their detailed schema-v2 manifests and retaining artifact hash validation.

### Fixed

- Exclude `.paper-fetch-results` reading snapshots from paper scans to prevent internal `body.md` files from taking ownership of a paper or causing duplicate conflicts.
- Preserve the official Windows launcher's bundled Node defaults for browser and formula tools, while respecting user overrides and older installers.

[Full changes](https://github.com/Dictation354/LitRoot/compare/v1.2.4...v1.3.0)

## [1.2.4](https://github.com/Dictation354/LitRoot/releases/tag/v1.2.4) — 2026-11-15

### Fixed

- Read paper-fetch publication years from `publication_dates`, preferring print, online, issued, then unspecified dates, with legacy field fallback.
- Automatically refresh existing cached metadata while preserving paper IDs, Markdown, and user year overrides, including explicitly cleared years.
- Add the real paper-fetch 7.6.2 golden fixture and regression coverage, alongside offline CLI integration coverage for paper-fetch 7.3.4.

[Full changes](https://github.com/Dictation354/LitRoot/compare/v1.2.3...v1.2.4)

## [1.2.3](https://github.com/Dictation354/LitRoot/releases/tag/v1.2.3) — 2026-11-06

### Improved

- Support Node.js 26.x for development, builds, and WSL services alongside Node.js 24.15+ (24.x).
- Update runtime diagnostics and documentation to reflect the supported Node.js versions.

[Full changes](https://github.com/Dictation354/LitRoot/compare/v1.2.2...v1.2.3)

## [1.2.2](https://github.com/Dictation354/LitRoot/releases/tag/v1.2.2) — 2026-11-01

### Fixed

- Fix the missing Linux application icon after installing the deb package by providing standard-size icons for the hicolor theme, including 512×512.

[Full changes](https://github.com/Dictation354/LitRoot/compare/v1.2.1...v1.2.2)

## [1.2.1](https://github.com/Dictation354/LitRoot/releases/tag/v1.2.1) — 2026-10-26

### Fixed

- Allow project entries to be disconnected after their directories have been deleted, and clear stale service registrations without requiring the project to be loaded.
- Replace garbled Windows system errors when paper-fetch is missing from PATH with readable installation and configuration guidance.

[Full changes](https://github.com/Dictation354/LitRoot/compare/v1.2.0...v1.2.1)

## [1.2.0](https://github.com/Dictation354/LitRoot/releases/tag/v1.2.0) — 2026-10-23

### Improved

- Replace KaTeX with MathJax 4.1.3 for synchronous offline SVG rendering and assistive MathML, with bundled TeX, mhchem, and bbm fonts and expanded TeX extension support.
- Share the formula engine with paper-fetch 7.2.0, with generated-source and SHA-256 consistency checks; verify compatibility through offline CLI integration and reader tests.
- Isolate macros and diagnostics per document, and display failed formulas as source TeX with an error tooltip while continuing to render the remaining body.
- Preserve Markdown formula delimiters and source TeX, adapt display styling and text search to MathJax, and remove unused KaTeX dependencies through a parser-preserving pnpm patch.

[Full changes](https://github.com/Dictation354/LitRoot/compare/v1.1.4...v1.2.0)

## 1.1.4 — 2026-09-27

- Require paper-fetch 7.0.1+ stable and JSONL progress/control support before creating or resuming tasks.
- Preserve official Windows installer configuration with user overrides taking precedence.
- Retain source/acquisition and acceptance diagnostics, preserve failure/fallback causes, and provide supported manual auth commands as a separate field.
- Distinguish unscheduled batch items from cancellations and persist completion order from actual terminal events across recovery.
- Add genuine 7.0.1 contract fixtures and optional offline CLI integration; older task records remain readable.

## [1.1.3](https://github.com/Dictation354/LitRoot/releases/tag/v1.1.3) — 2026-09-13

### Fixed

- Move the selected-paper count to the existing pagination footer so selecting papers no longer shifts the library table or causes a double-click to hit another paper.

[Full changes](https://github.com/Dictation354/LitRoot/compare/v1.1.2...v1.1.3)

## [1.1.2](https://github.com/Dictation354/LitRoot/releases/tag/v1.1.2) — 2026-09-12

### Fixed

- Archive fetched papers directly in `papers/` using the generated filename, without an identity-based subdirectory.
- Refuse to overwrite existing papers or attachments when filenames collide, and report the conflict.
- Preserve relative image paths when copying local attachments into the archive.

[Full changes](https://github.com/Dictation354/LitRoot/compare/v1.1.1...v1.1.2)

## [1.1.1](https://github.com/Dictation354/LitRoot/releases/tag/v1.1.1) — 2026-09-09

### Fixed

- Stop continuous rescanning and alternating “Scanning” / “Ready” status when multiple Markdown files share a paper identity, such as the same DOI or a shared source URL when no DOI is present.
- Keep the currently indexed version and record other copies as conflicts without modifying the source files. Preserve the selected version across restarts and index cache rebuilds.
- Avoid rewriting unchanged conflict records or emitting scan notifications for unchanged results.
- Let a remaining copy take over when the indexed file is deleted, preserving the paper ID, metadata overrides, and note association. Remove conflict records when duplicate files are deleted.

[Full changes](https://github.com/Dictation354/LitRoot/compare/v1.1.0...v1.1.1)

## [1.1.0](https://github.com/Dictation354/LitRoot/releases/tag/v1.1.0) — 2026-09-07

### Added

- Journal Radar and a subscription inbox, with improved literature workspace interactions.
- Live fetch progress and cancellation for individual papers.
- Page size preferences and fetching without a fixed batch size limit.

### Improved and fixed

- Preserve note and metadata drafts, and improve unsaved-change prompts and application exit handling.
- Improve Markdown reading, scroll position handling, dialog interactions, and error feedback.
- Fix timing-dependent cancellation tests and Windows checkout failures in CI.

[Full changes](https://github.com/Dictation354/LitRoot/compare/v1.0.0...v1.1.0)

## [1.0.0](https://github.com/Dictation354/LitRoot/releases/tag/v1.0.0) — 2026-08-29

### Added

- Initial stable release of the project-scoped local literature manager for paper-fetch Markdown.
- Support for native Windows 11 x64 and WSL2, Linux x64, and macOS 15+ on Apple Silicon.
- Markdown reading with local images, GFM tables, code, and KaTeX math; project-local full-text search, year filtering, metadata overrides, batch fetching, and project/per-paper notes.
- A bilingual Inno Setup installer for Windows, with installation, runtime, and uninstallation checks in CI.
- SHA-256 checksum files for Windows, Linux, and macOS packages.

### Fixed

- Avoid repeating the first body heading below the title on the paper reading page.
