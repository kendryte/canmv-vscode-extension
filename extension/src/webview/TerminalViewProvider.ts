import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { injectWebviewStrings, t } from '../i18n';

export class TerminalViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private inputEnabled = false;
  private inputReason = t('Connect board to use REPL input');
  private interruptEnabled = false;
  private pendingText = '';
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private _onClear = new vscode.EventEmitter<void>();
  private _onInput = new vscode.EventEmitter<string>();
  readonly onClear = this._onClear.event;
  readonly onInput = this._onInput.event;
  private readonly flushDelayMs = 100;
  private readonly immediateFlushBytes = 256 * 1024;

  constructor(
    private context: vscode.ExtensionContext,
    private scrollback: () => string,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    const htmlPath = path.join(this.context.extensionPath, 'webview', 'terminal.html');
    webviewView.webview.html = injectWebviewStrings(fs.readFileSync(htmlPath, 'utf-8'));
    webviewView.webview.onDidReceiveMessage((msg: any) => {
      if (msg.type === 'clearTerminal') {
        this._onClear.fire();
        this.clear();
      } else if (msg.type === 'saveTerminalLog') {
        void this.saveLog();
      } else if (msg.type === 'terminalReady') {
        this.flushPendingText();
        this.postInputState();
      } else if (msg.type === 'terminalInput' && typeof msg.text === 'string') {
        this._onInput.fire(msg.text);
      }
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        this.clearPendingText();
      }
    });
    const text = this.scrollback();
    if (text) {
      queueMicrotask(() => this.appendText(text));
    }
    setTimeout(() => this.postInputState(), 50);
  }

  appendText(text: string): void {
    if (!this.view || !text) {
      return;
    }
    this.pendingText += text;
    if (this.pendingText.length >= this.immediateFlushBytes) {
      this.flushPendingText();
      return;
    }
    this.scheduleFlush();
  }

  clear(): void {
    this.clearPendingText();
    if (this.view) {
      void this.view.webview.postMessage({ type: 'clear' });
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushPendingText();
    }, this.flushDelayMs);
  }

  private flushPendingText(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.view || !this.pendingText) {
      return;
    }
    const text = this.pendingText;
    this.pendingText = '';
    void this.view.webview.postMessage({ type: 'append', text });
  }

  private clearPendingText(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.pendingText = '';
  }

  private async saveLog(): Promise<void> {
    const text = this.scrollback();
    if (!text) {
      void vscode.window.showInformationMessage(t('CanMV: Terminal log is empty.'));
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = base ? vscode.Uri.joinPath(base, `canmv-terminal-${stamp}.log`) : undefined;
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { [t('Log File')]: ['log'], [t('Text File')]: ['txt'], [t('All Files')]: ['*'] },
      saveLabel: t('Save Log'),
    });
    if (!target) return;

    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    void vscode.window.showInformationMessage(t('CanMV: Terminal log saved to {path}', { path: target.fsPath }));
  }

  setInputEnabled(enabled: boolean, reason = '', interruptEnabled = false): void {
    if (this.inputEnabled === enabled && this.inputReason === reason && this.interruptEnabled === interruptEnabled) {
      return;
    }
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
