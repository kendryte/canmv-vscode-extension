import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse as parseToml } from 'smol-toml';
import { logInfo, logWarn } from '../output';
import type { McpHttpConnectionInfo } from './httpService';
import type { WslHttpRelayService } from './wslHttpRelay';

const MCP_SERVER_NAME = 'canmv-k230';
const MANAGED_MARKER = 'canmv-vscode';
const MANAGED_HEADER = 'CANMV_MCP_MANAGED';
const AUTH_FINGERPRINT_HEADER_PREFIX = 'CANMV_MCP_AUTH_';
const PROCESS_TIMEOUT_MS = 15_000;
const LEGACY_MANUAL_SETUP_FILES = [
  'README.txt',
  'codex-canmv-k230.toml',
  'claude-canmv-k230.json',
  'configure-canmv-mcp.ps1',
  'configure-canmv-mcp.sh',
] as const;

export const MCP_CLIENT_EXTENSION_IDS = {
  codex: 'openai.chatgpt',
  claudeCode: 'anthropic.claude-code',
} as const;

export interface McpClientRegistrationResult {
  configured: string[];
  unchanged: string[];
  skipped: string[];
  failed: string[];
  missingExtensions: string[];
}

type McpClientName = 'Codex' | 'Claude Code';
type ClientHost = 'native' | 'WSL';

type HttpServerDefinition = {
  url: string;
  headers: Record<string, string>;
};

type ClientCommand = {
  executable: string;
  prefixArgs: string[];
  display: string;
};

type ClientTarget = {
  cli: ClientCommand;
  host: ClientHost;
  definition: HttpServerDefinition;
  configPath?: string;
  wslConfig?: {
    wsl: string;
    distro: string;
    linuxPath: string;
  };
};

type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
};

export function removeLegacyMcpManualSetup(context: vscode.ExtensionContext): void {
  const directory = path.join(context.globalStorageUri.fsPath, 'mcp-manual-setup');
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      logWarn('MCP', `Legacy manual setup path is not a normal directory; leaving it unchanged: ${directory}`);
      return;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logWarn('MCP', `Unable to inspect legacy manual setup directory: ${errorMessage(err)}`);
    }
    return;
  }

  let removed = 0;
  for (const filename of LEGACY_MANUAL_SETUP_FILES) {
    try {
      fs.unlinkSync(path.join(directory, filename));
      removed += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logWarn('MCP', `Unable to remove legacy manual setup file ${filename}: ${errorMessage(err)}`);
      }
    }
  }
  try {
    fs.rmdirSync(directory);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
      logWarn('MCP', `Unable to remove legacy manual setup directory: ${errorMessage(err)}`);
    }
  }
  if (removed > 0) logInfo('MCP', `Removed ${removed} legacy manual setup file(s)`);
}

