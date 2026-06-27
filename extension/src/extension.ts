import * as cp from 'child_process';
import * as fs from 'fs';
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
import { ThresholdEditorPanel, type ThresholdEditorConfig, type ThresholdMode } from './webview/ThresholdEditorPanel';
import { Methods, createRequest } from './protocol/methods';
import { isResponse } from './protocol/types';
import { logDebug, logError, logInfo, logWarn } from './output';
import { t, states } from './i18n';

let disposables: vscode.Disposable[] = [];
let previewPanel: PreviewPanel | undefined;
let thresholdEditorPanel: ThresholdEditorPanel | undefined;
let terminalViewProvider: TerminalViewProvider | undefined;
let backend: NativeBackend | undefined;
let stubsService: StubsService | undefined;

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

  const boardService = new BoardService(session, new BoardDetector(session));
  const scriptService = new ScriptService(session);
  const fileService = new FileService(session);
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
  let connected = false;
  let disconnected = true;
  let scriptRunning = false;
  let boardReady = false;
  let pendingBoardReadyEvent = false;
  let connectionBusy = false;
  let connectionPhase: 'idle' | 'connecting' | 'disconnecting' = 'idle';
  let scriptBusy = false;
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
  const setScriptBusyContext = (value: boolean) => {
    scriptBusy = value;
    void vscode.commands.executeCommand('setContext', 'canmv.scriptBusy', value);
    updateTerminalInputState();
    updateExplorerConnectionState();
    if (!value) {
      refreshExplorerSoon(250);
    }
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
    if (wasRunning && !value) {
      pauseRemoteFiles(1500);
    }
    void vscode.commands.executeCommand('setContext', 'canmv.scriptRunning', value);
    previewPanel?.sendScriptRunning(value);
    controlProvider?.setState({ scriptRunning: value });
    updateTerminalInputState();
    updateExplorerConnectionState();
    if (!value) {
      refreshExplorerSoon(250);
    }
    onScriptRunningContextChanged();
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
      refreshExplorerSoon(100);
    }, remainingMs);
  };
  const explorerCanBrowse = () => remoteFilesAvailable();
  updateExplorerConnectionState = () => {
    const filesAvailable = remoteFilesAvailable();
    void vscode.commands.executeCommand('setContext', 'canmv.remoteFilesAvailable', filesAvailable);
    const activeExplorer = explorer;
    if (!activeExplorer) return;
    activeExplorer.setConnectionState(filesAvailable, !connected || boardSupportsFileExplorer(), remoteFilesUnavailableMessage());
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

  const startPreviewManual = async () => {
    cancelPreviewAutoStart();
    await waitForPreviewAutoStart();
    previewManuallyStopped = false;
    previewPausedForScript = false;
    previewPanel?.sendPreviewDisabled(false);
    if (session.state !== 'connected') {
      return;
    }
    ensurePreviewPanel();
    const started = await getVideoService()?.startPreview(undefined, undefined, { assumeScriptRunning: assumeScriptRunningForPreview() });
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
      refreshExplorerSoon(300);
      refreshExplorerSoon(1200);
    } finally {
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

  // Register commands
  disposables = [
    vscode.commands.registerCommand('canmv.connectBoard', async () => {
      if (!disconnected || connectionBusy || scriptBusy) return;
      setConnectionPhase('connecting');
      setConnectionBusyContext(true);
      cancelPreviewAutoStart();
      resetBoardReadiness();
      try {
        fileService.clearCache();
        const repl = await boardService.connectBoard();
        const info = boardService.boardInfo();
        if (info) {
          setBoardReadyContext(pendingBoardReadyEvent || !boardHasCapabilitiesProtocol());
          updateExplorerConnectionState();
          updateBoardStatus();
          previewPanel?.sendBoardInfo(info);
        } else {
          setBoardReadyContext(false);
        }
        if (repl) {
          appendTerminal(repl);
        }
        updateTerminalInputState();
      } finally {
        setConnectionBusyContext(false);
        setConnectionPhase('idle');
      }
    }),
    vscode.commands.registerCommand('canmv.disconnectBoard', async () => {
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
      } finally {
        setConnectionBusyContext(false);
        setConnectionPhase('idle');
      }
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
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('Uploading files to CanMV') },
          async (progress) => {
            for (let index = 0; index < files.length; index++) {
              const file = files[index];
              progress.report({ message: path.basename(file.fsPath), increment: files.length ? 100 / files.length : 0 });
              await fileService.upload(file.fsPath, childPath(item.absPath, path.basename(file.fsPath)));
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
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('Uploading folder to CanMV') },
          async (progress) => {
            progress.report({ message: path.basename(folder.fsPath) });
            await fileService.upload(folder.fsPath, remotePath);
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
            progress.report({ message: item.absPath });
            await fileService.download(item.absPath, localPath);
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
          ? await fileService.rmdir(item.absPath)
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
  ];
  context.subscriptions.push(...disposables);
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
    void remoteMirrorService.syncDocumentToRemote(document).catch((err) => {
      showRemoteOperationError(t('Sync remote file'), err);
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
