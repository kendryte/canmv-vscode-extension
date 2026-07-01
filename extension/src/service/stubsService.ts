import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { logError, logInfo, logWarn } from '../output';
import { resolveNativeBackendCommand } from '../backend/native';
import { t } from '../i18n';
import { CanmvResourceRoute, CanmvResourceRouteService, normalizeFirmwareRevision } from './resourceRouteService';

/**
 * Downloads K230 MicroPython stubs and configures Pylance to use them.
 *
 * Resource routing lives in CanmvResourceRouteService. This class owns only
 * the stubs cache and Pylance settings.
 */
export class StubsService {
  private static readonly lastRevisionKey = 'canmv.stubs.lastRevision';
  private static readonly userStubPathKey = 'canmv.stubs.userStubPath';
  private readonly baseDir: string;
  private readonly pylanceOverlayBaseDir: string;
  private boardRevisionRequested = '';

  constructor(
    private readonly context: vscode.ExtensionContext | undefined,
    private readonly routeService: CanmvResourceRouteService = new CanmvResourceRouteService(),
  ) {
    this.baseDir = path.join(os.homedir(), '.kendryte', 'k230_canmv_stubs');
    this.pylanceOverlayBaseDir = path.join(os.homedir(), '.kendryte', 'k230_canmv_pylance');
  }

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

    const route = await this.routeService.resolve('');
    if (!route) {
      logWarn('Stubs', 'Failed to resolve latest CanMV resources from CDN');
      return null;
    }

    logInfo('Stubs', `No local stubs found; downloading latest default stubs: ${route.revision}`);
    if (await this.downloadAndExtract(route)) {
      return this.configureRevision(route.revision, 'default');
    }

