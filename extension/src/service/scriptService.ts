import * as vscode from 'vscode';
import { Methods, createRequest } from '../protocol/methods';
import { Request, Response, isResponse } from '../protocol/types';
import { logBlock, logError, logInfo, logWarn } from '../output';
import type { ProtocolError } from '../protocol/types';
import { t } from '../i18n';

interface ProtocolRequester {
  request(req: Request<string>): Promise<Response | ProtocolError>;
}

/**
 * ScriptService — executes Python scripts on the board.
 * Depends on a request transport. Does NOT check connection state — caller is responsible.
 */
export class ScriptService {
  private lastPythonEditor: vscode.TextEditor | undefined;

  constructor(private requester: ProtocolRequester) {
    // Track the last active Python editor so Run Script works
    // even when the webview panel is focused.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.languageId === 'python') {
        this.lastPythonEditor = editor;
      }
    });
    // Initialize from current editor
    const current = vscode.window.activeTextEditor;
    if (current && current.document.languageId === 'python') {
      this.lastPythonEditor = current;
    }
  }

  async runCurrentScript(): Promise<boolean> {
    let editor = vscode.window.activeTextEditor;
    // If the active "editor" is the webview, fall back to the last known Python editor
    if (!editor || editor.document.languageId !== 'python') {
      editor = this.lastPythonEditor;
    }
    if (!editor) {
      vscode.window.showWarningMessage(t('CanMV: No Python file open. Open a .py file first.'));
      return false;
    }

    const script = editor.document.getText();
    const filename = editor.document.fileName.split('/').pop() || 'script.py';
    logInfo('Script', `Run active file: ${filename} (${script.length}B)`);
    const req = createRequest(Methods.runScript, { script });
    const result = await this.requester.request(req);

    if (isResponse(result)) {
      const r = result.result as { status: 'ok' | 'error'; output?: string; message?: string };
      if (r.status === 'ok') {
        logInfo('Script', `Started: ${filename}`);
        if (r.output) {
          logBlock('REPL', `Output from ${filename}`, r.output, 120);
        }
        vscode.window.showInformationMessage(t('CanMV: Script executed successfully ({filename}).', { filename }));
        return true;
      } else {
        const message = r.message || r.output || 'unknown';
        logWarn('Script', `Run error: ${message}`);
        vscode.window.showWarningMessage(t('CanMV: Script error - {message}', { message }));
        return false;
      }
    } else {
      const err = result as ProtocolError;
      logError('Script', `Run failed: ${err.error.message}`);
      vscode.window.showErrorMessage(t('CanMV: {message}', { message: err.error.message }));
      return false;
    }
  }

  async stopScript(): Promise<void> {
    const req = createRequest(Methods.stopScript, {});
    await this.requester.request(req);
  }
}
