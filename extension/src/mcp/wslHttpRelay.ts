import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { logInfo, logWarn } from '../output';
import { FramedMessageReader, MAGIC, MSG_REQUEST } from '../protocol/framed_reader';
import { isEvent } from '../protocol/types';
import type { McpHttpConnectionInfo } from './httpService';

const RELAY_START_TIMEOUT_MS = 10_000;
const RELAY_REQUEST_TIMEOUT_MS = 120_000;
const MAX_RELAY_BODY_BYTES = 32 * 1024 * 1024;
const WSL_RELAY_PORT_STATE_KEY_PREFIX = 'canmv.mcp.wslRelayPort.';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface WslHttpRelayConnectionInfo {
  url: string;
  port: number;
}

type RelayInstance = {
  child: cp.ChildProcess;
  connection: WslHttpRelayConnectionInfo;
};

type RelayRequest = {
  requestId: number;
  method: string;
  path: string;
  headers: Record<string, string[]>;
  body: Buffer;
};

export class WslHttpRelayService implements vscode.Disposable {
  private readonly instances = new Map<string, RelayInstance>();
  private readonly starts = new Map<string, Promise<WslHttpRelayConnectionInfo>>();
  private readonly startingChildren = new Set<cp.ChildProcess>();
  private generation = 0;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  start(
    wsl: string,
    distro: string,
    upstream: McpHttpConnectionInfo,
  ): Promise<WslHttpRelayConnectionInfo> {
    if (this.disposed) return Promise.reject(new Error('CanMV WSL HTTP relay has been disposed'));
    const existing = this.instances.get(distro);
    if (existing) return Promise.resolve(existing.connection);
    const pending = this.starts.get(distro);
    if (pending) return pending;
    const generation = this.generation;
    let start: Promise<WslHttpRelayConnectionInfo>;
    start = this.startWithSavedPort(wsl, distro, upstream, generation)
      .finally(() => {
        if (this.starts.get(distro) === start) this.starts.delete(distro);
      });
    this.starts.set(distro, start);
    return start;
  }

  reset(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.stopInstances();
    this.starts.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.stopInstances();
    this.starts.clear();
  }

  private stopInstances(): void {
    for (const instance of this.instances.values()) {
      stopRelayChild(instance.child);
    }
    for (const child of this.startingChildren) stopRelayChild(child);
    this.instances.clear();
    this.startingChildren.clear();
  }

  private async startWithSavedPort(
    wsl: string,
    distro: string,
    upstream: McpHttpConnectionInfo,
    generation: number,
  ): Promise<WslHttpRelayConnectionInfo> {
    const stateKey = relayPortStateKey(distro);
    const savedPort = validPort(this.context.globalState.get<number>(stateKey, 0));
    let connection: WslHttpRelayConnectionInfo;
    try {
      connection = await this.startRelay(wsl, distro, upstream, savedPort, generation);
    } catch (err) {
      if (this.disposed || this.generation !== generation) throw err;
      if (savedPort === 0) throw err;
      logWarn('MCP', `Unable to reuse WSL HTTP relay port ${savedPort} in ${distro}: ${errorMessage(err)}; selecting a new port`);
      connection = await this.startRelay(wsl, distro, upstream, 0, generation);
    }
    if (this.disposed || this.generation !== generation) {
      throw new Error('CanMV WSL HTTP relay startup was superseded');
    }
    try {
      await this.context.globalState.update(stateKey, connection.port);
    } catch (err) {
      logWarn('MCP', `Unable to remember WSL HTTP relay port ${connection.port} for ${distro}: ${errorMessage(err)}`);
    }
    return connection;
  }

