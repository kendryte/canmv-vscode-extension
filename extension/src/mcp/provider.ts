import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logInfo, logWarn } from '../output';
import { t } from '../i18n';
import type { McpBridgeConnectionInfo } from './bridge';
import {
  configureExternalMcpClients,
  MCP_CLIENT_EXTENSION_IDS,
  type McpClientRegistrationResult,
} from './clientRegistration';

export const CANMV_MCP_PROVIDER_ID = 'canmv.mcp';

export function registerMcpSupport(
  context: vscode.ExtensionContext,
  bridge?: McpBridgeConnectionInfo,
): void {
  const changed = new vscode.EventEmitter<void>();
  const configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('canmv.baudRate') || event.affectsConfiguration('canmv.autoMinifyStartupScripts')) {
      changed.fire();
      if (bridge && shouldAutoConfigureExternalClients()) void configureClients(false);
    }
  });

  let configurePromise: Promise<McpClientRegistrationResult> | undefined;
  const configureClients = (showResult: boolean): Promise<McpClientRegistrationResult> => {
    if (!bridge) return Promise.reject(new Error('CanMV MCP bridge is unavailable'));
    if (!configurePromise) {
      configurePromise = configureExternalMcpClients(context, bridge).finally(() => {
        configurePromise = undefined;
      });
    }
    if (showResult) {
      void configurePromise.then((result) => {
        const names = [...result.configured, ...result.unchanged];
        if (names.length > 0) {
          vscode.window.showInformationMessage(t('CanMV: MCP configured for {clients}. Restart active agent sessions to refresh tools.', {
            clients: names.join(', '),
          }));
        } else if (result.failed.length > 0) {
          vscode.window.showErrorMessage(t('CanMV: MCP client configuration failed. See the CanMV output for details.'));
        } else if (result.missingExtensions.length === Object.keys(MCP_CLIENT_EXTENSION_IDS).length) {
          const openExtensions = t('Open Extensions');
          void vscode.window.showErrorMessage(
            t('CanMV: Install the Codex or Claude Code extension before configuring MCP.'),
            openExtensions,
          ).then((choice) => {
            if (choice === openExtensions) {
              void vscode.commands.executeCommand(
                'workbench.extensions.action.showExtensionsWithIds',
                Object.values(MCP_CLIENT_EXTENSION_IDS),
              );
            }
          });
        } else {
          vscode.window.showWarningMessage(t('CanMV: No supported Codex or Claude Code client was found.'));
        }
      }, (err) => {
        logWarn('MCP', `Client configuration failed: ${err instanceof Error ? err.message : String(err)}`);
        vscode.window.showErrorMessage(t('CanMV: MCP client configuration failed. See the CanMV output for details.'));
      });
    }
    return configurePromise;
  };

  context.subscriptions.push(
    changed,
    configSubscription,
    vscode.commands.registerCommand('canmv.configureMcpClients', () => configureClients(true)),
  );

  if (bridge && shouldAutoConfigureExternalClients()) {
    void configureClients(false).catch((err) => {
      logWarn('MCP', `Automatic client configuration failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  const registerProvider = vscode.lm?.registerMcpServerDefinitionProvider;
  if (typeof registerProvider !== 'function' || typeof vscode.McpStdioServerDefinition !== 'function') {
    logWarn('MCP', 'VS Code MCP server definition API is unavailable in this runtime');
    return;
  }

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
        createMcpServerEnv(context, bridge),
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
      server.env = createMcpServerEnv(context, bridge);
      server.cwd = vscode.Uri.file(context.extensionPath);
      return server;
    },
  };

  context.subscriptions.push(
    registerProvider(CANMV_MCP_PROVIDER_ID, provider),
  );
  logInfo('MCP', 'Registered CanMV MCP server definition provider');
}

function createMcpServerEnv(
  context: vscode.ExtensionContext,
  bridge?: McpBridgeConnectionInfo,
): Record<string, string | number | null> {
  const config = vscode.workspace.getConfiguration('canmv');
  const pkg = context.extension.packageJSON as { version?: string };
  const baudRate = config.get<number>('baudRate', 12000000);
  const autoMinifyStartupScripts = config.get<boolean>('autoMinifyStartupScripts', true);

  const env: Record<string, string | number | null> = {
    CANMV_EXTENSION_PATH: context.extensionPath,
    CANMV_EXTENSION_VERSION: pkg.version || 'unknown',
    CANMV_BAUD_RATE: Number.isFinite(baudRate) ? baudRate : 12000000,
    CANMV_AUTO_MINIFY_STARTUP_SCRIPTS: autoMinifyStartupScripts ? 'true' : 'false',
  };
  if (bridge) {
    env.CANMV_MCP_BRIDGE_ENDPOINT = bridge.endpoint;
    env.CANMV_MCP_BRIDGE_TOKEN = bridge.token;
    env.CANMV_MCP_BRIDGE_REQUIRED = 'true';
  }
  return env;
}

function shouldAutoConfigureExternalClients(): boolean {
  return vscode.workspace.getConfiguration('canmv').get<boolean>('mcp.autoConfigureClients', true);
}