    logWarn('Stubs', `Failed to download default stubs: ${route.revision}`);
    return null;
  }

  async ensureBoardStubs(boardRevision: string): Promise<string | null> {
    const revision = normalizeFirmwareRevision(boardRevision);
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

    const route = await this.routeService.resolve(revision);
    if (!route) {
      logWarn('Stubs', `Unable to resolve stubs for connected board: ${revision}`);
      return null;
    }
    if (!route.exact) {
      logWarn('Stubs', `Exact board resources unavailable; using latest firmware resources: ${route.revision}`);
    }

    if (this.isCacheUsable(route.revision)) {
      logInfo('Stubs', `Using ${route.exact ? 'exact' : 'latest'} local stubs for connected board: ${route.revision}`);
      return this.configureRevision(route.revision, 'board');
    }

    logInfo('Stubs', `Downloading ${route.exact ? 'exact' : 'latest'} stubs for connected board: ${route.revision}`);
    if (await this.downloadAndExtract(route)) {
      return this.configureRevision(route.revision, 'board');
    }

    logWarn('Stubs', `Board stubs unavailable; keeping current default stubs: ${route.revision}`);
    return null;
  }

  async downloadStubs(boardRevision: string): Promise<string | null> {
    return boardRevision ? this.ensureBoardStubs(boardRevision) : this.ensureDefaultStubs();
  }

  async ensureRouteStubs(route: CanmvResourceRoute, source: 'default' | 'board'): Promise<string | null> {
    const routeLabel = source === 'default' ? 'default' : route.exact ? 'exact' : 'latest';

    if (source === 'board') {
      this.boardRevisionRequested = route.requestedRevision || route.revision;
      if (!route.exact) {
        logWarn('Stubs', `Exact board resources unavailable; using latest firmware resources: ${route.revision}`);
      }
    }

    if (this.isCacheUsable(route.revision)) {
      logInfo('Stubs', `Using ${routeLabel} local stubs: ${route.revision}`);
      return this.configureRevision(route.revision, source);
    }

    if (!this.canAutoDownload()) {
      logWarn('Stubs', `Stubs are not cached and auto-download is disabled: ${route.revision}`);
      return null;
    }

    logInfo('Stubs', `Downloading ${routeLabel} stubs: ${route.revision}`);
    if (await this.downloadAndExtract(route)) {
      return this.configureRevision(route.revision, source);
    }

    logWarn('Stubs', `Stubs unavailable: ${route.revision}`);
    return null;
  }

  private canAutoDownload(): boolean {
    const autoDownload = vscode.workspace.getConfiguration('canmv').get<boolean>('stubsAutoDownload', true);
    if (!autoDownload) {
      logInfo('Stubs', 'Auto-download disabled (canmv.stubsAutoDownload = false)');
      return false;
    }
    return true;
  }

  private cacheDirFor(revision: string): string {
    return path.join(this.baseDir, revision);
  }

  private isCacheUsable(revision: string): boolean {
    const normalized = normalizeFirmwareRevision(revision);
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
    const normalized = normalizeFirmwareRevision(revision);
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

  private async downloadAndExtract(route: CanmvResourceRoute): Promise<boolean> {
    const cacheDir = this.cacheDirFor(route.revision);
    logInfo('Stubs', `Downloading stubs archive: ${route.stubsUrl}`);

    try {
      const data = await this.routeService.fetchBuffer(route.stubsUrl);
      if (!data || data.length === 0) {
        logWarn('Stubs', `Empty response from stubs archive: ${route.revision}`);
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

      const moved = this.flattenIfNeeded(cacheDir);
      if (moved) {
        logInfo('Stubs', `Flattened nested stubs directory: ${cacheDir}`);
        return true;
      }

      this.cleanupEmpty(cacheDir);
      logWarn('Stubs', `Extracted archive did not contain .pyi files: ${route.revision}`);
      return false;
    } catch (err) {
      logError('Stubs', `Download/extract failed for ${route.revision}: ${err}`);
      this.cleanupEmpty(cacheDir);
      return false;
    }
  }

  private async configurePylance(stubsDir: string): Promise<void> {
    const workspace = this.firstFileWorkspaceFolder();
    const config = vscode.workspace.getConfiguration('python.analysis', workspace?.uri);
    const currentExtraPaths = config.get<string[]>('extraPaths') || [];
    const currentStubPath = config.get<string>('stubPath') || '';
    const currentDiagnosticOverrides = config.get<Record<string, string>>('diagnosticSeverityOverrides') || {};
    const userStubPath = await this.resolveUserStubPath(currentStubPath);
    const overlayStubPath = this.buildPylanceStubOverlay(stubsDir, userStubPath);
    const nextExtraPaths = this.replaceCanMVStubsPath(currentExtraPaths, stubsDir);
    const nextDiagnosticOverrides = {
      ...currentDiagnosticOverrides,
      reportMissingModuleSource: 'none',
    };
    const extraPathsChanged = !this.stringArraysEqual(currentExtraPaths, nextExtraPaths);
    const stubPathChanged = !this.pathsEqual(currentStubPath, overlayStubPath);
    const diagnosticsChanged = currentDiagnosticOverrides.reportMissingModuleSource !== 'none';

    if (!extraPathsChanged && !stubPathChanged && !diagnosticsChanged) {
      logInfo('Stubs', `Pylance stubs already configured: ${overlayStubPath}`);
      return;
    }

    const targets = workspace
      ? [vscode.ConfigurationTarget.Workspace]
      : [vscode.ConfigurationTarget.Global];
    for (const target of targets) {
      try {
        if (extraPathsChanged) {
          await config.update('extraPaths', nextExtraPaths, target);
        }
        if (stubPathChanged) {
          await config.update('stubPath', overlayStubPath, target);
        }
        if (diagnosticsChanged) {
          await config.update('diagnosticSeverityOverrides', nextDiagnosticOverrides, target);
        }
        const scope = target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'global';
        logInfo('Stubs', `Pylance python.analysis.stubPath configured (${scope}): ${overlayStubPath}`);
        vscode.window.showInformationMessage(
          t('CanMV: Pylance stubs configured. Reload window for full effect.')
        );
        return;
      } catch (err) {
        logWarn('Stubs', `Could not update Pylance settings (${target}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    logError('Stubs', `Failed to configure Pylance stubs path: ${overlayStubPath}`);
  }

  private replaceCanMVStubsPath(extraPaths: string[], stubsDir: string): string[] {
    const next: string[] = [];
    let inserted = false;

    for (const entry of extraPaths) {
      if (this.isCanMVStubsPath(entry)) {
        if (!inserted) {
          next.push(stubsDir);
          inserted = true;
        }
        continue;
      }
      next.push(entry);
    }

    if (!inserted && !next.some(entry => this.pathsEqual(entry, stubsDir))) {
      next.push(stubsDir);
    }

    return next;
  }

  private async resolveUserStubPath(currentStubPath: string): Promise<string> {
    const savedStubPath = this.context?.workspaceState.get<string>(StubsService.userStubPathKey) || '';

    if (!currentStubPath || this.isCanMVManagedStubPath(currentStubPath)) {
      return this.usableStubRoot(savedStubPath);
    }

    const resolved = this.usableStubRoot(currentStubPath);
    if (!resolved || this.isCanMVStubsPath(resolved) || this.isCanMVOverlayPath(resolved)) {
      await this.context?.workspaceState.update(StubsService.userStubPathKey, undefined);
      return '';
    }

    await this.context?.workspaceState.update(StubsService.userStubPathKey, currentStubPath);
    return resolved;
  }

  private buildPylanceStubOverlay(stubsDir: string, userStubPath: string): string {
    const overlayDir = this.pylanceOverlayDir();
    this.resetPylanceStubOverlay(overlayDir);
    this.linkOrCopyStubRoot(stubsDir, overlayDir, true);
    if (userStubPath) {
      this.linkOrCopyStubRoot(userStubPath, overlayDir, false);
    }
    return overlayDir;
  }

  private resetPylanceStubOverlay(overlayDir: string): void {
    if (!this.isCanMVOverlayPath(overlayDir)) {
      throw new Error(`Refusing to reset non-CanMV Pylance overlay path: ${overlayDir}`);
    }
    fs.rmSync(overlayDir, { recursive: true, force: true });
    fs.mkdirSync(overlayDir, { recursive: true });
  }

  private linkOrCopyStubRoot(sourceDir: string, overlayDir: string, overwrite: boolean): void {
    const normalizedSource = this.normalizeFsPathForCompare(sourceDir);
    const normalizedOverlay = this.normalizeFsPathForCompare(overlayDir);
    if (!normalizedSource || normalizedSource === normalizedOverlay) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    } catch (err) {
      logWarn('Stubs', `Could not read stub root for Pylance overlay: ${sourceDir}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    for (const entry of entries) {
      const source = path.join(sourceDir, entry.name);
      const target = path.join(overlayDir, entry.name);
      if (fs.existsSync(target)) {
        if (!overwrite) continue;
        fs.rmSync(target, { recursive: true, force: true });
      }
      this.linkOrCopyStubEntry(source, target, entry);
    }
  }

  private linkOrCopyStubEntry(source: string, target: string, entry: fs.Dirent): void {
    try {
      if (entry.isSymbolicLink()) {
        const realSource = fs.realpathSync(source);
        const realEntry = fs.statSync(realSource);
        const type = realEntry.isDirectory() ? this.directorySymlinkType() : 'file';
        fs.symlinkSync(realSource, target, type);
        return;
      }

      const type = entry.isDirectory() ? this.directorySymlinkType() : 'file';
      fs.symlinkSync(source, target, type);
    } catch {
      try {
        fs.cpSync(source, target, { recursive: true, dereference: true });
      } catch (err) {
        logWarn('Stubs', `Could not add stub entry to Pylance overlay: ${source}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private directorySymlinkType(): fs.symlink.Type {
    return process.platform === 'win32' ? 'junction' : 'dir';
  }

  private pylanceOverlayDir(): string {
    const workspace = this.firstFileWorkspaceFolder();
    const scope = workspace?.uri.toString() || this.context?.globalStorageUri.toString() || os.homedir();
    const scopeHash = crypto.createHash('sha256').update(scope).digest('hex').slice(0, 16);
    return path.join(this.pylanceOverlayBaseDir, scopeHash, 'typings');
  }

  private firstFileWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file');
  }

  private usableStubRoot(value: string): string {
    if (!value) return '';

    const resolved = this.resolveConfiguredPath(value);
    if (!resolved) return '';

    try {
      return fs.statSync(resolved).isDirectory() ? resolved : '';
    } catch {
      return '';
    }
  }

  private resolveConfiguredPath(value: string): string {
    const expanded = this.expandHome(value.trim());
    if (!expanded) return '';
    if (path.isAbsolute(expanded)) {
      return path.resolve(path.normalize(expanded));
    }

    const workspace = this.firstFileWorkspaceFolder();
    if (!workspace) return '';
    return path.resolve(workspace.uri.fsPath, path.normalize(expanded));
  }

  private isCanMVManagedStubPath(value: string): boolean {
    return this.isCanMVStubsPath(value) || this.isCanMVOverlayPath(value);
  }

  private isCanMVStubsPath(value: string): boolean {
    if (!value) return false;

    const baseDir = this.normalizeFsPathForCompare(this.baseDir);
    const candidate = this.normalizeFsPathForCompare(value);
    const relative = path.relative(baseDir, candidate);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private isCanMVOverlayPath(value: string): boolean {
    if (!value) return false;

    const baseDir = this.normalizeFsPathForCompare(this.pylanceOverlayBaseDir);
    const candidate = this.normalizeFsPathForCompare(value);
    const relative = path.relative(baseDir, candidate);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private pathsEqual(left: string, right: string): boolean {
    return this.normalizeFsPathForCompare(left) === this.normalizeFsPathForCompare(right);
  }

  private normalizeFsPathForCompare(value: string): string {
    const expanded = this.expandHome(value);
    const normalized = path.resolve(path.normalize(expanded));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  private expandHome(value: string): string {
    const trimmed = value.trim();
    return trimmed === '~'
      ? os.homedir()
      : trimmed.startsWith('~/') || trimmed.startsWith('~\\')
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;
  }

  private stringArraysEqual(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

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

  private flattenIfNeeded(targetDir: string): boolean {
    try {
      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      const pyis = entries.filter(e => e.isFile() && e.name.endsWith('.pyi'));
      if (pyis.length > 0) return true;

      const subdirs = entries.filter(e => e.isDirectory());
      for (const sub of subdirs) {
        const subPath = path.join(targetDir, sub.name);
        const subEntries = fs.readdirSync(subPath, { withFileTypes: true });
        const subPyis = subEntries.filter(e => e.isFile() && e.name.endsWith('.pyi'));
        if (subPyis.length > 0) {
          for (const entry of subEntries) {
            fs.renameSync(path.join(subPath, entry.name), path.join(targetDir, entry.name));
          }
          try { fs.rmdirSync(subPath); } catch { /* ignore */ }
          return true;
        }
      }
    } catch {
      // ignore
    }
    return false;
  }

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
