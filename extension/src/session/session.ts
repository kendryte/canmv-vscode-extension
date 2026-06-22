import * as vscode from 'vscode';
import { Request, Response, ProtocolError, ErrorCodes } from '../protocol/types';
import { logError, logInfo, logWarn } from '../output';

export type SessionState = 'disconnected' | 'connecting' | 'connected' | 'streaming';

interface BackendLike {
  open(path: string, baudRate: number): Promise<void>;
  close(): Promise<void>;
  isOpen(): boolean;
  request(req: Request<string>): Promise<Response | ProtocolError>;
  onDisconnect?: vscode.Event<void>;
}

/**
 * Session manages the UART port lifecycle and request timeout enforcement.
 * Once connected, the port stays open across state transitions
 * (connected↔streaming) until explicit disconnect.
 *
 * request() wraps BackendApi.request() with configurable timeout.
 */
export class Session implements vscode.Disposable {
  private _state: SessionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private autoReconnect: boolean;
  private connectionTimeout: number;
  private requestTimeout: number;
  private lastPath = '';
  private lastBaudRate = 115200;
  private backendDisconnectSubscription?: vscode.Disposable;

  private _onStateChange = new vscode.EventEmitter<SessionState>();
  readonly onStateChange = this._onStateChange.event;

  constructor(
    private backend: BackendLike,
    options?: { autoReconnect?: boolean; connectionTimeout?: number; requestTimeout?: number }
  ) {
    this.autoReconnect = options?.autoReconnect ?? true;
    this.connectionTimeout = options?.connectionTimeout ?? 10000;
    this.requestTimeout = options?.requestTimeout ?? 10000;
    this.backendDisconnectSubscription = this.backend.onDisconnect?.(this.onBackendDisconnect);
  }

  get state(): SessionState {
    return this._state;
  }

  dispose(): void {
    this.clearReconnectTimer();
    this.backendDisconnectSubscription?.dispose();
    this._onStateChange.dispose();
  }

  // ── Connection Lifecycle ──

  async connect(path: string, baudRate: number): Promise<void> {
    if (this._state === 'connecting' || this._state === 'connected' || this._state === 'streaming') {
      return;
    }
    logInfo('Session', `Connect requested: port=${path}, baud=${baudRate}`);
    this.lastPath = path;
    this.lastBaudRate = baudRate;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.transition('connecting');

    try {
      await this.withTimeout(this.backend.open(path, baudRate), this.connectionTimeout);
      this.transition('connected');
    } catch (err) {
      this.transition('disconnected');
      logError('Session', `Connect failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    if (this._state === 'disconnected') return;
    try {
      logInfo('Session', 'Disconnect requested');
      await this.backend.close();
    } finally {
      this.transition('disconnected');
    }
  }

  startStreaming(): void {
    if (this._state !== 'connected') {
      throw new Error(`Cannot start streaming: session is ${this._state}`);
    }
    this.transition('streaming');
  }

  stopStreaming(): void {
    if (this._state !== 'streaming') return;
    this.transition('connected');
  }

  // ── Request Proxy (with timeout enforcement) ──

  /**
   * Send a protocol Request with timeout enforcement.
   * Session layer owns timeout — BackendApi has no built-in timeout.
   */
  async request(req: Request<string>): Promise<Response | ProtocolError> {
    try {
      return await this.withTimeout(
        this.backend.request(req),
        this.requestTimeout
      );
    } catch {
      logWarn('Session', `Request timed out: ${req.method}`);
      return {
        id: req.id,
        error: {
          code: ErrorCodes.CONNECTION.TIMEOUT,
          message: `Request '${req.method}' timed out after ${this.requestTimeout}ms`,
        },
      };
    }
  }

  // ── Auto-reconnect ──

  private onBackendDisconnect = (): void => {
    if (!this.autoReconnect) {
      logWarn('Session', 'Backend disconnected; auto-reconnect disabled');
      this.transition('disconnected');
      return;
    }
    logWarn('Session', 'Backend disconnected; scheduling reconnect');
    this.scheduleReconnect();
  };

  private scheduleReconnect(): void {
    const delays = [1000, 2000, 4000, 8000, 16000, 30000];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt++;
    logInfo('Session', `Reconnect attempt ${this.reconnectAttempt} in ${delay}ms`);
    this.transition('connecting');

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.withTimeout(this.backend.open(this.lastPath, this.lastBaudRate), this.connectionTimeout);
        this.reconnectAttempt = 0;
        this.transition('connected');
      } catch (err) {
        logWarn('Session', `Reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private transition(newState: SessionState): void {
    if (this._state === newState) return;
    logInfo('Session', `State: ${this._state} -> ${newState}`);
    this._state = newState;
    this._onStateChange.fire(newState);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms)
      ),
    ]);
  }
}