export async function configureExternalMcpClients(
  connection: McpHttpConnectionInfo,
  wslRelay: WslHttpRelayService,
): Promise<McpClientRegistrationResult> {
  const result: McpClientRegistrationResult = {
    configured: [],
    unchanged: [],
    skipped: [],
    failed: [],
    missingExtensions: [],
  };
  const codexExtensionPath = findClientExtensionPath(MCP_CLIENT_EXTENSION_IDS.codex);
  const claudeExtensionPath = findClientExtensionPath(MCP_CLIENT_EXTENSION_IDS.claudeCode);
  if (!codexExtensionPath) result.missingExtensions.push(MCP_CLIENT_EXTENSION_IDS.codex);
  if (!claudeExtensionPath) result.missingExtensions.push(MCP_CLIENT_EXTENSION_IDS.claudeCode);

  const codexRequiresWsl = shouldPreferWslCodex();
  let codexTarget: ClientTarget | undefined;
  let codexResolutionFailed = false;
  if (codexRequiresWsl) {
    try {
      codexTarget = await resolveWslClientTarget('codex', codexExtensionPath, connection, wslRelay);
      if (!codexTarget) {
        throw new Error('Codex is configured to run in WSL, but no WSL Codex executable was found');
      }
    } catch (err) {
      codexResolutionFailed = true;
      logWarn('MCP', `Unable to configure Codex in its selected WSL host: ${errorMessage(err)}`);
      result.failed.push('Codex');
    }
  } else {
    codexTarget = await resolveClientTarget('codex', codexExtensionPath, connection, wslRelay);
  }
  if (codexTarget) {
    logInfo('MCP', `Using Codex CLI (${codexTarget.host}): ${codexTarget.cli.display}`);
    await configureCodex(codexTarget, result);
  } else if (!codexResolutionFailed) {
    const reason = codexExtensionPath ? 'CLI executable not found' : 'extension and CLI not found';
    logWarn('MCP', `Skipping Codex MCP configuration: ${reason}`);
    result.skipped.push(`Codex (${reason})`);
  }

  const claudeTarget = await resolveClientTarget('claude', claudeExtensionPath, connection, wslRelay);
  if (claudeTarget) {
    logInfo('MCP', `Using Claude Code CLI (${claudeTarget.host}): ${claudeTarget.cli.display}`);
    await configureClaude(claudeTarget, result);
  } else {
    const reason = claudeExtensionPath ? 'CLI executable not found' : 'extension and CLI not found';
    logWarn('MCP', `Skipping Claude Code MCP configuration: ${reason}`);
    result.skipped.push(`Claude Code (${reason})`);
  }

  return result;
}

async function configureCodex(
  target: ClientTarget,
  result: McpClientRegistrationResult,
): Promise<void> {
  if (!target.configPath) throw new Error('Codex config path is unavailable');
  const addArgs = ['mcp', 'add', MCP_SERVER_NAME, '--url', target.definition.url];
  const current = await runClientCommand(target.cli, ['mcp', 'get', MCP_SERVER_NAME, '--json']);
  if (current.code === 0 && isCurrentCodexEntry(current.stdout, target.definition)) {
    logInfo('MCP', `Codex MCP registration already verified in ${target.configPath}`);
    result.unchanged.push('Codex');
    return;
  }
  if (current.code === 0 && !isManagedCodexEntry(current.stdout)) {
    logWarn('MCP', `Codex server '${MCP_SERVER_NAME}' exists but is not managed by CanMV; leaving it unchanged`);
    result.skipped.push('Codex (name already in use)');
    return;
  }
  let preserveDisabled = false;
  if (current.code === 0) {
    try {
      preserveDisabled = await isCodexEntryExplicitlyDisabled(target);
    } catch (err) {
      failClient('Codex', `Unable to preserve Codex MCP state: ${errorMessage(err)}`, result);
      return;
    }
    const removed = await runClientCommand(target.cli, ['mcp', 'remove', MCP_SERVER_NAME]);
    if (removed.code !== 0) {
      failClient('Codex', `Unable to update Codex MCP registration: ${cleanProcessError(removed)}`, result);
      return;
    }
  }

  const added = await runClientCommand(target.cli, addArgs);
  if (added.code !== 0) {
    failClient('Codex', `Unable to configure Codex MCP: ${cleanProcessError(added)}`, result);
    return;
  }
  try {
    await writeCodexHttpHeaders(target, target.definition.headers, preserveDisabled);
  } catch (err) {
    await runClientCommand(target.cli, ['mcp', 'remove', MCP_SERVER_NAME]);
    failClient('Codex', `Unable to secure Codex MCP registration: ${errorMessage(err)}`, result);
    return;
  }

  const verified = await runClientCommand(target.cli, ['mcp', 'get', MCP_SERVER_NAME, '--json']);
  if (verified.code === 0 && isCurrentCodexEntry(verified.stdout, target.definition)) {
    const state = preserveDisabled ? ' with its user-disabled state preserved' : '';
    logInfo('MCP', `Configured and verified CanMV Streamable HTTP server for Codex in ${target.configPath}${state}`);
    result.configured.push('Codex');
    return;
  }
  const detail = verified.code === 0
    ? 'saved registration does not match the requested CanMV HTTP configuration'
    : cleanProcessError(verified);
  failClient('Codex', `Codex registration verification failed: ${detail}`, result);
}

