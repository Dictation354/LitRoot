# Phase 1: Universal local library

## Product outcome

A researcher can connect unrelated project directories, see their agent-fetched papers in one library, search their structured content, and open the original location. No import, copy, or source mutation is required.

## Workflow

1. Open PaperRelay and choose **Connect research folder**.
2. PaperRelay scans the folder recursively while keeping it usable as a normal project directory.
3. Recognized papers appear in **All Papers** with their research-folder context and extraction health.
4. Search covers both scholarly metadata and indexed article text.
5. Select a paper to read its abstract, structured sections, assets, provenance, and source locations.
6. Continue using `paper-fetch` through an agent. The watcher schedules a new authoritative scan when outputs change.

## Acceptance criteria

- Two unrelated project folders can be connected through a native folder picker.
- Scanning never moves, renames, rewrites, or deletes source content.
- Supported representations appear together in one library.
- A single DOI across multiple folders resolves to one paper with multiple locations.
- Search covers title, authors, DOI, journal, abstract, and body text.
- A malformed candidate produces a visible issue without stopping the scan.
- An unavailable folder keeps its cached records and reports its state.
- A successful rescan reconciles externally deleted artifacts.
- Symlinked directories are not traversed.
- Removing a research folder changes only PaperRelay's catalog.
- Restarting the app restores registered folders and the index.

## Data ownership

The PaperRelay SQLite database contains only an index and normalized projections needed by the interface. The original structured files remain authoritative. The UI communicates through a narrow typed bridge and cannot access arbitrary filesystem APIs.

## Deferred to later phases

- Paper acquisition inside PaperRelay
- Notes, highlights, annotations, or metadata editing
- Virtual projects and collections beyond physical research folders
- Agent/MCP mutation APIs and generated evidence objects
- Semantic/vector retrieval
- Zotero and Obsidian interoperability
- PDF-first reading
- Cloud sync, accounts, and collaboration
- Installer/signing and distribution polish
