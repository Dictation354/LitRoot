# Phase 3: Local personal library

## Product outcome

A researcher can organize papers by personal intent without changing the fetched article or its project folder. Favorites, reading progress, tags, and private notes work across every connected research folder and survive a temporary disconnect.

## Workflow

1. Star a paper to keep it in **Favorites**.
2. Set its status to **To read**, **Reading**, or **Reviewed**.
3. Browse the combined **Reading list** or completed **Reviewed** view across projects.
4. Add comma-separated personal tags and a Markdown note in **My Notes**. Switch between **Write** and **Preview** to check limited safe HTML, TeX equations, tables, code, and protected web links, then save explicitly.
5. Continue to read the paper, inspect its sources, or use its stable PaperRelay reference with Codex.

## Ownership and privacy boundary

- Indexed article files remain read-only and authoritative research sources.
- The rebuildable catalog remains `paperrelay.sqlite3` at schema version 2.
- Personal state is authoritative user data in a separately versioned `paperrelay-user.sqlite3` sidecar.
- The sidecar has no foreign keys to catalog papers and is never garbage-collected when a root disappears.
- Active counts exclude dormant state for papers that are not currently indexed.
- Exact paper identity, canonical-key, and safe same-document relinking restore state after reconnects or a DOI identity upgrade. Title/year guesses are never used.
- The existing MCP Agent Relay opens only the catalog and remains exactly four read-only tools. It cannot read private notes or mutate personal state.

## Bounds

- Up to 24 tags per paper.
- Up to 64 characters per tag, trimmed and deduplicated case-insensitively.
- Up to 20,000 characters per private note.
- Note previews never load images or embedded media; clickable links are limited to absolute HTTP(S) destinations and open outside PaperRelay.
- User-state writes require a paper that is currently present in the catalog.

## Acceptance criteria

- Favorite, reading status, tags, and notes agree in list and detail views.
- Favorite, Reading list, and Reviewed filters run before pagination, including full-text and root-scoped searches.
- Removing the last root copy makes state dormant rather than deleting it; reconnecting the same identity restores it.
- A DOI-less paper that gains a DOI at the same exact source document retains its state.
- Invalid or oversized updates fail without partial writes.
- Note previews render Markdown, limited safe HTML, and bounded TeX without executing scripts, loading remote resources, or making unsafe links active.
- A newer unsupported user-sidecar schema is rejected without being replaced.
- Personal updates do not change source artifacts, catalog paper timestamps, the catalog schema, or Agent Relay behavior.

## Deferred

- Anchored highlights and annotations
- Virtual projects, collections, and saved filter views
- Updates inbox and user-visible activity history
- Agent-authored notes, approval queues, or mutation tools
- Fetch/refetch requests from the desktop app
- Cloud accounts, synchronization, and collaboration
