import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BackendApi } from './api';
import { Request, Response, ProtocolError, Event } from '../protocol/types';
import { JsonCodec, WireMessage } from '../protocol/codec';
import { Methods, createRequest, resetRequestId } from '../protocol/methods';
import { FramedMessageReader, MSG_REQUEST, MAGIC } from '../protocol/framed_reader';
import { isResponse, isError, isEvent } from '../protocol/types';
import { logDebug, logError, logInfo, logWarn } from '../output';

export class NativeBackend implements BackendApi {
  private process: cp.ChildProcess | null = null;
  private _isOpen = false;
  private closingProcess: cp.ChildProcess | null = null;

  constructor(private context: vscode.ExtensionContext) {
    const cleanup = () => this.disposeSync();
    context.subscriptions.push({ dispose: cleanup });
    process.once('exit', cleanup);
  }

  private pendingRequests = new Map<number, {
    method: string;
    startedAt: number;
    resolve: (r: Response | ProtocolError) => void;
  }>();
  private stderrRemainder = '';

  private _onEvent = new vscode.EventEmitter<Event<string>>();
  private _onDisconnect = new vscode.EventEmitter<void>();

  readonly onEvent = this._onEvent.event;
  readonly onDisconnect = this._onDisconnect.event;

  private codec = new JsonCodec();

  private reader: FramedMessageReader = new FramedMessageReader({
    onMessage: (msg) => this.handleProtocolMessage(msg),
    onFrame: (frameId, data, chunkTs, dispatchTs) => this._onEvent.fire({
      event: 'frameAvailable',
      params: { data, frameId, streamId: 'default', chunkTs, dispatchTs },
    }),
  });

