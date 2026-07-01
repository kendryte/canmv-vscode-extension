# CanMV for Visual Studio Code

> 语言：[English](https://github.com/kendryte/canmv-vscode-extension/blob/main/extension/README.md) | **中文**

CanMV for Visual Studio Code 扩展将 CanMV K230 开发板集成到 Visual Studio Code 中。它通过内置的原生后端连接开发板，运行 MicroPython 脚本，传输摄像头画面，管理设备文件，并提供集成的开发板终端。

![CanMV for Visual Studio Code 演示](https://raw.githubusercontent.com/kendryte/canmv-vscode-extension/main/extension/resources/demo.gif)

[![YouTube 教程](https://img.shields.io/badge/YouTube-Tutorial-red?style=for-the-badge&logo=youtube&logoColor=white)](https://www.youtube.com/watch?v=E-uumNsHLZc) [![Bilibili 教程](https://img.shields.io/badge/Bilibili-教程-blue?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1q27q67EEV)

## 功能特性

- 通过 CanMV 活动栏或命令面板连接和断开 CanMV K230 开发板。
- 通过 USB VID/PID `1209:abd1` 自动检测支持的开发板，并可在需要时手动指定串口路径。
- 通过后端能力协商支持传统版和 v2 版板级协议。
- 在开发板上运行当前 Python 文件、停止正在运行的脚本，或直接从设备树运行 Python 文件。
- 预览实时 IDE 帧缓冲图像，支持适应/原始尺寸模式、旋转、PNG 截图、像素 RGB 拾取、ROI 直方图采样、视频录制、FPS 显示，以及 RGB/灰度/LAB/YUV 直方图和悬停数值读取。
- 使用阈值编辑器调整灰度和 LAB 阈值，包括图像文件加载、帧缓冲捕获、元组复制和选中元组应用。
- 当连接的固件支持虚拟触控时，从预览窗口发送虚拟触控点击。
- 浏览已挂载的设备存储，包括 `/sdcard`、`/data` 和 `/udisk`。
- 创建、重命名、删除、上传、下载、打开、编辑和自动同步远程文件。
- 将当前编辑器内容直接保存为 `/sdcard/main.py` 或 `/sdcard/boot.py`。
- 使用 CanMV 终端面板查看开发板输出、REPL 输入、Ctrl-C 脚本中断、日志清除和日志导出。
- 浏览已下载的 CanMV 官方示例，以可编辑的未保存缓冲区打开示例，在磁盘中显示示例位置，并在开发板上运行 Python 示例。
- 为兼容的 VS Code AI 客户端提供 CanMV MCP 服务器，包括开发板检测、连接、脚本、终端、远程文件系统、示例和 stubs 工具。
- 通过完整的 commit-hash 清单解析固件资源，然后为 Pylance 配置匹配的 K230 MicroPython stubs 并下载匹配的示例。
- 在 `CanMV` 输出通道中查看扩展、后端、stubs、预览和传输日志。

## 系统要求

- Visual Studio Code `1.90.0` 或更高版本。
- 通过 USB 连接的 CanMV K230 开发板。
- Pylance 将作为扩展依赖自动安装以支持 Python 分析。
- 如需从源码开发，请安装 Node.js/npm 和 Go。

## 快速开始

1. 通过 USB 连接 CanMV K230 开发板。
2. 打开命令面板，运行 `CanMV: Connect Board`（连接开发板）。
3. 打开一个 Python 文件。
4. 通过命令面板、编辑器运行按钮或编辑器上下文菜单运行 `CanMV: Run Active Python Script`（运行当前 Python 脚本）。
5. 使用 CanMV 活动栏视图查看开发板状态、工具和设备文件。
6. 打开示例视图浏览已下载的示例，或打开 `CanMV Terminal` 面板查看输出并在无脚本运行时输入 REPL 命令。

## 主要视图

| 视图 | 位置 | 用途 |
| --- | --- | --- |
| Controls（控制） | CanMV 活动栏 | 显示连接状态、开发板状态和脚本状态。 |
| Toolbox（工具箱） | CanMV 活动栏 | 打开扩展工具，如预览和阈值编辑器。 |
| Device（设备） | CanMV 活动栏 | 浏览和管理已连接开发板上的文件。 |
| Examples（示例） | CanMV 活动栏 | 浏览为当前固件资源下载的本地缓存官方示例和模型。 |
| CanMV Terminal（终端） | 面板 | 显示开发板输出，并在可用时接受 REPL 输入。 |

## 常见工作流程

### 连接开发板

运行 `CanMV: Connect Board`。扩展将启动后端，检测开发板，执行板级握手，更新状态栏，刷新设备树，并在可能时配置与固件匹配的资源。

在激活时，扩展会解析 `firmware/latest` 并使用该固件清单选择默认的 stubs 和示例。开发板连接后，扩展会解析 `firmware/<完整commit-hash>/manifest.json` 并切换到与连接固件匹配的资源。如果找不到精确匹配的清单，扩展将回退到最新的清单，然后回退到可用的本地缓存。

如果自动检测未找到开发板，可将 `canmv.serialPath` 设置为串口设备路径，例如 `/dev/ttyACM0`。当设置了 `canmv.serialPath` 时，将使用 `canmv.baudRate` 进行连接。

### 运行脚本

打开一个 Python 文件并运行 `CanMV: Run Active Python Script`。脚本运行期间，终端会同步显示脚本输出，运行按钮会变为停止按钮。使用 `CanMV: Stop Script` 或在 CanMV 终端中按 Ctrl-C 来中断脚本。

编辑器上下文菜单中也包含 `CanMV: Run Active File on K230`。对于远程或镜像文件，这将保存/同步文件并运行远程路径。对于普通本地文件，它将直接将当前编辑器内容发送到开发板。

### 预览摄像头画面

从工具箱打开 `Preview` 或运行 `CanMV: Enable Preview`。当运行的脚本发布 IDE 帧缓冲数据时，预览将在工具标签页中传输 JPEG 帧。

预览工具支持：

- 适应窗口和原始尺寸查看。
- 90 度旋转。
- 将当前帧保存为 PNG。
- 从当前帧拾取 RGB 像素值。
- FPS 和帧数显示。
- RGB、灰度、LAB 和 YUV 直方图。
- 选择 ROI 矩形区域，仅从该图像区域计算直方图。
- 直方图悬停读取，用于查看各柱的值。
- 将预览帧录制为视频。当 VS Code webview 运行时支持 MP4 编码时保存为 MP4，否则回退为 WebM。
- 当开发板固件支持时，转发虚拟触控点击。

当预览工具已打开且未手动禁用预览时，脚本开始运行后预览将自动启动。

### 调整阈值

从工具箱打开 `Threshold Editor` 或运行 `CanMV: Threshold Editor`。编辑器可以加载本地图像文件或获取当前的帧缓冲/预览画布图像，然后预览灰度或 LAB 阈值结果。

您可以复制生成的元组，或选择当前编辑器中已有的灰度/LAB 元组并直接应用新值。

### 管理设备文件

连接后在设备视图中操作。目录可以展开，文件可以从树中打开。右键单击目录或挂载根目录可创建文件/文件夹、上传文件或上传文件夹。右键单击文件或文件夹可下载、重命名或删除它们。

从设备树打开的 Python 文件会被镜像到扩展管理的临时文件夹中（位于当前工作区之外）。保存镜像文件会自动将其同步回开发板。扩展还会更新 `python.analysis.extraPaths`，以便 Pylance 能够解析镜像中的导入。

### 浏览示例

在 CanMV 活动栏中打开示例视图。扩展会从用于 stubs 的同一固件清单下载示例并将其存储在本地。该视图显示当前活动的缓存示例包，包括 `examples/` 和 `models/` 目录内容（如存在）。

打开示例会创建一个可编辑的未保存编辑器。这使您可以自由实验，同时保持下载的缓存不变；使用"另存为"将副本写入工作区。Python 示例文件也可以从示例树中直接在连接的开发板上运行。

示例缓存位置：

```text
~/.kendryte/k230_canmv_examples/<examples-id>
```

使用 `CanMV: Refresh Examples` 解析最新的固件资源并在需要时下载示例。使用 `CanMV: Reveal Examples` 在操作系统文件管理器中打开当前活动的示例缓存。

### 保存启动文件

连接开发板后，使用编辑器上下文菜单：

- `CanMV: Save as main.py` 将当前编辑器内容写入 `/sdcard/main.py`。
- `CanMV: Save as boot.py` 将当前编辑器内容写入 `/sdcard/boot.py`。

### 使用终端

CanMV 终端面板保留最近的滚动历史，同步显示开发板/脚本输出，并在开发板已连接且无脚本运行时接受 REPL 输入。脚本运行期间终端输入被禁用，但 Ctrl-C 除外（用于请求停止脚本）。终端 webview 还支持清除输出和保存日志。

### 使用 MCP 工具

该扩展向 VS Code 提供了一个 `CanMV MCP Server` 定义。兼容的 MCP 客户端可以发现用于能力分析、开发板检测/连接、脚本执行、预览帧、虚拟触控、终端输入/输出、远程文件系统操作、主机端文件保存以及对缓存的 CanMV 示例和 MicroPython stubs 的只读访问等工具。

MCP 服务器作为独立的 stdio Node 进程运行，使用与扩展相同的捆绑后端。它通过扩展传递的环境变量来遵循 `canmv.backendPath`、`canmv.serialPath` 和 `canmv.baudRate` 设置。示例和 stubs 工具读取 `~/.kendryte/k230_canmv_examples` 和 `~/.kendryte/k230_canmv_stubs` 下的本地缓存，因此如果这些缓存为空，请先刷新或连接一次。

面向开发板的 MCP 工具在需要硬件访问时会自动连接，并为相关的后续调用（如运行脚本、启动预览和读取帧）保持开发板会话。服务器在调用 `canmv_disconnect_board`、MCP 客户端退出或空闲超时后断开连接。设置 `CANMV_MCP_IDLE_DISCONNECT_MS` 可调整超时时间，默认为 120000 毫秒。

当 AI 工作流需要在主机上保存图像或下载的文件时，建议使用主机保存工具，而不是要求 MCP 客户端解码 base64 文本。`canmv_save_latest_frame_to_host` 直接保存当前预览 JPEG，`canmv_download_file_to_host` 将远程开发板文件复制到主机，`canmv_save_base64_to_host` 解码另一个工具返回的 base64 数据。相对输出路径在设置了 `CANMV_MCP_OUTPUT_DIR` 时写入该目录，否则默认写入临时的 `canmv-mcp` 输出目录。

MCP 功能包括：

| 功能 | 工具 | 用途 |
| --- | --- | --- |
| 扩展和开发板分析 | `canmv_analyze_capabilities`、`canmv_resource_summary`、`canmv_resource_route_info`、`canmv_board_info`、`canmv_board_capabilities`、`canmv_firmware_info` | 让 AI 客户端查看可用的 CanMV 功能、固件/资源缓存状态、本地脚本资源以及已连接开发板的状态。 |
| 开发板连接 | `canmv_detect_boards`、`canmv_connect_board`、`canmv_disconnect_board` | 从 AI 工作流中检测和管理开发板会话。 |
| 脚本执行 | `canmv_run_script`、`canmv_write_and_run_script`、`canmv_stop_script`、`canmv_script_running` | 生成、写入、运行、停止和检查 MicroPython 脚本，同时收集终端输出。 |
| 预览和视觉反馈 | `canmv_start_preview`、`canmv_get_latest_frame`、`canmv_save_latest_frame_to_host`、`canmv_stop_preview` | 启动帧缓冲传输，以 base64 格式返回最新的 JPEG 帧，或直接将其保存到 MCP 主机。 |
| 虚拟触控 | `canmv_virtual_touch_status`、`canmv_virtual_touch_tap` | 查询并向支持的运行中脚本发送虚拟触控点击。 |
| 终端访问 | `canmv_terminal_input`、`canmv_terminal_output` | 发送 REPL 输入并读取缓冲的开发板/脚本输出。 |
| 远程文件系统 | `canmv_list_dir`、`canmv_stat_file`、`canmv_read_file`、`canmv_download_file_to_host`、`canmv_write_file`、`canmv_execute_file`、`canmv_save_main_py`、`canmv_save_boot_py`、`canmv_mkdir`、`canmv_rename`、`canmv_delete_file`、`canmv_rmdir` | 检查、编辑、创建、下载、执行、安装启动文件以及删除开发板上的文件。 |
| 主机文件保存 | `canmv_save_base64_to_host`、`canmv_save_latest_frame_to_host`、`canmv_download_file_to_host` | 将预览图像、远程开发板文件或 base64 工具结果保存到 MCP 服务器运行的文件系统中。 |
| 示例上下文 | `canmv_examples_list`、`canmv_examples_search`、`canmv_examples_read` | 查找和读取缓存的官方示例，使生成的脚本遵循经过验证的 CanMV 模式。 |
| API Stubs 上下文 | `canmv_stubs_list`、`canmv_stubs_search`、`canmv_stubs_read` | 查找和读取 MicroPython `.pyi` 定义，使生成的脚本使用准确的 API 和签名。 |
| MCP 资源 | `resources/list`、`resources/read` | 将缓存的示例和 stubs 文件作为 MCP 资源暴露，供倾向于资源浏览而非工具调用的客户端使用。 |
| MCP 提示词 | `prompts/list`、`prompts/get` | 提供用于生成脚本、调试错误和使用预览帧迭代的预设工作流。 |

为获得最佳脚本生成效果，MCP 服务器指示 AI 客户端在编写、保存或运行生成的 MicroPython 代码之前，先调用 `canmv_resource_summary`，搜索/读取相关示例，并搜索/读取相关 stubs。这一基础步骤有助于避免生成的脚本使用错误的导入、过时的 API 或与当前 CanMV 固件不匹配的签名。

## 命令

| 命令 | 描述 |
| --- | --- |
| `CanMV: Connect Board` | 连接 CanMV K230 开发板。 |
| `CanMV: Disconnect Board` | 断开当前开发板连接。 |
| `CanMV: Run Active Python Script` | 在开发板上运行当前 Python 编辑器中的脚本。 |
| `CanMV: Stop Script` | 停止正在运行的脚本。 |
| `CanMV: Enable Preview` | 启用/打开实时帧预览。 |
| `CanMV: Disable Preview` | 停止实时帧预览并保持手动禁用状态。 |
| `CanMV: Run Remote File` | 运行设备树中选中的 Python 文件。 |
| `CanMV: Run Example File` | 运行示例树中选中的 Python 文件。 |
| `CanMV: Open Tool` | 选择并打开一个 CanMV 工具。 |
| `CanMV: Threshold Editor` | 打开阈值编辑器工具。 |
| `CanMV: Refresh Explorer` | 刷新设备树。 |
| `CanMV: Refresh Examples` | 解析并刷新缓存的示例。 |
| `CanMV: Reveal Examples` | 在操作系统文件管理器中打开示例缓存。 |
| `CanMV: Open Example File` | 以可编辑的未保存缓冲区打开缓存的示例。 |
| `CanMV: Run Active File on K230` | 通过 K230 工作流运行当前编辑器文件。 |
| `CanMV: Save as main.py` | 将当前编辑器内容保存到 `/sdcard/main.py`。 |
| `CanMV: Save as boot.py` | 将当前编辑器内容保存到 `/sdcard/boot.py`。 |
| `CanMV: New File` | 在选中的远程目录中创建文件。 |
| `CanMV: New Folder` | 在选中的远程目录中创建文件夹。 |
| `CanMV: Upload Files...` | 上传一个或多个本地文件到选中的远程目录。 |
| `CanMV: Upload Folder...` | 上传一个本地文件夹到选中的远程目录。 |
| `CanMV: Download...` | 下载选中的远程文件或文件夹。 |
| `CanMV: Rename` | 重命名选中的远程项目。 |
| `CanMV: Delete` | 删除选中的远程项目。 |

## 设置

| 设置 | 默认值 | 描述 |
| --- | --- | --- |
| `canmv.serialPath` | `""` | 串口设备路径。留空则通过 USB VID/PID `1209:abd1` 自动检测支持的 CanMV 开发板。 |
| `canmv.baudRate` | `12000000` | 手动设置 `canmv.serialPath` 时使用的串口波特率。 |
| `canmv.backendPath` | `""` | 自定义 `canmv-backend` 可执行文件的路径。留空则使用内置后端。 |
| `canmv.autoReconnect` | `true` | 意外断开后自动重新连接。 |
| `canmv.stubsAutoDownload` | `true` | 需要时自动下载 K230 MicroPython stubs 和示例。 |

后端路径也可以通过 `CANMV_BACKEND_PATH` 环境变量覆盖。

## 固件资源、示例和 Python Stubs

扩展通过发布在以下地址的固件清单来解析 stubs 和示例：

```text
https://download.kendryte.com/developer/tools/canmv_vscode_extension/
```

资源路由从固件清单开始：

```text
firmware/latest
firmware/<40位完整commit-hash>/manifest.json
```

清单指向匹配的 stubs 压缩包和示例压缩包。Stubs 使用完整的固件 commit hash，以便 Pylance 精确匹配已连接的固件。示例使用内容哈希 ID，因为示例不会随每次固件构建而改变。

固件路由元数据缓存位置：

```text
~/.kendryte/k230_canmv_resources/firmware/latest
~/.kendryte/k230_canmv_resources/firmware/<revision>/manifest.json
```

Stubs 缓存位置：

```text
~/.kendryte/k230_canmv_stubs/<revision>
```

示例缓存位置：

```text
~/.kendryte/k230_canmv_examples/<examples-id>
```

在激活时，扩展会解析最新的固件资源，在可用时复用本地缓存，并在 `canmv.stubsAutoDownload` 启用时下载缺失的 stubs/示例。开发板连接后，当开发板报告完整的固件 commit hash 时，扩展会切换到精确的固件路由。

扩展会配置由自身管理的 `python.analysis.stubPath` overlay，让 CanMV MicroPython stubs 优先于同名的主机 Python 模块。已有的用户 stub 根目录会尽量合并到该 overlay 中，同时仍会为当前 stubs 缓存和镜像的开发板文件更新 `python.analysis.extraPaths`。

## 后端

扩展通过内置的原生 Go 后端与开发板通信：

```text
extension/bin/<platform>/canmv-backend
extension/bin/<platform>/canmv-backend.exe
```

支持的打包目标平台：

- `linux-x64`
- `linux-arm64`
- `win32-x64`
- `win32-arm64`
- `darwin-x64`
- `darwin-arm64`

如需本地调试，可从 `native/go` 构建后端，并将 `canmv.backendPath` 或 `CANMV_BACKEND_PATH` 设置为生成的可执行文件。

## 开发

安装依赖并编译扩展：

```bash
cd extension
npm install
npm run compile
```

为当前平台构建并部署后端：

```bash
./scripts/stage-current-backend.sh
```

打包包含所有支持平台后端二进制文件的 VSIX：

```bash
./scripts/package.sh
```

编译并部署后端后，也可以从扩展目录打包：

```bash
cd extension
npm run package:vsix
```

## 常见问题排查

- 开发板未被检测到：检查开发板电源、USB 数据线、权限以及 `canmv.serialPath` 设置。
- 后端可执行文件缺失：构建/部署后端或设置 `canmv.backendPath`。
- 脚本输出缺失：打开 `CanMV Terminal` 面板和 `CanMV` 输出通道。
- 预览画面为空：确保运行中的脚本发布了 IDE 帧缓冲数据。
- 预览停止更新：禁用并重新启用预览，或停止并重新启动脚本。
- 远程文件编辑未同步：保存镜像后的本地文件，并检查 `CanMV` 输出通道中的传输错误。
- 示例缺失：运行 `CanMV: Refresh Examples`，在启用自动下载的情况下连接一次，并检查 `CanMV` 输出通道中的资源下载错误。
- Python 补全缺失：确认 Pylance 已安装，配置 stubs 后重新加载 Visual Studio Code，并检查 `python.analysis.stubPath` 和 `python.analysis.extraPaths`。
- 文件操作失败：刷新设备树并查看 `CanMV` 输出通道。

## 仓库

- 问题反馈：<https://github.com/kendryte/canmv-vscode-extension/issues>
- 源代码：<https://github.com/kendryte/canmv-vscode-extension>
