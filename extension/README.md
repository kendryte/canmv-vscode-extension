# CanMV for Visual Studio Code

The CanMV for Visual Studio Code extension brings CanMV K230 board development into Visual Studio Code. It connects to the board through the bundled native backend, runs MicroPython scripts, streams camera frames, manages files on the device, and provides an integrated board terminal.

![CanMV for Visual Studio Code demo](https://raw.githubusercontent.com/kendryte/canmv-vscode-extension/main/extension/resources/demo.gif)

[![YouTube Tutorial](https://img.shields.io/badge/YouTube-Tutorial-red?style=for-the-badge&logo=youtube&logoColor=white)](https://www.youtube.com/watch?v=E-uumNsHLZc) [![Bilibili Tutorial](https://img.shields.io/badge/Bilibili-教程-blue?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1q27q67EEV)

## Features

- Connect and disconnect CanMV K230 boards from the CanMV activity bar or Command Palette.
- Auto-detect supported boards by USB VID/PID `1209:abd1`, with a manual serial path override when needed.
- Use legacy and v2 board protocol support through backend capability negotiation.
- Run the active Python file on the board, stop a running script, or run a Python file directly from the device tree.
- Preview live IDE framebuffer images with fit/original-size modes, rotation, PNG capture, FPS display, and RGB/grayscale/LAB/YUV histograms with hover readouts.
- Tune grayscale and LAB thresholds with the Threshold Editor, including image file loading, Frame Buffer capture, tuple copy, and selected tuple apply.
- Send virtual touch clicks from the preview when the connected firmware reports virtual touch support.
- Browse mounted device storage, including `/sdcard`, `/data`, and `/udisk`.
- Create, rename, delete, upload, download, open, edit, and auto-sync remote files.
- Save the active editor directly as `/sdcard/main.py` or `/sdcard/boot.py`.
- Use the CanMV Terminal panel for board output, REPL input, Ctrl-C script interrupt, log clearing, and log export.
- Expose a CanMV MCP server for compatible VS Code AI clients, with board detection, connection, script, terminal, remote filesystem, examples, and stubs tools.
- Configure K230 MicroPython stubs for Pylance, with automatic download and local cache reuse.
- Inspect extension, backend, stubs, preview, and transfer logs in the `CanMV` Output channel.

## Requirements

- Visual Studio Code `1.90.0` or newer.
- A CanMV K230 board connected over USB.
- Pylance is installed automatically as an extension dependency for Python analysis.
- For source development, install Node.js/npm and Go.

## Quick Start

1. Connect a CanMV K230 board over USB.
2. Open the Command Palette and run `CanMV: Connect Board`.
3. Open a Python file.
4. Run `CanMV: Run Active Python Script` from the Command Palette, the editor run button, or the editor context menu.
5. Use the CanMV activity bar views for board status, tools, and device files.
6. Open the `CanMV Terminal` panel to view output or enter REPL commands when no script is running.

## Main Views

| View | Location | Purpose |
| --- | --- | --- |
| Controls | CanMV activity bar | Shows connection state, board status, and script state. |
| Toolbox | CanMV activity bar | Opens extension tools such as Preview and Threshold Editor. |
| Device | CanMV activity bar | Browses and manages files on the connected board. |
| CanMV Terminal | Panel | Shows board output and accepts REPL input when available. |

## Common Workflows

### Connect to a Board

Run `CanMV: Connect Board`. The extension starts the backend, detects the board, performs the board handshake, updates the status bar, refreshes the Device tree, and configures Python stubs when possible.

If auto-detection does not find the board, set `canmv.serialPath` to a serial device path such as `/dev/ttyACM0`. When `canmv.serialPath` is set, `canmv.baudRate` is used for the connection.

### Run a Script

Open a Python file and run `CanMV: Run Active Python Script`. While a script is running, the terminal mirrors script output and the run button changes to stop. Use `CanMV: Stop Script` or press Ctrl-C in the CanMV Terminal to interrupt the script.

The editor context menu also includes `CanMV: Run Active File on K230`. For remote or mirrored files, this saves/syncs the file and runs the remote path. For ordinary local files, it sends the current editor contents directly to the board.

### Preview Camera Frames

Open `Preview` from the Toolbox or run `CanMV: Enable Preview`. When the running script publishes IDE framebuffer data, the preview streams JPEG frames into a tool tab.

The Preview tool supports:

- Fit-to-window and original-size viewing.
- 90-degree rotation.
- Saving the current frame as PNG.
- FPS and frame count display.
- RGB, grayscale, LAB, and YUV histograms.
- Histogram hover readouts for inspecting bin values.
- Virtual touch click forwarding when supported by the board firmware.

Preview starts automatically after a script begins when the Preview tool is open and preview is not manually disabled.

### Tune Thresholds

Open `Threshold Editor` from the Toolbox or run `CanMV: Threshold Editor`. The editor can load a local image file or grab the current Frame Buffer/preview canvas image, then preview grayscale or LAB threshold results.

You can copy the generated tuple, or select an existing grayscale/LAB tuple in the active editor and apply the new value directly.

### Manage Device Files

Open the Device view after connecting. Directories can be expanded, and files can be opened from the tree. Right-click a directory or mounted root to create files/folders, upload files, or upload a folder. Right-click files or folders to download, rename, or delete them.

Python files opened from the Device tree are mirrored into an extension-managed temp folder outside the current workspace. Saving a mirrored file syncs it back to the board automatically. The extension also updates `python.analysis.extraPaths` so Pylance can resolve imports from the mirror.

### Save Startup Files

Use the editor context menu while connected:

- `CanMV: Save as main.py` writes the active editor to `/sdcard/main.py`.
- `CanMV: Save as boot.py` writes the active editor to `/sdcard/boot.py`.

### Use the Terminal

The CanMV Terminal panel keeps recent scrollback, mirrors board/script output, and accepts REPL input when the board is connected and no script is running. Terminal input is disabled while a script runs, except Ctrl-C, which requests a script stop. The terminal webview also supports clearing output and saving the log.

### Use MCP Tools

The extension contributes a `CanMV MCP Server` definition to VS Code. Compatible MCP clients can discover tools for capability analysis, board detection/connection, script execution, preview frames, virtual touch, terminal input/output, remote filesystem operations, host-side artifact saving, and read-only access to cached CanMV examples and MicroPython stubs.

The MCP server runs as a standalone stdio Node process and uses the same bundled backend as the extension. It honors `canmv.backendPath`, `canmv.serialPath`, and `canmv.baudRate` through environment passed by the extension. Example and stub tools read the local caches under `~/.kendryte/k230_canmv_examples` and `~/.kendryte/k230_canmv_stubs`, so refresh/connect once if those caches are empty.

Board-facing MCP tools auto-connect when hardware access is needed and keep the board session alive for related follow-up calls, such as running a script, starting preview, and reading a frame. The server disconnects on `canmv_disconnect_board`, when the MCP client exits, or after an idle timeout. Set `CANMV_MCP_IDLE_DISCONNECT_MS` to adjust the timeout; the default is 120000 milliseconds.

When an AI workflow needs to save an image or downloaded artifact on the host, prefer the host-save tools instead of asking the MCP client to decode base64 text. `canmv_save_latest_frame_to_host` saves the current preview JPEG directly, `canmv_download_file_to_host` copies a remote board file to the host, and `canmv_save_base64_to_host` decodes base64 data returned by another tool. Relative output paths are written under `CANMV_MCP_OUTPUT_DIR` when set, or a temporary `canmv-mcp` output directory by default.

MCP capabilities include:

| Capability | Tools | Purpose |
| --- | --- | --- |
| Extension and board analysis | `canmv_analyze_capabilities`, `canmv_resource_summary`, `canmv_resource_route_info`, `canmv_board_info`, `canmv_board_capabilities`, `canmv_firmware_info` | Let an AI client inspect available CanMV features, firmware/resource cache state, local script resources, and the connected board state. |
| Board connection | `canmv_detect_boards`, `canmv_connect_board`, `canmv_disconnect_board` | Detect and manage a board session from an AI workflow. |
| Script execution | `canmv_run_script`, `canmv_write_and_run_script`, `canmv_stop_script`, `canmv_script_running` | Generate, write, run, stop, and check MicroPython scripts while collecting terminal output. |
| Preview and visual feedback | `canmv_start_preview`, `canmv_get_latest_frame`, `canmv_save_latest_frame_to_host`, `canmv_stop_preview` | Start framebuffer streaming, return the latest JPEG frame as base64, or save it directly to the MCP host. |
| Virtual touch | `canmv_virtual_touch_status`, `canmv_virtual_touch_tap` | Query and send virtual touch taps to supported running scripts. |
| Terminal access | `canmv_terminal_input`, `canmv_terminal_output` | Send REPL input and read buffered board/script output. |
| Remote filesystem | `canmv_list_dir`, `canmv_stat_file`, `canmv_read_file`, `canmv_download_file_to_host`, `canmv_write_file`, `canmv_execute_file`, `canmv_save_main_py`, `canmv_save_boot_py`, `canmv_mkdir`, `canmv_rename`, `canmv_delete_file`, `canmv_rmdir` | Inspect, edit, create, download, execute, install startup files, and remove files on the board. |
| Host artifact saving | `canmv_save_base64_to_host`, `canmv_save_latest_frame_to_host`, `canmv_download_file_to_host` | Save preview images, remote board files, or base64 tool results to the filesystem where the MCP server is running. |
| Examples context | `canmv_examples_list`, `canmv_examples_search`, `canmv_examples_read` | Find and read cached official examples so generated scripts follow working CanMV patterns. |
| API stubs context | `canmv_stubs_list`, `canmv_stubs_search`, `canmv_stubs_read` | Find and read MicroPython `.pyi` definitions so generated scripts use accurate APIs and signatures. |
| MCP resources | `resources/list`, `resources/read` | Expose cached example and stub files as MCP resources for clients that prefer resource browsing over tool calls. |
| MCP prompts | `prompts/list`, `prompts/get` | Provide canned workflows for generating scripts, debugging errors, and iterating with preview frames. |

For best script generation, the MCP server instructs AI clients to call `canmv_resource_summary`, search/read relevant examples, and search/read relevant stubs before writing, saving, or running generated MicroPython code. This grounding step helps avoid scripts that use incorrect imports, outdated APIs, or signatures that do not match the connected CanMV firmware.

## Commands

| Command | Description |
| --- | --- |
| `CanMV: Connect Board` | Connect to a CanMV K230 board. |
| `CanMV: Disconnect Board` | Disconnect from the current board. |
| `CanMV: Run Active Python Script` | Run the active Python editor on the board. |
| `CanMV: Stop Script` | Stop the running script. |
| `CanMV: Enable Preview` | Enable/open live frame preview. |
| `CanMV: Disable Preview` | Stop live frame preview and keep it manually disabled. |
| `CanMV: Run Remote File` | Run a Python file selected in the Device tree. |
| `CanMV: Open Tool` | Pick and open a CanMV tool. |
| `CanMV: Threshold Editor` | Open the Threshold Editor tool. |
| `CanMV: Refresh Explorer` | Refresh the Device tree. |
| `CanMV: Run Active File on K230` | Run the active editor through the K230 workflow. |
| `CanMV: Save as main.py` | Save the active editor to `/sdcard/main.py`. |
| `CanMV: Save as boot.py` | Save the active editor to `/sdcard/boot.py`. |
| `CanMV: New File` | Create a file in the selected remote directory. |
| `CanMV: New Folder` | Create a folder in the selected remote directory. |
| `CanMV: Upload Files...` | Upload one or more local files to the selected remote directory. |
| `CanMV: Upload Folder...` | Upload a local folder to the selected remote directory. |
| `CanMV: Download...` | Download the selected remote file or folder. |
| `CanMV: Rename` | Rename the selected remote item. |
| `CanMV: Delete` | Delete the selected remote item. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `canmv.serialPath` | `""` | Serial device path. Leave empty to auto-detect supported CanMV boards by USB VID/PID `1209:abd1`. |
| `canmv.baudRate` | `12000000` | Serial baud rate used when `canmv.serialPath` is set manually. |
| `canmv.backendPath` | `""` | Path to a custom `canmv-backend` executable. Leave empty to use the bundled backend. |
| `canmv.autoReconnect` | `true` | Automatically reconnect after an unexpected disconnect. |
| `canmv.stubsAutoDownload` | `true` | Automatically download K230 MicroPython stubs when needed. |

The backend path can also be overridden with the `CANMV_BACKEND_PATH` environment variable.

## Python Stubs

The extension configures Pylance stubs for K230 MicroPython APIs. On activation it reuses the last cached stubs revision, then the newest local cache, and finally downloads the latest revision when `canmv.stubsAutoDownload` is enabled. After a board connects, it attempts to switch to stubs matching the connected board revision.

Stubs are cached under:

```text
~/.kendryte/k230_canmv_stubs/<revision>
```

The extension writes `python.analysis.stubPath` to the workspace when possible, with global settings as a fallback.

## Backend

The extension talks to the board through a bundled native Go backend:

```text
extension/bin/<platform>/canmv-backend
extension/bin/<platform>/canmv-backend.exe
```

Supported package targets are:

- `linux-x64`
- `linux-arm64`
- `win32-x64`
- `win32-arm64`
- `darwin-x64`
- `darwin-arm64`

For local troubleshooting, build a backend from `native/go` and set `canmv.backendPath` or `CANMV_BACKEND_PATH` to the resulting executable.

## Development

Install dependencies and compile the extension:

```bash
cd extension
npm install
npm run compile
```

Build and stage the backend for the current platform:

```bash
./scripts/stage-current-backend.sh
```

Package a VSIX with all supported backend binaries:

```bash
./scripts/package.sh
```

You can also package from the extension directory after compiling and staging a backend:

```bash
cd extension
npm run package:vsix
```

## Troubleshooting

- Board is not detected: check board power, USB data cable, permissions, and `canmv.serialPath`.
- Backend executable is missing: build/stage the backend or set `canmv.backendPath`.
- Script output is missing: open the `CanMV Terminal` panel and the `CanMV` Output channel.
- Preview is empty: make sure the running script publishes IDE framebuffer data.
- Preview stops updating: disable and re-enable Preview, or stop and restart the script.
- Remote file edits are not syncing: save the mirrored local file and check the `CanMV` Output channel for transfer errors.
- Python completions are missing: confirm Pylance is installed, reload Visual Studio Code after stubs are configured, and check `python.analysis.stubPath`.
- File operations fail: refresh the Device tree and inspect the `CanMV` Output channel.

## Repository

- Issues: <https://github.com/kendryte/canmv-vscode-extension/issues>
- Source: <https://github.com/kendryte/canmv-vscode-extension>
