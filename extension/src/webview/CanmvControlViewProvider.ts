import * as vscode from 'vscode';
import { states } from '../i18n';

type ControlState = {
  connected: boolean;
  scriptRunning: boolean;
  statusText: string;
};

export class CanmvControlViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private state: ControlState = {
    connected: false,
    scriptRunning: false,
    statusText: states.disconnected(),
  };

  constructor(private context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((msg: any) => {
      void this.handleMessage(msg);
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  setState(patch: Partial<ControlState>): void {
    this.state = { ...this.state, ...patch };
    this.post({ type: 'state', state: this.state });
  }

  private async handleMessage(msg: any): Promise<void> {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ready') {
      this.post({ type: 'state', state: this.state });
      return;
    }
    if (msg.type === 'command' && typeof msg.command === 'string') {
      await vscode.commands.executeCommand(msg.command);
      return;
    }
  }

  private post(message: unknown): void {
    if (this.view) {
      void this.view.webview.postMessage(message);
    }
  }

  private html(): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
    ].join('; ');
    return `<!doctype html>
<html lang="${escapeHtml(vscode.env.language || 'en')}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      min-height: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: var(--vscode-font-size) var(--vscode-font-family);
      overflow: hidden;
    }
    .bar {
      min-height: 28px;
      padding: 2px 6px;
    }
    .status {
      display: grid;
      grid-template-columns: 8px minmax(0, 1fr) auto;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-testing-iconFailed);
    }
    .dot.connected {
      background: var(--vscode-testing-iconPassed);
    }
    .status-main {
      min-width: 0;
      overflow: hidden;
    }
    .status-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-foreground);
      font-weight: 500;
    }
    .status-subtitle {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      margin-top: 1px;
    }
    .badge {
      min-width: 42px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-align: right;
    }
    .badge.idle {
      color: var(--vscode-descriptionForeground);
      background: transparent;
    }
  </style>
</head>
<body>
  <div class="bar">
    <div class="status">
      <span id="status-dot" class="dot"></span>
      <span class="status-main">
        <span id="status-title" class="status-title">CanMV</span>
        <span id="status-text" class="status-subtitle">${escapeHtml(states.disconnected())}</span>
      </span>
      <span id="status-badge" class="badge idle">${escapeHtml(states.offline())}</span>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const statusDot = document.getElementById('status-dot');
    const statusTitle = document.getElementById('status-title');
    const statusText = document.getElementById('status-text');
    const statusBadge = document.getElementById('status-badge');
    const l10n = ${jsonForScript({
      canmv: 'CanMV',
      canmvBoard: states.canmvBoard(),
      connected: states.connected(),
      disconnected: states.disconnected(),
      offline: states.offline(),
      ready: states.ready(),
      running: states.running(),
    })};
    let state = { connected: false, scriptRunning: false, statusText: l10n.disconnected };

    window.addEventListener('message', event => {
      const msg = event.data || {};
      if (msg.type === 'state') {
        state = msg.state || state;
        renderState();
      }
    });

    function renderState() {
      statusTitle.textContent = state.connected ? l10n.canmvBoard : l10n.canmv;
      statusText.textContent = state.statusText || (state.connected ? l10n.connected : l10n.disconnected);
      statusBadge.textContent = state.scriptRunning ? l10n.running : (state.connected ? l10n.ready : l10n.offline);
      statusBadge.classList.toggle('idle', !state.connected || !state.scriptRunning);
      statusDot.classList.toggle('connected', !!state.connected);
    }

    renderState();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
