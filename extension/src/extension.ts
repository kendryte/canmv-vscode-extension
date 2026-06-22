import * as path from 'path';
import * as vscode from 'vscode';
import { NativeBackend } from './backend/native';
import { Session } from './session/session';
import { PreviewPanel } from './webview/PreviewPanel';
import { TerminalViewProvider } from './webview/TerminalViewProvider';
import { BoardService, type BoardInfo } from './service/boardService';
import { ScriptService } from './service/scriptService';
import { VideoService } from './service/videoService';
import { FileService } from './service/fileService';
import { StubsService } from './service/stubsService';
import { RemoteMirrorService } from './service/remoteMirrorService';
import { CanmvExplorer } from './explorer/treeProvider';
import { FileTreeItem } from './explorer/fileItem';
import { BoardDetector } from './backend/detector';
import { CanmvFileSystemProvider } from './filesystem/provider';
import { ToolRegistry, ToolHost } from './webview/ToolHost';
import { CanmvControlViewProvider } from './webview/CanmvControlViewProvider';
import { ToolboxTreeProvider } from './webview/ToolboxTreeProvider';
import { Methods, createRequest } from './protocol/methods';
import { isResponse } from './protocol/types';
import { logDebug, logError, logInfo, logWarn } from './output';

let disposables: vscode.Disposable[] = [];
let previewPanel: PreviewPanel | undefined;
let terminalViewProvider: TerminalViewProvider | undefined;
let backend: NativeBackend | undefined;
let stubsService: StubsService | undefined;

type VirtualTouchState = {
  supported: boolean;
  enabled: boolean;
  range?: { w: number; h: number };
  queueDepth?: number;
};

const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
statusItem.text = '$(debug-disconnect) CanMV';
statusItem.tooltip = 'Disconnected';

