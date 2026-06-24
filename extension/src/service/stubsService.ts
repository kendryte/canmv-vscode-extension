import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { execFile } from 'child_process';
import { logError, logInfo, logWarn } from '../output';
import { resolveNativeBackendCommand } from '../backend/native';
import { t } from '../i18n';

/**
 * StubsService — downloads K230 MicroPython stubs from CanMV CDN
 * and configures Pylance to use them.
 *
 * CDN structure (verified 2026-06-16):
 *   ${baseUrl}/latest              -> plain-text file: latest revision id
 *   ${baseUrl}/${revision}.zip     -> stubs archive (~129KB)
 *
 * Local cache:
 *   ~/.kendryte/k230_canmv_stubs/${revision}/
 *
 * Pylance setting:
 *   python.analysis.stubPath = "~/.kendryte/k230_canmv_stubs/${revision}"
 */
export class StubsService {
  private static readonly lastRevisionKey = 'canmv.stubs.lastRevision';
  private readonly baseDir: string;
  private readonly stubsBaseUrl: string;
  private boardRevisionRequested = '';

  constructor(private readonly context?: vscode.ExtensionContext) {
    this.baseDir = path.join(os.homedir(), '.kendryte', 'k230_canmv_stubs');
    this.stubsBaseUrl = vscode.workspace
      .getConfiguration('canmv')
      .get<string>(
        'stubsBaseUrl',
        'https://kendryte-download.canaan-creative.com/developer/tools/canmv_ide_k230/canmv_k230_stubs'
      );
  }

  /**
   * Configure a useful default stubs revision without requiring a connected board.
   *
   * Flow:
   *   1. Reuse last configured revision if it is still cached.
   *   2. Reuse the most recently modified local cache.
   *   3. Download CDN latest if no local cache exists.
   */
  async ensureDefaultStubs(): Promise<string | null> {
    const lastRevision = this.context?.globalState.get<string>(StubsService.lastRevisionKey) || '';
    if (this.isCacheUsable(lastRevision)) {
      logInfo('Stubs', `Using last configured local stubs: ${lastRevision}`);
      return this.configureRevision(lastRevision, 'default');
    }

    const localRevision = this.findLatestLocalRevision();
    if (localRevision) {
      logInfo('Stubs', `Using latest local cached stubs: ${localRevision}`);
      return this.configureRevision(localRevision, 'default');
    }

    if (!this.canAutoDownload()) {
      return null;
    }

    const latestRevision = await this.fetchLatestRevision();
    if (!latestRevision) {
      logWarn('Stubs', 'Failed to fetch latest stubs revision from CDN');
      return null;
    }

    logInfo('Stubs', `No local stubs found; downloading latest default stubs: ${latestRevision}`);
    if (await this.downloadAndExtract(latestRevision, this.cacheDirFor(latestRevision))) {
      return this.configureRevision(latestRevision, 'default');
    }

    logWarn('Stubs', `Failed to download default stubs: ${latestRevision}`);
    return null;
  }

  /**
   * Configure stubs that exactly match the connected board revision when possible.
   *
   * @param boardRevision Board revision used internally for matching.
   * @returns The active stubs directory path, or null if download failed.
   */
  async ensureBoardStubs(boardRevision: string): Promise<string | null> {
    const revision = this.normalizeRevision(boardRevision);
    if (!revision) {
      logWarn('Stubs', 'Board revision unavailable; keeping default stubs');
      return this.ensureDefaultStubs();
    }
    this.boardRevisionRequested = revision;

    if (this.isCacheUsable(revision)) {
      logInfo('Stubs', `Using exact local stubs for connected board: ${revision}`);
      return this.configureRevision(revision, 'board');
    }

    if (!this.canAutoDownload()) {
      logWarn('Stubs', `Exact board stubs are not cached and auto-download is disabled: ${revision}`);
      return null;
    }

    logInfo('Stubs', `Downloading exact stubs for connected board: ${revision}`);
    if (await this.downloadAndExtract(revision, this.cacheDirFor(revision))) {
      return this.configureRevision(revision, 'board');
    }

    logWarn('Stubs', `Exact board stubs unavailable; keeping current default stubs: ${revision}`);
    return null;
  }