async function configureClaude(
  target: ClientTarget,
  result: McpClientRegistrationResult,
): Promise<void> {
  const definition = JSON.stringify({
    type: 'http',
    url: target.definition.url,
    headers: target.definition.headers,
  });
  const addArgs = ['mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, definition];
  const current = await runClientCommand(target.cli, ['mcp', 'get', MCP_SERVER_NAME]);
  if (current.code === 0 && isCurrentClaudeEntry(current.stdout, target.definition)) {
    result.unchanged.push('Claude Code');
    return;
  }
  if (current.code === 0 && !isManagedEntry(current.stdout)) {
    logWarn('MCP', `Claude Code server '${MCP_SERVER_NAME}' exists but is not managed by CanMV; leaving it unchanged`);
    result.skipped.push('Claude Code (name already in use)');
    return;
  }
  if (current.code === 0) {
    const removeArgs = ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME];
    const removed = await runClientCommand(target.cli, removeArgs);
    if (removed.code !== 0) {
      failClient('Claude Code', `Unable to update Claude Code MCP registration: ${cleanProcessError(removed)}`, result);
      return;
    }
  }

  const added = await runClientCommand(target.cli, addArgs);
  if (added.code !== 0) {
    failClient('Claude Code', `Unable to configure Claude Code MCP: ${cleanProcessError(added)}`, result);
    return;
  }
  const verified = await runClientCommand(target.cli, ['mcp', 'get', MCP_SERVER_NAME]);
  if (verified.code === 0 && isSavedClaudeEntry(verified.stdout, target.definition)) {
    logInfo('MCP', 'Configured and verified CanMV Streamable HTTP server for Claude Code');
    result.configured.push('Claude Code');
    return;
  }
  await runClientCommand(target.cli, ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
  const detail = verified.code === 0
    ? 'saved registration does not match the requested CanMV HTTP configuration'
    : cleanProcessError(verified);
  failClient('Claude Code', `Claude Code registration verification failed: ${detail}`, result);
}

function failClient(
  client: McpClientName,
  message: string,
  result: McpClientRegistrationResult,
): void {
  logWarn('MCP', message);
  result.failed.push(client);
}

async function resolveClientTarget(
  executableName: 'codex' | 'claude',
  extensionPath: string | undefined,
  connection: McpHttpConnectionInfo,
  wslRelay: WslHttpRelayService,
): Promise<ClientTarget | undefined> {
  const nativeExecutable = findClientExecutable(extensionPath, executableName);
  if (nativeExecutable) {
    return {
      cli: directClientCommand(nativeExecutable),
      host: 'native',
      definition: managedHttpDefinition(connection.url, connection.token),
      configPath: executableName === 'codex' ? nativeCodexConfigPath() : undefined,
    };
  }
  return safelyResolveWslClientTarget(executableName, extensionPath, connection, wslRelay);
}

async function safelyResolveWslClientTarget(
  executableName: 'codex' | 'claude',
  extensionPath: string | undefined,
  connection: McpHttpConnectionInfo,
  wslRelay: WslHttpRelayService,
): Promise<ClientTarget | undefined> {
  try {
    return await resolveWslClientTarget(executableName, extensionPath, connection, wslRelay);
  } catch (err) {
    logWarn('MCP', `Unable to configure ${executableName} in WSL: ${errorMessage(err)}`);
    return undefined;
  }
}

function shouldPreferWslCodex(): boolean {
  return process.platform === 'win32'
    && vscode.workspace.getConfiguration('chatgpt')
      .get<boolean>('runCodexInWindowsSubsystemForLinux', false);
}

async function resolveWslClientTarget(
  executableName: 'codex' | 'claude',
  extensionPath: string | undefined,
  connection: McpHttpConnectionInfo,
  wslRelay: WslHttpRelayService,
): Promise<ClientTarget | undefined> {
  if (process.platform !== 'win32') return undefined;
  const wsl = windowsSystemExecutable('wsl.exe');
  const distro = await findWslDistro(wsl);
  let linuxExecutable: string | undefined;
  if (executableName === 'codex' && extensionPath) {
    const bundled = findBundledLinuxExecutable(extensionPath, executableName);
    if (bundled) linuxExecutable = await translateWindowsPathToWsl(wsl, distro, bundled);
  }
  linuxExecutable ||= await findWslExecutable(wsl, distro, executableName);
  if (!linuxExecutable) return undefined;
  const relay = await wslRelay.start(wsl, distro, connection);
  logInfo('MCP', `Verified CanMV WSL HTTP relay in ${distro} at ${relay.url}`);
  const definition = managedHttpDefinition(relay.url, connection.token);
  const codexConfigPath = executableName === 'codex'
    ? await resolveWslCodexConfigPath(wsl, distro)
    : undefined;
  return {
    cli: {
      executable: wsl,
      prefixArgs: ['-d', distro, '--', linuxExecutable],
      display: `${linuxExecutable} in WSL ${distro}`,
    },
    host: 'WSL',
    definition,
    configPath: codexConfigPath,
    wslConfig: codexConfigPath ? { wsl, distro, linuxPath: codexConfigPath } : undefined,
  };
}

function managedHttpDefinition(url: string, token: string): HttpServerDefinition {
  // Claude may redact header values in CLI output. Encoding a short one-way
  // fingerprint in a header name still lets readback detect stale credentials.
  const authFingerprintHeader = AUTH_FINGERPRINT_HEADER_PREFIX
    + crypto.createHash('sha256').update(token).digest('hex').slice(0, 16).toUpperCase();
  return {
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      [MANAGED_HEADER]: MANAGED_MARKER,
      [authFingerprintHeader]: MANAGED_MARKER,
    },
  };
}