export function activate(context: vscode.ExtensionContext) {
  logActivationInfo(context);

  backend = new NativeBackend(context);
  const session = new Session(backend, {
    autoReconnect: vscode.workspace.getConfiguration('canmv').get('autoReconnect', true),
    requestTimeout: 10000,
  });
  context.subscriptions.push(session);
  stubsService = new StubsService(context);
  void stubsService.ensureDefaultStubs().catch((err) => {
    logError('Stubs', `Default setup error: ${err}`);
  });
  context.subscriptions.push(statusItem);
  statusItem.show();

  const boardService = new BoardService(session, new BoardDetector(session));
  const scriptService = new ScriptService(session);
  const fileService = new FileService(session);
  const remoteMirrorService = new RemoteMirrorService(context, fileService);
  let connected = false;
  let disconnected = true;
  let scriptRunning = false;
  let boardReady = false;
  let controlProvider: CanmvControlViewProvider | undefined;
  let onScriptRunningContextChanged = () => {};
  const boardStatusLabel = (info: BoardInfo) => {
    const board = info.boardName || info.boardType;
    return [board, info.fwVersion, info.memorySize].filter(Boolean).join(' ') || 'CanMV';
  };
  const sidebarStatusText = (state: string) => {
    if (state === 'connecting') return 'Connecting...';
    if (state === 'streaming') return 'Streaming';
    if (state === 'connected') {
      const info = boardService.boardInfo();
      return info ? boardStatusLabel(info) : 'Connected';
    }
    return 'Disconnected';
  };
  const setConnectionContexts = (state: string) => {
    connected = state === 'connected' || state === 'streaming';
    disconnected = state === 'disconnected';
    void vscode.commands.executeCommand('setContext', 'canmv.connected', connected);
    void vscode.commands.executeCommand('setContext', 'canmv.disconnected', disconnected);
    controlProvider?.setState({ connected, statusText: sidebarStatusText(state) });
    updateTerminalInputState();
  };
  const setScriptRunningContext = (value: boolean) => {
    scriptRunning = value;
    void vscode.commands.executeCommand('setContext', 'canmv.scriptRunning', value);
    previewPanel?.sendScriptRunning(value);
    controlProvider?.setState({ scriptRunning: value });
    updateTerminalInputState();
    onScriptRunningContextChanged();
  };
  const boardStatusText = (info: BoardInfo) => {
    return `$(circuit-board) ${boardStatusLabel(info)}`;
  };
  const boardStatusTooltip = (info: BoardInfo) => {
    const board = info.boardName || info.boardType;
    const lines = [
      'CanMV board connected',
      `Board: ${board}`,
      `Firmware: ${info.fwVersion}`,
    ];
    if (info.memorySize) lines.push(`Memory: ${info.memorySize}`);
    if (info.port) lines.push(`Port: ${info.port}`);
    return lines.join('\n');
  };
  const updateBoardStatus = () => {
    const info = boardService.boardInfo();
    if (info) {
      statusItem.text = boardStatusText(info);
      statusItem.tooltip = boardStatusTooltip(info);
      controlProvider?.setState({ statusText: boardStatusLabel(info) });
      return;
    }
    statusItem.text = '$(debug-start) CanMV';
    statusItem.tooltip = 'Connected';
  };
  const updateTerminalInputState = () => {
    const canInput = connected && !scriptRunning;
    const reason = disconnected
      ? 'Connect board to use REPL input'
      : scriptRunning
        ? 'Script is running; press Ctrl-C to stop it'
        : '';
    terminalViewProvider?.setInputEnabled(canInput, reason, connected && scriptRunning);
  };
  setConnectionContexts(session.state);
  setScriptRunningContext(false);

  // Preview is created lazily via ToolHost, not at activation
  let previewManuallyStopped = false;
  let previewPausedForScript = false;
  let previewAutoStartInFlight = false;
  let previewAutoRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let previewAutoRetryCount = 0;
  let previewWatchdogTimer: ReturnType<typeof setInterval> | undefined;
  let previewRecoverInFlight = false;
  let virtualTouchState: VirtualTouchState = { supported: false, enabled: false };
  let virtualTouchRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let virtualTouchRefreshInFlight = false;
  const previewFrameStaleMs = 4000;
  const previewWatchdogIntervalMs = 1500;
  const virtualTouchFrameStaleMs = 3000;
  const virtualTouchRefreshIntervalMs = 2000;
  const terminalScrollback: string[] = [];
  const terminalScrollbackLimit = 128 * 1024;

  const trimTerminalScrollback = () => {
    let total = terminalScrollback.reduce((sum, chunk) => sum + chunk.length, 0);
    while (total > terminalScrollbackLimit && terminalScrollback.length > 0) {
      const removed = terminalScrollback.shift() || '';
      total -= removed.length;
    }
  };

  const appendTerminal = (text: string) => {
    if (!text) return;
    terminalScrollback.push(text);
    trimTerminalScrollback();
    terminalViewProvider?.appendText(text);
  };

  const appendTerminalLine = (text: string) => {
    appendTerminal(`${text}\n`);
  };

  const sendVirtualTouchState = (state = virtualTouchState) => {
    previewPanel?.sendVirtualTouchState(state);
  };

  const setVirtualTouchState = (state: VirtualTouchState) => {
    virtualTouchState = {
      supported: state.supported === true,
      enabled: state.supported === true && state.enabled === true,
      range: state.range,
      queueDepth: state.queueDepth,
    };
    sendVirtualTouchState();
  };

  const clearVirtualTouchState = () => {
    setVirtualTouchState({ supported: false, enabled: false });
  };

  const boardSupportsVirtualTouch = () => {
    return boardService.boardInfo()?.capabilities?.virtualTouch === true;
  };

  const refreshVirtualTouchState = async () => {
    if (virtualTouchRefreshInFlight) {
      return;
    }
    if (!connected || !scriptRunning || session.state !== 'streaming') {
      clearVirtualTouchState();
      return;
    }
    if (!boardSupportsVirtualTouch()) {
      clearVirtualTouchState();
      return;
    }
    const frameAge = videoService?.lastFrameAgeMs();
    if (frameAge === null || frameAge === undefined || frameAge > virtualTouchFrameStaleMs) {
      clearVirtualTouchState();
      return;
    }
    virtualTouchRefreshInFlight = true;
    try {
      const result = await session.request(createRequest(Methods.virtualTouchStatus, {}));
      if (!isResponse(result)) {
        clearVirtualTouchState();
        return;
      }
      if (!connected || !scriptRunning || session.state !== 'streaming' || !boardSupportsVirtualTouch()) {
        clearVirtualTouchState();
        return;
      }
      setVirtualTouchState(result.result as VirtualTouchState);
    } finally {
      virtualTouchRefreshInFlight = false;
    }
  };

  const updateVirtualTouchRefreshTimer = () => {
    const shouldPoll = connected && scriptRunning && session.state === 'streaming' && boardSupportsVirtualTouch() && !!previewPanel && !previewPanel.disposed;
    if (shouldPoll && !virtualTouchRefreshTimer) {
      virtualTouchRefreshTimer = setInterval(() => {
        void refreshVirtualTouchState().catch((err) => {
          logDebug('Touch', `Status refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, virtualTouchRefreshIntervalMs);
    } else if (!shouldPoll && virtualTouchRefreshTimer) {
      clearInterval(virtualTouchRefreshTimer);
      virtualTouchRefreshTimer = undefined;
    }
  };

  const sendVirtualTouchTap = async (tap: { x: number; y: number; sourceWidth: number; sourceHeight: number }) => {
    if (!virtualTouchState.enabled || !connected || !scriptRunning || session.state !== 'streaming') {
      return;
    }
    const frameAge = videoService?.lastFrameAgeMs();
    if (frameAge === null || frameAge === undefined || frameAge > virtualTouchFrameStaleMs) {
      clearVirtualTouchState();
      return;
    }
    const base = {
      x: Math.round(tap.x),
      y: Math.round(tap.y),
      sourceWidth: Math.round(tap.sourceWidth),
      sourceHeight: Math.round(tap.sourceHeight),
      trackId: 1,
      width: 1,
    };
    const down = await session.request(createRequest(Methods.virtualTouchEvent, { ...base, event: 'down' }));
    if (!isResponse(down) || !(down.result as { accepted?: boolean }).accepted) {
      if (boardSupportsVirtualTouch()) {
        await refreshVirtualTouchState();
      }
      return;
    }
    const up = await session.request(createRequest(Methods.virtualTouchEvent, { ...base, event: 'up' }));
    if (!isResponse(up) || !(up.result as { accepted?: boolean }).accepted) {
      if (boardSupportsVirtualTouch()) {
        await refreshVirtualTouchState();
      }
    }
  };

  onScriptRunningContextChanged = () => {
    updatePreviewWatchdog();
    updateVirtualTouchRefreshTimer();
    if (!scriptRunning) {
      clearVirtualTouchState();
    }
  };
  context.subscriptions.push(new vscode.Disposable(() => {
    if (virtualTouchRefreshTimer) {
      clearInterval(virtualTouchRefreshTimer);
      virtualTouchRefreshTimer = undefined;
    }
    clearPreviewWatchdog();
  }));

  // ToolHost + ToolRegistry
  const registry = new ToolRegistry();
  registry.register({
    id: 'preview', name: 'Preview', icon: 'device-camera',
    factory: () => {
      // If we're recreating the panel after it was disposed, clean up old references
      if (previewPanel?.disposed) {
        logInfo('Preview', 'Recreating panel after disposal');
        videoService = undefined;
      }
      previewPanel = new PreviewPanel(context);

      // Cleanup when user closes the preview tab
      previewPanel.onDidDispose(() => {
        logInfo('Preview', 'Panel disposed by VS Code');
        if (videoService) {
          const disposedVideoService = videoService;
          void stopPreviewAfterScript().finally(() => {
            if (videoService === disposedVideoService) {
              videoService = undefined;
            }
            if (previewPanel && !previewPanel.disposed && scriptRunning && !previewManuallyStopped) {
              schedulePreviewAuto(150);
            }
          });
        }
        clearPreviewAutoRetry();
        previewPanel = undefined;
        updateVirtualTouchRefreshTimer();
        clearVirtualTouchState();
      });

      previewPanel.onCommand(async (command) => {
        if (command === 'setPreviewDisabled') {
          await setPreviewDisabledManual(true);
        } else if (command === 'setPreviewEnabled') {
          await setPreviewDisabledManual(false);
        } else if (command === 'stopScript') {
          await vscode.commands.executeCommand('canmv.stopScript');
        } else if (command === 'disconnectBoard') {
          await vscode.commands.executeCommand('canmv.disconnectBoard');
        }
      });
      previewPanel.onSaveImage(async (data) => {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const base = vscode.workspace.workspaceFolders?.[0]?.uri;
        const defaultUri = base ? vscode.Uri.joinPath(base, `canmv-frame-${stamp}.png`) : undefined;
        const target = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { 'PNG Image': ['png'] },
          saveLabel: 'Save Image',
        });
        if (!target) return;
        await vscode.workspace.fs.writeFile(target, data);
        logInfo('Preview', `Saved frame image: ${target.fsPath}`);
      });
      previewPanel.onVirtualTouch((tap) => {
        void sendVirtualTouchTap(tap).catch((err) => {
          logDebug('Touch', `Tap failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      });
      const info = boardService.boardInfo();
      if (info) {
        previewPanel.sendBoardInfo(info);
      }
      // Restore current preview state & connection state
      previewPanel.sendPreviewDisabled(previewManuallyStopped);
      previewPanel.sendScriptRunning(scriptRunning);
      previewPanel.sendState(session.state);
      sendVirtualTouchState();
      updateVirtualTouchRefreshTimer();
      setTimeout(() => {
        if (previewPanel && !previewPanel.disposed && scriptRunning && !previewManuallyStopped) {
          schedulePreviewAuto(150);
        }
      }, 0);
      return previewPanel;
    }
  });
  const toolHost = new ToolHost(registry);

  // VideoService — created on demand when Preview opens
  let videoService: VideoService | undefined;
  const getVideoService = () => {
    const b = backend!; // always set before any command is invoked
    if (!videoService && previewPanel) {
      videoService = new VideoService(session, b, previewPanel);
      videoService.onFirstFrame(() => {
        updateVirtualTouchRefreshTimer();
        void refreshVirtualTouchState().catch((err) => {
          logDebug('Touch', `Status refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      });
    }
    return videoService;
  };

  const ensurePreviewPanel = () => {
    if (!previewPanel) {
      toolHost.open('preview');
    }
    return previewPanel;
  };

  const clearPreviewAutoRetry = () => {
    if (previewAutoRetryTimer) {
      clearTimeout(previewAutoRetryTimer);
      previewAutoRetryTimer = undefined;
    }
  };

  const clearPreviewWatchdog = () => {
    if (previewWatchdogTimer) {
      clearInterval(previewWatchdogTimer);
      previewWatchdogTimer = undefined;
    }
  };

  const recoverStalePreview = async () => {
    if (previewRecoverInFlight || previewManuallyStopped || previewPausedForScript || !scriptRunning || session.state !== 'streaming') {
      return;
    }
    const age = videoService?.lastFrameAgeMs();
    if (age !== null && age !== undefined && age <= previewFrameStaleMs) {
      return;
    }
    previewRecoverInFlight = true;
    try {
      const ageText = age === null || age === undefined ? 'startup' : `${age}ms`;
      logWarn('Preview', `No frames received for ${ageText}; restarting preview`);
      await stopPreviewRuntime();
      if (!previewManuallyStopped && !previewPausedForScript && scriptRunning) {
        previewAutoRetryCount = 0;
        schedulePreviewAuto(150);
      }
    } catch (err) {
      logDebug('Preview', `Stale preview recovery failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      previewRecoverInFlight = false;
    }
  };

  const updatePreviewWatchdog = () => {
    const shouldWatch = connected && scriptRunning && session.state === 'streaming' && !previewManuallyStopped && !previewPausedForScript && !!previewPanel && !previewPanel.disposed;
    if (shouldWatch && !previewWatchdogTimer) {
      previewWatchdogTimer = setInterval(() => {
        void recoverStalePreview();
      }, previewWatchdogIntervalMs);
    } else if (!shouldWatch) {
      clearPreviewWatchdog();
    }
  };

  const schedulePreviewAuto = (delayMs = 0) => {
    if (previewManuallyStopped || previewPausedForScript || !scriptRunning || session.state !== 'connected') {
      return;
    }
    clearPreviewAutoRetry();
    previewAutoRetryTimer = setTimeout(() => {
      previewAutoRetryTimer = undefined;
      void startPreviewAuto();
    }, delayMs);
  };

  const startPreviewAuto = async () => {
    if (previewManuallyStopped || previewPausedForScript || session.state !== 'connected') {
      logDebug('Preview', `Auto-start skipped: manualStop=${previewManuallyStopped} paused=${previewPausedForScript} scriptRun=${scriptRunning} state=${session.state}`);
      return;
    }
    if (!scriptRunning) {
      logDebug('Preview', 'Auto-start skipped: no script is running');
      return;
    }
    if (previewAutoStartInFlight) {
      logDebug('Preview', 'Auto-start already in flight');
      return;
    }
    previewAutoStartInFlight = true;
    logInfo('Preview', 'Auto-starting');
    try {
      ensurePreviewPanel();
      const started = await getVideoService()?.startPreview();
      if (started) {
        previewAutoRetryCount = 0;
        logInfo('Preview', 'Auto-started');
        updatePreviewWatchdog();
        updateVirtualTouchRefreshTimer();
        return;
      }
      if (!previewManuallyStopped && !previewPausedForScript && scriptRunning && session.state === 'connected') {
        const delays = [500, 1000, 2000, 3000, 3000];
        const delay = delays[Math.min(previewAutoRetryCount, delays.length - 1)];
        previewAutoRetryCount++;
        logDebug('Preview', `Auto-start deferred; retrying in ${delay}ms`);
        schedulePreviewAuto(delay);
      }
    } catch (e) {
      logError('Preview', `Auto-start error: ${e}`);
    } finally {
      previewAutoStartInFlight = false;
    }
  };

  const startPreviewManual = async () => {
    clearPreviewAutoRetry();
    previewAutoRetryCount = 0;
    previewManuallyStopped = false;
    previewPausedForScript = false;
    previewPanel?.sendPreviewDisabled(false);
    if (session.state !== 'connected') {
      return;
    }
    ensurePreviewPanel();
    const started = await getVideoService()?.startPreview();
    if (started) {
      updatePreviewWatchdog();
      updateVirtualTouchRefreshTimer();
    }
  };

  async function stopPreviewRuntime() {
    if (session.state === 'streaming') {
      if (videoService) {
        await videoService.stopPreview();
      } else {
        await session.request(createRequest(Methods.stopPreview, {}));
        session.stopStreaming();
      }
    }
    updatePreviewWatchdog();
    updateVirtualTouchRefreshTimer();
  }

  const stopPreviewManual = async () => {
    clearPreviewAutoRetry();
    previewAutoRetryCount = 0;
    previewManuallyStopped = true;
    previewPausedForScript = false;
    previewPanel?.sendPreviewDisabled(true);
    await stopPreviewRuntime();
    clearVirtualTouchState();
  };

  const setPreviewDisabledManual = async (disabled: boolean) => {
    if (disabled) {
      await stopPreviewManual();
    } else {
      await startPreviewManual();
    }
  };

  const stopPreviewBeforeScript = async () => {
    if (session.state === 'streaming') {
      previewPausedForScript = true;
      await stopPreviewRuntime();
    }
  };

  const startPreviewForScript = () => {
    previewPausedForScript = false;
    previewAutoRetryCount = 0;
    schedulePreviewAuto(1500);
  };

  const showTerminalView = () => {
    void vscode.commands.executeCommand('canmv.terminalView.focus');
  };

  const showScriptViews = () => {
    toolHost.open('preview');
    showTerminalView();
  };

  const stopPreviewAfterScript = async () => {
    clearPreviewAutoRetry();
    previewAutoRetryCount = 0;
    previewPausedForScript = false;
    await stopPreviewRuntime();
    clearVirtualTouchState();
  };

  const stopRunningScript = async (options: { stopPreview: boolean }) => {
    if (!connected && !scriptRunning) return;
    const result = await session.request(createRequest(Methods.stopScript, {}));
    if (isResponse(result)) {
      const payload = result.result as { output?: string };
      if (payload.output) {
        appendTerminal(payload.output);
      }
      vscode.window.showInformationMessage('CanMV: Script stopped.');
    } else {
      logError('Script', `Stop failed: ${result.error.message}`);
      appendTerminalLine(`[CanMV] ${result.error.message}`);
      vscode.window.showErrorMessage(`CanMV: Failed to stop script - ${result.error.message}`);
    }
    setScriptRunningContext(false);
    if (options.stopPreview) {
      await stopPreviewAfterScript();
    }
    refreshExplorerSoon(300);
    refreshExplorerSoon(1200);
  };

  const showScriptAlreadyRunning = () => {
    void vscode.window.showWarningMessage('CanMV: A script is already running. Stop it before running another script.', 'Stop Script')
      .then((selection) => {
        if (selection === 'Stop Script') {
          void vscode.commands.executeCommand('canmv.stopScript');
        }
      });
  };

  const ensureCanStartScript = async (): Promise<boolean> => {
    if (!connected) return false;
    if (scriptRunning) {
      showScriptAlreadyRunning();
      return false;
    }
    const runningResult = await session.request(createRequest(Methods.scriptRunning, {}));
    if (!isResponse(runningResult)) {
      logWarn('Script', `Could not check running state: ${runningResult.error.message}`);
      vscode.window.showWarningMessage(`CanMV: Cannot check script state — ${runningResult.error.message}`);
      return false;
    }
    const running = !!(runningResult.result as { running?: boolean }).running;
    if (running) {
      setScriptRunningContext(true);
      showScriptAlreadyRunning();
      return false;
    }
    return true;
  };

  const runRemotePath = async (path: string): Promise<boolean> => {
    if (!(await ensureCanStartScript())) return false;
    await stopPreviewBeforeScript();
    logInfo('Script', `Run remote file: ${path}`);
    setScriptRunningContext(true);
    try {
      const result = await fileService.fileExec(path);
      if (result.status !== 'started') {
        setScriptRunningContext(false);
        if (result.message) {
          vscode.window.showWarningMessage(`CanMV: ${result.message}`);
        }
        return false;
      }
      startPreviewForScript();
      showScriptViews();
      return true;
    } catch (err) {
      setScriptRunningContext(false);
      throw err;
    }
  };

  const trimRemotePath = (path: string) => path.replace(/\/+$/g, '');

  const childPath = (parentPath: string, name: string) =>
    parentPath === '/' ? '/' + name : trimRemotePath(parentPath) + '/' + name;

  const parentRemotePath = (path: string) => {
    const trimmed = trimRemotePath(path);
    const index = trimmed.lastIndexOf('/');
    return index <= 0 ? '/' : trimmed.slice(0, index);
  };

  const remotePathFromCommandArg = (arg?: vscode.Uri | FileTreeItem): string | undefined => {
    if (arg instanceof vscode.Uri && arg.scheme === 'canmv') {
      return arg.path;
    }
    if (arg instanceof vscode.Uri && arg.scheme === 'file') {
      return remoteMirrorService.remotePathForUri(arg);
    }
    if (arg instanceof FileTreeItem) {
      return arg.absPath;
    }
    return selectedExplorerItem()?.absPath;
  };

  const showRemoteOperationError = (operation: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`CanMV: ${operation} failed - ${message}`);
  };

  const promptRemoteName = async (prompt: string, value = '') => vscode.window.showInputBox({
    prompt,
    value,
    validateInput: (input) => {
      const name = input.trim();
      if (!name) return 'Name is required';
      if (name.includes('/')) return 'Use a name, not a path';
      return undefined;
    },
  });

  const refreshExplorer = () => {
    fileService.clearCache();
    explorer.refresh();
  };

  const refreshExplorerSoon = (delayMs = 250) => {
    setTimeout(() => {
      if (connected) {
        refreshExplorer();
      }
    }, delayMs);
  };

  // Register read-only remote file system provider
  const fsProvider = new CanmvFileSystemProvider(fileService);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('canmv', fsProvider)
  );

  const explorer = new CanmvExplorer({
    listDir: (path: string) => fileService.listDir(path),
  });
  const treeView = vscode.window.createTreeView('canmv.explorer', {
    treeDataProvider: explorer,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  const selectedExplorerItem = () => treeView.selection.length === 1 ? treeView.selection[0] : undefined;
  const updateExplorerSelectionContexts = () => {
    const item = selectedExplorerItem();
    const hasSelection = !!item?.absPath;
    void vscode.commands.executeCommand('setContext', 'canmv.explorerSelected', hasSelection);
    void vscode.commands.executeCommand('setContext', 'canmv.explorerSelectedDirectory', hasSelection && item?.fileType === 'directory');
    void vscode.commands.executeCommand('setContext', 'canmv.explorerSelectedMutable', hasSelection && item?.contextValue !== 'mountRoot');
  };
  updateExplorerSelectionContexts();
  context.subscriptions.push(treeView.onDidChangeSelection(updateExplorerSelectionContexts));
  controlProvider = new CanmvControlViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('canmv.controls', controlProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  controlProvider.setState({
    connected,
    scriptRunning,
    statusText: sidebarStatusText(session.state),
  });
  const toolboxProvider = new ToolboxTreeProvider(registry);
  const toolboxView = vscode.window.createTreeView('canmv.toolbox', {
    treeDataProvider: toolboxProvider,
  });
  context.subscriptions.push(toolboxView);

  terminalViewProvider = new TerminalViewProvider(context, () => terminalScrollback.join(''));
  terminalViewProvider.onClear(() => {
    terminalScrollback.length = 0;
  });
  let terminalInputQueue = Promise.resolve();
  terminalViewProvider.onInput((text) => {
    const isCtrlC = text === '\x03';
    if (scriptRunning && isCtrlC) {
      logInfo('Terminal', 'Ctrl-C requested script stop');
      terminalInputQueue = Promise.resolve();
      void stopRunningScript({ stopPreview: true }).catch((err) => {
        logError('Terminal', `Ctrl-C stop error: ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }
    const terminalCanSend = session.state === 'connected' || session.state === 'streaming';
    if (!terminalCanSend || scriptRunning) {
      updateTerminalInputState();
      return;
    }
    const req = createRequest(Methods.terminalInput, { text });
    const activeBackend = backend;
    if (activeBackend?.notify) {
      activeBackend.notify(req);
      return;
    }
    terminalInputQueue = terminalInputQueue.then(async () => {
      const result = await session.request(req);
      if (!isResponse(result)) {
        logWarn('Terminal', `Input error: ${result.error.message}`);
      }
    }).catch((err) => {
      logError('Terminal', `Input queue error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('canmv.terminalView', terminalViewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  updateTerminalInputState();

  // Register commands
  disposables = [
    vscode.commands.registerCommand('canmv.connectBoard', async () => {
      if (!disconnected) return;
      fileService.clearCache();
      const repl = await boardService.connectBoard();
      const info = boardService.boardInfo();
      boardReady = false;
      if (info) {
        updateBoardStatus();
        previewPanel?.sendBoardInfo(info);
      }
      if (repl) {
        appendTerminal(repl);
      }
      updateTerminalInputState();
    }),
    vscode.commands.registerCommand('canmv.disconnectBoard', async () => {
      if (!connected) return;
      clearPreviewAutoRetry();
      previewAutoRetryCount = 0;
      previewPausedForScript = false;
      clearVirtualTouchState();
      updateVirtualTouchRefreshTimer();
      if (scriptRunning) {
        await stopRunningScript({ stopPreview: true });
      }
      videoService?.clearPreviewState();
      boardReady = false;
      fileService.clearCache();
      await boardService.disconnectBoard();
      statusItem.text = '$(debug-disconnect) CanMV';
      statusItem.tooltip = 'Disconnected';
      updateTerminalInputState();
      appendTerminalLine('[CanMV] Disconnected');
    }),
    vscode.commands.registerCommand('canmv.runCurrentScript', async () => {
      if (!(await ensureCanStartScript())) return;
      await stopPreviewBeforeScript();
      setScriptRunningContext(true);
      const started = await scriptService.runCurrentScript();
      if (!started) {
        setScriptRunningContext(false);
      }
      if (started) {
        startPreviewForScript();
        showScriptViews();
      }
    }),
    vscode.commands.registerCommand('canmv.stopScript', async () => {
      if (!connected || !scriptRunning) return;
      await stopRunningScript({ stopPreview: true });
    }),
    vscode.commands.registerCommand('canmv.startPreview', async () => {
      await startPreviewManual();
    }),
    vscode.commands.registerCommand('canmv.stopPreview', async () => {
      await stopPreviewManual();
    }),
    vscode.commands.registerCommand('canmv.runRemoteFile', async (arg?: vscode.Uri | FileTreeItem) => {
      const path = remotePathFromCommandArg(arg);
      if (!path || !path.endsWith('.py')) return;
      await runRemotePath(path);
    }),
    vscode.commands.registerCommand('canmv.openRemoteFile', async (arg?: vscode.Uri | FileTreeItem) => {
      const path = remotePathFromCommandArg(arg);
      if (!path) return;
      try {
        await remoteMirrorService.openRemoteFile(path);
      } catch (err) {
        showRemoteOperationError('Open remote file', err);
      }
    }),
    vscode.commands.registerCommand('canmv.runOnK230', async () => {
      if (!(await ensureCanStartScript())) return;
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const uri = editor.document.uri;
      const mirroredRemotePath = remoteMirrorService.remotePathForDocument(editor.document);
      if (uri.scheme === 'canmv') {
        if (editor.document.isDirty) await editor.document.save();
        await runRemotePath(uri.path);
        return;
      } else if (mirroredRemotePath) {
        if (editor.document.isDirty) await editor.document.save();
        await remoteMirrorService.syncDocumentToRemote(editor.document);
        await runRemotePath(mirroredRemotePath);
        return;
      } else {
        await stopPreviewBeforeScript();
        setScriptRunningContext(true);
        const script = editor.document.getText();
        logInfo('Script', `Run active file on K230: ${uri.fsPath} (${script.length}B)`);
        const req = createRequest(Methods.runScript, { script });
        const result = await session.request(req);
        if (!isResponse(result)) {
          setScriptRunningContext(false);
          vscode.window.showErrorMessage(`CanMV: ${result.error.message}`);
        } else if ((result.result as { status?: string }).status !== 'ok') {
          const payload = result.result as { message?: string; output?: string };
          setScriptRunningContext(false);
          vscode.window.showWarningMessage(`CanMV: ${payload.message || payload.output || 'Script did not start'}`);
        } else {
          startPreviewForScript();
          showScriptViews();
        }
      }
    }),
    vscode.commands.registerCommand('canmv.saveAsMainPy', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const text = editor.document.getText();
      const data = new TextEncoder().encode(text);
      await fileService.writeFile('/sdcard/main.py', data);
      vscode.window.showInformationMessage('CanMV: Saved as /sdcard/main.py');
    }),
    vscode.commands.registerCommand('canmv.saveAsBootPy', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const text = editor.document.getText();
      const data = new TextEncoder().encode(text);
      await fileService.writeFile('/boot.py', data);
      vscode.window.showInformationMessage('CanMV: Saved as /boot.py');
    }),
    vscode.commands.registerCommand('canmv.openTool', (toolId?: string) => {
      if (toolId) {
        toolHost.open(toolId);
      } else {
        const items = registry.listVisible().map(t => ({ label: t.name, id: t.id }));
        vscode.window.showQuickPick(items).then(pick => {
          if (pick) toolHost.open(pick.id);
        });
      }
    }),
    vscode.commands.registerCommand('canmv.newRemoteFile', async (item?: FileTreeItem) => {
      item = item ?? selectedExplorerItem();
      if (!connected || !item || item.fileType !== 'directory') return;
      const name = await promptRemoteName('New file name');
      if (!name) return;
      const path = childPath(item.absPath, name.trim());
      try {
        const ok = await fileService.writeFile(path, new Uint8Array());
        if (!ok) throw new Error('backend rejected the request');
        explorer.refresh();
        await remoteMirrorService.openRemoteFile(path);
      } catch (err) {
        showRemoteOperationError('Create file', err);
      }
    }),
    vscode.commands.registerCommand('canmv.newRemoteFolder', async (item?: FileTreeItem) => {
      item = item ?? selectedExplorerItem();
      if (!connected || !item || item.fileType !== 'directory') return;
      const name = await promptRemoteName('New folder name');
      if (!name) return;
      const path = childPath(item.absPath, name.trim());
      try {
        const ok = await fileService.mkdir(path);
        if (!ok) throw new Error('backend rejected the request');
        explorer.refresh();
      } catch (err) {
        showRemoteOperationError('Create folder', err);
      }
    }),
    vscode.commands.registerCommand('canmv.uploadFiles', async (item?: FileTreeItem) => {
      item = item ?? selectedExplorerItem();
      if (!connected || !item || item.fileType !== 'directory') return;
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: 'Upload Files',
      });
      if (!files || files.length === 0) return;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Uploading files to CanMV' },
          async (progress) => {
            for (let index = 0; index < files.length; index++) {
              const file = files[index];
              progress.report({ message: path.basename(file.fsPath), increment: files.length ? 100 / files.length : 0 });
              await fileService.upload(file.fsPath, childPath(item.absPath, path.basename(file.fsPath)));
            }
          }
        );
        explorer.refresh();
      } catch (err) {
        showRemoteOperationError('Upload files', err);
      }
    }),
    vscode.commands.registerCommand('canmv.uploadFolder', async (item?: FileTreeItem) => {
      item = item ?? selectedExplorerItem();
      if (!connected || !item || item.fileType !== 'directory') return;
      const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Upload Folder',
      });
      if (!folders || folders.length === 0) return;
      const folder = folders[0];
      const remotePath = childPath(item.absPath, path.basename(folder.fsPath));
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Uploading folder to CanMV' },
          async (progress) => {
            progress.report({ message: path.basename(folder.fsPath) });
            await fileService.upload(folder.fsPath, remotePath);
          }
        );
        explorer.refresh();
      } catch (err) {
        showRemoteOperationError('Upload folder', err);
      }
    }),
    vscode.commands.registerCommand('canmv.downloadRemoteItem', async (item?: FileTreeItem) => {
      item = item ?? selectedExplorerItem();
      if (!connected || !item || !item.absPath) return;
      const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Download Here',
        title: 'Select Download Folder',
      });
      if (!folders || folders.length === 0) return;

      const localPath = path.join(folders[0].fsPath, item.name || path.basename(item.absPath));
      const localUri = vscode.Uri.file(localPath);
      let targetExists = false;
      try {
        await vscode.workspace.fs.stat(localUri);
        targetExists = true;
      } catch {
        targetExists = false;
      }

      if (targetExists) {
        const action = item.fileType === 'directory' ? 'Merge and Overwrite' : 'Overwrite';
        const confirmed = await vscode.window.showWarningMessage(
          `"${path.basename(localPath)}" already exists in the selected folder.`,
          { modal: true, detail: item.fileType === 'directory' ? 'Existing files with matching names may be overwritten.' : 'The existing local file will be overwritten.' },
          action
        );
        if (confirmed !== action) return;
      }

      const label = item.fileType === 'directory' ? 'folder' : 'file';
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Downloading ${label} from CanMV` },
          async (progress) => {
            progress.report({ message: item.absPath });
            await fileService.download(item.absPath, localPath);
          }
        );
        void vscode.window.showInformationMessage(`CanMV: Downloaded ${item.name} to ${localPath}`);
      } catch (err) {
        showRemoteOperationError('Download', err);
      }
    }),
    vscode.commands.registerCommand('canmv.renameRemoteItem', async (item?: FileTreeItem) => {
      item = item ?? selectedExplorerItem();
      if (!connected || !item || item.contextValue === 'mountRoot') return;
      const name = await promptRemoteName('New name', item.name || '');
      if (!name || name.trim() === item.name) return;
      const parent = parentRemotePath(item.absPath);
      const newPath = childPath(parent, name.trim());
      try {
        const ok = await fileService.renameFile(item.absPath, newPath);
        if (!ok) throw new Error('backend rejected the request');
        explorer.refresh();
      } catch (err) {
        showRemoteOperationError('Rename', err);
      }
    }),
    vscode.commands.registerCommand('canmv.deleteRemoteItem', async (item?: FileTreeItem) => {
      item = item ?? selectedExplorerItem();
      if (!connected || !item || item.contextValue === 'mountRoot') return;
      const label = item.fileType === 'directory' ? 'folder' : 'file';
      const confirmed = await vscode.window.showWarningMessage(
        `Delete ${label} "${item.name}" from CanMV?`,
        { modal: true },
        'Delete'
      );
      if (confirmed !== 'Delete') return;
      try {
        const ok = item.fileType === 'directory'
          ? await fileService.rmdir(item.absPath)
          : await fileService.deleteFile(item.absPath);
        if (!ok) throw new Error('backend rejected the request');
        explorer.refresh();
      } catch (err) {
        showRemoteOperationError('Delete', err);
      }
    }),
    vscode.commands.registerCommand('canmv.refreshExplorer', () => {
      refreshExplorer();
    }),
  ];
  context.subscriptions.push(...disposables);
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
    void remoteMirrorService.syncDocumentToRemote(document).catch((err) => {
      showRemoteOperationError('Sync remote file', err);
    });
  }));

  // Script output events → Output Channel
  backend.onEvent((event) => {
    if (event.event === 'scriptOutput') {
      const text = (event.params as any).text || '';
      appendTerminal(text);
    } else if (event.event === 'scriptState') {
      const s = (event.params as any).state;
      if (s === 'started') {
        setScriptRunningContext(true);
      }
      if (s === 'finished') {
        setScriptRunningContext(false);
        void stopPreviewAfterScript().finally(() => {
          refreshExplorerSoon(300);
          refreshExplorerSoon(1200);
        });
      }
    } else if (event.event === 'boardReady') {
      boardReady = !!boardService.boardInfo();
      if (boardReady) {
        logInfo('Board', 'Ready after connect soft reboot');
        void configureBoardStubs(session);
        refreshExplorerSoon(300);
        schedulePreviewAuto(150);
      }
    } else if (event.event === 'boardDisconnected') {
      const params = event.params as { source?: string; message?: string };
      const detail = [params.source, params.message].filter(Boolean).join(': ');
      logWarn('Board', `Disconnected${detail ? ` (${detail})` : ''}`);
      clearPreviewAutoRetry();
      previewAutoRetryCount = 0;
      previewPausedForScript = false;
      boardReady = false;
      setScriptRunningContext(false);
      clearVirtualTouchState();
      updatePreviewWatchdog();
      updateVirtualTouchRefreshTimer();
      videoService?.clearPreviewState();
      if (connected) {
        void session.disconnect().catch((err) => {
          logWarn('Session', `Disconnect after board loss failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  });

  // Auto-refresh explorer on connection state change
  session.onStateChange((state) => {
    previewPanel?.sendState(state);
    explorer.setConnected(state === 'connected' || state === 'streaming');
    const nextConnected = state === 'connected' || state === 'streaming';
    setConnectionContexts(state);
    updatePreviewWatchdog();
    updateVirtualTouchRefreshTimer();
    if (state !== 'streaming') {
      clearVirtualTouchState();
    }
    if (!nextConnected) {
      clearPreviewAutoRetry();
      boardReady = false;
      fileService.clearCache();
      setScriptRunningContext(false);
      previewPausedForScript = false;
      clearVirtualTouchState();
      updateVirtualTouchRefreshTimer();
      videoService?.clearPreviewState();
    }
    if (nextConnected) {
      updateBoardStatus();
      if (state === 'connected') {
        boardReady = false;
      }
    } else {
      statusItem.text = '$(debug-disconnect) CanMV';
      statusItem.tooltip = 'Disconnected';
    }
  });

  toolHost.open('preview');
  logInfo('Extension', 'Activation complete');
}

function logActivationInfo(context: vscode.ExtensionContext): void {
  const pkg = context.extension.packageJSON as {
    name?: string;
    displayName?: string;
    publisher?: string;
    version?: string;
  };
  const extensionId = context.extension.id || [pkg.publisher, pkg.name].filter(Boolean).join('.');
  const mode = vscode.ExtensionMode[context.extensionMode] || String(context.extensionMode);
  const version = pkg.version || 'unknown';
  const displayName = pkg.displayName || pkg.name || extensionId || 'CanMV';

  logInfo('Extension', `Activated ${displayName} ${version}`);
  logInfo('Extension', `ID: ${extensionId || 'unknown'}`);
  logInfo('Extension', `Mode: ${mode}`);
  logInfo('Extension', `VS Code: ${vscode.version}`);
  logInfo('Extension', `Runtime: ${process.platform}-${process.arch}, Node ${process.versions.node}, Electron ${process.versions.electron || 'n/a'}`);
  logInfo('Extension', `Path: ${context.extensionPath}`);
}

export async function deactivate() {
  if (backend) {
    backend.disposeSync();
  }
  disposables.forEach((d) => d.dispose());
  logInfo('Extension', 'Deactivated');
}

async function fetchCommitFromBoard(session: Session): Promise<string> {
  try {
    const req = createRequest(Methods.getFirmwareCommit, {});
    const result = await session.request(req);
    if (isResponse(result)) {
      const { commitId } = result.result as { commitId: string; archStr: string };
      logInfo('Stubs', `Board firmware revision ${commitId ? 'detected' : 'not available'}`);
      return commitId || '';
    }
  } catch (err) {
    logWarn('Stubs', `getFirmwareCommit error: ${err}`);
  }
  return '';
}

async function configureBoardStubs(session: Session): Promise<void> {
  const commitId = await fetchCommitFromBoard(session);
  await configureStubs(stubsService!, commitId);
}

async function configureStubs(svc: StubsService, commitId: string): Promise<void> {
  if (!commitId) {
    logInfo('Stubs', 'No board revision available; using default stubs');
  }
  try {
    await svc.downloadStubs(commitId);
  } catch (err) {
    logError('Stubs', `Setup error: ${err}`);
  }
}