  /**
   * Backward-compatible entry point used by commands.
   */
  async downloadStubs(boardRevision: string): Promise<string | null> {
    return boardRevision ? this.ensureBoardStubs(boardRevision) : this.ensureDefaultStubs();
  }

  /**
   * Fetch ${baseUrl}/latest - returns the stubs revision id.
   */
  private async fetchLatestRevision(): Promise<string> {
    const latestUrl = `${this.stubsBaseUrl}/latest`;
    logInfo('Stubs', `Fetching latest stubs revision: ${latestUrl}`);
    try {
      const data = await this.httpGet(latestUrl);
      const text = data.toString('utf-8').trim();
      // Validate: should be 40 hex chars
      if (/^[0-9a-fA-F]{40}$/.test(text)) {
        logInfo('Stubs', `Latest stubs revision found: ${text}`);
        return text;
      }
      // Try to extract a 40-char hex hash from the response
      const m = text.match(/\b([0-9a-fA-F]{40})\b/);
      if (m) {
        logInfo('Stubs', `Extracted latest stubs revision: ${m[1]}`);
        return m[1];
      }
      logWarn('Stubs', `Unexpected latest response format: "${text.substring(0, 80)}"`);
      return '';
    } catch (err) {
      logWarn('Stubs', `Failed to fetch latest revision: ${err}`);
      return '';
    }
  }

  private canAutoDownload(): boolean {
    const autoDownload = vscode.workspace.getConfiguration('canmv').get<boolean>('stubsAutoDownload', true);
    if (!autoDownload) {
      logInfo('Stubs', 'Auto-download disabled (canmv.stubsAutoDownload = false)');
      return false;
    }
    return true;
  }

  private normalizeRevision(revision: string): string {
    const trimmed = (revision || '').trim();
    return /^[0-9a-fA-F]{7,40}$/.test(trimmed) ? trimmed : '';
  }

  private cacheDirFor(revision: string): string {
    return path.join(this.baseDir, revision);
  }

