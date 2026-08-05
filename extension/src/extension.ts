import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { NativeBackend } from './backend/native';
import { Session } from './session/session';
import { PreviewPanel } from './webview/PreviewPanel';
import { TerminalViewProvider } from './webview/TerminalViewProvider';
import { BoardService, type BoardInfo, type ConnectBoardOptions } from './service/boardService';
import { ScriptService } from './service/scriptService';
import { VideoService } from './service/videoService';
import { FileService, type FileTransferProgress } from './service/fileService';
import { StubsService } from './service/stubsService';
import { CanmvResourceService } from './service/canmvResourceService';
import { RemoteMirrorService } from './service/remoteMirrorService';
import { CanmvExplorer } from './explorer/treeProvider';
import { FileTreeItem } from './explorer/fileItem';
import { ExamplesTreeProvider, ExampleTreeItem } from './explorer/examplesTreeProvider';
import { BoardDetector } from './backend/detector';
import { CanmvFileSystemProvider } from './filesystem/provider';
import { ToolRegistry, ToolHost } from './webview/ToolHost';
import { CanmvControlViewProvider } from './webview/CanmvControlViewProvider';
import { ToolboxTreeProvider } from './webview/ToolboxTreeProvider';
import { ExamplesService } from './service/examplesService';
import { CanmvResourceRouteService } from './service/resourceRouteService';
import { ThresholdEditorPanel, type ThresholdEditorConfig, type ThresholdMode } from './webview/ThresholdEditorPanel';
import { Methods, createRequest } from './protocol/methods';
import { isResponse, type ProtocolError, type Response } from './protocol/types';
import { registerMcpSupport } from './mcp/provider';
import { McpBridgeServer } from './mcp/bridge';
import { logDebug, logError, logInfo, logWarn } from './output';
import { t, states } from './i18n';

let disposables: vscode.Disposable[] = [];
let previewPanel: PreviewPanel | undefined;
let thresholdEditorPanel: ThresholdEditorPanel | undefined;
let terminalViewProvider: TerminalViewProvider | undefined;
let backend: NativeBackend | undefined;
let stubsService: StubsService | undefined;
let examplesService: ExamplesService | undefined;
let canmvResourceService: CanmvResourceService | undefined;

type VirtualTouchState = {
  supported: boolean;
  enabled: boolean;
  range?: { w: number; h: number };
  queueDepth?: number;
};

type ThresholdSelection = {
  mode: ThresholdMode;
  values: number[];
  range: vscode.Range;
  uri: vscode.Uri;
};

const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
statusItem.text = '$(debug-disconnect) CanMV';
statusItem.tooltip = states.disconnected();

const scriptExceptionBufferLimit = 4096;
const tracebackHeader = 'Traceback (most recent call last):';
const pythonExceptionLinePattern = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*(?::.*)?$/;
const ignoredStopExceptionLinePattern = /^(?:KeyboardInterrupt|SystemExit)(?::.*)?$/;
const ideInterruptExceptionLine = 'Exception: IDE interrupt';

function scriptExceptionSummary(output: string, stopInFlight = false): string | undefined {
  const tracebackIndex = output.lastIndexOf(tracebackHeader);
  if (tracebackIndex < 0) return undefined;

  const lines = output.slice(tracebackIndex + tracebackHeader.length).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line || /^\s/.test(rawLine) || line.startsWith('File ') || line.startsWith('Traceback ') || /^\^+$/.test(line)) {
      continue;
    }
    if (ignoredStopExceptionLinePattern.test(line) || (stopInFlight && line === ideInterruptExceptionLine)) {
      return undefined;
    }
    if (pythonExceptionLinePattern.test(line)) {
      return line;
    }
  }

  return undefined;
}

