import * as vscode from 'vscode';
import { FileService, type FileEntry } from '../service/fileService';
import { t } from '../i18n';

const WRITABLE_ROOTS = new Set(['sdcard', 'data', 'udisk']);

export class CanmvFileSystemProvider implements vscode.FileSystemProvider {
  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._emitter.event;

  constructor(private fileService: FileService) {}

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (uri.path === '/') {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }

    const entry = await this.findEntry(uri);
    if (entry) {
      return {
        type: entry.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: entry.size || 0,
      };
    }

    const r = await this.fileService.statFile(uri.path);
    if (!r.exists) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return {
      type: r.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: 0,
      mtime: r.mtime ? r.mtime * 1000 : 0,
      size: r.size,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const entries = await this.listDir(uri.path);
    return entries.map(e => [
      e.name,
      e.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      return await this.fileService.readFile(uri.path);
    } catch (err) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> {
    this.assertWritablePath(uri);
    const exists = await this.exists(uri);
    if (exists && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (!exists && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const ok = await this.fileService.writeFile(uri.path, content);
    if (!ok) {
      throw vscode.FileSystemError.Unavailable(t('Write failed'));
    }
    this.fireChanged(uri, exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created);
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean }
  ): Promise<void> {
    this.assertWritablePath(oldUri);
    this.assertWritablePath(newUri);
    if (!(await this.exists(oldUri))) {
      throw vscode.FileSystemError.FileNotFound(oldUri);
    }
    const targetExists = await this.exists(newUri);
    if (targetExists) {
      if (!options.overwrite) {
        throw vscode.FileSystemError.FileExists(newUri);
      }
      await this.delete(newUri, { recursive: true });
    }

    const ok = await this.fileService.renameFile(oldUri.path, newUri.path);
    if (!ok) {
      throw vscode.FileSystemError.Unavailable(t('Rename failed'));
    }
    this._emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
      { type: vscode.FileChangeType.Changed, uri: this.parentUri(oldUri) },
      { type: vscode.FileChangeType.Changed, uri: this.parentUri(newUri) },
    ]);
  }

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    this.assertWritablePath(uri);
    const stat = await this.stat(uri);
    if (stat.type === vscode.FileType.Directory && !options.recursive) {
      const entries = await this.readDirectory(uri);
      if (entries.length > 0) {
        throw vscode.FileSystemError.NoPermissions(t('Directory is not empty'));
      }
    }
    const ok = stat.type === vscode.FileType.Directory
      ? await this.fileService.rmdir(uri.path)
      : await this.fileService.deleteFile(uri.path);
    if (!ok) {
      throw vscode.FileSystemError.Unavailable(t('Delete failed'));
    }
    this.fireChanged(uri, vscode.FileChangeType.Deleted);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    this.assertWritablePath(uri);
    const ok = await this.fileService.mkdir(uri.path);
    if (!ok) {
      throw vscode.FileSystemError.Unavailable(t('Create directory failed'));
    }
    this.fireChanged(uri, vscode.FileChangeType.Created);
  }

  watch(_uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[] }): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  private assertWritablePath(uri: vscode.Uri): void {
    if (!this.isWritablePath(uri.path)) {
      throw vscode.FileSystemError.NoPermissions(t('CanMV root folders are read-only'));
    }
  }

  private isWritablePath(path: string): boolean {
    const parts = path.split('/').filter(Boolean);
    return parts.length > 1 && WRITABLE_ROOTS.has(parts[0]);
  }

  private async listDir(path: string): Promise<FileEntry[]> {
    try {
      return await this.fileService.listDir(path);
    } catch {
      throw vscode.FileSystemError.FileNotFound(vscode.Uri.from({ scheme: 'canmv', path }));
    }
  }

  private async findEntry(uri: vscode.Uri): Promise<FileEntry | undefined> {
    const parent = this.parentPath(uri.path);
    const name = this.basename(uri.path);
    try {
      const entries = await this.listDir(parent);
      return entries.find(e => e.name === name);
    } catch {
      return undefined;
    }
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await this.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private fireChanged(uri: vscode.Uri, type: vscode.FileChangeType): void {
    this._emitter.fire([
      { type, uri },
      { type: vscode.FileChangeType.Changed, uri: this.parentUri(uri) },
    ]);
  }

  private parentUri(uri: vscode.Uri): vscode.Uri {
    return uri.with({ path: this.parentPath(uri.path) });
  }

  private parentPath(path: string): string {
    if (!path || path === '/') return '/';
    const trimmed = path.replace(/\/+$/g, '');
    const index = trimmed.lastIndexOf('/');
    return index <= 0 ? '/' : trimmed.slice(0, index);
  }

  private basename(path: string): string {
    return path.replace(/\/+$/g, '').split('/').pop() || '';
  }
}
