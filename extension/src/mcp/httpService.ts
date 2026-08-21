import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { logInfo, logWarn } from '../output';

const HTTP_PORT_STATE_KEY = 'canmv.mcp.httpPort';
const HTTP_START_TIMEOUT_MS = 10_000;
const HTTP_STOP_TIMEOUT_MS = 5_000;
const HTTP_KILL_TIMEOUT_MS = 1_000;
const HTTP_RESTART_MAX_DELAY_MS = 10_000;

export interface McpHttpConnectionInfo {
  url: string;
  port: number;
  token: string;
  headers: Record<string, string>;
}

type ReadyMessage = {
  type: 'ready';
  host: string;
  port: number;
};

type StartedChild = {
  child: cp.ChildProcess;
  ready: ReadyMessage;
};

export class McpHttpService implements vscode.Disposable {
  private child: cp.ChildProcess | undefined;
  private connectionInfo: McpHttpConnectionInfo | undefined;
  private startPromise: Promise<McpHttpConnectionInfo> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private restartAttempts = 0;
  private readonly expectedExits = new WeakSet<cp.ChildProcess>();
  private readonly connectionChanged = new vscode.EventEmitter<McpHttpConnectionInfo | undefined>();
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly serverEnv: () => Record<string, string | number | null>,
  ) {}

  readonly onDidChangeConnection = this.connectionChanged.event;

  start(): Promise<McpHttpConnectionInfo> {
    if (this.disposed) return Promise.reject(new Error('CanMV MCP HTTP service has been disposed'));
    if (this.connectionInfo) return Promise.resolve(this.connectionInfo);
    const operation = this.beginStart();
    void operation.catch(() => {
      const preferredPort = this.context.globalState.get<number>(HTTP_PORT_STATE_KEY, 0);
      this.scheduleRestart(preferredPort);
    });
    return operation;
  }

  async restart(): Promise<McpHttpConnectionInfo> {
    if (this.disposed) throw new Error('CanMV MCP HTTP service has been disposed');
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // A fresh start below supersedes the failed attempt.
      }
    }
    const preferredPort = this.connectionInfo?.port
      || this.context.globalState.get<number>(HTTP_PORT_STATE_KEY, 0);
    this.cancelScheduledRestart();
    this.setConnection(undefined);
    await this.stopChild();
    try {
      return await this.beginStart(preferredPort);
    } catch (err) {
      this.scheduleRestart(preferredPort);
      throw err;
    }
  }

  private beginStart(preferredPort?: number): Promise<McpHttpConnectionInfo> {
    if (this.startPromise) return this.startPromise;
    const operation = this.startService(preferredPort).finally(() => {
      if (this.startPromise === operation) this.startPromise = undefined;
    });
    this.startPromise = operation;
    return operation;
  }

  private async startService(preferredPort?: number): Promise<McpHttpConnectionInfo> {
    if (this.disposed) throw new Error('CanMV MCP HTTP service has been disposed');

    const token = readOrCreateHttpToken(this.context);
    const pkg = this.context.extension.packageJSON as { version?: string };
    const version = pkg.version || 'unknown';
    const env = this.serverEnv();
    const configurationId = httpConfigurationId(env);
    env.CANMV_MCP_CONFIGURATION_ID = configurationId;
    const savedPort = validPort(preferredPort)
      || validPort(this.context.globalState.get<number>(HTTP_PORT_STATE_KEY, 0));
    if (savedPort > 0 && await probeHttpService(savedPort, token, version, configurationId)) {
      const existing = connectionInfo(savedPort, token);
      this.setConnection(existing);
      logInfo('MCP', `Using existing Streamable HTTP service at ${existing.url}`);
      return existing;
    }

    let started: StartedChild;
    try {
      started = await this.startChild(savedPort, token, env);
    } catch (err) {
      if (savedPort <= 0) throw err;
      logWarn('MCP', `Unable to reuse MCP HTTP port ${savedPort}: ${errorMessage(err)}; selecting a new port`);
      started = await this.startChild(0, token, env);
    }
    if (this.child !== started.child || !childIsRunning(started.child)) {
      throw new Error('MCP HTTP service exited immediately after startup');
    }
    try {
      await this.context.globalState.update(HTTP_PORT_STATE_KEY, started.ready.port);
    } catch (err) {
      logWarn('MCP', `Unable to remember MCP HTTP port ${started.ready.port}: ${errorMessage(err)}`);
    }
    if (this.child !== started.child || !childIsRunning(started.child)) {
      throw new Error('MCP HTTP service exited immediately after startup');
    }
    const connection = connectionInfo(started.ready.port, token);
    this.setConnection(connection);
    logInfo('MCP', `Streamable HTTP service ready at ${connection.url}`);
    return connection;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelScheduledRestart();
    this.connectionInfo = undefined;
    this.connectionChanged.dispose();
    void this.stopChild();
  }

  private startChild(
    port: number,
    token: string,
    serverEnv: Record<string, string | number | null>,
  ): Promise<StartedChild> {
    const serverPath = path.join(this.context.extensionPath, 'out', 'mcp', 'server.js');
    if (!fs.existsSync(serverPath)) {
      return Promise.reject(new Error(`CanMV MCP server script not found: ${serverPath}`));
    }
    const listenHost = '127.0.0.1';
    return new Promise((resolve, reject) => {
      const child = cp.spawn(process.execPath, [serverPath], {
        cwd: this.context.extensionPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          ...stringEnvironment(serverEnv),
          ELECTRON_RUN_AS_NODE: '1',
          CANMV_MCP_HTTP_HOST: listenHost,
          CANMV_MCP_HTTP_PORT: String(port),
          CANMV_MCP_HTTP_TOKEN: token,
        },
      });
      this.child = child;
      let settled = false;
      let stdout = '';
      const finish = (err?: Error, ready?: ReadyMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          if (this.child === child) this.child = undefined;
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          reject(err);
        } else if (ready) {
          resolve({ child, ready });
        }
      };
      const timer = setTimeout(() => finish(new Error(`MCP HTTP service did not start within ${HTTP_START_TIMEOUT_MS}ms`)), HTTP_START_TIMEOUT_MS);
      timer.unref?.();
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        for (;;) {
          const newline = stdout.indexOf('\n');
          if (newline < 0) break;
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (!line) continue;
          try {
            const message = JSON.parse(line) as Partial<ReadyMessage>;
            if (message.type === 'ready' && typeof message.port === 'number' && message.port > 0) {
              finish(undefined, message as ReadyMessage);
            }
          } catch {
            logWarn('MCP', `Unexpected MCP HTTP service output: ${line.slice(0, 500)}`);
          }
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        const message = chunk.trim();
        if (message) logInfo('MCP Server', message);
      });
      child.once('error', (err) => finish(err));
      child.once('exit', (code, signal) => {
        const wasCurrent = this.child === child;
        if (wasCurrent) this.child = undefined;
        if (!settled) {
          finish(new Error(`MCP HTTP service exited before startup: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
        } else if (!this.disposed && !this.expectedExits.has(child)) {
          logWarn('MCP', `Streamable HTTP service exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
          if (wasCurrent && this.connectionInfo) {
            const preferredPort = this.connectionInfo.port;
            this.setConnection(undefined);
            this.scheduleRestart(preferredPort);
          }
        }
      });
    });
  }

  private stopChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || !childIsRunning(child)) return Promise.resolve();
    this.expectedExits.add(child);
    return new Promise((resolve) => {
      let settled = false;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (stopTimer) clearTimeout(stopTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve();
      };
      stopTimer = setTimeout(() => {
        if (!childIsRunning(child)) {
          finish();
          return;
        }
        try {
          child.kill('SIGKILL');
        } catch {
          finish();
          return;
        }
        killTimer = setTimeout(finish, HTTP_KILL_TIMEOUT_MS);
        killTimer.unref?.();
      }, HTTP_STOP_TIMEOUT_MS);
      stopTimer.unref?.();
      child.once('exit', finish);
      if (!childIsRunning(child)) {
        finish();
        return;
      }
      try {
        child.kill('SIGTERM');
      } catch {
        finish();
      }
    });
  }

  private scheduleRestart(preferredPort: number): void {
    if (this.disposed || this.restartTimer) return;
    const delay = Math.min(500 * (2 ** this.restartAttempts), HTTP_RESTART_MAX_DELAY_MS);
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.beginStart(preferredPort).catch((err) => {
        logWarn('MCP', `Unable to restart Streamable HTTP service: ${errorMessage(err)}`);
        this.scheduleRestart(preferredPort);
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  private cancelScheduledRestart(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private setConnection(connection: McpHttpConnectionInfo | undefined): void {
    const previous = this.connectionInfo;
    if (previous?.url === connection?.url && previous?.token === connection?.token) return;
    this.connectionInfo = connection;
    if (connection) this.restartAttempts = 0;
    this.connectionChanged.fire(connection);
  }
}

function connectionInfo(port: number, token: string): McpHttpConnectionInfo {
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    token,
    headers: { Authorization: `Bearer ${token}` },
  };
}

function stringEnvironment(env: Record<string, string | number | null>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== null) result[key] = String(value);
  }
  return result;
}

function readOrCreateHttpToken(context: vscode.ExtensionContext): string {
  const storagePath = context.globalStorageUri.fsPath;
  const tokenPath = path.join(storagePath, 'mcp-http-token');
  fs.mkdirSync(storagePath, { recursive: true, mode: 0o700 });
  try {
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(token)) {
      if (process.platform !== 'win32') fs.chmodSync(tokenPath, 0o600);
      return token;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(tokenPath, token + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(existing)) {
      if (process.platform !== 'win32') fs.chmodSync(tokenPath, 0o600);
      return existing;
    }
    throw new Error(`Invalid CanMV MCP HTTP token file: ${tokenPath}`);
  }
}

function probeHttpService(port: number, token: string, version: string, configurationId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/health',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeout: 500,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          resolve(response.statusCode === 200
            && body.service === 'canmv-k230'
            && body.transport === 'streamable-http'
            && body.version === version
            && body.configurationId === configurationId);
        } catch {
          resolve(false);
        }
      });
    });
    request.once('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.once('error', () => resolve(false));
    request.end();
  });
}

function httpConfigurationId(env: Record<string, string | number | null>): string {
  const entries = Object.entries(env).sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function validPort(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
    ? value
    : 0;
}

function childIsRunning(child: cp.ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