export async function activate(context: vscode.ExtensionContext) {
  logActivationInfo(context);

  backend = new NativeBackend(context);
  const session = new Session(backend, {
    autoReconnect: vscode.workspace.getConfiguration('canmv').get('autoReconnect', true),
    requestTimeout: 10000,
  });
  context.subscriptions.push(session);
  const resourceRouteService = new CanmvResourceRouteService();
  examplesService = new ExamplesService(context, resourceRouteService);
  stubsService = new StubsService(context, resourceRouteService);
  canmvResourceService = new CanmvResourceService(resourceRouteService, stubsService, examplesService);
  void canmvResourceService.ensureDefaultResources().catch((err) => {
    logError('Resources', `Default setup error: ${err}`);
  });
  context.subscriptions.push(statusItem);

  const boardService = new BoardService(session, new BoardDetector(session));
  const scriptService = new ScriptService(session);
  const fileService = new FileService(
    session,
    () => vscode.workspace.getConfiguration('canmv').get<boolean>('autoMinifyStartupScripts', true),
  );
  const pkg = context.extension.packageJSON as { displayName?: string; name?: string; version?: string };
  const extensionName = pkg.displayName || pkg.name || 'CanMV';
  const extensionVersion = pkg.version || 'unknown';
  const extensionStatusLabel = `${extensionName} v${extensionVersion}`;
  let remoteFilesAvailable: () => boolean = () => false;
  let remoteFilesUnavailableMessage: () => string = () => t('Not connected');
  const remoteMirrorService = new RemoteMirrorService(
    context,
    fileService,
    () => remoteFilesAvailable(),
    () => remoteFilesUnavailableMessage(),
  );
  const examplesTreeProvider = new ExamplesTreeProvider(examplesService);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('canmv.examples', examplesTreeProvider));
  let connected = false;
  let disconnected = true;
  let scriptRunning = false;
  let boardReady = false;
  let pendingBoardReadyEvent = false;
  let connectionBusy = false;
  let connectionPhase: 'idle' | 'connecting' | 'disconnecting' = 'idle';
  let scriptBusy = false;
  let scriptStopInFlight = false;
  let scriptExceptionBuffer = '';
  let scriptExceptionNotified = false;
  let lastOperationEndTime = 0;
  let remoteFilesPausedUntil = 0;
  let remoteFilesPauseTimer: ReturnType<typeof setTimeout> | undefined;
  let controlProvider: CanmvControlViewProvider | undefined;
  let explorer: CanmvExplorer | undefined;
  let explorerRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let updateExplorerConnectionState = () => {};
  let refreshExplorerSoon: (delayMs?: number) => void = () => {};
  let pauseRemoteFiles: (durationMs: number) => void = () => {};
  let onScriptRunningContextChanged = () => {};
  let mcpBridge: McpBridgeServer | undefined;
  const extensionStatusTooltipLines = () => [
    t('CanMV extension'),
    t('Extension Version: {version}', { version: extensionVersion }),
  ];
  const statusTooltipForState = (state: string) => [
    ...extensionStatusTooltipLines(),
    t('Status: {status}', { status: state }),
  ].join('\n');
  const setStatusForState = (state: string) => {
    if (state === 'connecting') {
      statusItem.text = `$(sync~spin) ${extensionStatusLabel}`;
      statusItem.tooltip = statusTooltipForState(states.connecting());
      return;
    }
    if (state === 'streaming') {
      statusItem.text = `$(device-camera) ${extensionStatusLabel}`;
      statusItem.tooltip = statusTooltipForState(states.streaming());
      return;
    }
    if (state === 'connected') {
      statusItem.text = `$(debug-start) ${extensionStatusLabel}`;
      statusItem.tooltip = statusTooltipForState(states.connected());
      return;
    }
    statusItem.text = `$(debug-disconnect) ${extensionStatusLabel}`;
    statusItem.tooltip = statusTooltipForState(states.disconnected());
  };
  const boardStatusLabel = (info: BoardInfo) => {
    const board = info.boardName || info.boardType;
    return [board, info.fwVersion, info.memorySize].filter(Boolean).join(' ') || 'CanMV';
  };
  const sidebarStatusText = (state: string) => {
    if (state === 'connecting') return states.connecting();
    if (state === 'streaming') return states.streaming();
    if (state === 'connected') {
      const info = boardService.boardInfo();
      return info ? boardStatusLabel(info) : states.connected();
    }
    return states.disconnected();
  };
  const setBoardReadyContext = (value: boolean) => {
    boardReady = value;
    void vscode.commands.executeCommand('setContext', 'canmv.boardReady', value);
    controlProvider?.setState({ boardReady: value });
    updateTerminalInputState();
    updateExplorerConnectionState();
    if (value) {
      refreshExplorerSoon(250);
    }
    mcpBridge?.broadcastSnapshot();
  };
  const resetBoardReadiness = () => {
    pendingBoardReadyEvent = false;
    setBoardReadyContext(false);
  };
  const markBoardReadyEvent = () => {
    pendingBoardReadyEvent = true;
    if (boardService.boardInfo()) {
      setBoardReadyContext(true);
    }
  };
  const setConnectionBusyContext = (value: boolean) => {
    connectionBusy = value;
    void vscode.commands.executeCommand('setContext', 'canmv.connectionBusy', value);
    updateTerminalInputState();
    updateExplorerConnectionState();
    if (!value) {
      refreshExplorerSoon(250);
    }
  };
  const setConnectionPhase = (value: 'idle' | 'connecting' | 'disconnecting') => {
    connectionPhase = value;
    controlProvider?.setState({ connectionPhase: value });
  };
  const resetScriptExceptionDetector = () => {
    scriptExceptionBuffer = '';
    scriptExceptionNotified = false;
  };
  const inspectScriptOutputForException = (text: string) => {
    if (!scriptRunning || scriptExceptionNotified) return;
    scriptExceptionBuffer = (scriptExceptionBuffer + text).slice(-scriptExceptionBufferLimit);
    const summary = scriptExceptionSummary(scriptExceptionBuffer, scriptStopInFlight);
    if (!summary) return;

    scriptExceptionNotified = true;
    logWarn('Script', `Runtime exception detected: ${summary}`);
    const showTerminal = t('Show Terminal');
    void vscode.window.showWarningMessage(t('CanMV: Script exception detected - {message}', { message: summary }), showTerminal)
      .then((selection) => {
        if (selection === showTerminal) {
          void vscode.commands.executeCommand('canmv.terminalView.focus');
        }
      });
  };
  const setScriptBusyContext = (value: boolean) => {
    scriptBusy = value;
    void vscode.commands.executeCommand('setContext', 'canmv.scriptBusy', value);
    updateTerminalInputState();
    updateExplorerConnectionState();
  };
  const beginScriptOperation = (options: { allowWhileConnectionBusy?: boolean; skipCooldown?: boolean } = {}) => {
    if (scriptBusy || (connectionBusy && !options.allowWhileConnectionBusy)) return false;
    // Debounce: enforce minimum cooldown between board operations to prevent
    // overwhelming the board with rapid soft-reset / ScriptExec cycles.
    if (!options.skipCooldown) {
      const cooldownMs = 500;
      const elapsed = Date.now() - lastOperationEndTime;
      if (elapsed < cooldownMs) {
        logDebug('Script', `Operation deferred: cooldown ${cooldownMs - elapsed}ms remaining`);
        return false;
      }
    }
    setScriptBusyContext(true);
    return true;
  };
  const endScriptOperation = () => {
    lastOperationEndTime = Date.now();
    setScriptBusyContext(false);
  };
  const setConnectionContexts = (state: string) => {
    if (state === 'connecting') {
      setConnectionPhase('connecting');
    } else if (state === 'disconnected') {
      setConnectionPhase('idle');
    }
    connected = state === 'connected' || state === 'streaming';
    disconnected = state === 'disconnected';
    if (state === 'connecting' || state === 'disconnected') {
      resetBoardReadiness();
    }
    void vscode.commands.executeCommand('setContext', 'canmv.connected', connected);
    void vscode.commands.executeCommand('setContext', 'canmv.disconnected', disconnected);
    controlProvider?.setState({ connected, statusText: sidebarStatusText(state) });
    updateTerminalInputState();
    updateExplorerConnectionState();
  };
  const setScriptRunningContext = (value: boolean) => {
    const wasRunning = scriptRunning;
    scriptRunning = value;
    if (!wasRunning && value) {
      resetScriptExceptionDetector();
    }
    if (wasRunning && !value) {
      pauseRemoteFiles(1500);
      resetScriptExceptionDetector();
    }
    void vscode.commands.executeCommand('setContext', 'canmv.scriptRunning', value);
    previewPanel?.sendScriptRunning(value);
    controlProvider?.setState({ scriptRunning: value });
    updateTerminalInputState();
    updateExplorerConnectionState();
    onScriptRunningContextChanged();
    mcpBridge?.broadcastSnapshot();
  };
  const boardStatusText = (_info: BoardInfo) => {
    return `$(circuit-board) ${extensionStatusLabel}`;
  };
  const boardStatusTooltip = (info: BoardInfo) => {
    const board = info.boardName || info.boardType;
    const stateLabel = session.state === 'streaming' ? states.streaming() : states.connected();
    const lines = [
      ...extensionStatusTooltipLines(),
      t('Status: {status}', { status: stateLabel }),
      '',
      t('CanMV board connected'),
      t('Board: {board}', { board }),
      t('Firmware: {firmwareVersion}', { firmwareVersion: info.fwVersion }),
    ];
    if (info.memorySize) lines.push(t('Memory: {memory}', { memory: info.memorySize }));
    if (info.port) lines.push(t('Port: {port}', { port: info.port }));
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
    setStatusForState(session.state);
  };
  setStatusForState(session.state);
  statusItem.show();
  const boardSupportsReplInput = () => {
    return boardService.boardInfo()?.capabilities?.replInput === true;
  };
  const boardSupportsFileExplorer = () => {
    return boardService.boardInfo()?.capabilities?.listDir === true;
  };
  const boardHasCapabilitiesProtocol = () => {
    return (boardService.boardInfo()?.protocolVersion ?? 0) > 0;
  };
  const assumeScriptRunningForPreview = () => {
    return scriptRunning || !boardHasCapabilitiesProtocol();
  };
  remoteFilesAvailable = () => {
    return connected
      && boardReady
      && !connectionBusy
      && !scriptBusy
      && Date.now() >= remoteFilesPausedUntil
      && boardSupportsFileExplorer();
  };
  remoteFilesUnavailableMessage = () => {
    if (!connected) return t('Not connected');
    if (!boardReady) return t('Board is not ready yet');
    if (connectionBusy || scriptBusy) return t('CanMV operation is in progress');
    if (Date.now() < remoteFilesPausedUntil) return t('CanMV operation is in progress');
    return t('File explorer is not supported by this firmware');
  };
  pauseRemoteFiles = (durationMs: number) => {
    remoteFilesPausedUntil = Math.max(remoteFilesPausedUntil, Date.now() + durationMs);
    updateExplorerConnectionState();
    if (remoteFilesPauseTimer) {
      clearTimeout(remoteFilesPauseTimer);
    }
    const remainingMs = Math.max(0, remoteFilesPausedUntil - Date.now());
    remoteFilesPauseTimer = setTimeout(() => {
      remoteFilesPauseTimer = undefined;
      updateExplorerConnectionState();
    }, remainingMs);
  };
  const explorerCanBrowse = () => remoteFilesAvailable();
  updateExplorerConnectionState = () => {
    const filesAvailable = remoteFilesAvailable();
    void vscode.commands.executeCommand('setContext', 'canmv.remoteFilesAvailable', filesAvailable);
    const activeExplorer = explorer;
    if (!activeExplorer) return;
    // Keep the last tree visible while an operation temporarily blocks new file requests.
    const canDisplayFiles = connected && boardReady && boardSupportsFileExplorer();
    activeExplorer.setConnectionState(canDisplayFiles, !connected || boardSupportsFileExplorer(), remoteFilesUnavailableMessage());
  };
  const updateTerminalInputState = () => {
    const replInputSupported = boardSupportsReplInput();
    const canInput = connected && boardReady && replInputSupported && !scriptRunning && !connectionBusy && !scriptBusy;
    const reason = disconnected
      ? t('Connect board to use REPL input')
      : connectionBusy || scriptBusy
        ? t('CanMV operation is in progress')
      : !boardReady
        ? t('Board is not ready yet')
      : !replInputSupported
        ? t('REPL input is not supported by this firmware')
        : scriptRunning
          ? t('Script is running; press Ctrl-C to stop it')
          : '';
    terminalViewProvider?.setInputEnabled(canInput, reason, connected && scriptRunning);
  };
  setConnectionContexts(session.state);
  setScriptRunningContext(false);
  setConnectionBusyContext(false);
  setScriptBusyContext(false);
  setBoardReadyContext(false);

  // Preview is created lazily via ToolHost, not at activation
  let previewManuallyStopped = false;
  let previewPausedForScript = false;
  let previewAutoStartInFlight = false;
  let previewAutoStartPromise: Promise<void> | undefined;
  let previewAutoStartToken = 0;
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
  let terminalScrollbackSize = 0;

  const trimTerminalScrollback = () => {
    while (terminalScrollbackSize > terminalScrollbackLimit && terminalScrollback.length > 0) {
      const excess = terminalScrollbackSize - terminalScrollbackLimit;
      const first = terminalScrollback[0] || '';
      if (first.length <= excess) {
        const removed = terminalScrollback.shift() || '';
        terminalScrollbackSize -= removed.length;
      } else {
        terminalScrollback[0] = first.slice(excess);
        terminalScrollbackSize -= excess;
      }
    }
  };

  const appendTerminal = (text: string) => {
    if (!text) return;
    terminalScrollback.push(text);
    terminalScrollbackSize += text.length;
    trimTerminalScrollback();
    inspectScriptOutputForException(text);
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
      cancelPreviewAutoStart();
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
    id: 'preview', name: t('Preview'), icon: 'device-camera',
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
        cancelPreviewAutoStart();
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
          filters: { [t('PNG Image')]: ['png'] },
          saveLabel: t('Save Image'),
        });
        if (!target) return;
        await vscode.workspace.fs.writeFile(target, data);
        logInfo('Preview', `Saved frame image: ${target.fsPath}`);
      });
      previewPanel.onSaveVideo(async ({ data, extension }) => {
        const normalizedExtension = extension === 'mp4' ? 'mp4' : 'webm';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const base = vscode.workspace.workspaceFolders?.[0]?.uri;
        const defaultUri = base ? vscode.Uri.joinPath(base, `canmv-recording-${stamp}.${normalizedExtension}`) : undefined;
        const filterName = normalizedExtension === 'mp4' ? t('MP4 Video') : t('WebM Video');
        const target = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { [filterName]: [normalizedExtension] },
          saveLabel: t('Save Video'),
        });
        if (!target) return;
        await vscode.workspace.fs.writeFile(target, data);
        logInfo('Preview', `Saved video recording: ${target.fsPath}`);
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
  registry.register({
    id: 'thresholdEditor', name: t('Threshold Editor'), icon: 'settings',
    factory: () => {
      if (thresholdEditorPanel?.disposed) {
        thresholdEditorPanel = undefined;
      }
      thresholdEditorPanel = new ThresholdEditorPanel(context);
      thresholdEditorPanel.onDidDispose(() => {
        thresholdEditorPanel = undefined;
      });
      thresholdEditorPanel.onCopyThreshold((text) => {
        void vscode.env.clipboard.writeText(text).then(() => {
          thresholdEditorPanel?.sendCopied();
        });
      });
      thresholdEditorPanel.onApplyThreshold((text) => {
        void applyThresholdToSelection(text).catch((err) => {
          vscode.window.showErrorMessage(t('CanMV: Failed to update threshold - {message}', { message: err instanceof Error ? err.message : String(err) }));
        });
      });
      thresholdEditorPanel.onRequestPreviewFrame(() => {
        const frame = videoService?.getLatestFrame();
        if (frame) {
          thresholdEditorPanel?.sendPreviewFrame(frame);
          return;
        }
        if (!previewPanel) {
          thresholdEditorPanel?.sendFrameUnavailable(t('No frame buffer image available. Start Preview, wait for a frame, or open an image file.'));
          return;
        }
        void previewPanel.captureImage().then((data) => {
          if (data) {
            thresholdEditorPanel?.sendPreviewFrame(data, t('Preview Canvas'));
          } else {
            thresholdEditorPanel?.sendFrameUnavailable(t('No frame buffer image available. Start Preview, wait for a frame, or open an image file.'));
          }
        });
      });
      thresholdEditorPanel.configure(createThresholdEditorConfig());
      return thresholdEditorPanel;
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

  const openThresholdEditor = (config?: ThresholdEditorConfig) => {
    const panel = toolHost.open('thresholdEditor') as ThresholdEditorPanel;
    panel.configure(config || createThresholdEditorConfig());
    return panel;
  };

  const clearPreviewAutoRetry = () => {
    if (previewAutoRetryTimer) {
      clearTimeout(previewAutoRetryTimer);
      previewAutoRetryTimer = undefined;
    }
  };

  const cancelPreviewAutoStart = () => {
    clearPreviewAutoRetry();
    previewAutoRetryCount = 0;
    previewAutoStartToken++;
  };

  const waitForPreviewAutoStart = async () => {
    const inFlight = previewAutoStartPromise;
    if (inFlight) {
      await inFlight;
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
      cancelPreviewAutoStart();
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

  const schedulePreviewAuto = (delayMs = 0, options: { allowWhileScriptBusy?: boolean } = {}) => {
    if (previewManuallyStopped || previewPausedForScript || !scriptRunning || connectionBusy || (scriptBusy && !options.allowWhileScriptBusy) || session.state !== 'connected') {
      return;
    }
    const token = previewAutoStartToken;
    clearPreviewAutoRetry();
    previewAutoRetryTimer = setTimeout(() => {
      previewAutoRetryTimer = undefined;
      const promise = startPreviewAuto(token);
      previewAutoStartPromise = promise;
      void promise.finally(() => {
        if (previewAutoStartPromise === promise) {
          previewAutoStartPromise = undefined;
        }
      });
    }, delayMs);
  };

  const startPreviewAuto = async (token = previewAutoStartToken) => {
    if (token !== previewAutoStartToken || previewManuallyStopped || previewPausedForScript || connectionBusy || scriptBusy || session.state !== 'connected') {
      logDebug('Preview', `Auto-start skipped: token=${token === previewAutoStartToken ? 'current' : 'stale'} manualStop=${previewManuallyStopped} paused=${previewPausedForScript} scriptRun=${scriptRunning} state=${session.state}`);
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
      if (token !== previewAutoStartToken || previewPausedForScript || !scriptRunning || connectionBusy || scriptBusy || session.state !== 'connected') {
        logDebug('Preview', 'Auto-start canceled before request');
        return;
      }
      const started = await getVideoService()?.startPreview(undefined, undefined, { assumeScriptRunning: assumeScriptRunningForPreview(), suppressErrors: true });
      if (token !== previewAutoStartToken || previewPausedForScript || !scriptRunning || connectionBusy || scriptBusy) {
        logDebug('Preview', 'Auto-start result discarded after script state changed');
        if (started) {
          await stopPreviewRuntime();
        }
        return;
      }
      if (started) {
        previewAutoRetryCount = 0;
        logInfo('Preview', 'Auto-started');
        updatePreviewWatchdog();
        updateVirtualTouchRefreshTimer();
        return;
      }
      if (token === previewAutoStartToken && !previewManuallyStopped && !previewPausedForScript && !connectionBusy && !scriptBusy && scriptRunning && session.state === 'connected') {
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

  const startPreviewManual = async (): Promise<boolean> => {
    cancelPreviewAutoStart();
    await waitForPreviewAutoStart();
    previewManuallyStopped = false;
    previewPausedForScript = false;
    previewPanel?.sendPreviewDisabled(false);
    if (session.state === 'streaming') {
      ensurePreviewPanel();
      return true;
    }
    if (session.state !== 'connected') {
      return false;
    }
    ensurePreviewPanel();
    const started = await getVideoService()?.startPreview(undefined, undefined, { assumeScriptRunning: assumeScriptRunningForPreview() });
    if (started) {
      updatePreviewWatchdog();
      updateVirtualTouchRefreshTimer();
    }
    return started === true;
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
    cancelPreviewAutoStart();
    previewManuallyStopped = true;
    previewPausedForScript = false;
    await waitForPreviewAutoStart();
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
    cancelPreviewAutoStart();
    await waitForPreviewAutoStart();
    if (session.state === 'streaming') {
      previewPausedForScript = true;
      await stopPreviewRuntime();
    }
  };

  const startPreviewForScript = () => {
    previewAutoStartToken++;
    previewPausedForScript = false;
    previewAutoRetryCount = 0;
    schedulePreviewAuto(1500, { allowWhileScriptBusy: true });
  };

  const showTerminalView = () => {
    void vscode.commands.executeCommand('canmv.terminalView.focus');
  };

  const showScriptViews = () => {
    toolHost.open('preview');
    showTerminalView();
  };

  const stopPreviewAfterScript = async () => {
    cancelPreviewAutoStart();
    await waitForPreviewAutoStart();
    previewPausedForScript = false;
    await stopPreviewRuntime();
    clearVirtualTouchState();
  };

  const stopRunningScript = async (options: { stopPreview: boolean; allowWhileConnectionBusy?: boolean }) => {
    if (!connected && !scriptRunning) return;
    if (!beginScriptOperation({ allowWhileConnectionBusy: options.allowWhileConnectionBusy, skipCooldown: options.allowWhileConnectionBusy })) return;
    scriptStopInFlight = true;
    try {
      cancelPreviewAutoStart();
      if (options.stopPreview) {
        previewPausedForScript = true;
        await waitForPreviewAutoStart();
        await stopPreviewRuntime();
        clearVirtualTouchState();
      }
      const result = await session.request(createRequest(Methods.stopScript, {}));
      if (isResponse(result)) {
        const payload = result.result as { output?: string };
        if (payload.output) {
          appendTerminal(payload.output);
        }
        vscode.window.showInformationMessage(t('CanMV: Script stopped.'));
      } else {
        logError('Script', `Stop failed: ${result.error.message}`);
        appendTerminalLine(`[CanMV] ${result.error.message}`);
        vscode.window.showErrorMessage(t('CanMV: Failed to stop script - {message}', { message: result.error.message }));
      }
      setScriptRunningContext(false);
      if (options.stopPreview) {
        await stopPreviewAfterScript();
      }
    } finally {
      scriptStopInFlight = false;
      endScriptOperation();
    }
  };

  const showScriptAlreadyRunning = () => {
    const stopScript = t('Stop Script');
    void vscode.window.showWarningMessage(t('CanMV: A script is already running. Stop it before running another script.'), stopScript)
      .then((selection) => {
        if (selection === stopScript) {
          void vscode.commands.executeCommand('canmv.stopScript');
        }
      });
  };

  const ensureCanStartScript = async (): Promise<boolean> => {
    if (!connected) return false;
    if (!boardReady) {
      vscode.window.showWarningMessage(t('CanMV: Board is not ready yet. Wait for initialization to finish.'));
      return false;
    }
    if (scriptRunning) {
      showScriptAlreadyRunning();
      return false;
    }
    if (!boardHasCapabilitiesProtocol()) {
      logDebug('Script', 'Skipping scriptRunning precheck: legacy firmware has no capabilities protocol');
      return true;
    }
    const runningResult = await session.request(createRequest(Methods.scriptRunning, {}));
    if (!isResponse(runningResult)) {
      logWarn('Script', `Could not check running state: ${runningResult.error.message}`);
      vscode.window.showWarningMessage(t('CanMV: Cannot check script state - {message}', { message: runningResult.error.message }));
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

  const runRemotePathLocked = async (path: string): Promise<boolean> => {
    if (!(await ensureCanStartScript())) return false;
    await stopPreviewBeforeScript();
    logInfo('Script', `Run remote file: ${path}`);
    try {
      const result = await fileService.fileExec(path);
      if (result.status !== 'started') {
        if (result.message) {
          vscode.window.showWarningMessage(t('CanMV: {message}', { message: result.message }));
        }
        return false;
      }
      setScriptRunningContext(true);
      startPreviewForScript();
      showScriptViews();
      return true;
    } catch (err) {
      setScriptRunningContext(false);
      throw err;
    }
  };

  const runRemotePath = async (path: string): Promise<boolean> => {
    if (!beginScriptOperation()) return false;
    try {
      return await runRemotePathLocked(path);
    } finally {
      endScriptOperation();
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
    void vscode.window.showErrorMessage(t('CanMV: {operation} failed - {message}', { operation, message }));
  };

  let thresholdSelection: ThresholdSelection | undefined;

  const parseThresholdTuple = (text: string): { mode: ThresholdMode; values: number[] } | undefined => {
    const trimmed = text.trim();
    const match = /^\(\s*([+-]?\d+)\s*,\s*([+-]?\d+)(?:\s*,\s*([+-]?\d+)\s*,\s*([+-]?\d+)\s*,\s*([+-]?\d+)\s*,\s*([+-]?\d+))?\s*\)$/.exec(trimmed);
    if (!match) return undefined;
    const values = match.slice(1).filter((value): value is string => value !== undefined).map((value) => Number.parseInt(value, 10));
    if (values.some((value) => !Number.isFinite(value))) return undefined;
    if (values.length === 2) return { mode: 'grayscale', values };
    if (values.length === 6) return { mode: 'lab', values };
    return undefined;
  };

  const thresholdSelectionFromEditor = (): ThresholdSelection | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) return undefined;
    const parsed = parseThresholdTuple(editor.document.getText(editor.selection));
    if (!parsed) return undefined;
    return {
      ...parsed,
      range: editor.selection,
      uri: editor.document.uri,
    };
  };

  const createThresholdEditorConfig = (): ThresholdEditorConfig => {
    thresholdSelection = thresholdSelectionFromEditor();
    if (!thresholdSelection) {
      return { canApplyToEditor: false };
    }
    return {
      mode: thresholdSelection.mode,
      values: thresholdSelection.values,
      canApplyToEditor: true,
    };
  };

  const applyThresholdToSelection = async (text: string) => {
    if (!thresholdSelection) {
      vscode.window.showWarningMessage(t('CanMV: Select a grayscale or LAB threshold tuple before applying.'));
      return;
    }
    const document = await vscode.workspace.openTextDocument(thresholdSelection.uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    await editor.edit((builder) => {
      builder.replace(thresholdSelection!.range, text);
    });
    thresholdSelection = {
      ...thresholdSelection,
      values: parseThresholdTuple(text)?.values || thresholdSelection.values,
      range: new vscode.Range(thresholdSelection.range.start, thresholdSelection.range.start.translate(0, text.length)),
    };
    thresholdEditorPanel?.sendApplied();
  };

  const promptRemoteName = async (prompt: string, value = '') => vscode.window.showInputBox({
    prompt,
    value,
    validateInput: (input) => {
      const name = input.trim();
      if (!name) return t('Name is required');
      if (name.includes('/')) return t('Use a name, not a path');
      return undefined;
    },
  });

  const ensureRemoteFilesAvailable = () => {
    if (remoteFilesAvailable()) return true;
    vscode.window.showWarningMessage(t('CanMV: {message}', { message: remoteFilesUnavailableMessage() }));
    return false;
  };

  const refreshExplorer = () => {
    if (!explorerCanBrowse()) {
      updateExplorerConnectionState();
      return;
    }
    fileService.clearCache();
    explorer?.refresh();
  };

  refreshExplorerSoon = (delayMs = 250) => {
    if (explorerRefreshTimer) {
      clearTimeout(explorerRefreshTimer);
    }
    explorerRefreshTimer = setTimeout(() => {
      explorerRefreshTimer = undefined;
      refreshExplorer();
    }, delayMs);
  };

  // Register read-only remote file system provider
  const fsProvider = new CanmvFileSystemProvider(fileService, {
    isAvailable: () => remoteFilesAvailable(),
    unavailableMessage: () => remoteFilesUnavailableMessage(),
  });
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('canmv', fsProvider)
  );

  const canmvExplorer = new CanmvExplorer({
    listDir: async (path: string) => {
      if (!explorerCanBrowse()) {
        return [];
      }
      return fileService.listDir(path);
    },
    listDirPage: async (path: string, offset: number) => {
      if (!explorerCanBrowse()) {
        return { entries: [] };
      }
      return fileService.listDirPage(path, offset);
    },
  });
  explorer = canmvExplorer;
  const treeView = vscode.window.createTreeView('canmv.explorer', {
    treeDataProvider: canmvExplorer,
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
  context.subscriptions.push(treeView.onDidExpandElement((event) => canmvExplorer.resumeListing(event.element)));
  controlProvider = new CanmvControlViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('canmv.controls', controlProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  controlProvider.setState({
    connected,
    scriptRunning,
    boardReady,
    connectionPhase,
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
    terminalScrollbackSize = 0;
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
    if (!terminalCanSend || !boardReady || connectionBusy || scriptBusy || scriptRunning) {
      updateTerminalInputState();
      return;
    }
    if (!boardSupportsReplInput()) {
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

  const connectBoardRuntime = async (options: ConnectBoardOptions = {}): Promise<BoardInfo | null> => {
    if (connected) return boardService.boardInfo();
    if (!disconnected || connectionBusy || scriptBusy) return null;
    setConnectionPhase('connecting');
    setConnectionBusyContext(true);
    cancelPreviewAutoStart();
    resetBoardReadiness();
    try {
      fileService.clearCache();
      const repl = await boardService.connectBoard(options);
      const info = boardService.boardInfo();
      if (info) {
        setBoardReadyContext(pendingBoardReadyEvent || !boardHasCapabilitiesProtocol());
        updateExplorerConnectionState();
        updateBoardStatus();
        previewPanel?.sendBoardInfo(info);
      } else {
        setBoardReadyContext(false);
      }
      if (repl) appendTerminal(repl);
      updateTerminalInputState();
      mcpBridge?.broadcastSnapshot();
      return info;
    } finally {
      setConnectionBusyContext(false);
      setConnectionPhase('idle');
    }
  };

  const disconnectBoardRuntime = async (): Promise<void> => {
    if (!connected || connectionBusy || scriptBusy) return;
    setConnectionPhase('disconnecting');
    setConnectionBusyContext(true);
    try {
      cancelPreviewAutoStart();
      previewPausedForScript = false;
      clearVirtualTouchState();
      updateVirtualTouchRefreshTimer();
      if (scriptRunning) {
        await stopRunningScript({ stopPreview: true, allowWhileConnectionBusy: true });
      }
      videoService?.clearPreviewState();
      resetBoardReadiness();
      fileService.clearCache();
      await boardService.disconnectBoard();
      setStatusForState('disconnected');
      updateTerminalInputState();
      appendTerminalLine(t('[CanMV] Disconnected'));
      mcpBridge?.broadcastSnapshot();
    } finally {
      setConnectionBusyContext(false);
      setConnectionPhase('idle');
    }
  };

  // Register commands
  disposables = [
    vscode.commands.registerCommand('canmv.connectBoard', async () => {
      await connectBoardRuntime();
    }),
    vscode.commands.registerCommand('canmv.disconnectBoard', async () => {
      await disconnectBoardRuntime();
    }),
    vscode.commands.registerCommand('canmv.runCurrentScript', async () => {
      if (!beginScriptOperation()) return;
      let started = false;
      try {
        if (!(await ensureCanStartScript())) return;
        await stopPreviewBeforeScript();
        started = await scriptService.runCurrentScript();
        if (!started) {
          setScriptRunningContext(false);
        } else {
          setScriptRunningContext(true);
          startPreviewForScript();
          showScriptViews();
        }
      } catch (err) {
        if (!started) {
          setScriptRunningContext(false);
        }
        throw err;
      } finally {
        endScriptOperation();
      }
    }),
    vscode.commands.registerCommand('canmv.stopScript', async () => {
      if (!connected || !scriptRunning || scriptBusy || connectionBusy) return;
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
    vscode.commands.registerCommand('canmv.runExampleFile', async (item?: ExampleTreeItem | vscode.Uri) => {
      const fsPath = item instanceof vscode.Uri ? item.fsPath : item?.fsPath;
      if (!fsPath || !fsPath.toLowerCase().endsWith('.py')) return;
      if (!beginScriptOperation()) return;
      let started = false;
      try {
        if (!(await ensureCanStartScript())) return;
        await stopPreviewBeforeScript();
        const script = fs.readFileSync(fsPath, 'utf8');
        started = await scriptService.runScriptContent(script, path.basename(fsPath));
        if (!started) {
          setScriptRunningContext(false);
        } else {
          setScriptRunningContext(true);
          startPreviewForScript();
          showScriptViews();
        }
      } catch (err) {
        if (!started) {
          setScriptRunningContext(false);
        }
        logError('Script', `Run example failed: ${err}`);
        vscode.window.showErrorMessage(t('CanMV: {message}', { message: err instanceof Error ? err.message : String(err) }));
      } finally {
        endScriptOperation();
      }
    }),
    vscode.commands.registerCommand('canmv.openRemoteFile', async (arg?: vscode.Uri | FileTreeItem) => {
      const path = remotePathFromCommandArg(arg);
      if (!path) return;
      if (!ensureRemoteFilesAvailable()) return;
      try {
        await remoteMirrorService.openRemoteFile(path);
      } catch (err) {
        showRemoteOperationError('Open remote file', err);
      }
    }),
    vscode.commands.registerCommand('canmv.runOnK230', async () => {
      if (!beginScriptOperation()) return;
      let started = false;
      try {
        if (!(await ensureCanStartScript())) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const uri = editor.document.uri;
        const mirroredRemotePath = remoteMirrorService.remotePathForDocument(editor.document);
        if (uri.scheme === 'canmv') {
          if (editor.document.isDirty) await editor.document.save();
          started = await runRemotePathLocked(uri.path);
          return;
        } else if (mirroredRemotePath) {
          if (editor.document.isDirty) await editor.document.save();
          await remoteMirrorService.syncDocumentToRemote(editor.document);
          started = await runRemotePathLocked(mirroredRemotePath);
          return;
        } else {
          await stopPreviewBeforeScript();
          const script = editor.document.getText();
          logInfo('Script', `Run active file on K230: ${uri.fsPath} (${script.length}B)`);
          const req = createRequest(Methods.runScript, { script });
          const result = await session.request(req);
          if (!isResponse(result)) {
            vscode.window.showErrorMessage(t('CanMV: {message}', { message: result.error.message }));
          } else if ((result.result as { status?: string }).status !== 'ok') {
            const payload = result.result as { message?: string; output?: string };
            vscode.window.showWarningMessage(t('CanMV: {message}', { message: payload.message || payload.output || t('Script did not start') }));
          } else {
            started = true;
            setScriptRunningContext(true);
            startPreviewForScript();
            showScriptViews();
          }
        }
      } catch (err) {
        if (!started) {
          setScriptRunningContext(false);
        }
        throw err;
      } finally {
        endScriptOperation();
      }
    }),
    vscode.commands.registerCommand('canmv.saveAsMainPy', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (!ensureRemoteFilesAvailable()) return;
      const text = editor.document.getText();
      const data = new TextEncoder().encode(text);
      try {
        const ok = await fileService.writeFile('/sdcard/main.py', data);
        if (!ok) {
          vscode.window.showWarningMessage(t('CanMV: Save as /sdcard/main.py was rejected by the board'));
          return;
        }
        vscode.window.showInformationMessage(t('CanMV: Saved as /sdcard/main.py'));
      } catch (err) {
        showRemoteOperationError(t('Save as /sdcard/main.py'), err);
      }
    }),
    vscode.commands.registerCommand('canmv.saveAsBootPy', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (!ensureRemoteFilesAvailable()) return;
      const text = editor.document.getText();
      const data = new TextEncoder().encode(text);
      try {
        const ok = await fileService.writeFile('/sdcard/boot.py', data);
        if (!ok) {
          vscode.window.showWarningMessage(t('CanMV: Save as /sdcard/boot.py was rejected by the board'));
          return;
        }
        vscode.window.showInformationMessage(t('CanMV: Saved as /sdcard/boot.py'));
      } catch (err) {
        showRemoteOperationError(t('Save as /sdcard/boot.py'), err);
      }
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
    vscode.commands.registerCommand('canmv.openThresholdEditor', () => {
      openThresholdEditor(createThresholdEditorConfig());
    }),
    vscode.commands.registerCommand('canmv.newRemoteFile', async (item?: FileTreeItem) => {
      item = item ?? selectedExplorerItem();
      if (!connected || !item || item.fileType !== 'directory') return;
      if (!ensureRemoteFilesAvailable()) return;
      const name = await promptRemoteName(t('New file name'));
      if (!name) return;
      const path = childPath(item.absPath, name.trim());
      try {
        const ok = await fileService.writeFile(path, new Uint8Array());
        if (!ok) throw new Error(t('backend rejected the request'));
        refreshExplorer();
        await remoteMirrorService.openRemoteFile(path);
      } catch (err) {
        showRemoteOperationError(t('Create file'), err);
      }
    }),
    vscode.commands.registerCommand('canmv.newRemoteFolder', async (item?: FileTreeItem) => {
      item = item ?? selectedExplorerItem();
      if (!connected || !item || item.fileType !== 'directory') return;
      if (!ensureRemoteFilesAvailable()) return;
      const name = await promptRemoteName(t('New folder name'));
      if (!name) return;
      const path = childPath(item.absPath, name.trim());
      try {
        const ok = await fileService.mkdir(path);
        if (!ok) throw new Error(t('backend rejected the request'));
        refreshExplorer();
      } catch (err) {
        showRemoteOperationError(t('Create folder'), err);
      }
    }),
    vscode.commands.registerCommand('canmv.uploadFiles', async (item?: FileTreeItem) => {
      item = item ?? selectedExplorerItem();
      if (!connected || !item || item.fileType !== 'directory') return;
      if (!ensureRemoteFilesAvailable()) return;
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: t('Upload Files'),
      });
      if (!files || files.length === 0) return;
      const uploads = files.map((file) => {
        const remotePath = childPath(item.absPath, path.basename(file.fsPath));
        return { file, remotePath, totals: fileService.measureUpload(file.fsPath, remotePath) };
      });
      const totalBytes = uploads.reduce((sum, upload) => sum + upload.totals.bytes, 0);
      const totalFiles = uploads.reduce((sum, upload) => sum + upload.totals.files, 0);
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('Uploading files to CanMV') },
          async (progress) => {
            const tracker = { lastBytes: 0 };
            let byteOffset = 0;
            let fileOffset = 0;
            for (const upload of uploads) {
              await fileService.upload(upload.file.fsPath, upload.remotePath, (event) => {
                reportFileTransferProgress(progress, event, tracker, {
                  byteOffset,
                  fileOffset,
                  totalBytes,
                  totalFiles,
                });
              });
              byteOffset += upload.totals.bytes;
              fileOffset += upload.totals.files;
            }
          }
        );
        refreshExplorer();
      } catch (err) {
        showRemoteOperationError(t('Upload files'), err);
      }
    }),
    vscode.commands.registerCommand('canmv.uploadFolder', async (item?: FileTreeItem) => {
      item = item ?? selectedExplorerItem();
      if (!connected || !item || item.fileType !== 'directory') return;
      if (!ensureRemoteFilesAvailable()) return;
      const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: t('Upload Folder'),
      });
      if (!folders || folders.length === 0) return;
      const folder = folders[0];
      const remotePath = childPath(item.absPath, path.basename(folder.fsPath));
      const totals = fileService.measureUpload(folder.fsPath, remotePath);
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('Uploading folder to CanMV') },
          async (progress) => {
            const tracker = { lastBytes: 0 };
            await fileService.upload(folder.fsPath, remotePath, (event) => {
              reportFileTransferProgress(progress, event, tracker, {
                totalBytes: totals.bytes,
                totalFiles: totals.files,
              });
            });
          }
        );
        refreshExplorer();
      } catch (err) {
        showRemoteOperationError(t('Upload folder'), err);
      }
    }),
    vscode.commands.registerCommand('canmv.downloadRemoteItem', async (item?: FileTreeItem) => {
      item = item ?? selectedExplorerItem();
      if (!connected || !item || !item.absPath) return;
      if (!ensureRemoteFilesAvailable()) return;
      const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: t('Download Here'),
        title: t('Select Download Folder'),
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
        const action = item.fileType === 'directory' ? t('Merge and Overwrite') : t('Overwrite');
        const confirmed = await vscode.window.showWarningMessage(
          t('"{name}" already exists in the selected folder.', { name: path.basename(localPath) }),
          { modal: true, detail: item.fileType === 'directory' ? t('Existing files with matching names may be overwritten.') : t('The existing local file will be overwritten.') },
          action
        );
        if (confirmed !== action) return;
      }

      const label = item.fileType === 'directory' ? t('folder') : t('file');
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('Downloading {label} from CanMV', { label }) },
          async (progress) => {
            const tracker = { lastBytes: 0 };
            await fileService.download(item.absPath, localPath, (event) => {
              reportFileTransferProgress(progress, event, tracker);
            });
          }
        );
        void vscode.window.showInformationMessage(t('CanMV: Downloaded {name} to {path}', { name: item.name, path: localPath }));
      } catch (err) {
        showRemoteOperationError(t('Download'), err);
      }
    }),
    vscode.commands.registerCommand('canmv.renameRemoteItem', async (item?: FileTreeItem) => {
      item = item ?? selectedExplorerItem();
      if (!connected || !item || item.contextValue === 'mountRoot') return;
      if (!ensureRemoteFilesAvailable()) return;
      const name = await promptRemoteName(t('New name'), item.name || '');
      if (!name || name.trim() === item.name) return;
      const parent = parentRemotePath(item.absPath);
      const newPath = childPath(parent, name.trim());
      try {
        const ok = await fileService.renameFile(item.absPath, newPath);
        if (!ok) throw new Error(t('backend rejected the request'));
        refreshExplorer();
      } catch (err) {
        showRemoteOperationError(t('Rename'), err);
      }
    }),
    vscode.commands.registerCommand('canmv.deleteRemoteItem', async (item?: FileTreeItem) => {
      item = item ?? selectedExplorerItem();
      if (!connected || !item || item.contextValue === 'mountRoot') return;
      if (!ensureRemoteFilesAvailable()) return;
      const label = item.fileType === 'directory' ? t('folder') : t('file');
      const deleteAction = t('Delete');
      const confirmed = await vscode.window.showWarningMessage(
        t('Delete {label} "{name}" from CanMV?', { label, name: item.name }),
        { modal: true },
        deleteAction
      );
      if (confirmed !== deleteAction) return;
      try {
        const ok = item.fileType === 'directory'
          ? await fileService.rmdir(item.absPath, true)
          : await fileService.deleteFile(item.absPath);
        if (!ok) throw new Error(t('backend rejected the request'));
        refreshExplorer();
      } catch (err) {
        showRemoteOperationError(t('Delete'), err);
      }
    }),
    vscode.commands.registerCommand('canmv.refreshExplorer', () => {
      refreshExplorer();
    }),
    vscode.commands.registerCommand('canmv.refreshExamples', async () => {
      try {
        await canmvResourceService?.ensureDefaultExamples();
      } catch (err) {
        logError('Examples', `Refresh examples failed: ${err}`);
      }
      examplesService?.refresh();
    }),
    vscode.commands.registerCommand('canmv.openExampleFile', async (item?: ExampleTreeItem | vscode.Uri) => {
      const fsPath = item instanceof vscode.Uri ? item.fsPath : item?.fsPath;
      if (!fsPath) return;
      const content = fs.readFileSync(fsPath, 'utf8');
      const doc = await vscode.workspace.openTextDocument({
        content,
        language: languageForExampleFile(fsPath),
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand('canmv.revealExamples', async (item?: ExampleTreeItem) => {
      const target = item?.fsPath || examplesService?.activeExamplesDir() || examplesService?.examplesRootDir();
      if (!target) return;
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
    }),
  ];
  context.subscriptions.push(...disposables);
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
    void remoteMirrorService.syncDocumentToRemote(document).catch((err) => {
      showRemoteOperationError(t('Sync remote file'), err);
    });
  }));

  // Script output events → Output Channel
  backend.onEvent((event) => {
    mcpBridge?.broadcastEvent(event);
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
        void stopPreviewAfterScript();
      }
    } else if (event.event === 'boardReady') {
      markBoardReadyEvent();
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
      cancelPreviewAutoStart();
      previewPausedForScript = false;
      resetBoardReadiness();
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
    const nextConnected = state === 'connected' || state === 'streaming';
    setConnectionContexts(state);
    updateExplorerConnectionState();
    updatePreviewWatchdog();
    updateVirtualTouchRefreshTimer();
    if (state !== 'streaming') {
      clearVirtualTouchState();
    }
    if (!nextConnected) {
      cancelPreviewAutoStart();
      resetBoardReadiness();
      fileService.clearCache();
      setScriptRunningContext(false);
      previewPausedForScript = false;
      clearVirtualTouchState();
      updateVirtualTouchRefreshTimer();
      videoService?.clearPreviewState();
    }
    if (nextConnected) {
      updateBoardStatus();
    } else {
      setStatusForState(state);
    }
    mcpBridge?.broadcastSnapshot();
  });

  const sendBridgeRequest = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<Response | ProtocolError> => {
    const request = createRequest({
      method,
      params: {} as Record<string, unknown>,
      result: {} as unknown,
      errors: {} as Record<number, string>,
    }, params);

    if (method === Methods.detectBoards.method && session.state === 'disconnected') {
      const baudRate = vscode.workspace.getConfiguration('canmv').get<number>('baudRate', 12000000);
      try {
        await backend!.open('__detect__', baudRate);
        return await session.request(request);
      } finally {
        await backend!.close();
      }
    }

    if (method === Methods.connectBoard.method) {
      const requestedPort = typeof params.port === 'string' ? params.port : undefined;
      const current = boardService.boardInfo();
      if (connected && current) {
        if (requestedPort && current.port && requestedPort !== current.port) {
          return {
            id: request.id,
            error: { code: 1003, message: `Already connected to ${current.port}` },
          };
        }
        return {
          id: request.id,
          result: {
            ...current,
            repl: '',
            mcpBridgeReady: boardReady,
            mcpBridgeScriptRunning: scriptRunning,
          },
        };
      }
      const info = await connectBoardRuntime({
        port: requestedPort,
        baudRate: typeof params.baudRate === 'number' ? params.baudRate : undefined,
        interactive: false,
        notify: false,
      });
      if (!info) {
        return { id: request.id, error: { code: 1001, message: 'Unable to connect to the CanMV board' } };
      }
      return {
        id: request.id,
        result: {
          ...info,
          mcpBridgeReady: boardReady,
          mcpBridgeScriptRunning: scriptRunning,
        },
      };
    }

    if (method === Methods.disconnectBoard.method) {
      if (connectionBusy || scriptBusy) {
        return { id: request.id, error: { code: 1003, message: 'Another CanMV operation is in progress' } };
      }
      if (connected) await disconnectBoardRuntime();
      return { id: request.id, result: {} };
    }

    if (!connected) {
      return { id: request.id, error: { code: 1004, message: 'Not connected' } };
    }

    if (method === Methods.startPreview.method) {
      setScriptBusyContext(true);
      try {
        const started = await startPreviewManual();
        if (!started) {
          return { id: request.id, error: { code: 3002, message: 'Unable to start preview' } };
        }
        return { id: request.id, result: { streamId: 'default' } };
      } finally {
        setScriptBusyContext(false);
      }
    }

    if (method === Methods.stopPreview.method) {
      setScriptBusyContext(true);
      try {
        await stopPreviewManual();
        return { id: request.id, result: {} };
      } finally {
        setScriptBusyContext(false);
      }
    }

    setScriptBusyContext(true);
    try {
      if (method === Methods.runScript.method || method === Methods.ioFileExec.method) {
        if (scriptRunning) {
          return { id: request.id, error: { code: 2002, message: 'A script is already running' } };
        }
        await stopPreviewBeforeScript();
      }
      const response = await session.request(request);
      if (!isResponse(response)) return response;

      if (method === Methods.runScript.method || method === Methods.ioFileExec.method) {
        const status = (response.result as { status?: string }).status;
        if (status === 'ok' || status === 'started') {
          setScriptRunningContext(true);
          startPreviewForScript();
          showScriptViews();
        }
      } else if (method === Methods.stopScript.method) {
        setScriptRunningContext(false);
      } else if (method === Methods.scriptRunning.method) {
        setScriptRunningContext((response.result as { running?: boolean }).running === true);
      }
      if (method.startsWith('io.')) refreshExplorerSoon(200);
      return response;
    } finally {
      setScriptBusyContext(false);
    }
  };

  mcpBridge = new McpBridgeServer(context, sendBridgeRequest, () => {
    const info = boardService.boardInfo();
    return {
      board: connected && info ? { ...info, repl: undefined } : undefined,
      boardReady,
      scriptRunning,
      streaming: session.state === 'streaming',
    };
  });
  context.subscriptions.push(mcpBridge);
  try {
    const bridgeInfo = await mcpBridge.start();
    registerMcpSupport(context, bridgeInfo);
  } catch (err) {
    logWarn('MCP', `Local bridge unavailable: ${err instanceof Error ? err.message : String(err)}`);
    registerMcpSupport(context);
  }

  logInfo('Extension', 'Activation complete');
}

interface FileTransferProgressScope {
  byteOffset?: number;
  fileOffset?: number;
  totalBytes?: number;
  totalFiles?: number;
}

function reportFileTransferProgress(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  event: FileTransferProgress,
  tracker: { lastBytes: number },
  scope: FileTransferProgressScope = {},
): void {
  const totalBytes = scope.totalBytes ?? event.totalBytes;
  const totalFiles = scope.totalFiles ?? event.totalFiles;
  const bytesTransferred = Math.min(totalBytes, (scope.byteOffset ?? 0) + event.bytesTransferred);
  const filesTransferred = Math.min(totalFiles, (scope.fileOffset ?? 0) + event.filesTransferred);
  const increment = totalBytes > 0
    ? Math.max(0, (bytesTransferred - tracker.lastBytes) * 100 / totalBytes)
    : undefined;
  tracker.lastBytes = Math.max(tracker.lastBytes, bytesTransferred);

  const name = path.basename(event.path) || event.path;
  let message: string;
  if (event.phase === 'scanning') {
    message = t('Scanning {name}', { name });
  } else if (event.phase === 'hashing') {
    message = t('Hashing {name}', { name });
  } else if (event.phase === 'verifying') {
    message = t('Verifying {name}', { name });
  } else if (totalBytes > 0) {
    const percent = Math.min(100, Math.floor(bytesTransferred * 100 / totalBytes));
    message = `${name} - ${formatTransferSize(bytesTransferred)} / ${formatTransferSize(totalBytes)} (${percent}%)`;
  } else {
    message = name;
  }
  if (totalFiles > 1) {
    message += ` - ${filesTransferred}/${totalFiles} ${t('files')}`;
  }
  progress.report({ message, increment });
}

function formatTransferSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = size;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(unit === 'B' || value >= 10 ? 0 : 1)} ${unit}`;
}

function logActivationInfo(context: vscode.ExtensionContext): void {
  const pkg = context.extension.packageJSON as {
    name?: string;
    displayName?: string;
    publisher?: string;
    version?: string;
  };
  const buildInfo = readBuildInfo(context);
  const extensionId = context.extension.id || [pkg.publisher, pkg.name].filter(Boolean).join('.');
  const mode = vscode.ExtensionMode[context.extensionMode] || String(context.extensionMode);
  const version = pkg.version || 'unknown';
  const displayName = pkg.displayName || pkg.name || extensionId || 'CanMV';
  const commitId = shortCommit(buildInfo.commit) || buildInfo.shortCommit || readGitCommit(context.extensionPath) || 'unknown';

  logInfo('Extension', `Activated ${displayName} ${version}`);
  logInfo('Extension', `ID: ${extensionId || 'unknown'}`);
  logInfo('Extension', `Commit: ${commitId}${buildInfo.dirty ? '-dirty' : ''}`);
  if (buildInfo.builtAt) {
    logInfo('Extension', `Built: ${buildInfo.builtAt}`);
  }
  logInfo('Extension', `Mode: ${mode}`);
  logInfo('Extension', `VS Code: ${vscode.version}`);
  logInfo('Extension', `Runtime: ${process.platform}-${process.arch}, Node ${process.versions.node}, Electron ${process.versions.electron || 'n/a'}`);
  logInfo('Extension', `Path: ${context.extensionPath}`);
}

type BuildInfo = {
  commit?: string;
  shortCommit?: string;
  dirty?: boolean;
  builtAt?: string;
};

function readBuildInfo(context: vscode.ExtensionContext): BuildInfo {
  const file = path.join(context.extensionPath, 'build-info.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as BuildInfo;
  } catch {
    return {};
  }
}

function readGitCommit(extensionPath: string): string {
  try {
    const output = cp.execFileSync('git', ['-C', extensionPath, 'rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim();
  } catch {
    return '';
  }
}

function shortCommit(commit?: string): string {
  return commit ? commit.slice(0, 12) : '';
}

function languageForExampleFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.py': return 'python';
    case '.json': return 'json';
    case '.md': return 'markdown';
    case '.yml':
    case '.yaml': return 'yaml';
    case '.sh': return 'shellscript';
    case '.c':
    case '.h': return 'c';
    case '.cpp':
    case '.hpp': return 'cpp';
    default: return 'plaintext';
  }
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
  await configureResources(canmvResourceService!, commitId);
}

async function configureResources(svc: CanmvResourceService, commitId: string): Promise<void> {
  if (!commitId) {
    logInfo('Stubs', 'No board revision available; using default stubs');
  }
  try {
    if (commitId) {
      await svc.ensureBoardResources(commitId);
    } else {
      await svc.ensureDefaultResources();
    }
  } catch (err) {
    logError('Stubs', `Setup error: ${err}`);
  }
}
