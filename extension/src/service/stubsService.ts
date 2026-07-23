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

type PylanceStubOverlay = {
  stubPath: string;
  refreshed: boolean;
};

type PylanceStubOverlayManifest = {
  version: 2;
  stubsDir: string;
  userStubPath: string;
  cacheSignature: string;
  userStubSignature: string;
};

type StubCacheValidation = {
  ok: boolean;
  pyiFiles: number;
};

type StubCacheStats = {
  files: number;
  pyiFiles: number;
  maxMtimeMs: number;
};

/**
 * Downloads K230 MicroPython stubs and configures Pylance to use them.
 *
 * Resource routing lives in CanmvResourceRouteService. This class owns only
 * the stubs cache and Pylance settings.
 */
export class StubsService {
  private static readonly lastRevisionKey = 'canmv.stubs.lastRevision';
  private static readonly userStubPathKey = 'canmv.stubs.userStubPath';
  private static readonly reloadPromptSignatureKey = 'canmv.stubs.reloadPromptSignature';
  private static readonly overlayManifestFile = '.canmv-pylance-overlay.json';
  private static readonly pylanceExtensionId = 'ms-python.vscode-pylance';
  private readonly baseDir: string;
  private readonly pylanceOverlayBaseDir: string;
  private boardRevisionRequested = '';
  private pylanceWarningShown = false;
  private reloadPromptSignature = '';

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
    return this.validateStubCache(cacheDir).ok;
  }

  private validateStubCache(cacheDir: string): StubCacheValidation {
    try {
      if (!fs.statSync(cacheDir).isDirectory()) {
        return { ok: false, pyiFiles: 0 };
      }

      const stats = this.collectStubCacheStats(cacheDir);
      return {
        ok: stats.pyiFiles > 0,
        pyiFiles: stats.pyiFiles,
      };
    } catch {
      return { ok: false, pyiFiles: 0 };
    }
  }

  private collectStubCacheStats(dir: string): StubCacheStats {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let files = 0;
    let pyiFiles = 0;
    let maxMtimeMs = 0;

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      try {
        maxMtimeMs = Math.max(maxMtimeMs, fs.statSync(entryPath).mtimeMs);
      } catch {
        // ignore entries that disappear while validating
      }
      if (entry.isDirectory()) {
        const child = this.collectStubCacheStats(entryPath);
        files += child.files;
        pyiFiles += child.pyiFiles;
        maxMtimeMs = Math.max(maxMtimeMs, child.maxMtimeMs);
        continue;
      }

      if (entry.isFile() || entry.isSymbolicLink()) {
        files += 1;
        if (entry.name.endsWith('.pyi')) {
          pyiFiles += 1;
        }
      }
    }

    return { files, pyiFiles, maxMtimeMs };
  }

  private stubCacheValidationMessage(validation: StubCacheValidation): string {
    if (validation.pyiFiles === 0) {
      return 'no .pyi files found';
    }
    return 'unknown validation failure';
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
    if (!await this.configurePylance(cacheDir)) {
      return null;
    }
    await this.context?.globalState.update(StubsService.lastRevisionKey, normalized);
    logInfo('Stubs', `Active ${source} stubs: ${normalized} (${cacheDir})`);
    return cacheDir;
  }

  private async downloadAndExtract(route: CanmvResourceRoute): Promise<boolean> {
    const ok = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('CanMV: Downloading code completion stubs ({revision})...', { revision: route.revision }),
      },
      () => this.performDownloadAndExtract(route)
    );
    if (!ok) {
      void vscode.window.showWarningMessage(
        t('CanMV: Failed to download code completion stubs ({revision}). See the CanMV output for details.', { revision: route.revision })
      );
    }
    return ok;
  }

  private async performDownloadAndExtract(route: CanmvResourceRoute): Promise<boolean> {
    const cacheDir = this.cacheDirFor(route.revision);
    let tempDir = '';
    logInfo('Stubs', `Downloading stubs archive: ${route.stubsUrl}`);

    try {
      const data = await this.routeService.fetchBuffer(route.stubsUrl);
      if (!data || data.length === 0) {
        logWarn('Stubs', `Empty response from stubs archive: ${route.revision}`);
        return false;
      }

      tempDir = this.createCacheTempDir(route.revision);
      const zipPath = path.join(tempDir, 'stubs.zip');
      fs.writeFileSync(zipPath, data);

      await this.extractArchive(zipPath, tempDir);
      fs.unlinkSync(zipPath);

      this.flattenIfNeeded(tempDir);
      const validation = this.validateStubCache(tempDir);
      if (validation.ok) {
        this.replaceCacheDir(tempDir, cacheDir);
        logInfo('Stubs', `Extracted stubs archive: ${data.length} bytes, ${validation.pyiFiles} .pyi files -> ${cacheDir}`);
        return true;
      }

      this.cleanupCacheTempDir(tempDir);
      logWarn('Stubs', `Extracted archive is incomplete for ${route.revision}: ${this.stubCacheValidationMessage(validation)}`);
      return false;
    } catch (err) {
      logError('Stubs', `Download/extract failed for ${route.revision}: ${err}`);
      this.cleanupCacheTempDir(tempDir);
      return false;
    }
  }

  private async configurePylance(stubsDir: string): Promise<boolean> {
    const workspace = this.firstFileWorkspaceFolder();
    const config = vscode.workspace.getConfiguration('python.analysis', workspace?.uri);
    const currentExtraPaths = config.get<string[]>('extraPaths') || [];
    const currentStubPath = config.get<string>('stubPath') || '';
    const currentDiagnosticOverrides = config.get<Record<string, string>>('diagnosticSeverityOverrides') || {};
    const userStubPath = await this.resolveUserStubPath(currentStubPath);
    let overlayStubPath: string;
    let overlayRefreshed = false;
    try {
      const overlay = this.buildPylanceStubOverlay(stubsDir, userStubPath);
      overlayStubPath = overlay.stubPath;
      overlayRefreshed = overlay.refreshed;
    } catch (err) {
      logWarn('Stubs', `Could not build Pylance stub overlay; using stubs directory directly: ${err instanceof Error ? err.message : String(err)}`);
      overlayStubPath = stubsDir;
    }
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
      const pylanceReady = await this.ensurePylanceExtensionReady();
      if (overlayRefreshed && pylanceReady) {
        await this.showPylanceReloadPrompt(stubsDir, overlayStubPath);
      }
      return true;
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
        const pylanceReady = await this.ensurePylanceExtensionReady();
        if (pylanceReady) {
          await this.showPylanceReloadPrompt(stubsDir, overlayStubPath);
        }
        return true;
      } catch (err) {
        logWarn('Stubs', `Could not update Pylance settings (${target}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    logError('Stubs', `Failed to configure Pylance stubs path: ${overlayStubPath}`);
    void vscode.window.showErrorMessage(
      t('CanMV: Failed to update Pylance settings. See the CanMV output for details.')
    );
    return false;
  }

  private async ensurePylanceExtensionReady(): Promise<boolean> {
    const pylance = vscode.extensions.getExtension(StubsService.pylanceExtensionId);
    if (!pylance) {
      logWarn('Stubs', `Pylance extension is not available in this VS Code extension host: ${StubsService.pylanceExtensionId}`);
      this.showPylanceWarning(
        t('CanMV: Pylance is not available in this VS Code host. Install or enable Pylance for code completion tips.')
      );
      return false;
    }

    if (pylance.isActive) {
      logInfo('Stubs', `Pylance extension active: ${pylance.id}`);
      return true;
    }

    try {
      await pylance.activate();
      logInfo('Stubs', `Pylance extension activated: ${pylance.id}`);
      return true;
    } catch (err) {
      logWarn('Stubs', `Could not activate Pylance extension: ${err instanceof Error ? err.message : String(err)}`);
      this.showPylanceWarning(
        t('CanMV: Pylance could not activate in this VS Code host. Code completion tips may not work.')
      );
      return false;
    }
  }

  private showPylanceWarning(message: string): void {
    if (this.pylanceWarningShown) return;

    this.pylanceWarningShown = true;
    const openExtensions = t('Open Extensions');
    void vscode.window.showWarningMessage(message, openExtensions).then(choice => {
      if (choice === openExtensions) {
        void vscode.commands.executeCommand(
          'workbench.extensions.search',
          `@id:${StubsService.pylanceExtensionId}`
        );
      }
    });
  }

  private async showPylanceReloadPrompt(stubsDir: string, overlayStubPath: string): Promise<void> {
    const signature = crypto.createHash('sha256')
      .update([
        this.normalizeFsPathForCompare(stubsDir),
        this.normalizeFsPathForCompare(overlayStubPath),
        this.stubCacheSignature(stubsDir),
      ].join('\n'))
      .digest('hex');
    const savedSignature = this.context?.workspaceState.get<string>(StubsService.reloadPromptSignatureKey) || '';
    if (signature === this.reloadPromptSignature || signature === savedSignature) {
      logInfo('Stubs', 'Pylance reload prompt already shown for the current stubs configuration');
      return;
    }

    this.reloadPromptSignature = signature;
    await this.context?.workspaceState.update(StubsService.reloadPromptSignatureKey, signature);
    const reloadAction = t('Reload Window');
    void vscode.window.showInformationMessage(
      t('CanMV: Pylance stubs configured. Reload window for full effect.'),
      reloadAction
    ).then(choice => {
      if (choice === reloadAction) {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
  }

  private replaceCanMVStubsPath(extraPaths: string[], stubsDir: string): string[] {
    const next: string[] = [];
    let inserted = false;
    let removed = 0;

    for (const entry of extraPaths) {
      if (this.isCanMVStubsPath(entry)) {
        removed += 1;
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

    if (removed > 1) {
      logInfo('Stubs', `Collapsed ${removed} CanMV python.analysis.extraPaths entries into the current stubs path`);
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

  private buildPylanceStubOverlay(stubsDir: string, userStubPath: string): PylanceStubOverlay {
    const overlayDir = this.pylanceOverlayDir();
    const cacheSignature = this.stubCacheSignature(stubsDir);
    const userStubSignature = userStubPath ? this.stubCacheSignature(userStubPath) : '';
    if (this.isPylanceStubOverlayCurrent(overlayDir, stubsDir, userStubPath, cacheSignature, userStubSignature)) {
      return { stubPath: overlayDir, refreshed: false };
    }

    const tempDir = this.createPylanceOverlayTempDir(overlayDir);
    try {
      fs.mkdirSync(tempDir, { recursive: true });
      this.copyStubRoot(stubsDir, tempDir, true);
      if (userStubPath) {
        this.copyStubRoot(userStubPath, tempDir, false);
      }
      if (!this.isStubRootCopied(stubsDir, tempDir)
        || (userStubPath && !this.isMergedUserStubRootCopied(userStubPath, stubsDir, tempDir))) {
        throw new Error('Pylance stub overlay verification failed');
      }
      this.writePylanceStubOverlayManifest(tempDir, stubsDir, userStubPath, cacheSignature, userStubSignature);
      this.replacePylanceStubOverlay(tempDir, overlayDir);
      return { stubPath: overlayDir, refreshed: true };
    } catch (err) {
      this.cleanupPylanceOverlayTempDir(tempDir);
      throw err;
    }
  }

  private isPylanceStubOverlayCurrent(
    overlayDir: string,
    stubsDir: string,
    userStubPath: string,
    cacheSignature: string,
    userStubSignature: string,
  ): boolean {
    try {
      if (!fs.statSync(overlayDir).isDirectory()) {
        return false;
      }
      const manifestPath = path.join(overlayDir, StubsService.overlayManifestFile);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<PylanceStubOverlayManifest>;
      const manifestMatches = manifest.version === 2
        && this.pathsEqual(manifest.stubsDir || '', stubsDir)
        && this.pathsEqual(manifest.userStubPath || '', userStubPath)
        && manifest.cacheSignature === cacheSignature
        && manifest.userStubSignature === userStubSignature;
      return manifestMatches
        && this.isStubRootCopied(stubsDir, overlayDir)
        && (!userStubPath || this.isMergedUserStubRootCopied(userStubPath, stubsDir, overlayDir));
    } catch {
      return false;
    }
  }

  private writePylanceStubOverlayManifest(
    overlayDir: string,
    stubsDir: string,
    userStubPath: string,
    cacheSignature: string,
    userStubSignature: string,
  ): void {
    const manifest: PylanceStubOverlayManifest = {
      version: 2,
      stubsDir,
      userStubPath,
      cacheSignature,
      userStubSignature,
    };
    fs.writeFileSync(
      path.join(overlayDir, StubsService.overlayManifestFile),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
  }

  private stubCacheSignature(stubsDir: string): string {
    const stats = this.collectStubCacheStats(stubsDir);
    return `${stats.files}:${stats.pyiFiles}:${Math.trunc(stats.maxMtimeMs)}`;
  }

  private createCacheTempDir(revision: string): string {
    fs.mkdirSync(this.baseDir, { recursive: true });
    return fs.mkdtempSync(path.join(this.baseDir, `${revision}.tmp-`));
  }

  private replaceCacheDir(tempDir: string, cacheDir: string): void {
    if (!this.isCanMVStubsPath(tempDir)) {
      throw new Error(`Refusing to use non-CanMV stubs temp path: ${tempDir}`);
    }
    if (!this.isCanMVStubsPath(cacheDir)) {
      throw new Error(`Refusing to replace non-CanMV stubs cache path: ${cacheDir}`);
    }
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.renameSync(tempDir, cacheDir);
  }

  private cleanupCacheTempDir(tempDir: string): void {
    if (!tempDir) return;
    try {
      if (this.isCanMVStubsPath(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (err) {
      logWarn('Stubs', `Could not remove temporary stubs cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private createPylanceOverlayTempDir(overlayDir: string): string {
    const parentDir = path.dirname(overlayDir);
    fs.mkdirSync(parentDir, { recursive: true });
    return fs.mkdtempSync(path.join(parentDir, 'typings-'));
  }

  private replacePylanceStubOverlay(tempDir: string, overlayDir: string): void {
    if (!this.isCanMVOverlayPath(overlayDir)) {
      throw new Error(`Refusing to replace non-CanMV Pylance overlay path: ${overlayDir}`);
    }
    if (!this.isCanMVOverlayPath(tempDir)) {
      throw new Error(`Refusing to use non-CanMV Pylance overlay temp path: ${tempDir}`);
    }
    try {
      fs.rmSync(overlayDir, { recursive: true, force: true });
    } catch (err) {
      throw new Error(`Could not reset Pylance overlay: ${err instanceof Error ? err.message : String(err)}`);
    }
    fs.renameSync(tempDir, overlayDir);
  }

  private cleanupPylanceOverlayTempDir(tempDir: string): void {
    try {
      if (this.isCanMVOverlayPath(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (err) {
      logWarn('Stubs', `Could not remove temporary Pylance overlay: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private copyStubRoot(sourceDir: string, overlayDir: string, overwrite: boolean): void {
    const normalizedSource = this.normalizeFsPathForCompare(sourceDir);
    const normalizedOverlay = this.normalizeFsPathForCompare(overlayDir);
    if (!normalizedSource || normalizedSource === normalizedOverlay) return;

    try {
      const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
      for (const entry of entries) {
        const source = path.join(sourceDir, entry.name);
        const target = path.join(overlayDir, entry.name);
        if (fs.existsSync(target)) {
          if (!overwrite) continue;
          fs.rmSync(target, { recursive: true, force: true });
        }
        fs.cpSync(source, target, { recursive: true, dereference: true, errorOnExist: true, force: false });
      }
    } catch (err) {
      throw new Error(`Could not copy stub root into Pylance overlay: ${sourceDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private isStubRootCopied(sourceDir: string, overlayDir: string): boolean {
    try {
      for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const source = path.join(sourceDir, entry.name);
        const target = path.join(overlayDir, entry.name);
        const sourceStat = fs.statSync(source);
        const targetStat = fs.lstatSync(target);
        if (targetStat.isSymbolicLink()) {
          return false;
        }
        if (sourceStat.isDirectory()) {
          if (!targetStat.isDirectory() || !this.isStubRootCopied(source, target)) {
            return false;
          }
        } else if (!targetStat.isFile() || sourceStat.size !== targetStat.size) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private isMergedUserStubRootCopied(userStubPath: string, stubsDir: string, overlayDir: string): boolean {
    try {
      const canmvEntries = new Set(fs.readdirSync(stubsDir));
      for (const entry of fs.readdirSync(userStubPath, { withFileTypes: true })) {
        if (canmvEntries.has(entry.name)) {
          continue;
        }
        const source = path.join(userStubPath, entry.name);
        const target = path.join(overlayDir, entry.name);
        if (!this.isStubEntryCopied(source, target)) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private isStubEntryCopied(source: string, target: string): boolean {
    try {
      const sourceStat = fs.statSync(source);
      const targetStat = fs.lstatSync(target);
      if (targetStat.isSymbolicLink()) {
        return false;
      }
      if (sourceStat.isDirectory()) {
        return targetStat.isDirectory() && this.isStubRootCopied(source, target);
      }
      return targetStat.isFile() && sourceStat.size === targetStat.size;
    } catch {
      return false;
    }
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
    if (this.hasCanMVManagedPathMarker(value, 'k230_canmv_stubs')) return true;

    const baseDir = this.normalizeFsPathForCompare(this.baseDir);
    const candidate = this.normalizeFsPathForCompare(value);
    const relative = path.relative(baseDir, candidate);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private isCanMVOverlayPath(value: string): boolean {
    if (!value) return false;
    if (this.hasCanMVManagedPathMarker(value, 'k230_canmv_pylance')) return true;

    const baseDir = this.normalizeFsPathForCompare(this.pylanceOverlayBaseDir);
    const candidate = this.normalizeFsPathForCompare(value);
    const relative = path.relative(baseDir, candidate);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private hasCanMVManagedPathMarker(value: string, directoryName: string): boolean {
    const normalized = this.expandHome(value)
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .trim();
    const marker = `/.kendryte/${directoryName}`;
    return normalized.endsWith(marker)
      || normalized.includes(`${marker}/`)
      || normalized === `.kendryte/${directoryName}`
      || normalized.startsWith(`.kendryte/${directoryName}/`);
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

}