function directClientCommand(executable: string): ClientCommand {
  return { executable, prefixArgs: [], display: executable };
}

function findClientExtensionPath(extensionId: string): string | undefined {
  const visible = vscode.extensions.getExtension(extensionId)?.extensionPath;
  if (visible) return visible;
  const roots = new Set<string>();
  if (process.env.VSCODE_EXTENSIONS) roots.add(process.env.VSCODE_EXTENSIONS);
  roots.add(path.join(os.homedir(), '.vscode', 'extensions'));
  roots.add(path.join(os.homedir(), '.vscode-insiders', 'extensions'));
  const prefix = `${extensionId.toLowerCase()}-`;
  const candidates: string[] = [];
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix)) {
          candidates.push(path.join(root, entry.name));
        }
      }
    } catch {
      // The extension directory is optional.
    }
  }
  return candidates.sort((left, right) => right.localeCompare(left))[0];
}

function findClientExecutable(extensionPath: string | undefined, filename: string): string | undefined {
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

function findBundledLinuxExecutable(extensionPath: string, filename: string): string | undefined {
  return findExecutableInLinuxDirectory(path.join(extensionPath, 'bin'), filename, 3);
}

function findExecutableInLinuxDirectory(root: string, filename: string, depth: number): string | undefined {
  if (depth < 0) return undefined;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    if (/^linux(?:-|$)/i.test(entry.name)) {
      const executable = findNamedFile(directory, filename, depth - 1);
      if (executable) return executable;
    }
    const nested = findExecutableInLinuxDirectory(directory, filename, depth - 1);
    if (nested) return nested;
  }
  return undefined;
}

function findFile(root: string, names: string[], depth: number): string | undefined {
  for (const name of names) {
    const found = findNamedFile(root, name, depth);
    if (found) return found;
  }
  return undefined;
}

