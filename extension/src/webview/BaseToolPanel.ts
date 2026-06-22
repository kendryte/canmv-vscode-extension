import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export abstract class BaseToolPanel {
  protected panel: vscode.WebviewPanel;
  private _disposed = false;
  /** Fired when VS Code disposes the webview (user closes tab). */
  readonly onDidDispose: vscode.Event<void>;

  constructor(
    protected id: string,
    protected title: string,
    context: vscode.ExtensionContext,
    htmlFile: string
  ) {
    this.panel = vscode.window.createWebviewPanel(
      id, title, BaseToolPanel.resolveColumn(),
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const htmlPath = path.join(context.extensionPath, 'webview', htmlFile);
    this.panel.webview.html = fs.readFileSync(htmlPath, 'utf-8');

    // Track disposal — when user closes the tab, VS Code fires this.
    this.onDidDispose = this.panel.onDidDispose;
    this.panel.onDidDispose(() => {
      this._disposed = true;
    });
  }

  static resolveColumn(): vscode.ViewColumn {
    const groups = new Set<number>();
    for (const editor of vscode.window.visibleTextEditors) {
      const col = editor.viewColumn ?? vscode.ViewColumn.One;
      groups.add(col);
    }
    return groups.size >= 2 ? Math.max(...groups) : vscode.ViewColumn.Beside;
  }

  get disposed(): boolean { return this._disposed; }

  reveal(): void { this.panel.reveal(undefined, false); }

  dispose(): void {
    this._disposed = true;
    this.panel.dispose();
  }

  postMessage(message: unknown): void { this.panel.webview.postMessage(message); }

  sendState(state: string): void { this.postMessage({ type: 'state', state }); }
}
