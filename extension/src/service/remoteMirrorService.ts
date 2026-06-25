import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { FileService } from './fileService';
import { logInfo, logWarn } from '../output';

const CANMV_SCHEME = 'canmv';
const MIRROR_DIR = 'canmv-vscode';
const REMOTE_DIR = 'remote';
const PYTHON_EXTENSIONS = new Set(['.py', '.pyi']);
const COMMON_IMPORT_ROOTS = ['sdcard', 'data', 'udisk'];

export class RemoteMirrorService {
  private readonly localToRemote = new Map<string, string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fileService: FileService,
  ) {}

  async openRemoteFile(remotePath: string): Promise<void> {
    const normalizedRemotePath = normalizeRemotePath(remotePath);
    if (!isPythonFile(normalizedRemotePath)) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.from({
        scheme: CANMV_SCHEME,
        path: normalizedRemotePath,
      }));
      return;
    }

    const localUri = this.localUriForRemotePath(normalizedRemotePath);
    this.remember(localUri, normalizedRemotePath);

    const openDocument = this.findOpenDocument(localUri);
    if (!openDocument?.isDirty) {
      const data = await this.fileService.readFile(normalizedRemotePath);
      await vscode.workspace.fs.createDirectory(parentUri(localUri));
      await vscode.workspace.fs.writeFile(localUri, data);
      logInfo('Mirror', `Synced ${normalizedRemotePath} -> ${localUri.fsPath}`);
    }

    await this.ensurePythonAnalysisPaths(localUri, normalizedRemotePath);
    const document = await vscode.workspace.openTextDocument(localUri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  remotePathForDocument(document: vscode.TextDocument): string | undefined {
    return this.remotePathForUri(document.uri);
  }

  remotePathForUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') return undefined;

    const key = normalizeFsPath(uri.fsPath);
    const mapped = this.localToRemote.get(key);
    if (mapped) return mapped;

    const relativePath = path.relative(this.mirrorRootUri().fsPath, uri.fsPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return undefined;
    }
    return normalizeRemotePath('/' + relativePath.split(path.sep).join('/'));
  }

  async syncDocumentToRemote(document: vscode.TextDocument): Promise<boolean> {
    const remotePath = this.remotePathForDocument(document);
    if (!remotePath) return false;

    const data = new TextEncoder().encode(document.getText());
    const ok = await this.fileService.writeFile(remotePath, data);
    if (ok) {
      logInfo('Mirror', `Synced ${document.uri.fsPath} -> ${remotePath}`);
    } else {
      logWarn('Mirror', `Write rejected for mirrored file: ${remotePath}`);
    }
    return ok;
  }

  private localUriForRemotePath(remotePath: string): vscode.Uri {
    const parts = normalizeRemotePath(remotePath)
      .split('/')
      .filter(Boolean)
      .map(sanitizePathSegment);
    return vscode.Uri.joinPath(this.mirrorRootUri(), ...parts);
  }

  private mirrorRootUri(): vscode.Uri {
    const workspace = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file');
    const scope = workspace?.uri.toString() || this.context.globalStorageUri.toString();
    const scopeHash = crypto.createHash('sha256').update(scope).digest('hex').slice(0, 16);
    const userDir = `${MIRROR_DIR}-${os.userInfo().username}`;
    return vscode.Uri.file(path.join(os.tmpdir(), userDir, scopeHash, REMOTE_DIR));
  }

  private findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    const target = normalizeFsPath(uri.fsPath);
    return vscode.workspace.textDocuments.find(document =>
      document.uri.scheme === 'file' && normalizeFsPath(document.uri.fsPath) === target
    );
  }

  private remember(localUri: vscode.Uri, remotePath: string): void {
    this.localToRemote.set(normalizeFsPath(localUri.fsPath), normalizeRemotePath(remotePath));
  }

  private async ensurePythonAnalysisPaths(localUri: vscode.Uri, remotePath: string): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file');
    if (!workspace) return;

    const mirrorRoot = this.mirrorRootUri().fsPath;
    const topLevel = normalizeRemotePath(remotePath).split('/').filter(Boolean)[0];
    const candidatePaths = [
      mirrorRoot,
      ...COMMON_IMPORT_ROOTS.map(root => path.join(mirrorRoot, root)),
      topLevel ? path.join(mirrorRoot, sanitizePathSegment(topLevel)) : '',
      path.dirname(localUri.fsPath),
    ].filter(Boolean);

    const config = vscode.workspace.getConfiguration('python.analysis', workspace.uri);
    const current = config.get<string[]>('extraPaths') || [];
    const currentKeys = new Set(current.map(normalizeFsPath));
    const next = [...current];
    for (const candidate of candidatePaths) {
      const key = normalizeFsPath(candidate);
      if (!currentKeys.has(key)) {
        currentKeys.add(key);
        next.push(candidate);
      }
    }
    if (next.length === current.length) return;

    try {
      await config.update('extraPaths', next, vscode.ConfigurationTarget.Workspace);
      logInfo('Mirror', `Pylance extraPaths updated for CanMV mirror: ${mirrorRoot}`);
    } catch (err) {
      logWarn('Mirror', `Could not update python.analysis.extraPaths: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function parentUri(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.file(path.dirname(uri.fsPath));
}

function normalizeRemotePath(value: string): string {
  const pathValue = value.trim() || '/';
  return ('/' + pathValue.replace(/^\/+/, '')).replace(/\/+$/g, '') || '/';
}

function normalizeFsPath(value: string): string {
  return path.normalize(value);
}

function sanitizePathSegment(value: string): string {
  if (!value || value === '.' || value === '..') return '_';
  return value.replace(/[<>:"\\|?*\x00-\x1F]/g, '_');
}

function isPythonFile(remotePath: string): boolean {
  return PYTHON_EXTENSIONS.has(path.extname(remotePath).toLowerCase());
}
