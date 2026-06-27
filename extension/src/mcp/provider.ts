import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logInfo, logWarn } from '../output';

export const CANMV_MCP_PROVIDER_ID = 'canmv.mcp';

export function registerMcpSupport(context: vscode.ExtensionContext): void {
  const registerProvider = vscode.lm?.registerMcpServerDefinitionProvider;
  if (typeof registerProvider !== 'function' || typeof vscode.McpStdioServerDefinition !== 'function') {
    logWarn('MCP', 'VS Code MCP server definition API is unavailable in this runtime');
    return;
  }

  const changed = new vscode.EventEmitter<void>();
  const configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration('canmv.backendPath') ||
      event.affectsConfiguration('canmv.serialPath') ||
      event.affectsConfiguration('canmv.baudRate')
    ) {
      changed.fire();
    }
  });

  const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => {
      const serverPath = path.join(context.extensionPath, 'out', 'mcp', 'server.js');
      const pkg = context.extension.packageJSON as { version?: string };
      const version = pkg.version || 'unknown';
      const definition = new vscode.McpStdioServerDefinition(
        'CanMV K230',
        process.execPath,
        [serverPath],
        createMcpServerEnv(context),
        version,
      );
      definition.cwd = vscode.Uri.file(context.extensionPath);
      return [definition];
    },
    resolveMcpServerDefinition: (server) => {
      const serverPath = server.args[0];
      if (!serverPath || !fs.existsSync(serverPath)) {
        throw new Error(`CanMV MCP server script not found: ${serverPath || '<missing>'}`);
      }
      server.env = createMcpServerEnv(context);
      server.cwd = vscode.Uri.file(context.extensionPath);
      return server;
    },
  };

  context.subscriptions.push(
    registerProvider(CANMV_MCP_PROVIDER_ID, provider),
    changed,
    configSubscription,
  );
  logInfo('MCP', 'Registered CanMV MCP server definition provider');
}

function createMcpServerEnv(context: vscode.ExtensionContext): Record<string, string | number | null> {
  const config = vscode.workspace.getConfiguration('canmv');
  const pkg = context.extension.packageJSON as { version?: string };
  const backendPath = process.env.CANMV_BACKEND_PATH || config.get<string>('backendPath', '');
  const serialPath = config.get<string>('serialPath', '');
  const baudRate = config.get<number>('baudRate', 12000000);

  return {
    CANMV_EXTENSION_PATH: context.extensionPath,
    CANMV_EXTENSION_VERSION: pkg.version || 'unknown',
    CANMV_BACKEND_PATH: backendPath || null,
    CANMV_SERIAL_PATH: serialPath || null,
    CANMV_BAUD_RATE: Number.isFinite(baudRate) ? baudRate : 12000000,
  };
}
