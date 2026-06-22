import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class TerminalViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private inputEnabled = false;
  private inputReason = 'Connect board to use REPL input';
  private interruptEnabled = false;
  private _onClear = new vscode.EventEmitter<void>();
  private _onInput = new vscode.EventEmitter<string>();
  readonly onClear = this._onClear.event;
  readonly onInput = this._onInput.event;

  constructor(
    private context: vscode.ExtensionContext,
    private scrollback: () => string,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    const htmlPath = path.join(this.context.extensionPath, 'webview', 'terminal.html');
    webviewView.webview.html = fs.readFileSync(htmlPath, 'utf-8');
    webviewView.webview.onDidReceiveMessage((msg: any) => {
      if (msg.type === 'clearTerminal') {
        this._onClear.fire();
        this.clear();
      } else if (msg.type === 'saveTerminalLog') {
        void this.saveLog();
      } else if (msg.type === 'terminalReady') {
        this.postInputState();
      } else if (msg.type === 'terminalInput' && typeof msg.text === 'string') {
        this._onInput.fire(msg.text);
      }
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
    const text = this.scrollback();
    if (text) {
      queueMicrotask(() => this.appendText(text));
    }
    setTimeout(() => this.postInputState(), 50);
  }

  appendText(text: string): void {
    if (this.view) {
      void this.view.webview.postMessage({ type: 'append', text });
    }
  }

  clear(): void {
    if (this.view) {
      void this.view.webview.postMessage({ type: 'clear' });
    }
  }

  private async saveLog(): Promise<void> {
    const text = this.scrollback();
    if (!text) {
      void vscode.window.showInformationMessage('CanMV: Terminal log is empty.');
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = base ? vscode.Uri.joinPath(base, `canmv-terminal-${stamp}.log`) : undefined;
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'Log File': ['log'], 'Text File': ['txt'], 'All Files': ['*'] },
      saveLabel: 'Save Log',
    });
    if (!target) return;

    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    void vscode.window.showInformationMessage(`CanMV: Terminal log saved to ${target.fsPath}`);
  }

  setInputEnabled(enabled: boolean, reason = '', interruptEnabled = false): void {
    this.inputEnabled = enabled;
    this.inputReason = reason;
    this.interruptEnabled = interruptEnabled;
    this.postInputState();
  }

  private postInputState(): void {
    if (this.view) {
      void this.view.webview.postMessage({
        type: 'inputState',
        enabled: this.inputEnabled,
        reason: this.inputReason,
        interruptEnabled: this.interruptEnabled,
      });
    }
  }
}
