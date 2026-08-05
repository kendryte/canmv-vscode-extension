import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logInfo, logWarn } from '../output';
import type { McpBridgeConnectionInfo } from './bridge';

const MCP_SERVER_NAME = 'canmv-k230';
const MANAGED_MARKER = 'canmv-vscode';
const PROCESS_TIMEOUT_MS = 15_000;

export interface McpClientRegistrationResult {
  configured: string[];
  unchanged: string[];
  skipped: string[];
  failed: string[];
}

export async function configureExternalMcpClients(
  context: vscode.ExtensionContext,
  bridge: McpBridgeConnectionInfo,
): Promise<McpClientRegistrationResult> {
  const serverPath = path.join(context.extensionPath, 'out', 'mcp', 'server.js');
  if (!fs.existsSync(serverPath)) {
    throw new Error(`CanMV MCP server script not found: ${serverPath}`);
  }
  const env = createExternalServerEnv(context, bridge);
  const result: McpClientRegistrationResult = {
    configured: [],
    unchanged: [],
    skipped: [],
    failed: [],
  };

  const codex = findClientExecutable('openai.chatgpt', 'codex');
  if (codex) {
    await configureCodex(codex, serverPath, env, result);
  } else {
    result.skipped.push('Codex (not installed)');
  }

  const claude = findClientExecutable('anthropic.claude-code', 'claude');
  if (claude) {
    await configureClaude(claude, serverPath, env, result);
  } else {
    result.skipped.push('Claude Code (not installed)');
  }

  return result;
}

function createExternalServerEnv(
  context: vscode.ExtensionContext,
  bridge: McpBridgeConnectionInfo,
): Record<string, string> {
  const config = vscode.workspace.getConfiguration('canmv');
  const pkg = context.extension.packageJSON as { version?: string };
  return {
    ELECTRON_RUN_AS_NODE: '1',
    CANMV_MCP_MANAGED: MANAGED_MARKER,
    CANMV_EXTENSION_PATH: context.extensionPath,
    CANMV_EXTENSION_VERSION: pkg.version || 'unknown',
    CANMV_BAUD_RATE: String(config.get<number>('baudRate', 12000000)),
    CANMV_AUTO_MINIFY_STARTUP_SCRIPTS: config.get<boolean>('autoMinifyStartupScripts', true) ? 'true' : 'false',
    CANMV_MCP_BRIDGE_ENDPOINT: bridge.endpoint,
    CANMV_MCP_BRIDGE_TOKEN: bridge.token,
  };
}

async function configureCodex(
  executable: string,
  serverPath: string,
  env: Record<string, string>,
  result: McpClientRegistrationResult,
): Promise<void> {
  const current = await runProcess(executable, ['mcp', 'get', MCP_SERVER_NAME, '--json']);
  if (current.code === 0 && isCurrentManagedEntry(current.stdout, serverPath, env)) {
    result.unchanged.push('Codex');
    return;
  }
  if (current.code === 0 && !isManagedEntry(current.stdout)) {
    logWarn('MCP', `Codex server '${MCP_SERVER_NAME}' exists but is not managed by CanMV; leaving it unchanged`);
    result.skipped.push('Codex (name already in use)');
    return;
  }
  if (current.code === 0) {
    const removed = await runProcess(executable, ['mcp', 'remove', MCP_SERVER_NAME]);
    if (removed.code !== 0) {
      logWarn('MCP', `Unable to update Codex MCP registration: ${cleanProcessError(removed)}`);
      result.failed.push('Codex');
      return;
    }
  }

  const envArgs = Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  const added = await runProcess(executable, [
    'mcp', 'add', MCP_SERVER_NAME,
    ...envArgs,
    '--', process.execPath, serverPath,
  ]);
  if (added.code === 0) {
    logInfo('MCP', 'Configured CanMV MCP server for Codex');
    result.configured.push('Codex');
  } else {
    logWarn('MCP', `Unable to configure Codex MCP: ${cleanProcessError(added)}`);
    result.failed.push('Codex');
  }
}

async function configureClaude(
  executable: string,
  serverPath: string,
  env: Record<string, string>,
  result: McpClientRegistrationResult,
): Promise<void> {
  const current = await runProcess(executable, ['mcp', 'get', MCP_SERVER_NAME]);
  if (current.code === 0 && isCurrentManagedEntry(current.stdout, serverPath, env)) {
    result.unchanged.push('Claude Code');
    return;
  }
  if (current.code === 0 && !isManagedEntry(current.stdout)) {
    logWarn('MCP', `Claude Code server '${MCP_SERVER_NAME}' exists but is not managed by CanMV; leaving it unchanged`);
    result.skipped.push('Claude Code (name already in use)');
    return;
  }
  if (current.code === 0) {
    const removed = await runProcess(executable, ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
    if (removed.code !== 0) {
      logWarn('MCP', `Unable to update Claude Code MCP registration: ${cleanProcessError(removed)}`);
      result.failed.push('Claude Code');
      return;
    }
  }

  const definition = JSON.stringify({
    type: 'stdio',
    command: process.execPath,
    args: [serverPath],
    env,
  });
  const added = await runProcess(executable, [
    'mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, definition,
  ]);
  if (added.code === 0) {
    logInfo('MCP', 'Configured CanMV MCP server for Claude Code');
    result.configured.push('Claude Code');
  } else {
    logWarn('MCP', `Unable to configure Claude Code MCP: ${cleanProcessError(added)}`);
    result.failed.push('Claude Code');
  }
}

function findClientExecutable(extensionId: string, filename: string): string | undefined {
  const extensionPath = vscode.extensions.getExtension(extensionId)?.extensionPath;
  if (extensionPath) {
    const bundled = findFile(extensionPath, executableNames(filename), 5);
    if (bundled) return bundled;
  }
  const pathValue = process.env.PATH || '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const name of executableNames(filename)) {
      const candidate = path.join(directory, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function findFile(root: string, names: string[], depth: number): string | undefined {
  if (depth < 0) return undefined;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.isFile() && names.includes(entry.name)) {
      const candidate = path.join(root, entry.name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findFile(path.join(root, entry.name), names, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function executableNames(name: string): string[] {
  return process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isManagedEntry(output: string): boolean {
  return output.includes('CANMV_MCP_MANAGED') && output.includes(MANAGED_MARKER);
}

function isCurrentManagedEntry(output: string, serverPath: string, env: Record<string, string>): boolean {
  return isManagedEntry(output)
    && outputIncludesValue(output, process.execPath)
    && outputIncludesValue(output, serverPath)
    && Object.entries(env).every(([key, value]) => output.includes(key) && outputIncludesValue(output, value));
}

function outputIncludesValue(output: string, value: string): boolean {
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  return output.includes(value) || output.includes(jsonEscaped);
}

function runProcess(executable: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = cp.execFile(executable, args, {
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const rawCode = (err as cp.ExecFileException | null)?.code;
      const code = typeof rawCode === 'number'
        ? rawCode
        : err ? 1 : 0;
      resolve({ code, stdout: stdout || '', stderr: stderr || '' });
    });
    child.unref();
  });
}

function cleanProcessError(result: { stdout: string; stderr: string }): string {
  const text = (result.stderr || result.stdout || 'unknown error').trim();
  return text
    .replace(/\b[0-9a-f]{64}\b/gi, '<redacted>')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}
