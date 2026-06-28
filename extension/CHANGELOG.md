# Changelog

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
