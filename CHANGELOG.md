# Changelog

[中文](CHANGELOG_CN.md)

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
