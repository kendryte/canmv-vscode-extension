import * as vscode from 'vscode';
import { BaseToolPanel } from './BaseToolPanel';

export class PreviewPanel extends BaseToolPanel {
  private _onProfile = new vscode.EventEmitter<any>();
  private _onCommand = new vscode.EventEmitter<string>();
  private _onSaveImage = new vscode.EventEmitter<Uint8Array>();
  private _onVirtualTouch = new vscode.EventEmitter<{ x: number; y: number; sourceWidth: number; sourceHeight: number }>();
  readonly onProfile = this._onProfile.event;
  readonly onCommand = this._onCommand.event;
  readonly onSaveImage = this._onSaveImage.event;
  readonly onVirtualTouch = this._onVirtualTouch.event;

  constructor(context: vscode.ExtensionContext) {
    super('canmvPreview', 'CanMV Preview', context, 'index.html');
    this.panel.webview.onDidReceiveMessage((msg: any) => {
      if (msg.type === 'profile') {
        this._onProfile.fire(msg);
      } else if (msg.type === 'previewCommand' && typeof msg.command === 'string') {
        this._onCommand.fire(msg.command);
      } else if (msg.type === 'saveImage' && msg.data) {
        this._onSaveImage.fire(new Uint8Array(msg.data));
      } else if (msg.type === 'virtualTouch') {
        const payload = {
          x: Number(msg.x),
          y: Number(msg.y),
          sourceWidth: Number(msg.sourceWidth),
          sourceHeight: Number(msg.sourceHeight),
        };
        if ([payload.x, payload.y, payload.sourceWidth, payload.sourceHeight].every(Number.isFinite)) {
          this._onVirtualTouch.fire(payload);
        }
      }
    });
    this.postMessage({ type: 'profileConfig', enabled: process.env.CANMV_PROFILE === '1' });
  }

  sendBoardInfo(info: { boardType: string; fwVersion: string; boardName?: string; memorySize?: string }): void {
    this.postMessage({ type: 'boardInfo', ...info });
  }

  sendFrame(frameId: number, data: ArrayBuffer): void {
    const bytes = new Uint8Array(data);
    this.postMessage({ type: 'frame', data: bytes, byteLength: bytes.byteLength, frameId });
  }

  sendStarted(): void { this.postMessage({ type: 'started' }); }

  sendStopped(): void { this.postMessage({ type: 'stopped' }); }

  sendPreviewDisabled(disabled: boolean): void {
    this.postMessage({ type: 'previewDisabled', disabled });
  }

  sendScriptRunning(running: boolean): void {
    this.postMessage({ type: 'scriptRunning', running });
  }

  sendVirtualTouchState(state: { supported: boolean; enabled: boolean; range?: { w: number; h: number } }): void {
    this.postMessage({ type: 'virtualTouchState', ...state });
  }

  isActive(): boolean { return this.panel.visible; }
}
