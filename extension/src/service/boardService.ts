import * as vscode from 'vscode';
import { Session } from '../session/session';
import { Methods, createRequest } from '../protocol/methods';
import { isResponse } from '../protocol/types';
import { logBlock, logError, logInfo } from '../output';
import { BoardDetector } from '../backend/detector';
import type { ProtocolError } from '../protocol/types';
import { t } from '../i18n';

export interface BoardInfo {
  boardType: string;
  fwVersion: string;
  fwVersionFull?: string;
  archStr?: string;
  boardName?: string;
  memorySize?: string;
  protocolVersion?: number;
  capabilities?: Record<string, unknown>;
  port?: string;
}

export class BoardService {
  private cachedInfo: BoardInfo | null = null;

  constructor(
    private session: Session,
    private detector: BoardDetector,
  ) {}

  async connectBoard(): Promise<string | null> {
    const config = vscode.workspace.getConfiguration('canmv');
    const configuredPort = config.get<string>('serialPath', '');
    const baudRate = config.get<number>('baudRate', 115200);

    let port: string;
    let backendOpenedForDetection = false;

    // Manual override
    if (configuredPort) {
      port = configuredPort;
      logInfo('Board', `Using configured serial port: ${port}`);
    } else {
      await this.session.connect('__detect__', baudRate);
      backendOpenedForDetection = true;

      const boards = await this.detector.scan();
      logInfo('Board', `Auto-detected ${boards.length} CanMV device${boards.length === 1 ? '' : 's'}`);
      if (boards.length === 0) {
        await this.session.disconnect();
        vscode.window.showErrorMessage(
          t('CanMV: No CanMV device detected. Connect the board via USB or configure canmv.serialPath in settings.')
        );
        return null;
      }
      if (boards.length === 1) {
        port = boards[0].port;
        logInfo('Board', `Selected device: ${port} (${boards[0].name})`);
      } else {
        const selected = await vscode.window.showQuickPick(
          boards.map(b => ({
            label: b.port,
            description: b.name,
            detail: [
              b.vid && b.pid ? 'USB ' + b.vid + ':' + b.pid : undefined,
              b.serialNumber ? t('Serial {serialNumber}', { serialNumber: b.serialNumber }) : undefined,
              b.description,
            ].filter(Boolean).join(' | '),
          })),
          { placeHolder: t('Select CanMV device') }
        );
        if (!selected) {
          await this.session.disconnect();
          return null;
        }
        port = selected.label;
        logInfo('Board', `Selected device: ${port}`);
      }
    }

    try {
      if (!backendOpenedForDetection) {
        await this.session.connect(port, baudRate);
      }
      const req = createRequest(Methods.connectBoard, { port, baudRate });
      const result = await this.session.request(req);
      if (isResponse(result)) {
        const info = result.result as BoardInfo & { repl?: string };
        this.cachedInfo = info;
        const connectedPort = info.port || port;
        logInfo(
          'Board',
          `Connected: ${[info.boardName || info.boardType, info.fwVersion, info.memorySize].filter(Boolean).join(' ')} on ${connectedPort}`
        );
        if (info.archStr) {
          logInfo('Board', `ARCH_STR: ${info.archStr}`);
        }
        if (info.repl) {
          logBlock('REPL', 'Boot output', redactFirmwareRevision(info.repl), 80);
        }
        vscode.window.showInformationMessage(
          t('CanMV: Connected - {boardType} (FW {firmwareVersion})', { boardType: info.boardType, firmwareVersion: info.fwVersion })
        );
        return info.repl || null;
      } else {
        const err = result as ProtocolError;
        logError('Board', `Connect failed: ${err.error.message}`);
        vscode.window.showErrorMessage(t('CanMV: {message}', { message: err.error.message }));
        if (backendOpenedForDetection) {
          await this.session.disconnect();
        }
        return null;
      }
    } catch (err) {
      logError('Board', `Connect failed: ${err instanceof Error ? err.message : String(err)}`);
      vscode.window.showErrorMessage(t('CanMV: Failed to connect - {message}', { message: String(err) }));
      if (backendOpenedForDetection) {
        await this.session.disconnect();
      }
      return null;
    }
  }

  async disconnectBoard(): Promise<void> {
    await this.session.disconnect();
    logInfo('Board', 'Disconnected');
    this.cachedInfo = null;
  }

  boardInfo(): BoardInfo | null {
    return this.cachedInfo;
  }

  setBoardInfo(info: BoardInfo): void {
    this.cachedInfo = info;
  }
}

function redactFirmwareRevision(text: string): string {
  return text
    .replace(/-([0-9]+)-g[0-9a-fA-F]{7,40}\b/g, '-$1')
    .replace(/-(?:g)?[0-9a-fA-F]{7,40}\b/g, '')
    .replace(/\b[0-9a-fA-F]{40}\b/g, '<revision>');
}
