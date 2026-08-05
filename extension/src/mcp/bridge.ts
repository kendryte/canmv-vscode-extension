import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Event, ProtocolError, Response } from '../protocol/types';
import { logDebug, logInfo, logWarn } from '../output';

const MAX_BRIDGE_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface McpBridgeSnapshot {
  board?: Record<string, unknown>;
  boardReady: boolean;
  scriptRunning: boolean;
  streaming: boolean;
}

export interface McpBridgeConnectionInfo {
  endpoint: string;
  token: string;
}

export type McpBridgeRequestHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Response | ProtocolError>;

type BridgeClient = {
  socket: net.Socket;
  authenticated: boolean;
  buffer: string;
  queue: Promise<void>;
};

export class McpBridgeServer implements vscode.Disposable {
  private readonly server = net.createServer((socket) => this.accept(socket));
  private readonly clients = new Set<BridgeClient>();
  private requestQueue: Promise<void> = Promise.resolve();
  private connectionInfo: McpBridgeConnectionInfo | undefined;
  private ownsEndpoint = false;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly handleRequest: McpBridgeRequestHandler,
    private readonly getSnapshot: () => McpBridgeSnapshot,
  ) {}

  async start(): Promise<McpBridgeConnectionInfo> {
    if (this.connectionInfo) return this.connectionInfo;
    if (this.disposed) throw new Error('CanMV MCP bridge has been disposed');

    const endpoint = createBridgeEndpoint(this.context);
    const token = readOrCreateBridgeToken(this.context);
    if (await isBridgeEndpointActive(endpoint)) {
      this.connectionInfo = { endpoint, token };
      logInfo('MCP', `Using existing local bridge at ${endpoint}`);
      return this.connectionInfo;
    }
    if (process.platform !== 'win32' && fs.existsSync(endpoint)) {
      fs.unlinkSync(endpoint);
    }
    await this.listen(endpoint);
    if (process.platform !== 'win32') {
      fs.chmodSync(endpoint, 0o600);
    }
    this.ownsEndpoint = true;
    this.connectionInfo = { endpoint, token };
    logInfo('MCP', `Local bridge listening at ${endpoint}`);
    return this.connectionInfo;
  }

  private listen(endpoint: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(endpoint);
    });
  }

  broadcastEvent(event: Event<string>): void {
    if (event.event === 'frameAvailable') {
      const params = event.params as {
        data?: ArrayBuffer | Uint8Array;
        frameId?: number;
        chunkTs?: number;
        dispatchTs?: number;
      };
      const data = params.data ? Buffer.from(asUint8Array(params.data)) : Buffer.alloc(0);
      this.broadcast({
        type: 'frame',
        frameId: params.frameId || 0,
        dataBase64: data.toString('base64'),
        chunkTs: params.chunkTs,
        dispatchTs: params.dispatchTs,
      });
      return;
    }
    this.broadcast({ type: 'event', event });
  }

  broadcastSnapshot(): void {
    this.broadcast({
      type: 'event',
      event: { event: 'mcpBridgeSnapshot', params: this.getSnapshot() },
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const client of this.clients) {
      client.socket.destroy();
    }
    this.clients.clear();
    if (this.ownsEndpoint) this.server.close();
    const endpoint = this.connectionInfo?.endpoint;
    this.connectionInfo = undefined;
    if (this.ownsEndpoint && endpoint && process.platform !== 'win32') {
      try {
        fs.unlinkSync(endpoint);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logDebug('MCP', `Unable to remove bridge socket: ${errorMessage(err)}`);
        }
      }
    }
    this.ownsEndpoint = false;
  }

  private accept(socket: net.Socket): void {
    socket.setEncoding('utf8');
    const client: BridgeClient = { socket, authenticated: false, buffer: '', queue: Promise.resolve() };
    this.clients.add(client);
    socket.on('data', (chunk: string) => this.handleData(client, chunk));
    socket.on('error', (err) => logDebug('MCP', `Bridge client error: ${err.message}`));
    socket.on('close', () => this.clients.delete(client));
  }

  private handleData(client: BridgeClient, chunk: string): void {
    client.buffer += chunk;
    if (Buffer.byteLength(client.buffer) > MAX_BRIDGE_MESSAGE_BYTES) {
      logWarn('MCP', 'Closing bridge client after oversized message');
      client.socket.destroy();
      return;
    }
    for (;;) {
      const newline = client.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = client.buffer.slice(0, newline).trim();
      client.buffer = client.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.write(client, { type: 'error', message: 'Invalid bridge JSON' });
        client.socket.destroy();
        return;
      }
      client.queue = client.queue.then(() => this.handleMessage(client, message)).catch((err) => {
        logWarn('MCP', `Bridge request failed: ${errorMessage(err)}`);
      });
    }
  }

  private async handleMessage(client: BridgeClient, message: Record<string, unknown>): Promise<void> {
    if (!client.authenticated) {
      if (message.type !== 'hello' || message.token !== this.connectionInfo?.token) {
        this.write(client, { type: 'hello', ok: false });
        client.socket.destroy();
        return;
      }
      client.authenticated = true;
      this.write(client, { type: 'hello', ok: true, snapshot: this.getSnapshot() });
      return;
    }

    if (message.type !== 'request' || typeof message.id !== 'number' || typeof message.method !== 'string') {
      this.write(client, { type: 'error', message: 'Invalid bridge request' });
      return;
    }
    const id = message.id;
    const params = asObject(message.params);
    try {
      const operation = this.requestQueue.then(() => this.handleRequest(message.method as string, params));
      this.requestQueue = operation.then(() => undefined, () => undefined);
      const response = await operation;
      this.write(client, { type: 'response', response: { ...response, id } });
    } catch (err) {
      this.write(client, {
        type: 'response',
        response: { id, error: { code: 9001, message: errorMessage(err) } },
      });
    }
  }

  private broadcast(message: Record<string, unknown>): void {
    for (const client of this.clients) {
      if (client.authenticated) this.write(client, message);
    }
  }

  private write(client: BridgeClient, message: Record<string, unknown>): void {
    if (client.socket.writable) {
      client.socket.write(JSON.stringify(message) + '\n');
    }
  }
}

function createBridgeEndpoint(context: vscode.ExtensionContext): string {
  const id = crypto.createHash('sha256').update(context.globalStorageUri.fsPath).digest('hex').slice(0, 20);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\canmv-mcp-${id}`;
  }
  return path.join(os.tmpdir(), `canmv-mcp-${id}.sock`);
}

function readOrCreateBridgeToken(context: vscode.ExtensionContext): string {
  const storagePath = context.globalStorageUri.fsPath;
  const tokenPath = path.join(storagePath, 'mcp-bridge-token');
  fs.mkdirSync(storagePath, { recursive: true });
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
    throw new Error(`Invalid CanMV MCP bridge token file: ${tokenPath}`);
  }
}

function isBridgeEndpointActive(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    const finish = (active: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(active);
    };
    const timer = setTimeout(() => finish(false), 250);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
