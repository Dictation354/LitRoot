# Windows 11 + WSL2 physical acceptance

This checklist requires a real Windows 11 machine and is intentionally separate from automated Linux tests.

## Setup

1. Install the unsigned LitRoot build from `release/` on Windows 11.
2. Prepare a WSL2 distribution with Node.js 24.15+, official `paper-fetch`, and Git. Keep Node and paper-fetch visible only through the login-shell configuration (for example, `nvm` and the managed paper-fetch block in `.bashrc`); do not add test-only `/usr/local/bin` shims.
3. Create an empty WSL-native project directory under `/home/...`; do not use `/mnt/c`, a network share, or NTFS.

## Required evidence

- Launch `LitRoot.exe`, select the intended distribution, and record the successful dependency diagnostic.
- Connect the WSL absolute project path and verify all fixed directories were created.
- From a separate WSL shell/Agent, write a trusted paper-fetch Markdown file under `papers/`; verify it appears without manual import.
- Add one DOI and one title through the GUI. Verify identity, fetch, acceptance, output path, and hash are visible.
- Submit exactly 50 inputs with concurrency 4. Verify input order is stable when completion order differs and one failure does not stop unrelated items.
- Correct title, DOI, year, and keywords; restart both app and WSL service; search for the corrected values and verify the same paper ID/note remains.
- Render a paper containing a local image, GFM table, fenced code block, inline math, and display math.
- Edit `notes/project.md` and `notes/papers/<paper-id>.md`; read both directly with `cat` from WSL.
- Modify an open note externally while the UI has an unsaved draft; verify LitRoot stops saving and offers reload/copy without overwriting disk.
- Request an existing DOI and verify no duplicate file is produced. Run a limited refresh and verify the previous full text remains byte-identical.
- Verify a request to the service port without `Authorization: Bearer <token>` returns 401.

Record the Windows build number, WSL version/distribution, Node version, paper-fetch version, Git version, installer SHA-256, and pass/fail evidence for every item.