  private async startRelay(
    wsl: string,
    distro: string,
    upstream: McpHttpConnectionInfo,
    port: number,
    generation: number,
  ): Promise<WslHttpRelayConnectionInfo> {
    const relayPath = await this.resolveRelayPath(wsl, distro);
    if (this.disposed || this.generation !== generation) {
      throw new Error('CanMV WSL HTTP relay startup was superseded');
    }
    return new Promise((resolve, reject) => {
      const child = cp.spawn(wsl, ['-d', distro, '--', relayPath, '--http-relay', String(port)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.startingChildren.add(child);
      let settled = false;
      let relayConnection: WslHttpRelayConnectionInfo | undefined;
      const finish = (err?: Error, connection?: WslHttpRelayConnectionInfo) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.startingChildren.delete(child);
          stopRelayChild(child);
          reject(err);
          return;
        }
        if (!connection) return;
        if (this.disposed || this.generation !== generation) {
          this.startingChildren.delete(child);
          stopRelayChild(child);
          reject(new Error('CanMV WSL HTTP relay startup was superseded'));
          return;
        }
        this.startingChildren.delete(child);
        const instance = { child, connection };
        this.instances.set(distro, instance);
        resolve(connection);
      };
      const timer = setTimeout(() => {
        finish(new Error(`WSL HTTP relay did not start within ${RELAY_START_TIMEOUT_MS}ms`));
      }, RELAY_START_TIMEOUT_MS);
      timer.unref?.();

      const reader = new FramedMessageReader({
        onMessage: (message) => {
          if (!isEvent(message)) return;
          const params = asObject(message.params);
          if (message.event === 'httpRelayReady') {
            const port = integerValue(params.port);
            if (port > 0 && port <= 65535) {
              if (relayConnection) return;
              relayConnection = { url: `http://127.0.0.1:${port}/mcp`, port };
              logInfo('MCP', `WSL HTTP relay listening in ${distro} at ${relayConnection.url}; validating end-to-end forwarding`);
              if (!writeRelayMessage(child, 'httpRelaySelfTest', { token: upstream.token })) {
                finish(new Error('Unable to start the WSL HTTP relay self-test'));
              }
            }
            return;
          }
          if (message.event === 'httpRelaySelfTestResult') {
            if (!relayConnection) {
              finish(new Error('WSL HTTP relay returned a self-test result before reporting its address'));
              return;
            }
            if (params.ok === true) {
              finish(undefined, relayConnection);
              return;
            }
            const statusCode = integerValue(params.statusCode);
            const detail = typeof params.error === 'string' && params.error.trim()
              ? params.error.trim()
              : 'unknown relay error';
            const status = statusCode > 0 ? ` (HTTP ${statusCode})` : '';
            finish(new Error(`WSL HTTP relay self-test failed${status}: ${detail}`));
            return;
          }
          if (message.event === 'httpRelayRequest') {
            void this.forwardRequest(child, upstream, params);
          }
        },
        onFrame: () => undefined,
      });
      child.stdout?.on('data', (chunk: Buffer) => reader.handleData(chunk));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        const message = chunk.trim();
        if (message) logInfo('MCP Relay', message);
      });
      child.stdin?.on('error', (err) => {
        if (!settled) finish(new Error(`WSL HTTP relay input failed: ${errorMessage(err)}`));
      });
      child.once('error', (err) => finish(err));
      child.once('exit', (code, signal) => {
        this.startingChildren.delete(child);
        const current = this.instances.get(distro);
        if (current?.child === child) this.instances.delete(distro);
        if (!settled) {
          finish(new Error(`WSL HTTP relay exited before startup: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
        } else if (!this.disposed && this.generation === generation) {
          logWarn('MCP', `WSL HTTP relay in ${distro} exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        }
      });
    });
  }

  private async resolveRelayPath(wsl: string, distro: string): Promise<string> {
    const architecture = (await runWslText(wsl, distro, ['uname', '-m'])).toLowerCase();
    const target = /^(?:x86_64|amd64)$/.test(architecture)
      ? 'linux-x64'
      : /^(?:aarch64|arm64)$/.test(architecture)
        ? 'linux-arm64'
        : undefined;
    if (!target) throw new Error(`Unsupported WSL relay architecture: ${architecture || '<unknown>'}`);
    const windowsPath = path.join(this.context.extensionPath, 'bin', target, 'canmv-backend');
    if (!fs.existsSync(windowsPath)) {
      throw new Error(`CanMV WSL HTTP relay executable not found: ${windowsPath}`);
    }
    const drivePath = windowsPath.match(/^([A-Za-z]):[\\/](.*)$/);
    if (drivePath) return `/mnt/${drivePath[1].toLowerCase()}/${drivePath[2].replace(/\\/g, '/')}`;
    const translated = await runWslText(wsl, distro, ['wslpath', '-u', windowsPath]);
    if (!translated) throw new Error(`Unable to translate WSL relay path: ${windowsPath}`);
    return translated;
  }

  private async forwardRequest(
    child: cp.ChildProcess,
    upstream: McpHttpConnectionInfo,
    params: Record<string, unknown>,
  ): Promise<void> {
    const requestId = integerValue(params.requestId);
    let request: RelayRequest;
    try {
      request = parseRelayRequest(params);
    } catch (err) {
      logWarn('MCP', `Rejected invalid WSL relay request: ${errorMessage(err)}`);
      if (requestId > 0) {
        writeRelayResponse(
          child,
          requestId,
          400,
          { 'Content-Type': ['application/json; charset=utf-8'] },
          Buffer.from(JSON.stringify({ error: 'Invalid CanMV relay request' })),
        );
      }
      return;
    }
    try {
      const response = await requestUpstream(upstream.port, request);
      writeRelayResponse(child, request.requestId, response.statusCode, response.headers, response.body);
    } catch (err) {
      logWarn('MCP', `WSL HTTP relay upstream failed: ${errorMessage(err)}`);
      writeRelayResponse(
        child,
        request.requestId,
        502,
        { 'Content-Type': ['application/json; charset=utf-8'] },
        Buffer.from(JSON.stringify({ error: 'CanMV MCP upstream is unavailable' })),
      );
    }
  }
}

