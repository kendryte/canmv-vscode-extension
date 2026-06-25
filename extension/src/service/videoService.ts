import * as vscode from 'vscode';
import { BackendApi } from '../backend/api';
import { Session } from '../session/session';
import { PreviewPanel } from '../webview/PreviewPanel';
import { Methods, createRequest } from '../protocol/methods';
import { isResponse, isFrameEvent } from '../protocol/types';
import { FrameProfiler } from './profiler';
import { logDebug, logError, logInfo, logWarn } from '../output';
import type { Event as ProtocolEvent, ProtocolError } from '../protocol/types';
import { t } from '../i18n';

/**
 * VideoService — manages video preview lifecycle.
 * Depends on Session + BackendApi + PreviewPanel.
 * Maintains latestFrame cache and dispatches frameAvailable events to webview.
 * Integrates FrameProfiler when CANMV_PROFILE=1 for end-to-end latency analysis.
 */
export class VideoService {
  private latestFrame: ArrayBuffer | Uint8Array | null = null;
  private frameSubscription: vscode.Disposable | null = null;
  private profiler = new FrameProfiler();
  private frameCount = 0;
  private previewActive = false;
  private lastFrameAt = 0;
  private firstFrameCallback: (() => void) | undefined;

  constructor(
    private session: Session,
    private backend: BackendApi,
    private panel: PreviewPanel,
  ) {
    // Receive webview profiling reports (decode/draw stats)
    this.panel.onProfile((msg: any) => {
      if (msg.segments) {
        for (const [label, stats] of Object.entries(msg.segments)) {
          const s = stats as { avg: number; p95: number; max: number };
          logInfo('Profile WebView', `frames ${msg.frameRange} ${label}: avg=${s.avg.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms max=${s.max.toFixed(2)}ms`);
        }
      }
    });
  }

  async startPreview(fps?: number, resolution?: { w: number; h: number }, options?: { assumeScriptRunning?: boolean; suppressErrors?: boolean }): Promise<boolean> {
    const suppressErrors = options?.suppressErrors === true;
    if (this.previewActive) {
      return true;
    }
    if (this.session.state === 'streaming') {
      this.clearPreviewState();
    }
    if (this.session.state !== 'connected') {
      vscode.window.showWarningMessage(t('CanMV: Please connect to the board first.'));
      return false;
    }
    if (!options?.assumeScriptRunning) {
      const runningResult = await this.session.request(createRequest(Methods.scriptRunning, {}));
      if (!isResponse(runningResult)) {
        const err = runningResult as ProtocolError;
        logWarn('Preview', `Skipped: ${err.error.message}`);
        if (!suppressErrors) {
          vscode.window.showWarningMessage(t('CanMV: Cannot enable preview - {message}', { message: err.error.message }));
        }
        return false;
      }
      const runningPayload = runningResult.result as { running?: boolean };
      if (!runningPayload.running) {
        logDebug('Preview', 'Skipped: no script is running on board');
        return false;
      }
    }

    const req = createRequest(Methods.startPreview, { fps, resolution });

    this.frameCount = 0;
    this.frameSubscription?.dispose();

    this.frameSubscription = this.backend.onEvent((event: ProtocolEvent<string>) => {
      if (isFrameEvent(event)) {
        const params = event.params as { data: ArrayBuffer | Uint8Array; frameId: number; chunkTs?: number; dispatchTs?: number };
        this.frameCount = params.frameId;
        this.profiler.startFrame(params.frameId);
        this.profiler.mark(params.frameId, 'ts_chunk', params.chunkTs);
        this.profiler.mark(params.frameId, 'ts_dispatch', params.dispatchTs);
        this.profiler.mark(params.frameId, 'ts_service');
        this.profiler.finishFrame();

        this.latestFrame = params.data;
        this.lastFrameAt = Date.now();
        this.panel.sendFrame(params.frameId, this.latestFrame);
        if (this.frameCount === 1 && this.firstFrameCallback) {
          this.firstFrameCallback();
        }

        if (this.frameCount === 1 || this.frameCount % 100 === 0) {
          logInfo('Preview', `Frame ${this.frameCount} delivered (${params.data.byteLength}B)`);
        }

        // Batch stats every 100 frames
        if (this.profiler.shouldFlush()) {
          const report = this.profiler.flushSegments();
          if (report) {
            logInfo('Profile', `frames ${report.frameRange}`);
            for (const [label, stats] of Object.entries(report.segments)) {
              logInfo('Profile', `${label}: avg=${stats.avg.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`);
            }
          }
        }
      }
    });

    const result = await this.session.request(req);

    if (isResponse(result)) {
      const payload = result.result as { status?: string; message?: string };
      if (payload.status === 'error') {
        this.frameSubscription?.dispose();
        this.frameSubscription = null;
        const message = payload.message || t('Unknown preview error');
        logError('Preview', `Start failed: ${message}`);
        if (!suppressErrors) {
          vscode.window.showErrorMessage(t('CanMV: Preview failed - {message}', { message }));
        }
        return false;
      }
      if (payload.status === 'waiting') {
        this.frameSubscription?.dispose();
        this.frameSubscription = null;
        logDebug('Preview', 'Waiting for framebuffer');
        return false;
      }
      logInfo('Preview', 'Started');
      this.previewActive = true;
      this.session.startStreaming();
      this.panel.postMessage({ type: 'started' });
      return true;
    } else {
      this.frameSubscription?.dispose();
      this.frameSubscription = null;
      const err = result as ProtocolError;
      logError('Preview', `Start failed: ${err.error.message}`);
      if (!suppressErrors) {
        vscode.window.showErrorMessage(t('CanMV: Preview failed - {message}', { message: err.error.message }));
      }
      return false;
    }
  }

  async stopPreview(): Promise<void> {
    logInfo('Preview', 'Stopping');
    try {
      const req = createRequest(Methods.stopPreview, {});
      await this.session.request(req);
    } finally {
      this.clearPreviewState();
    }
  }

  clearPreviewState(): void {
    const hadPreviewState = this.previewActive || this.frameSubscription !== null || this.latestFrame !== null;
    this.session.stopStreaming();
    this.frameSubscription?.dispose();
    this.frameSubscription = null;
    this.latestFrame = null;
    this.lastFrameAt = 0;
    this.previewActive = false;
    if (hadPreviewState && !this.panel.disposed) {
      logInfo('Preview', 'Stopped');
      this.panel.postMessage({ type: 'stopped' });
    }
  }

  getLatestFrame(): ArrayBuffer | Uint8Array | null {
    return this.latestFrame;
  }

  lastFrameAgeMs(now = Date.now()): number | null {
    return this.lastFrameAt > 0 ? now - this.lastFrameAt : null;
  }

  hasActivePreview(): boolean {
    return this.previewActive;
  }

  onFirstFrame(callback: () => void): void {
    this.firstFrameCallback = callback;
  }
}