  private isCacheUsable(revision: string): boolean {
    const normalized = this.normalizeRevision(revision);
    if (!normalized) return false;
    const cacheDir = this.cacheDirFor(normalized);
    try {
      return fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).some(f => f.endsWith('.pyi'));
    } catch {
      return false;
    }
  }

  private findLatestLocalRevision(): string {
    try {
      if (!fs.existsSync(this.baseDir)) return '';
      const revisions = fs.readdirSync(this.baseDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && this.isCacheUsable(entry.name))
        .map(entry => {
          const revision = entry.name;
          const mtime = fs.statSync(this.cacheDirFor(revision)).mtimeMs;
          return { revision, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return revisions[0]?.revision || '';
    } catch {
      return '';
    }
  }

  private async configureRevision(revision: string, source: 'default' | 'board'): Promise<string | null> {
    const normalized = this.normalizeRevision(revision);
    if (!this.isCacheUsable(normalized)) return null;
    if (source === 'default' && this.boardRevisionRequested) {
      logInfo('Stubs', `Board-specific stubs requested; skipping default stubs switch: ${this.boardRevisionRequested}`);
      return null;
    }

    const cacheDir = this.cacheDirFor(normalized);
    await this.configurePylance(cacheDir);
    await this.context?.globalState.update(StubsService.lastRevisionKey, normalized);
    logInfo('Stubs', `Active ${source} stubs: ${normalized} (${cacheDir})`);
    return cacheDir;
  }

  /**
   * Download ${baseUrl}/${revision}.zip and extract to cacheDir.
   */
  private async downloadAndExtract(revision: string, cacheDir: string): Promise<boolean> {
    const zipUrl = `${this.stubsBaseUrl}/${revision}.zip`;
    logInfo('Stubs', `Downloading stubs archive: ${zipUrl}`);

    try {
      const data = await this.httpGet(zipUrl);
      if (!data || data.length === 0) {
        logWarn('Stubs', `Empty response from stubs archive: ${revision}`);
        return false;
      }

      fs.mkdirSync(cacheDir, { recursive: true });
      const zipPath = path.join(cacheDir, 'stubs.zip');
      fs.writeFileSync(zipPath, data);

      await this.extractArchive(zipPath, cacheDir);
      fs.unlinkSync(zipPath);

      const hasPyis = fs.readdirSync(cacheDir).some(f => f.endsWith('.pyi'));
      if (hasPyis) {
        logInfo('Stubs', `Extracted stubs archive: ${data.length} bytes -> ${cacheDir}`);
        return true;
      }

      // The zip may have a top-level directory — flatten it
      const moved = this.flattenIfNeeded(cacheDir);
      if (moved) {
        logInfo('Stubs', `Flattened nested stubs directory: ${cacheDir}`);
        return true;
      }

      this.cleanupEmpty(cacheDir);
      logWarn('Stubs', `Extracted archive did not contain .pyi files: ${revision}`);
      return false;
    } catch (err) {
      logError('Stubs', `Download/extract failed for ${revision}: ${err}`);
      this.cleanupEmpty(cacheDir);
      return false;
    }
  }

  /**
   * Configure Pylance to use the given stubs directory.
   * Sets python.analysis.stubPath in workspace settings (or global fallback).
   */
  private async configurePylance(stubsDir: string): Promise<void> {
    // Use the python.analysis sub-section directly (not python → analysis object)
    const config = vscode.workspace.getConfiguration('python.analysis');
    const currentStubPath = config.get<string>('stubPath') || '';

    if (currentStubPath === stubsDir) {
      logInfo('Stubs', `Pylance stubPath already configured: ${stubsDir}`);
      return;
    }

    // Try workspace-level first, fall back to global
    for (const target of [vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.Global]) {
      try {
        await config.update('stubPath', stubsDir, target);
        const scope = target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'global';
        logInfo('Stubs', `Pylance python.analysis.stubPath configured (${scope}): ${stubsDir}`);
        vscode.window.showInformationMessage(
          t('CanMV: Pylance stubs configured. Reload window for full effect.')
        );
        return;
      } catch (err) {
        // Workspace may not be open — try global
      }
    }

    logError('Stubs', `Failed to configure Pylance stubPath: ${stubsDir}`);
  }

  // ── HTTP Helpers ──

  /**
   * HTTP GET — returns response body as Buffer, or throws on non-2xx.
   */
  private httpGet(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const get = url.startsWith('https') ? https.get : http.get;
      const req = get(url, { timeout: 30000 }, (res) => {
        // Follow redirects (up to 3)
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            this.httpGet(redirectUrl).then(resolve).catch(reject);
            return;
          }
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  /**
   * Extract a .tar.gz or .zip archive to targetDir using the bundled Go backend.
   */
  private async extractArchive(archivePath: string, targetDir: string): Promise<void> {
    if (!this.context) {
      throw new Error('CanMV backend unavailable for stubs archive extraction');
    }

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

  /**
   * If extraction created a single subdirectory containing .pyi files,
   * move them up to targetDir (flatten).
   * Returns true if .pyi files are now present in targetDir.
   */
  private flattenIfNeeded(targetDir: string): boolean {
    try {
      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      const pyis = entries.filter(e => e.isFile() && e.name.endsWith('.pyi'));
      if (pyis.length > 0) return true; // already flat

      // Look for a single subdirectory that might contain stubs
      const subdirs = entries.filter(e => e.isDirectory());
      for (const sub of subdirs) {
        const subPath = path.join(targetDir, sub.name);
        const subEntries = fs.readdirSync(subPath, { withFileTypes: true });
        const subPyis = subEntries.filter(e => e.isFile() && e.name.endsWith('.pyi'));
        if (subPyis.length > 0) {
          // Move all files from subdirectory up
          for (const entry of subEntries) {
            const src = path.join(subPath, entry.name);
            const dest = path.join(targetDir, entry.name);
            if (entry.isDirectory()) {
              fs.renameSync(src, dest);
            } else {
              fs.renameSync(src, dest);
            }
          }
          // Remove now-empty subdirectory
          try { fs.rmdirSync(subPath); } catch { /* ignore */ }
          return true;
        }
      }
    } catch {
      // ignore
    }
    return false;
  }

  /**
   * Remove targetDir if it's empty (no .pyi files).
   */
  private cleanupEmpty(targetDir: string): void {
    try {
      if (fs.existsSync(targetDir)) {
        const entries = fs.readdirSync(targetDir);
        const hasPyis = entries.some(f => f.endsWith('.pyi'));
        if (!hasPyis && entries.length === 0) {
          fs.rmdirSync(targetDir);
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }
}
