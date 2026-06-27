import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { logError, logInfo, logWarn } from '../output';
import { resolveNativeBackendCommand } from '../backend/native';
import { CanmvResourceRoute, CanmvResourceRouteService, normalizeExamplesId } from './resourceRouteService';

export class ExamplesService {
  private static readonly lastExamplesKey = 'canmv.examples.lastId';
  private readonly _onDidChangeExamples = new vscode.EventEmitter<void>();
  readonly onDidChangeExamples = this._onDidChangeExamples.event;
  private readonly baseDir: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly routeService: CanmvResourceRouteService,
  ) {
    this.baseDir = path.join(os.homedir(), '.kendryte', 'k230_canmv_examples');
  }

  async ensureExamples(route: CanmvResourceRoute | null): Promise<string | null> {
    const examplesId = normalizeExamplesId(route?.examplesId || '');
    if (!examplesId) return this.ensureLocalExamples();

    if (this.isCacheUsable(examplesId)) {
      const cacheDir = this.cacheDirFor(examplesId);
      logInfo('Examples', `Using local examples: ${examplesId} (${cacheDir})`);
      await this.context.globalState.update(ExamplesService.lastExamplesKey, examplesId);
      this._onDidChangeExamples.fire();
      return cacheDir;
    }

    if (!this.canAutoDownload()) {
      logInfo('Examples', `Examples are not cached and auto-download is disabled: ${examplesId}`);
      return null;
    }

    if (!route?.examplesUrl) {
      logWarn('Examples', `Firmware manifest does not include examples URL: ${examplesId}`);
      return null;
    }

    const cacheDir = this.cacheDirFor(examplesId);
    if (await this.downloadAndExtract(examplesId, route.examplesUrl, cacheDir)) {
      await this.context.globalState.update(ExamplesService.lastExamplesKey, examplesId);
      this._onDidChangeExamples.fire();
      return cacheDir;
    }

    return null;
  }

  activeExamplesDir(): string {
    const lastExamplesId = this.context.globalState.get<string>(ExamplesService.lastExamplesKey) || '';
    const normalized = normalizeExamplesId(lastExamplesId);
    if (normalized && this.isCacheUsable(normalized)) {
      return this.cacheDirFor(normalized);
    }
    const localExamplesId = this.findLatestLocalExamplesId();
    return localExamplesId ? this.cacheDirFor(localExamplesId) : '';
  }

  examplesRootDir(): string {
    return this.baseDir;
  }

  refresh(): void {
    this._onDidChangeExamples.fire();
  }

  private canAutoDownload(): boolean {
    const autoDownload = vscode.workspace.getConfiguration('canmv').get<boolean>('stubsAutoDownload', true);
    if (!autoDownload) {
      logInfo('Examples', 'Auto-download disabled (canmv.stubsAutoDownload = false)');
      return false;
    }
    return true;
  }

  private cacheDirFor(examplesId: string): string {
    return path.join(this.baseDir, examplesId);
  }

  private isCacheUsable(examplesId: string): boolean {
    const normalized = normalizeExamplesId(examplesId);
    if (!normalized) return false;
    const cacheDir = this.cacheDirFor(normalized);
    try {
      return fs.existsSync(cacheDir) && this.hasExtractedContent(cacheDir);
    } catch {
      return false;
    }
  }

  private async ensureLocalExamples(): Promise<string | null> {
    const lastExamplesId = this.context.globalState.get<string>(ExamplesService.lastExamplesKey) || '';
    const normalized = normalizeExamplesId(lastExamplesId);
    if (normalized && this.isCacheUsable(normalized)) {
      const cacheDir = this.cacheDirFor(normalized);
      logInfo('Examples', `Using last configured local examples: ${normalized} (${cacheDir})`);
      return cacheDir;
    }

    const localExamplesId = this.findLatestLocalExamplesId();
    if (localExamplesId) {
      const cacheDir = this.cacheDirFor(localExamplesId);
      logInfo('Examples', `Using latest local cached examples: ${localExamplesId} (${cacheDir})`);
      await this.context.globalState.update(ExamplesService.lastExamplesKey, localExamplesId);
      this._onDidChangeExamples.fire();
      return cacheDir;
    }

    return null;
  }

  private findLatestLocalExamplesId(): string {
    try {
      if (!fs.existsSync(this.baseDir)) return '';
      const examples = fs.readdirSync(this.baseDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && this.isCacheUsable(entry.name))
        .map(entry => {
          const examplesId = entry.name;
          const mtime = fs.statSync(this.cacheDirFor(examplesId)).mtimeMs;
          return { examplesId, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return examples[0]?.examplesId || '';
    } catch {
      return '';
    }
  }

  private hasExtractedContent(cacheDir: string): boolean {
    try {
      const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
      return entries.some(entry =>
        entry.isDirectory() && (entry.name === 'examples' || entry.name === 'models')
      );
    } catch {
      return false;
    }
  }

  private async downloadAndExtract(examplesId: string, zipUrl: string, cacheDir: string): Promise<boolean> {
    logInfo('Examples', `Downloading examples archive: ${zipUrl}`);
    try {
      const data = await this.routeService.fetchBuffer(zipUrl);
      if (!data || data.length === 0) {
        logWarn('Examples', `Empty response from examples archive: ${examplesId}`);
        return false;
      }

      fs.mkdirSync(cacheDir, { recursive: true });
      const zipPath = path.join(cacheDir, 'examples.zip');
      fs.writeFileSync(zipPath, data);
      await this.extractArchive(zipPath, cacheDir);
      fs.unlinkSync(zipPath);

      if (this.isCacheUsable(examplesId)) {
        logInfo('Examples', `Extracted examples archive: ${data.length} bytes -> ${cacheDir}`);
        return true;
      }

      this.cleanupFailedDownload(cacheDir);
      logWarn('Examples', `Extracted archive did not contain example files: ${examplesId}`);
      return false;
    } catch (err) {
      logError('Examples', `Download/extract failed for ${examplesId}: ${err}`);
      this.cleanupFailedDownload(cacheDir);
      return false;
    }
  }

  private async extractArchive(archivePath: string, targetDir: string): Promise<void> {
    const backend = resolveNativeBackendCommand(this.context, { preferPackaged: true });
    await new Promise<void>((resolve, reject) => {
      execFile(
        backend.command,
        [...backend.args, '--extract-archive', archivePath, targetDir],
        { cwd: backend.cwd, windowsHide: true, timeout: 60000 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = stderr?.trim() || stdout?.trim() || err.message;
            reject(new Error(detail));
            return;
          }
          resolve();
        }
      );
    });
  }

  private cleanupFailedDownload(targetDir: string): void {
    try {
      if (!fs.existsSync(targetDir) || this.hasExtractedContent(targetDir)) {
        return;
      }
      for (const entry of fs.readdirSync(targetDir)) {
        fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
      }
      fs.rmdirSync(targetDir);
    } catch {
      // ignore cleanup errors
    }
  }
}
