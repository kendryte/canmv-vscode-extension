# CanMV VS Code Extension

This repository contains the CanMV VS Code extension and its native backend for CanMV K230 development. The extension lets you connect to a board, run MicroPython scripts, preview camera frames, manage files on the device, and use an integrated board terminal from VS Code.

The extension package README lives at [`extension/README.md`](extension/README.md). VS Code uses that file when building the VSIX/Marketplace package from `extension/package.json`. This root README is for repository-level setup and development.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `extension/` | VS Code extension source, package metadata, webviews, resources, and packaged backend binaries. |
| `extension/src/` | TypeScript extension code. |
| `extension/webview/` | Preview and terminal webview HTML. |
| `native/go/` | Native Go backend used by the extension to communicate with the board. |
| `scripts/` | Repository-level build, staging, and packaging helpers. |
| `manifest.json` | Release metadata for firmware, backend, and extension versions. |

## Features

- CanMV K230 board connection and auto-detection.
- Active Python script execution and script stop control.
- Live camera/framebuffer preview with FPS, histograms, image capture, rotation, and virtual touch support.
- Device filesystem browsing, upload/download, rename/delete, and remote Python file editing.
- Integrated CanMV Terminal for board output, REPL input, Ctrl-C interrupt, and log export.
- Automatic K230 MicroPython stub configuration for Pylance.
- Bundled native backend binaries for Linux, Windows, and macOS package targets.

## Requirements

- VS Code `1.90.0` or newer.
- Node.js/npm for extension development.
- Go for backend development and packaging.
- A CanMV K230 board connected over USB for runtime testing.

## Build From Source

Install extension dependencies and compile TypeScript:

```bash
cd extension
npm install
npm run compile
```

Build and stage the backend for your current platform:

```bash
./scripts/stage-current-backend.sh
```

Package a VSIX with backend binaries for all supported platforms:

```bash
./scripts/package.sh
```

The packaged VSIX is written to `release/`.

## Development Workflow

1. Open this repository in VS Code.
2. Run `npm install` in `extension/`.
3. Run `./scripts/stage-current-backend.sh` from the repository root.
4. Start the extension host from VS Code using the extension launch configuration.
5. Connect a CanMV K230 board and run `CanMV: Connect Board`.

For backend-only work:

```bash
cd native/go
go build ./cmd/canmv-backend
```

To use a custom backend while developing, set `canmv.backendPath` in VS Code settings or export `CANMV_BACKEND_PATH`.

## Documentation

- Extension user guide: [`extension/README.md`](extension/README.md)
- Changelog: [`extension/CHANGELOG.md`](extension/CHANGELOG.md)
- Package metadata: [`extension/package.json`](extension/package.json)

## Troubleshooting

- If the extension cannot find the backend, run `./scripts/stage-current-backend.sh` or set `canmv.backendPath`.
- If TypeScript output looks stale, run `npm run compile` from `extension/`.
- If the board is not detected, check the USB cable, board power, serial permissions, and `canmv.serialPath`.
- Use the `CanMV` Output channel in VS Code for backend, connection, preview, stubs, and file-transfer diagnostics.
