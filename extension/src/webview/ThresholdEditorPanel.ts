import * as vscode from 'vscode';
import { BaseToolPanel } from './BaseToolPanel';

export type ThresholdMode = 'grayscale' | 'lab';

export type ThresholdEditorConfig = {
  mode?: ThresholdMode;
  values?: number[];
  canApplyToEditor?: boolean;
};

export class ThresholdEditorPanel extends BaseToolPanel {
  private readonly _onCopyThreshold = new vscode.EventEmitter<string>();
  private readonly _onApplyThreshold = new vscode.EventEmitter<string>();
  private readonly _onRequestPreviewFrame = new vscode.EventEmitter<void>();
  private config: ThresholdEditorConfig = {};
  private ready = false;

  readonly onCopyThreshold = this._onCopyThreshold.event;
  readonly onApplyThreshold = this._onApplyThreshold.event;
  readonly onRequestPreviewFrame = this._onRequestPreviewFrame.event;

  constructor(context: vscode.ExtensionContext) {
    super('canmvThresholdEditor', 'Threshold Editor', context, 'threshold.html');
    this.panel.webview.onDidReceiveMessage((msg: any) => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'ready') {
        this.ready = true;
        this.sendConfig();
      } else if (msg.type === 'copyThreshold' && typeof msg.text === 'string') {
        this._onCopyThreshold.fire(msg.text);
      } else if (msg.type === 'applyThreshold' && typeof msg.text === 'string') {
        this._onApplyThreshold.fire(msg.text);
      } else if (msg.type === 'requestPreviewFrame') {
        this._onRequestPreviewFrame.fire();
      }
    });
  }

  configure(config: ThresholdEditorConfig): void {
    this.config = { ...config };
    this.sendConfig();
  }

  sendPreviewFrame(data: ArrayBuffer | Uint8Array, name = 'Preview Frame'): void {
    this.postMessage({
      type: 'previewFrame',
      data,
      byteLength: data.byteLength,
      name,
    });
  }

  sendFrameUnavailable(message: string): void {
    this.postMessage({ type: 'frameUnavailable', message });
  }

  sendCopied(): void {
    this.postMessage({ type: 'copied' });
  }

  sendApplied(): void {
    this.postMessage({ type: 'applied' });
  }

  private sendConfig(): void {
    if (!this.ready) return;
    this.postMessage({ type: 'configure', config: this.config });
  }
}