function parseRelayRequest(params: Record<string, unknown>): RelayRequest {
  const requestId = integerValue(params.requestId);
  const method = typeof params.method === 'string' ? params.method : '';
  const requestPath = typeof params.path === 'string' ? params.path : '';
  if (!Number.isSafeInteger(requestId) || requestId <= 0) throw new Error('invalid request ID');
  let pathname = '';
  try {
    pathname = new URL(requestPath, 'http://localhost').pathname;
  } catch {
    throw new Error('invalid request path');
  }
  if (!((method === 'GET' && pathname === '/health')
    || (method === 'POST' && pathname === '/mcp'))) {
    throw new Error('unsupported route or method');
  }
  const bodyBase64 = typeof params.bodyBase64 === 'string' ? params.bodyBase64 : '';
  const body = Buffer.from(bodyBase64, 'base64');
  if (body.byteLength > MAX_RELAY_BODY_BYTES) throw new Error('request body is too large');
  return {
    requestId,
    method,
    path: requestPath,
    headers: parseHeaders(params.headers),
    body,
  };
}

function requestUpstream(
  port: number,
  relayRequest: RelayRequest,
): Promise<{ statusCode: number; headers: Record<string, string[]>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: relayRequest.method,
      path: relayRequest.path,
      headers: relayRequest.headers,
      timeout: RELAY_REQUEST_TIMEOUT_MS,
    }, (response) => {
      const chunks: Buffer[] = [];
      let byteLength = 0;
      response.on('data', (chunk: Buffer) => {
        byteLength += chunk.byteLength;
        if (byteLength > MAX_RELAY_BODY_BYTES) {
          response.destroy(new Error('CanMV MCP relay response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.on('end', () => resolve({
        statusCode: response.statusCode || 502,
        headers: responseHeaders(response.headers),
        body: Buffer.concat(chunks),
      }));
    });
    request.once('timeout', () => request.destroy(new Error('CanMV MCP relay upstream timed out')));
    request.once('error', reject);
    request.end(relayRequest.body);
  });
}

function writeRelayResponse(
  child: cp.ChildProcess,
  requestId: number,
  statusCode: number,
  headers: Record<string, string[]>,
  body: Buffer,
): void {
  writeRelayMessage(child, 'httpRelayResponse', {
    requestId,
    statusCode,
    headers,
    bodyBase64: body.toString('base64'),
  });
}

function writeRelayMessage(
  child: cp.ChildProcess,
  method: string,
  params: Record<string, unknown>,
): boolean {
  if (!child.stdin?.writable) return false;
  const payload = Buffer.from(JSON.stringify({
    id: 0,
    method,
    params,
  }));
  const header = Buffer.alloc(7);
  MAGIC.copy(header, 0);
  header[2] = MSG_REQUEST;
  header.writeUInt32LE(payload.byteLength, 3);
  try {
    child.stdin.write(Buffer.concat([header, payload]));
    return true;
  } catch {
    return false;
  }
}

function parseHeaders(value: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(asObject(value))) {
    if (!relayHeaderAllowed(key) || !Array.isArray(raw)) continue;
    const values = raw.filter((item): item is string => typeof item === 'string');
    if (values.length > 0) result[key] = values;
  }
  return result;
}

function responseHeaders(headers: http.IncomingHttpHeaders): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!relayHeaderAllowed(key) || value === undefined) continue;
    result[key] = Array.isArray(value) ? value : [value];
  }
  return result;
}

function relayHeaderAllowed(key: string): boolean {
  return !HOP_BY_HOP_HEADERS.has(key.toLowerCase());
}

function runWslText(wsl: string, distro: string, command: string[]): Promise<string> {
  return new Promise((resolve) => {
    cp.execFile(wsl, ['-d', distro, '--', ...command], {
      encoding: 'utf8',
      timeout: RELAY_START_TIMEOUT_MS,
      windowsHide: true,
    }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
}

function integerValue(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : 0;
}

function validPort(value: number): number {
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : 0;
}

function stopRelayChild(child: cp.ChildProcess): void {
  child.stdin?.end();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}

function relayPortStateKey(distro: string): string {
  return `${WSL_RELAY_PORT_STATE_KEY_PREFIX}${encodeURIComponent(distro.toLowerCase())}`;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