function findNamedFile(root: string, name: string, depth: number): string | undefined {
  if (depth < 0) return undefined;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const matches = process.platform === 'win32'
      ? entry.name.toLowerCase() === name.toLowerCase()
      : entry.name === name;
    if (entry.isFile() && matches) {
      const candidate = path.join(root, entry.name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findNamedFile(path.join(root, entry.name), name, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function executableNames(name: string): string[] {
  return process.platform === 'win32'
    ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`]
    : [name];
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

async function findWslDistro(wsl: string): Promise<string> {
  const verbose = await runProcess(wsl, ['--list', '--verbose']);
  if (verbose.code === 0) {
    const defaultLine = verbose.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('*'));
    const defaultDistro = defaultLine?.slice(1).trim().split(/\s{2,}|\t+/)[0]?.trim();
    if (defaultDistro) return defaultDistro;
  }
  const listed = await runProcess(wsl, ['--list', '--quiet']);
  if (listed.code !== 0) throw new Error(`unable to list WSL distributions: ${cleanProcessError(listed)}`);
  const distro = listed.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!distro) throw new Error('no WSL distribution was found');
  return distro;
}

async function findWslExecutable(wsl: string, distro: string, name: string): Promise<string | undefined> {
  const command = await runProcess(wsl, [
    '-d', distro, '--', '/usr/bin/bash', '-lc',
    `command -v ${shellQuote(name)} 2>/dev/null || true`,
  ]);
  const executable = command.stdout.trim().split(/\r?\n/)[0];
  return command.code === 0 && executable.startsWith('/') ? executable : undefined;
}

async function translateWindowsPathToWsl(wsl: string, distro: string, windowsPath: string): Promise<string> {
  const drivePath = windowsPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drivePath) return `/mnt/${drivePath[1].toLowerCase()}/${drivePath[2].replace(/\\/g, '/')}`;
  const translated = await runProcess(wsl, ['-d', distro, '--', 'wslpath', '-u', windowsPath.replace(/\\/g, '/')]);
  if (translated.code !== 0 || !translated.stdout.trim()) {
    throw new Error(`unable to translate path for WSL: ${cleanProcessError(translated)}`);
  }
  return translated.stdout.trim();
}

async function resolveWslCodexConfigPath(wsl: string, distro: string): Promise<string> {
  const codexHome = await runProcess(wsl, [
    '-d', distro, '--', '/usr/bin/printenv', 'CODEX_HOME',
  ]);
  if (codexHome.code === 0 && codexHome.stdout.trim()) {
    return path.posix.join(codexHome.stdout.trim(), 'config.toml');
  }
  const home = await runProcess(wsl, [
    '-d', distro, '--', '/usr/bin/printenv', 'HOME',
  ]);
  if (home.code !== 0 || !home.stdout.trim()) {
    throw new Error(`unable to resolve the WSL Codex home: ${cleanProcessError(home)}`);
  }
  return path.posix.join(home.stdout.trim(), '.codex', 'config.toml');
}

function windowsSystemExecutable(filename: string): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', filename);
}

function windowsPowerShellExecutable(): string {
  return path.win32.join(
    process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
}

function nativeCodexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'config.toml');
}

function isManagedEntry(output: string): boolean {
  // Claude may redact header values in CLI output, but preserves the private
  // marker header name used exclusively by this extension.
  return output.includes(MANAGED_HEADER);
}

function isManagedCodexEntry(output: string): boolean {
  const transport = codexTransport(output);
  return transport?.http_headers?.[MANAGED_HEADER] === MANAGED_MARKER
    || transport?.env?.CANMV_MCP_MANAGED === MANAGED_MARKER;
}

function isCurrentCodexEntry(output: string, definition: HttpServerDefinition): boolean {
  const transport = codexTransport(output);
  return transport?.type === 'streamable_http'
    && transport.url === definition.url
    && Object.entries(definition.headers).every(([key, value]) => transport.http_headers?.[key] === value);
}

type CodexTransport = {
  type?: string;
  url?: string;
  http_headers?: Record<string, string> | null;
  env?: Record<string, string> | null;
};

function codexTransport(output: string): CodexTransport | undefined {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const transport = parsed.transport;
    return transport && typeof transport === 'object' && !Array.isArray(transport)
      ? transport as CodexTransport
      : undefined;
  } catch {
    return undefined;
  }
}

function isCurrentClaudeEntry(output: string, definition: HttpServerDefinition): boolean {
  return isSavedClaudeEntry(output, definition);
}

function isSavedClaudeEntry(output: string, definition: HttpServerDefinition): boolean {
  return isManagedEntry(output)
    && /(?:^|\r?\n)\s*(?:Type|Transport):\s*(?:http|streamable[-_ ]http)\s*(?:\r?\n|$)/i.test(output)
    && outputIncludesValue(output, definition.url)
    && Object.keys(definition.headers).every((key) => outputIncludesValue(output, key));
}

function outputIncludesValue(output: string, value: string): boolean {
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  return output.includes(value) || output.includes(jsonEscaped);
}

async function isCodexEntryExplicitlyDisabled(target: ClientTarget): Promise<boolean> {
  if (!target.configPath) throw new Error('Codex config path is unavailable');
  const content = await readCodexConfig(target);
  const parsed = parseToml(content) as Record<string, unknown>;
  const servers = parsed.mcp_servers as Record<string, unknown> | undefined;
  const entry = servers?.[MCP_SERVER_NAME] as Record<string, unknown> | undefined;
  return entry?.enabled === false;
}

async function readCodexConfig(target: ClientTarget): Promise<string> {
  if (!target.configPath) throw new Error('Codex config path is unavailable');
  if (target.wslConfig) return readWslFile(target.wslConfig);
  try {
    return fs.readFileSync(target.configPath, 'utf8');
  } catch (err) {
    throw new Error(`Unable to read Codex config ${target.configPath}: ${errorMessage(err)}`);
  }
}

async function writeCodexHttpHeaders(
  target: ClientTarget,
  headers: Record<string, string>,
  disabled: boolean,
): Promise<void> {
  if (!target.configPath) throw new Error('Codex config path is unavailable');
  const original = await readCodexConfig(target);
  const updated = codexConfigWithHttpHeaders(original, target.configPath, headers, disabled);
  if (target.wslConfig) {
    await writeWslPrivateFile(target.wslConfig, updated);
  } else {
    writePrivateFileAtomic(target.configPath, updated);
  }
}

function codexConfigWithHttpHeaders(
  original: string,
  configPath: string,
  headers: Record<string, string>,
  disabled: boolean,
): string {
  parseToml(original);
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const headerPattern = /^\s*\[\s*mcp_servers\s*\.\s*(?:"canmv-k230"|'canmv-k230'|canmv-k230)\s*\]\s*(?:#.*)?$/;
  const tableStart = lines.findIndex((line) => headerPattern.test(line));
  if (tableStart < 0) throw new Error(`Codex did not create the expected MCP table in ${configPath}`);
  let tableEnd = tableStart + 1;
  while (tableEnd < lines.length && !/^\s*\[/.test(lines[tableEnd])) tableEnd += 1;
  const upsertTableValue = (pattern: RegExp, value: string): void => {
    const existing = lines.findIndex((line, index) => index > tableStart
      && index < tableEnd
      && pattern.test(line));
    if (existing >= 0) {
      lines[existing] = value;
      return;
    }
    while (tableEnd > tableStart + 1 && lines[tableEnd - 1].trim() === '') tableEnd -= 1;
    lines.splice(tableEnd, 0, value);
    tableEnd += 1;
  };
  upsertTableValue(/^\s*http_headers\s*=/, `http_headers = ${tomlInlineTable(headers)}`);
  if (disabled) upsertTableValue(/^\s*enabled\s*=/, 'enabled = false');
  const updated = lines.join(newline);
  const parsed = parseToml(updated) as Record<string, unknown>;
  const servers = parsed.mcp_servers as Record<string, unknown> | undefined;
  const entry = servers?.[MCP_SERVER_NAME] as Record<string, unknown> | undefined;
  const savedHeaders = entry?.http_headers as Record<string, unknown> | undefined;
  if (!savedHeaders || Object.entries(headers).some(([key, value]) => savedHeaders[key] !== value)) {
    throw new Error('Generated Codex HTTP header configuration did not validate');
  }
  if (disabled && entry?.enabled !== false) {
    throw new Error('Generated Codex configuration did not preserve the user-disabled state');
  }
  return updated;
}

async function readWslFile(location: NonNullable<ClientTarget['wslConfig']>): Promise<string> {
  const result = await runProcess(location.wsl, [
    '-d', location.distro, '--', '/bin/cat', '--', location.linuxPath,
  ]);
  if (result.code !== 0) {
    throw new Error(`Unable to read WSL Codex config ${location.linuxPath}: ${cleanProcessError(result)}`);
  }
  return result.stdout;
}

function writePrivateFileAtomic(configPath: string, content: string): void {
  let targetPath = configPath;
  try {
    if (fs.lstatSync(configPath).isSymbolicLink()) {
      try {
        targetPath = fs.realpathSync(configPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const linkTarget = fs.readlinkSync(configPath);
        targetPath = path.resolve(path.dirname(configPath), linkTarget);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.canmv-codex-config.${crypto.randomBytes(16).toString('hex')}`);
  let descriptor: number | undefined;
  let moved = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (fs.readFileSync(temporary, 'utf8') !== content) {
      throw new Error('temporary Codex config verification failed');
    }
    fs.renameSync(temporary, targetPath);
    moved = true;
    if (process.platform !== 'win32') fs.chmodSync(targetPath, 0o600);
    if (fs.readFileSync(configPath, 'utf8') !== content) {
      throw new Error('saved Codex config does not match the verified content');
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (!moved) {
      try {
        fs.unlinkSync(temporary);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logWarn('MCP', `Unable to remove temporary Codex config ${temporary}: ${errorMessage(err)}`);
        }
      }
    }
  }
}

async function writeWslPrivateFile(
  location: NonNullable<ClientTarget['wslConfig']>,
  content: string,
): Promise<void> {
  if (!content) throw new Error('Refusing to replace the WSL Codex config with empty content');
  const resolved = await runProcess(location.wsl, [
    '-d', location.distro, '--', '/usr/bin/readlink', '-f', '--', location.linuxPath,
  ]);
  const targetPath = resolved.code === 0 && resolved.stdout.trim()
    ? resolved.stdout.trim()
    : location.linuxPath;
  const directory = path.posix.dirname(targetPath);
  const temporary = path.posix.join(
    directory,
    `.canmv-codex-config.${crypto.randomBytes(16).toString('hex')}`,
  );
  const runWsl = (command: string, args: string[] = [], input?: string): Promise<ProcessResult> => runProcess(
    location.wsl,
    ['-d', location.distro, '--', command, ...args],
    input,
  );
  let moved = false;
  try {
    const directoryResult = await runWsl('/bin/mkdir', ['-p', '--', directory]);
    if (directoryResult.code !== 0) {
      throw new Error(`unable to prepare the config directory: ${cleanProcessError(directoryResult)}`);
    }
    const touchResult = await runWsl('/usr/bin/touch', ['--', temporary]);
    if (touchResult.code !== 0) {
      throw new Error(`unable to create the temporary config: ${cleanProcessError(touchResult)}`);
    }
    const privateResult = await runWsl('/bin/chmod', ['600', '--', temporary]);
    if (privateResult.code !== 0) {
      throw new Error(`unable to secure the temporary config: ${cleanProcessError(privateResult)}`);
    }
    const writeResult = await runWsl('/usr/bin/tee', ['--', temporary], content);
    if (writeResult.code !== 0) {
      throw new Error(`unable to write the temporary config: ${cleanProcessError({ ...writeResult, stdout: '' })}`);
    }
    const temporaryContent = await readWslFile({ ...location, linuxPath: temporary });
    if (temporaryContent !== content) {
      throw new Error('temporary config verification failed; WSL stdin did not preserve the requested content');
    }
    const moveResult = await runWsl('/bin/mv', ['-f', '--', temporary, targetPath]);
    if (moveResult.code !== 0) {
      throw new Error(`unable to replace the config atomically: ${cleanProcessError(moveResult)}`);
    }
    moved = true;
    const savedContent = await readWslFile(location);
    if (savedContent !== content) {
      throw new Error('saved WSL Codex config does not match the verified content');
    }
  } catch (err) {
    throw new Error(`Unable to write WSL Codex config ${location.linuxPath}: ${errorMessage(err)}`);
  } finally {
    if (!moved) {
      const cleanupResult = await runWsl('/bin/rm', ['-f', '--', temporary]);
      if (cleanupResult.code !== 0) {
        logWarn('MCP', `Unable to remove temporary WSL Codex config ${temporary}: ${cleanProcessError(cleanupResult)}`);
      }
    }
  }
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(', ')} }`;
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function runClientCommand(command: ClientCommand, args: string[]): Promise<ProcessResult> {
  const invocation = clientInvocation(command, args);
  return runProcess(invocation.executable, invocation.args);
}

function clientInvocation(command: ClientCommand, args: string[]): { executable: string; args: string[] } {
  return { executable: command.executable, args: [...command.prefixArgs, ...args] };
}

function runProcess(executable: string, args: string[], input?: string): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const invocation = processInvocation(executable, args);
    try {
      const child = cp.execFile(invocation.executable, invocation.args, {
        encoding: 'buffer',
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        const processError = err as (cp.ExecFileException & {
          code?: string | number;
          killed?: boolean;
          signal?: string;
        }) | null;
        const rawCode = processError?.code;
        resolve({
          code: typeof rawCode === 'number' ? rawCode : err ? 1 : 0,
          stdout: decodeProcessOutput(stdout),
          stderr: decodeProcessOutput(stderr),
          error: processErrorDescription(processError, executable),
        });
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: '', error: errorMessage(err) });
    }
  });
}

function decodeProcessOutput(value: string | Buffer | null | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value.length >= 2 && value[0] === 0xff && value[1] === 0xfe) return value.subarray(2).toString('utf16le');
  if (value.length >= 3 && value[0] === 0xef && value[1] === 0xbb && value[2] === 0xbf) {
    return value.subarray(3).toString('utf8');
  }
  const sampleLength = Math.min(value.length - (value.length % 2), 256);
  let nullHighBytes = 0;
  for (let index = 1; index < sampleLength; index += 2) {
    if (value[index] === 0) nullHighBytes += 1;
  }
  return sampleLength > 0 && nullHighBytes / (sampleLength / 2) > 0.6
    ? value.toString('utf16le').replace(/^\uFEFF/, '')
    : value.toString('utf8').replace(/^\uFEFF/, '');
}

function processInvocation(executable: string, args: string[]): { executable: string; args: string[] } {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) return { executable, args };
  const powershell = windowsPowerShellExecutable();
  const script = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    `& ${powershellQuote(executable)} ${args.map(powershellQuote).join(' ')}`,
    'if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }',
  ].join('; ');
  return {
    executable: powershell,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

function processErrorDescription(
  err: (cp.ExecFileException & { code?: string | number; killed?: boolean; signal?: string }) | null,
  executable: string,
): string | undefined {
  if (!err) return undefined;
  if (err.killed) return `Process timed out after ${PROCESS_TIMEOUT_MS}ms`;
  if (err.signal) return `Process terminated by ${err.signal}`;
  if (typeof err.code === 'string') return `${err.code}: unable to launch ${executable}`;
  if (typeof err.code === 'number') return `Process exited with code ${err.code}`;
  return `Unable to launch ${executable}`;
}

function cleanProcessError(result: ProcessResult): string {
  return (result.stderr || result.stdout || result.error || `process exited with code ${result.code}`)
    .trim()
    .replace(/\b[0-9a-f]{64}\b/gi, '<redacted>')
    .replace(/\b[A-Za-z0-9+/]{256,}={0,2}\b/g, '<redacted-command>')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
