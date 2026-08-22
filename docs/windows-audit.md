# Windows x64 engineering audit

Audit date: 2026-08-20

Application version: 0.2.0

Target: unsigned NSIS installer for Windows 10 version 1809 or newer on x64

## Outcome

The application now has one explicit Windows build: an unsigned x64 NSIS engineering installer. The implementation and cross-platform source checks pass on the current macOS workspace. A native `windows-2022` CI job is responsible for compiling and exercising the Windows runtime because the app includes `node-pty`; upstream build guidance requires native dependencies without suitable prebuilds to be compiled on their target platform.

No `.exe` was produced in this workspace. It has no Git metadata, pnpm executable, Windows Electron runtime, or NSIS toolchain, so the new Windows job could not be dispatched and its packaged-runtime checks have not yet run. The output must not be treated as a public release until that job passes and the installer is signed and clean-profile tested.

## Findings and disposition

| Priority | Area | Audit finding | Disposition |
| --- | --- | --- | --- |
| P0 | Packaging | There was no Windows target, installer command, artifact checksum, or native Windows job. | Added an x64 NSIS target, exact builder command, SHA-256 generation, artifact upload, and `windows-2022` checks. |
| P0 | Packaged Relay | Packaged setup referenced a development `dist/mcp` path and a `node` executable from `PATH`, while the package shipped a different relay resource. | Packaged setup now invokes the shipped relay bundle through the absolute PaperRelay executable with `ELECTRON_RUN_AS_NODE=1`; the generated Codex TOML/CLI environment and startup probe use the same descriptor. |
| P0 | Windows paths | Containment checks could accept a candidate on another drive because a cross-drive relative path is absolute on Windows. | Containment now rejects absolute relative results and has host-independent `path.win32` drive/case tests. |
| P0 | Embedded Console | Windows environment names are case-insensitive, npm commonly exposes Codex as a `.cmd` shim, and `node-pty` does not accept POSIX signal names on Windows. | The Console normalizes an explicit Windows environment allowlist, resolves Windows `Path`, wraps `.cmd`/`.bat` through an absolute validated `cmd.exe`, keeps `.exe` direct, and uses signal-less Windows PTY termination. |
| P1 | Native package | A source build alone does not prove that the unpacked Windows `node-pty` binary or packaged Relay works. | The package job launches the unpacked PaperRelay executable as Node to load `node-pty`, opens a ConPTY, verifies output and shutdown, then performs an MCP handshake/search through the packaged Relay with an empty `PATH`. |
| P1 | Electron boundary | Packaged builds honored an arbitrary renderer URL, renderer permissions had no deny policy, and many IPC handlers lacked active-main-frame authorization. | Packaged renderer URL overrides are ignored, all renderer permissions are denied, and every invoke handler authorizes the active main frame before access or side effects. |
| P1 | Window chrome | macOS title-bar behavior and labels were applied to Windows, and custom Windows controls could cover top-right actions. | Windows uses a native Window Controls Overlay, taskbar application ID, generic folder labels, and CSS safe-area values for the controls. |
| P2 | Reproducibility | `electron-builder` could not be installed into the lockfile in the restricted workspace. | Both package scripts pin `electron-builder@26.15.6`, and the package-boundary test enforces it. Moving the tool into `devDependencies` and `pnpm-lock.yaml` remains preferable when registry access is available. |
| P2 | Local toolchain | The available shell uses Node 25.8, outside the repository's pinned Node 24 line, and has no pnpm executable. | Local validation used the installed project binaries; the authoritative package job reads `.node-version` and installs pnpm 11.19 on Windows. |
| P2 | Supply chain | Registry-backed production dependency and license audits could not run in the offline workspace. | Run `pnpm run check:release` in the release environment and review any high-severity or license findings before signing. |
| P2 | Release trust | The engineering installer is unsigned and retains Electron's RunAsNode capability for the packaged Relay fallback. | Artifact names include `unsigned`; documentation forbids presenting it as trusted. Authenticode signing, an explicit Electron-fuse/Relay runtime decision, and clean-machine validation remain release gates. |
| P2 | End-to-end coverage | There is no installed Windows UI/Electron E2E pass yet. | Unit, integration, bundle, Relay-runtime, and planned packaged native smoke coverage are in place; installed UI flows remain deferred. |
| P3 | Performance | The current production renderer JavaScript bundle is approximately 2.66 MB before compression. | Non-blocking for this engineering installer; measure cold launch on Windows and split heavy Reader/Radar modules if startup or memory targets are missed. |

## Build and artifact

Run on a native x64 Windows host with Node 24.15 and pnpm 11.19:

```powershell
pnpm install --frozen-lockfile
pnpm run package:win
```

Expected installer:

```text
release/PaperRelay-0.2.0-win-x64-unsigned-setup.exe
```

The CI artifact also contains the adjacent `.sha256` file. `pnpm run package:win:dir` produces only the unpacked directory for local launch/debugging.

## Verification completed in this workspace

- TypeScript: main/preload, renderer, and MCP projects pass.
- Tests: 43 files pass, 2 opt-in files skip; 280 tests pass and 2 skip.
- Production output: Electron main/preload/renderer, MCP entry, and single-file Relay bundles build; all JavaScript entry points pass `node --check`.
- Packaged-runtime simulation: the built Relay passes its full MCP handshake, exact four-tool contract, and catalog search when launched through the absolute local Electron executable with an empty `PATH`.
- Package boundary: only production output, runtime dependencies, the icon, and the Relay resource are selected; `node-pty` is explicitly unpacked from ASAR.
- Configuration: `package.json`, `electron-builder.yml`, and the Windows CI workflow parse successfully; source and formatting hygiene pass.

## Gates before distribution

1. Put the workspace under version control and run the `windows-package` job on `windows-2022`.
2. Confirm the packaged PTY and Relay smoke steps, installer checksum, install, first launch, Console start/stop, Agent Relay setup, folder selection, source reveal, and uninstall on a clean Windows profile.
3. Add Authenticode signing and verify the signature after download; keep credentials only in the release environment.
4. Decide whether to replace the Electron-as-Node Relay fallback with a single-purpose executable, then apply compatible Electron fuses.
5. Run `pnpm run check:release`, add installed Electron E2E coverage, and measure cold launch/bundle memory before calling the Windows package release-ready.

## Primary references

- [node-pty Windows support and build requirements](https://github.com/microsoft/node-pty/blob/main/README.md)
- [electron-builder multi-platform and native-dependency guidance](https://www.electron.build/docs/features/multi-platform-build/)
- [electron-builder NSIS target](https://www.electron.build/nsis/)
- [Electron custom title-bar safe areas](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)
- [Codex STDIO MCP server configuration](https://learn.chatgpt.com/docs/extend/mcp#stdio-servers)
