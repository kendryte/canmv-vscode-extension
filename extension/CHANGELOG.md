# Changelog

## 0.4.2

- Implemented stream resynchronization in native board communication layer for improved connection stability
- Added tests for Sync functionality

## 0.4.1

- Added YouTube and Bilibili tutorial links to README
- Enhanced terminal buffer management and rendering in webview

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
