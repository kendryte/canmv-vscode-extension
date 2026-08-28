# Changelog

## 0.9.10

- Reused the active authenticated extension bridge connection across MCP HTTP requests instead of opening and abandoning a socket for each request
- Prevented concurrent bridge retries from treating a connecting socket as authenticated and sending requests before the bridge handshake completed

## 0.9.9

- Added `CanMV: Show MCP Configuration for Other Agents` to open ephemeral JSON and TOML connection settings without writing credential-bearing setup files
- Applied baud-rate and startup-script minification changes by restarting the shared MCP service, republishing its VS Code definition, and refreshing managed client registrations
- Added supervised MCP service recovery that clears stale endpoints, restarts after unexpected exits, and re-registers replacement endpoints with external clients
- Verified Claude Code registrations after writing them and used a token-derived credential fingerprint to detect stale bearer authentication even when the CLI redacts header values
- Replaced native and WSL Codex configuration files atomically while preserving symlinks and validating the saved content
- Reset active and starting WSL relays when their upstream endpoint or selected client host changes
- Improved Windows MCP client registration by preferring native executables and launching command shims through PowerShell
- Added actionable process errors for automatic Codex or Claude Code registration failures without generating manual setup artifacts
- Verified Codex registrations after writing them, reported the active config path, and suppressed redundant VS Code reload prompts after automatic registration
- Preserved an explicit Codex `enabled = false` choice when refreshing the extension-managed MCP endpoint
- Replaced the per-client MCP stdio process with one extension-owned, bearer-authenticated Streamable HTTP service shared by VS Code, Codex, and Claude Code
- Added an authenticated WSL-local Streamable HTTP relay with a relay-native end-to-end self-test, so WSL Codex or Claude Code clients do not depend on Windows inbound networking, shell HTTP tools, firewall, VPN, NAT, or mirrored-network behavior
- Reused a saved relay port per WSL distribution, with dynamic fallback on conflicts, to avoid rewriting Codex configuration on every activation
- Kept explicitly selected WSL Codex registration on its actual host and routed config updates through direct, non-login `wsl.exe` commands, avoiding false native success, shell startup interference, and blocked `\\wsl.localhost` file access
- Restricted both the Windows MCP service and each WSL relay to loopback interfaces, with only `/health` and `/mcp` forwarded through private framed extension IPC

## 0.9.8

- Required the corresponding Codex or Claude Code VS Code extension before configuring its CanMV MCP registration
- Added an actionable error that opens both supported extensions when neither MCP client extension is installed

## 0.9.7

- Added automatic user-scope MCP registration for Codex and Claude Code, with managed-entry protection, configuration refresh, and a manual setup command
- Added an authenticated local bridge so MCP operations share the extension's board session and keep connection, script, terminal, preview, and explorer state synchronized
- Preserved standalone MCP fallback when the VS Code extension bridge is unavailable

## 0.9.6

- Added automatic user-scope MCP registration for installed Codex and Claude Code clients, with an opt-out setting and manual refresh command
- Routed MCP board operations through an authenticated local extension bridge so connection, script, terminal, preview, and explorer state stay synchronized with the CanMV UI
- Added capability-negotiated recursive remote directory deletion across the explorer, filesystem provider, MCP server, Go backend, and K230 firmware
- Added the `RMDIR_RECURSIVE` USB debug command and `rmdirRecursive` capability while retaining ordinary empty-directory removal for backward compatibility
- Added protected-root checks and depth-first directory removal in firmware, without following symlinks
- Improved deletion errors so older firmware clearly reports when recursive folder deletion requires a firmware update

## 0.9.5

- Improved Windows large-file downloads by separating bounded USB CDC receives from protocol frame assembly
- Added idle-aware continuation reads so split file payloads and synchronization markers survive transient empty serial reads
- Added automatic stream resynchronization and one-time retry for malformed or incomplete file-read responses
- Rejected invalid file payload lengths without draining untrusted frame sizes, preventing stale data from corrupting later commands
- Expanded USB debug tests for split payloads, final-byte delivery, malformed-frame recovery, and transient synchronization gaps

## 0.9.4

- Improved large-file upload reliability by retrying transient zero-byte serial writes before treating the transport as stalled
- Fixed connection-state reporting after an unrecoverable file-upload transport failure so VS Code receives a board-disconnected event
- Expanded serial-write tests to cover temporary zero-byte writes

## 0.9.3

- Added reliable streamed file uploads with 8 KiB write chunks for compatibility with legacy CanMV CDC receive buffers
- Added 32 KiB remote file reads and extended final file verification timeouts for large-device-storage writes
- Added determinate byte-level progress for single-file, multi-file, and recursive folder uploads and downloads, including scanning, hashing, and verification phases
- Improved file-operation serialization, transfer cleanup, protocol recovery, connection handling, and diagnostics for interrupted or timed-out operations
- Expanded backend, board protocol, and transfer tests for chunk sizing, verification timeouts, and long-running file operations

## 0.9.2

