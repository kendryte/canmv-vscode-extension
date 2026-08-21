import * as vscode from 'vscode';
import { logInfo, logWarn } from '../output';
import { t } from '../i18n';
import type { McpBridgeConnectionInfo } from './bridge';
import {
  configureExternalMcpClients,
  MCP_CLIENT_EXTENSION_IDS,
  removeLegacyMcpManualSetup,
  type McpClientRegistrationResult,
} from './clientRegistration';
import { McpHttpService, type McpHttpConnectionInfo } from './httpService';
import { WslHttpRelayService } from './wslHttpRelay';

export const CANMV_MCP_PROVIDER_ID = 'canmv.mcp';

export async function registerMcpSupport(
  context: vscode.ExtensionContext,
  bridge?: McpBridgeConnectionInfo,
): Promise<void> {
  removeLegacyMcpManualSetup(context);
  const changed = new vscode.EventEmitter<void>();
  const httpService = new McpHttpService(context, () => createMcpServerEnv(context, bridge));
  const wslRelay = new WslHttpRelayService(context);
  context.subscriptions.push(httpService, wslRelay);
  let httpConnection: McpHttpConnectionInfo | undefined;
  try {
    httpConnection = await httpService.start();
  } catch (err) {
    logWarn('MCP', `Streamable HTTP service unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const showClientConfigurationFailure = (): void => {
    void vscode.window.showErrorMessage(
      t('CanMV: MCP client configuration failed. See the CanMV output for details.'),
    );
  };

  const showClientConfigurationSuccess = (names: string[]): void => {
    void vscode.window.showInformationMessage(
      t('CanMV: MCP configured for {clients}.', {
        clients: names.join(', '),
      }),
    );
  };

  let configurePromise: Promise<McpClientRegistrationResult> | undefined;
  let configureConnection: McpHttpConnectionInfo | undefined;
  let configureAgain = false;
  const configureClients = (showResult: boolean): Promise<McpClientRegistrationResult> => {
    const connection = httpConnection;
    if (!connection) return Promise.reject(new Error('CanMV MCP HTTP service is unavailable'));
    if (!configurePromise) {
      configureConnection = connection;
      configurePromise = configureExternalMcpClients(connection, wslRelay).finally(() => {
        configurePromise = undefined;
        configureConnection = undefined;
        if (configureAgain) {
          configureAgain = false;
          queueMicrotask(configureAutomatically);
        }
      });
    } else if (configureConnection?.url !== connection.url
      || configureConnection?.token !== connection.token) {
      configureAgain = true;
    }
    if (showResult) {
      void configurePromise.then((result) => {
        const names = [...result.configured, ...result.unchanged];
        if (result.failed.length > 0) {
          showClientConfigurationFailure();
        } else if (names.length > 0) {
          showClientConfigurationSuccess(names);
        } else if (result.missingExtensions.length === Object.keys(MCP_CLIENT_EXTENSION_IDS).length) {
          const openExtensions = t('Open Extensions');
          const showConfiguration = t('Show MCP Configuration');
          void vscode.window.showErrorMessage(
            t('CanMV: Install the Codex or Claude Code extension before configuring MCP.'),
            openExtensions,
            showConfiguration,
          ).then((choice) => {
            if (choice === openExtensions) {
              void vscode.commands.executeCommand(
                'workbench.extensions.action.showExtensionsWithIds',
                Object.values(MCP_CLIENT_EXTENSION_IDS),
              );
            } else if (choice === showConfiguration) {
              void showManualConfiguration();
            }
          });
        } else {
          const showConfiguration = t('Show MCP Configuration');
          void vscode.window.showWarningMessage(
            t('CanMV: No supported Codex or Claude Code client was found.'),
            showConfiguration,
          ).then((choice) => {
            if (choice === showConfiguration) void showManualConfiguration();
          });
        }
      }, (err) => {
        logWarn('MCP', `Client configuration failed: ${err instanceof Error ? err.message : String(err)}`);
        vscode.window.showErrorMessage(t('CanMV: MCP client configuration failed. See the CanMV output for details.'));
      });
    }
    return configurePromise;
  };

  const configureAutomatically = (force = false): void => {
    if (!httpConnection || !shouldAutoConfigureExternalClients()) return;
    if (force && configurePromise) configureAgain = true;
    void configureClients(false).then((result) => {
      if (result.failed.length > 0) showClientConfigurationFailure();
    }, (err) => {
      logWarn('MCP', `Automatic client configuration failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const showManualConfiguration = async (): Promise<void> => {
    const connection = httpConnection;
    if (!connection) {
      showClientConfigurationFailure();
      return;
    }
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: manualMcpConfiguration(connection),
    });
    await vscode.window.showTextDocument(document, { preview: true });
  };

  let lastRelayUpstreamUrl = httpConnection?.url;
  const connectionSubscription = httpService.onDidChangeConnection((connection) => {
    if (connection && lastRelayUpstreamUrl && connection.url !== lastRelayUpstreamUrl) {
      wslRelay.reset();
    }
    if (connection) lastRelayUpstreamUrl = connection.url;
    httpConnection = connection;
    changed.fire();
    if (connection) configureAutomatically();
  });

  let restartPromise: Promise<void> | undefined;
  let restartAgain = false;
  const restartHttpService = (): void => {
    if (restartPromise) {
      restartAgain = true;
      return;
    }
    restartPromise = (async () => {
      do {
        restartAgain = false;
        try {
          await httpService.restart();
        } catch (err) {
          logWarn('MCP', `Unable to refresh Streamable HTTP service settings: ${err instanceof Error ? err.message : String(err)}`);
        }
      } while (restartAgain);
    })().finally(() => {
      restartPromise = undefined;
      if (restartAgain) restartHttpService();
    });
  };

  const configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('canmv.baudRate')
      || event.affectsConfiguration('canmv.autoMinifyStartupScripts')) {
      restartHttpService();
    }
    if (event.affectsConfiguration('chatgpt.runCodexInWindowsSubsystemForLinux')) {
      wslRelay.reset();
      changed.fire();
      configureAutomatically(true);
    }
  });

  context.subscriptions.push(
    changed,
    connectionSubscription,
    configSubscription,
    vscode.commands.registerCommand('canmv.configureMcpClients', () => configureClients(true)),
    vscode.commands.registerCommand('canmv.showMcpConfiguration', showManualConfiguration),
  );

  configureAutomatically();

  const registerProvider = vscode.lm?.registerMcpServerDefinitionProvider;
  if (typeof registerProvider !== 'function' || typeof vscode.McpHttpServerDefinition !== 'function') {
    logWarn('MCP', 'VS Code Streamable HTTP MCP server definition API is unavailable in this runtime');
    return;
  }

  const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => {
      const connection = httpConnection;
      if (!connection) return [];
      const pkg = context.extension.packageJSON as { version?: string };
      const version = pkg.version || 'unknown';
      return [new vscode.McpHttpServerDefinition(
        'CanMV K230',
        vscode.Uri.parse(connection.url),
        connection.headers,
        version,
      )];
    },
    resolveMcpServerDefinition: (server) => {
      const connection = httpConnection;
      if (!connection) throw new Error('CanMV MCP HTTP service is unavailable');
      server.uri = vscode.Uri.parse(connection.url);
      server.headers = connection.headers;
      return server;
    },
  };

  context.subscriptions.push(
    registerProvider(CANMV_MCP_PROVIDER_ID, provider),
  );
  logInfo('MCP', 'Registered CanMV Streamable HTTP server definition provider');
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

function manualMcpConfiguration(connection: McpHttpConnectionInfo): string {
  const definition = {
    type: 'http',
    url: connection.url,
    headers: connection.headers,
  };
  const json = JSON.stringify({
    mcpServers: {
      'canmv-k230': definition,
    },
  }, null, 2);
  const headers = Object.entries(connection.headers)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
    .join(', ');
  return [
    `# ${t('CanMV MCP configuration')}`,
    '',
    `> ${t('Keep this bearer token private. The endpoint is available only while the CanMV extension is running.')}`,
    '',
    '## JSON',
    '',
    '```json',
    json,
    '```',
    '',
    '## TOML',
    '',
    '```toml',
    '[mcp_servers.canmv-k230]',
    `url = ${JSON.stringify(connection.url)}`,
    `http_headers = { ${headers} }`,
    '```',
    '',
  ].join('\n');
}
