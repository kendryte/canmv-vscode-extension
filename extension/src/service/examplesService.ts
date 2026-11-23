import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { logError, logInfo, logWarn } from '../output';
import { resolveNativeBackendCommand } from '../backend/native';
import {
  createCacheTempDir,
  examplesArchiveFile,
  hasExtractedExamples,
  isUsableExamplesCache,
  listExamplesCaches,
  normalizeExamplesId,
  publishCacheDir,
  removeDir,
  removeStaleCacheTempDirs,
} from './resourceCache';
import { CanmvResourceRoute, CanmvResourceRouteService } from './resourceRouteService';

export class ExamplesService {
  private static readonly lastExamplesKey = 'canmv.examples.lastId';
  private readonly _onDidChangeExamples = new vscode.EventEmitter<void>();
  readonly onDidChangeExamples = this._onDidChangeExamples.event;
  private readonly baseDir: string;
  private staleTempCleanup: Promise<void> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly routeService: CanmvResourceRouteService,
  ) {
    this.baseDir = path.join(os.homedir(), '.kendryte', 'k230_canmv_examples');
  }

  async ensureExamples(route: CanmvResourceRoute | null): Promise<string | null> {
    await this.removeStaleTempDirs();
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
    return listExamplesCaches(this.baseDir)[0]?.dir || '';
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
    return isUsableExamplesCache(this.cacheDirFor(examplesId));
  }

  private async ensureLocalExamples(): Promise<string | null> {
    const lastExamplesId = this.context.globalState.get<string>(ExamplesService.lastExamplesKey) || '';
    const normalized = normalizeExamplesId(lastExamplesId);
    if (normalized && this.isCacheUsable(normalized)) {
      const cacheDir = this.cacheDirFor(normalized);
      logInfo('Examples', `Using last configured local examples: ${normalized} (${cacheDir})`);
      return cacheDir;
    }

    const local = listExamplesCaches(this.baseDir)[0];
    if (local) {
      if (local.legacy) {
        logWarn('Examples', `Using possibly incomplete examples from an older version; connect a board online to refresh: ${local.id} (${local.dir})`);
      } else {
        logInfo('Examples', `Using latest local cached examples: ${local.id} (${local.dir})`);
      }
      await this.context.globalState.update(ExamplesService.lastExamplesKey, local.id);
      this._onDidChangeExamples.fire();
      return local.dir;
    }

    return null;
  }

  private removeStaleTempDirs(): Promise<void> {
    this.staleTempCleanup ??= removeStaleCacheTempDirs(this.baseDir).then(removed => {
      for (const dir of removed) logInfo('Examples', `Removed interrupted examples download: ${dir}`);
    });
    return this.staleTempCleanup;
  }

  private async downloadAndExtract(examplesId: string, zipUrl: string, cacheDir: string): Promise<boolean> {
    logInfo('Examples', `Downloading examples archive: ${zipUrl}`);
    let tempDir = '';
    try {
      const data = await this.routeService.fetchBuffer(zipUrl);
      if (!data || data.length === 0) {
        logWarn('Examples', `Empty response from examples archive: ${examplesId}`);
        return false;
      }

      tempDir = createCacheTempDir(this.baseDir, examplesId);
      const zipPath = path.join(tempDir, examplesArchiveFile);
      fs.writeFileSync(zipPath, data);
      await this.extractArchive(zipPath, tempDir);
      fs.unlinkSync(zipPath);

      if (!hasExtractedExamples(tempDir)) {
        logWarn('Examples', `Extracted archive did not contain example files: ${examplesId}`);
        return false;
      }

      if (await publishCacheDir(tempDir, cacheDir, isUsableExamplesCache)) {
        tempDir = '';
        logInfo('Examples', `Extracted examples archive: ${data.length} bytes -> ${cacheDir}`);
      } else {
        logInfo('Examples', `Examples were already published by another window: ${cacheDir}`);
      }
      return true;
    } catch (err) {
      logError('Examples', `Download/extract failed for ${examplesId}: ${err}`);
      return false;
    } finally {
      if (tempDir) {
        await removeDir(tempDir).catch(err => {
          logWarn('Examples', `Could not remove temporary examples cache: ${err}`);
        });
      }
    }
  }

  private async extractArchive(archivePath: string, targetDir: string): Promise<void> {
    const backend = resolveNativeBackendCommand(this.context);
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
}