- Added startup-script minification for `/sdcard/main.py` and `/sdcard/boot.py`, removing comments, standalone triple-quoted comment blocks, blank lines, and trailing whitespace while preserving string values and Python indentation
- Added the `canmv.autoMinifyStartupScripts` setting so startup-script minification can be disabled when source preservation is required
- Added paged remote directory listing to keep large device trees complete and resumable
- Improved script and busy-state handling across IDE runs, REPL workflows, preview, and MCP operations
- Improved board detection and connection error handling, backend shutdown behavior, and MCP file operations
- Expanded backend and protocol tests for script state, directory pagination, and board capability handling

## 0.9.1

- Fixed large remote file downloads by reading files in bounded chunks instead of one timeout-prone response
- Preserved the expanded remote file tree while scripts start or stop instead of temporarily hiding and rebuilding it

## 0.9.0

- Improved ZIP extraction verification for nested stub files across supported platforms
- Added recursive stub cache validation and staged cache replacement to prevent incomplete downloads from becoming active
- Reworked the Pylance stub overlay to use verified file and directory copies instead of symlinks or junctions
- Added overlay versioning and signatures so stale or incomplete Pylance stub paths are rebuilt automatically
- Improved Pylance availability, configuration failure, download progress, and reload notifications
- Prevented repeated reload prompts for an unchanged Pylance stubs configuration

## 0.8.0

- Added Chinese README for CanMV extension users
- Enhanced framebuffer preview and examples management documentation
- Enhanced Pylance configuration with extension-managed stub overlays while preserving user-managed paths
- Added script exception detection with user-friendly notifications and terminal reveal support
- Improved terminal input and script output processing for smoother repeated script start/stop workflows

## 0.7.0

- Added CanMV MCP server: standalone stdio server exposing board detection, connection, script execution, terminal I/O, remote filesystem operations, preview frame capture, virtual touch, startup-file helpers, firmware/resource diagnostics, cached examples and stubs context, and host-side file saving tools for compatible VS Code AI clients
- Added MCP server auto-disconnect on idle timeout and graceful board disconnect on MCP shutdown
- Added CanmvResourceService for managing default resources, examples, and board-specific resource resolution
- Added ExamplesService with local caching and auto-download of CanMV examples
- Added ResourceRouteService for firmware revision resolution and CDN manifest-based resource fetching
- Refactored StubsService to use ResourceRouteService for board-revision-matched stub downloads
- Enhanced script execution to support running scripts directly from the active editor
- Enhanced Examples tree provider with improved caching and download progress
- Improved backend firmware version parsing with unit tests for version handling
- Updated README with MCP tools documentation and localized MCP provider labels

## 0.6.0

- Added video recording functionality with UI controls for capturing and managing recordings from the device
- Fixed stubsBaseUrl to correct download link for MicroPython stubs

## 0.5.0

- Added `writeFull` for reliable serial writes that retry until all bytes are flushed
- Improved device communication: normalized port names and enhanced build info management
- Improved connection reliability: ensure DTR transition on Open for consistent device handshakes
- Improved stream stability: desynchronization recovery in preview and polling loops, plus resynchronization in the native board communication layer
- Added YouTube and Bilibili tutorial links to README
- Enhanced terminal buffer management and rendering in webview
- Added tests for Sync functionality

## 0.4.0

- Added Python stubs system: automatic download of K230 MicroPython stubs for Pylance code completion, with board firmware revision matching and local caching
- Added Controls view in the activity bar with board connection status, state indicator, and quick actions
- Added Toolbox view with tool launcher (Preview, Threshold Editor)
- Added Device tree context menu commands: Run on K230, Save as main.py, Save as boot.py
- Added file upload/download support with transfer progress and recursive directory operations
- Added remote file execution (`fileExec`) support
- Improved remote file mirroring: isolated per-workspace mirror directories under a system temp folder, with automatic Pylance import path injection for cross-file references
- Improved board connection state management: readiness tracking, busy gates, post-script pause window to prevent operations during board transitions
- Improved file read caching with size/mtime staleness detection and incomplete read detection
- Improved script execution: Run Script now works from any focused webview by tracking the last active Python editor
- Improved localization: comprehensive Simplified Chinese translations for all commands, views, error messages, and webview strings
- Fixed Pylance settings being overwritten when configuring extra paths and stub paths
- Fixed remote file mirror path collisions by normalizing path keys
- Fixed boot.py save path to target `/sdcard/boot.py`
- Rewrote extension README with features, quick start, workflows, commands reference, settings table, and troubleshooting guide

## 0.3.0

- Added localization support for extension commands, views, webviews, and user-facing messages, including Simplified Chinese strings.
- Improved remote mirror directory management and Pylance configuration handling for device files and stubs.
- Improved preview framebuffer recovery by tuning the stale-frame threshold.

## 0.2.0

- Added legacy and v2 board protocol support.
- Improved backend capability negotiation and protocol-aware board operations.
- Added the Threshold Editor for grayscale and LAB threshold tuning.
- Added Frame Buffer/image loading, tuple copy, and selected tuple apply support in the Threshold Editor.
- Added histogram hover readouts in the preview panel.

## 0.1.0

- Initial CanMV K230 Visual Studio Code integration.
- Added native Go backend packaging path.
- Added board detection, script execution, file operations, preview, and terminal support.
