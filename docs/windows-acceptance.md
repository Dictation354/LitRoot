# Windows 11 native + WSL2 physical acceptance

This checklist requires a real x64 Windows 11 machine and is intentionally separate from automated package smoke tests.

## Setup

1. If an older NSIS build is installed, uninstall it manually. The Inno Setup installer does not detect, remove, or migrate NSIS installations.
2. Install the unsigned Inno Setup build from `release/` on Windows 11 without silent flags.
3. Install the official Windows x64 `paper-fetch` package, then prepare a WSL2 distribution with Node.js 24.15+ and official `paper-fetch`. Keep WSL Node and paper-fetch visible through the login-shell configuration; do not add test-only shims.
4. Create one empty native NTFS project directory and one WSL-native directory under `/home/...`; do not place the WSL project under `/mnt/c`.

## Required evidence

- On both Simplified Chinese and English Windows UI settings, verify Setup selects the matching language by default and permits switching languages before the wizard starts.
- Verify the standard wizard shows the welcome, destination, optional tasks, and finished pages without a UAC prompt. Confirm the default destination is `%LOCALAPPDATA%\Programs\LitRoot` and can be changed.
- Verify a Start Menu shortcut is always created, the desktop shortcut is unchecked by default and follows the selected task, and the finished page offers to launch LitRoot with that option checked by default.
- Launch `LitRoot.exe`, select **Windows 本机**, and record the successful bundled-Node and paper-fetch diagnostic.
- Connect the native project, then verify scan, fetch, notes, export, image copy, and reveal all use Windows paths.
- Connect the WSL project, select the intended distribution, and record its successful dependency diagnostic.
- Verify the WSL absolute path and all fixed directories were created.
- From a separate WSL shell/Agent, write a trusted paper-fetch Markdown file under `papers/`; verify it appears without manual import.
- Add one DOI and one title through the GUI. Verify identity, fetch, acceptance, output path, and hash are visible.
- Submit exactly 50 inputs with concurrency 4. Verify input order is stable when completion order differs and one failure does not stop unrelated items.
- Correct title, DOI, year, and keywords; restart both app and WSL service; search for the corrected values and verify the same paper ID/note remains.
- Render a paper containing a local image, GFM table, fenced code block, inline math, and display math.
- Edit `notes/project.md` and `notes/papers/<paper-id>.md`; read both directly with `cat` from WSL.
- Modify an open note externally while the UI has an unsaved draft; verify LitRoot stops saving and offers reload/copy without overwriting disk.
- Request an existing DOI and verify no duplicate file is produced. Run a limited refresh and verify the previous full text remains byte-identical.
- Verify a request to the service port without `Authorization: Bearer <token>` returns 401.
- Install a newer Inno Setup build over the same destination and verify LitRoot launches with the existing application state intact.
- Uninstall LitRoot and verify the Start Menu and optional desktop shortcuts are removed and `LitRoot.exe` no longer exists in the selected destination.

Record the Windows build number, WSL version/distribution, bundled and WSL Node versions, both paper-fetch versions, installer SHA-256, and pass/fail evidence for every item.