  async open(_serialPath: string, _baudRate: number): Promise<void> {
    if (this._isOpen) return;
    if (this.process) {
      await this.close();
    }

    resetRequestId();

    const backend = resolveNativeBackendCommand(this.context);
    logInfo('Backend', `Starting ${backend.label}: ${backend.command}${backend.args.length ? ' ' + backend.args.join(' ') : ''}`);

    this.process = cp.spawn(backend.command, backend.args, {
      cwd: backend.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      detached: process.platform !== 'win32',
    });
    const child = this.process;
    child.unref();

    child.on('error', (err: Error) => {
      logError('Backend', `Spawn error: ${err.message}`);
      if (this.process === child) {
        this._isOpen = false;
      }
    });

    child.on('exit', (code, signal) => {
      this.flushBackendStderr();
      if (this.process !== child) {
        logDebug('Backend', `Previous backend exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
        return;
      }
      const expectedClose = this.closingProcess === child;
      if (expectedClose) {
        logInfo('Backend', `${backend.label} stopped (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      } else {
        logWarn('Backend', `${backend.label} exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      }
      this._isOpen = false;
      this.process = null;
      if (this.closingProcess === child) {
        this.closingProcess = null;
      }
      if (!expectedClose) {
        this._onDisconnect.fire();
        this._onEvent.fire({ event: 'boardDisconnected', params: {} });
      }
      for (const [, pending] of this.pendingRequests) {
        pending.resolve({ id: 0, error: { code: 1004, message: 'Connection lost' } });
      }
      this.pendingRequests.clear();
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      this.reader.handleData(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.handleBackendStderr(chunk);
    });

    this._isOpen = true;
    logDebug('Backend', 'Backend process is ready');
  }

  async close(): Promise<void> {
    const child = this.process;
    if (child) {
      logInfo('Backend', 'Stopping backend');
      this.closingProcess = child;
      await this.requestBackendDisconnect(child);
      child.stdin?.end();
      const exited = await waitForExit(child, 1500);
      if (!exited) {
        logWarn('Backend', 'Backend did not exit after graceful disconnect; terminating');
        signalChildProcess(child, 'SIGTERM');
        const terminated = await waitForExit(child, 1000);
        if (!terminated) {
          signalChildProcess(child, 'SIGKILL');
          await waitForExit(child, 500);
        }
      }
      if (this.process === child) {
        this.process = null;
      }
      if (this.closingProcess === child) {
        this.closingProcess = null;
      }
    }
    this._isOpen = false;
    this.reader.reset();
    for (const [, pending] of this.pendingRequests) {
      pending.resolve({ id: 0, error: { code: 1004, message: 'Not connected' } });
    }
    this.pendingRequests.clear();
  }

  disposeSync(): void {
    const child = this.process;
    if (!child) {
      return;
    }
    this.closingProcess = child;
    try {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    } catch {
      // Process shutdown can happen after stdio handles are already closed.
    }
    if (child.exitCode === null && child.signalCode === null) {
      signalChildProcess(child, 'SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          signalChildProcess(child, 'SIGKILL');
        }
      }, 3000);
      killTimer.unref();
    }
    this.process = null;
    this._isOpen = false;
    this.reader.reset();
    for (const [, pending] of this.pendingRequests) {
      pending.resolve({ id: 0, error: { code: 1004, message: 'Not connected' } });
    }
    this.pendingRequests.clear();
  }

  isOpen(): boolean {
    return this._isOpen;
  }

  async request(req: Request<string>): Promise<Response | ProtocolError> {
    return new Promise((resolve) => {
      const wire: WireMessage = this.codec.encodeRequest(req);
      this.pendingRequests.set(req.id, { method: req.method, startedAt: Date.now(), resolve });
      if (!this.process?.stdin?.writable) {
        logError('Backend', `Cannot send ${req.method}: backend stdin is not writable`);
        resolve({ id: req.id, error: { code: 1004, message: 'Backend stdin not available' } });
        this.pendingRequests.delete(req.id);
        return;
      }
      const payload = Buffer.from(wire, 'utf-8');
      const header = Buffer.alloc(7);
      header[0] = MAGIC[0]; header[1] = MAGIC[1];
      header[2] = MSG_REQUEST;
      header.writeUInt32LE(payload.length, 3);
      this.process.stdin.write(header);
      this.process.stdin.write(payload);
    });
  }

  notify(req: Request<string>): void {
    if (!this.process?.stdin?.writable) {
      logError('Backend', `Cannot send ${req.method}: backend stdin is not writable`);
      return;
    }
    const payload = Buffer.from(this.codec.encodeRequest({ ...req, id: 0 }), 'utf-8');
    const header = Buffer.alloc(7);
    header[0] = MAGIC[0]; header[1] = MAGIC[1];
    header[2] = MSG_REQUEST;
    header.writeUInt32LE(payload.length, 3);
    this.process.stdin.write(header);
    this.process.stdin.write(payload);
  }

  // ── Protocol message dispatch (replaces old processJsonLines / processPendingFrame) ──

  private handleProtocolMessage(msg: Response | ProtocolError | Event<string>): void {
    if (isResponse(msg) || isError(msg)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        const elapsed = Date.now() - pending.startedAt;
        if (isError(msg)) {
          logError('Backend', `${pending.method} failed after ${elapsed}ms: ${msg.error.message}`);
        }
        pending.resolve(msg as Response | ProtocolError);
        this.pendingRequests.delete(msg.id);
      }
    } else if (isEvent(msg)) {
      this._onEvent.fire(msg);
    }
  }

  private handleBackendStderr(chunk: Buffer): void {
    this.stderrRemainder += chunk.toString('utf8');
    const lines = this.stderrRemainder.split(/\r?\n/);
    this.stderrRemainder = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed) {
        logDebug('Backend', trimmed);
      }
    }
  }

  private flushBackendStderr(): void {
    const line = this.stderrRemainder.trim();
    if (line) {
      logDebug('Backend', line);
    }
    this.stderrRemainder = '';
  }

  private async requestBackendDisconnect(child: cp.ChildProcess): Promise<void> {
    if (!child.stdin?.writable || this.process !== child) {
      return;
    }
    try {
      const result = await withTimeout(
        this.request(createRequest(Methods.disconnectBoard, {})),
        3000
      );
      if (isError(result)) {
        logWarn('Backend', `Graceful disconnect failed: ${result.error.message}`);
      }
    } catch {
      logWarn('Backend', 'Graceful disconnect timed out');
    }
  }

}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function waitForExit(child: cp.ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function signalChildProcess(child: cp.ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to direct child signaling below.
    }
  }
  child.kill(signal);
}

export interface BackendCommand {
  label: string;
  command: string;
  args: string[];
  cwd: string;
}

function executableName(): string {
  return process.platform === 'win32' ? 'canmv-backend.exe' : 'canmv-backend';
}

function platformTarget(): string {
  const arch = process.arch === 'x64' ? 'x64' : process.arch;
  if (process.platform === 'win32') return `win32-${arch}`;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'linux') return `linux-${arch}`;
  return `${process.platform}-${arch}`;
}

export function resolveNativeBackendCommand(
  context: vscode.ExtensionContext,
  options: { preferPackaged?: boolean } = {},
): BackendCommand {
  const override = process.env.CANMV_BACKEND_PATH || vscode.workspace.getConfiguration('canmv').get<string>('backendPath', '');
  const packaged = path.join(context.extensionPath, 'bin', platformTarget(), executableName());

  if (options.preferPackaged && fs.existsSync(packaged)) {
    return {
      label: 'Go backend',
      command: packaged,
      args: [],
      cwd: path.dirname(packaged),
    };
  }

  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`Configured CanMV backend executable not found: ${override}`);
    }
    return {
      label: 'configured backend',
      command: override,
      args: [],
      cwd: path.dirname(override),
    };
  }

  if (!fs.existsSync(packaged)) {
    throw new Error(`CanMV Go backend executable not found for ${platformTarget()}. Set canmv.backendPath or install a platform-specific extension package.`);
  }
  return {
    label: 'Go backend',
    command: packaged,
    args: [],
    cwd: path.dirname(packaged),
  };
}
