# paper-fetch 7.0.1 contract captures

Captured on 2026-09-27 from upstream v7.0.1 (`c77c19a79f8447eed04941d1cc2216e5728a4a02`) during the compatibility audit. Network retrieval was replaced with deterministic provider outcomes; the real CLI, serializer, Markdown renderer, progress protocol and batch scheduler produced these records. These are offline contract evidence, not publisher network tests.

`records.json` contains complete, degraded fallback, abstract-only, browser failure, manual authentication, cancellation and three rate-limited batch records. Temporary absolute paths were replaced with `output` paths; synthetic article metadata, diagnostics and output SHA-256 values are unchanged. The Markdown files match the captured hashes. `replay.mjs` rebinds artifact paths, engine indexes and run IDs for portable integration tests.

`offline-cli.py` runs the same audit scenarios against an explicitly selected local source checkout, without modifying it. It uses upstream test envelope construction and patches only retrieval/runtime loading. Opt in with `LITROOT_PAPER_FETCH_SOURCE` (checkout root) and `LITROOT_PAPER_FETCH_PYTHON` (its Python environment); ordinary tests need neither a neighboring checkout nor network access.
