import * as fs from 'fs';
import * as path from 'path';
import { Methods, createRequest } from '../protocol/methods';
import { Request, Response, isResponse } from '../protocol/types';
import type { ProtocolError } from '../protocol/types';
import { logDebug, logError, logInfo, logWarn } from '../output';

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  mtime?: number;
}

export interface FileStat {
  exists: boolean;
  type?: 'file' | 'directory';
  size: number;
  mtime?: number;
}

interface CachedFile {
  data: Uint8Array;
  size: number;
  mtime?: number;
}

interface FileMutationResult {
  success: boolean;
  errorCode?: number;
}

interface TransferStats {
  files: number;
  folders: number;
  bytes: number;
}

interface ProtocolRequester {
  request(req: Request<string>): Promise<Response | ProtocolError>;
}

function mutationSucceeded(result: unknown): boolean {
  return !!(result as FileMutationResult).success;
}

function joinRemotePath(parent: string, name: string): string {
  return parent === '/' ? '/' + name : parent.replace(/\/+$/g, '') + '/' + name;
}

export class FileService {
  private readonly readCache = new Map<string, CachedFile>();

  constructor(private requester: ProtocolRequester) {}

  async listDir(path: string): Promise<FileEntry[]> {
    const req = createRequest(Methods.ioListDir, { path });
    const result = await this.requester.request(req);
    if (isResponse(result)) {
      return (result.result as { entries: FileEntry[] }).entries;
    }
    const message = (result as ProtocolError).error.message;
    logWarn('Files', `List failed: ${path}: ${message}`);
    throw new Error(message);
  }

  async statFile(path: string): Promise<FileStat> {
    const req = createRequest(Methods.ioQueryFileStat, { path });
    const result = await this.requester.request(req);
    if (isResponse(result)) {
      return result.result as FileStat;
    }
    const message = (result as ProtocolError).error.message;
    logWarn('Files', `Stat failed: ${path}: ${message}`);
    throw new Error(message);
  }

  async readFile(path: string, options?: { logSuccess?: boolean }): Promise<Uint8Array> {
    const shouldLogSuccess = options?.logSuccess ?? true;
    const cacheKey = normalizeRemotePath(path);
    const startedAt = Date.now();
    const stat = await this.statFile(cacheKey);
    if (!stat.exists) {
      logWarn('Files', `Read failed: ${cacheKey}: file not found`);
      throw new Error(`Remote file not found: ${cacheKey}`);
    }
    if (stat.type === 'directory') {
      logWarn('Files', `Read failed: ${cacheKey}: path is a folder`);
      throw new Error(`Remote path is a folder: ${cacheKey}`);
    }

    const cached = this.readCache.get(cacheKey);
    if (cached && cacheMatchesStat(cached, stat)) {
      if (shouldLogSuccess) {
        logDebug('Files', `Read cache hit: ${cacheKey} (${formatFileSize(cached.size)})`);
      }
      return new Uint8Array(cached.data);
    }
    if (cached) {
      if (shouldLogSuccess) {
        logDebug('Files', `Read cache stale: ${cacheKey}`);
      }
    }

    const req = createRequest(Methods.ioReadFile, { path: cacheKey });
    const result = await this.requester.request(req);
    if (isResponse(result)) {
      const data = decodeFilePayload(result.result as { data?: number[]; dataBase64?: string });
      if (data.byteLength !== stat.size) {
        this.invalidateCache(cacheKey);
        logError('Files', `Read incomplete: ${cacheKey}: expected ${formatFileSize(stat.size)}, got ${formatFileSize(data.byteLength)}`);
        throw new Error(`Read incomplete: expected ${stat.size} bytes, got ${data.byteLength}`);
      }
      this.readCache.set(cacheKey, {
        data: new Uint8Array(data),
        size: stat.size,
        mtime: stat.mtime,
      });
      if (shouldLogSuccess) {
        logInfo('Files', `Read ${cacheKey} (${formatFileSize(data.byteLength)}, ${Date.now() - startedAt}ms)`);
      }
      return data;
    }
    const message = (result as ProtocolError).error.message;
    logWarn('Files', `Read failed: ${cacheKey}: ${message}`);
    throw new Error(message);
  }

  async writeFile(path: string, data: Uint8Array, options?: { logSuccess?: boolean }): Promise<boolean> {
    const shouldLogSuccess = options?.logSuccess ?? true;
    const startedAt = Date.now();
    const req = createRequest(Methods.ioWriteFile, { path, dataBase64: Buffer.from(data).toString('base64') });
    const result = await this.requester.request(req);
    if (isResponse(result)) {
      const success = (result.result as { success: boolean }).success;
      if (success) {
        await this.updateCachedWrite(path, data);
        if (shouldLogSuccess) {
          logInfo('Files', `Wrote ${path} (${formatFileSize(data.byteLength)}, ${Date.now() - startedAt}ms)`);
        }
      } else {
        this.invalidateCache(path);
        logWarn('Files', `Write rejected: ${path} (${formatFileSize(data.byteLength)})`);
      }
      return success;
    }
    const message = (result as ProtocolError).error.message;
    logWarn('Files', `Write failed: ${path}: ${message}`);
    throw new Error(message);
  }

  async fileExec(path: string): Promise<{ status: string; message?: string }> {
    const startedAt = Date.now();
    const req = createRequest(Methods.ioFileExec, { path });
    const result = await this.requester.request(req);
    if (isResponse(result)) {
      const payload = result.result as { status: string; message?: string };
      logInfo('Files', `Executed ${path}: ${payload.status} (${Date.now() - startedAt}ms)`);
      return payload;
    }
    const message = (result as ProtocolError).error.message;
    logWarn('Files', `Execute failed: ${path}: ${message}`);
    throw new Error(message);
  }

  async deleteFile(path: string): Promise<boolean> {
    const req = createRequest(Methods.ioDeleteFile, { path });
    const result = await this.requester.request(req);
    if (isResponse(result)) {
      const success = mutationSucceeded(result.result);
      if (success) {
        this.invalidateCache(path);
        logInfo('Files', `Deleted file: ${path}`);
      } else {
        logWarn('Files', `Delete file rejected: ${path}`);
      }
      return success;
    }
    const message = (result as ProtocolError).error.message;
    logWarn('Files', `Delete file failed: ${path}: ${message}`);
    throw new Error(message);
  }

  async renameFile(oldPath: string, newPath: string): Promise<boolean> {
    const req = createRequest(Methods.ioRenameFile, { oldPath, newPath });
    const result = await this.requester.request(req);
    if (isResponse(result)) {
      const success = mutationSucceeded(result.result);
      if (success) {
        this.invalidateCache(oldPath, true);
        this.invalidateCache(newPath, true);
        logInfo('Files', `Renamed: ${oldPath} -> ${newPath}`);
      } else {
        logWarn('Files', `Rename rejected: ${oldPath} -> ${newPath}`);
      }
      return success;
    }
    const message = (result as ProtocolError).error.message;
    logWarn('Files', `Rename failed: ${oldPath} -> ${newPath}: ${message}`);
    throw new Error(message);
  }

  async mkdir(path: string, options?: { logSuccess?: boolean; logRejected?: boolean }): Promise<boolean> {
    const shouldLogSuccess = options?.logSuccess ?? true;
    const shouldLogRejected = options?.logRejected ?? true;
    const req = createRequest(Methods.ioMkdir, { path });
    const result = await this.requester.request(req);
    if (isResponse(result)) {
      const success = mutationSucceeded(result.result);
      if (success) {
        this.invalidateCache(path, true);
        if (shouldLogSuccess) {
          logInfo('Files', `Created folder: ${path}`);
        }
      } else if (shouldLogRejected) {
        logWarn('Files', `Create folder rejected: ${path}`);
      }
      return success;
    }
    const message = (result as ProtocolError).error.message;
    logWarn('Files', `Create folder failed: ${path}: ${message}`);
    throw new Error(message);
  }

  clearCache(): void {
    this.readCache.clear();
    logDebug('Files', 'Cleared file read cache');
  }

  async rmdir(path: string): Promise<boolean> {
    const req = createRequest(Methods.ioRmdir, { path });
    const result = await this.requester.request(req);
    if (isResponse(result)) {
      const success = mutationSucceeded(result.result);
      if (success) {
        this.invalidateCache(path, true);
        logInfo('Files', `Deleted folder: ${path}`);
      } else {
        logWarn('Files', `Delete folder rejected: ${path}`);
      }
      return success;
    }
    const message = (result as ProtocolError).error.message;
    logWarn('Files', `Delete folder failed: ${path}: ${message}`);
    throw new Error(message);
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    const stat = fs.statSync(localPath);
    const startedAt = Date.now();
    const stats: TransferStats = { files: 0, folders: 0, bytes: 0 };
    if (stat.isDirectory()) {
      logInfo('Files', `Upload folder started: ${localPath} -> ${remotePath}`);
      await this.uploadDirectory(localPath, remotePath, stats);
      logInfo('Files', `Upload folder finished: ${localPath} -> ${remotePath} (${describeTransfer(stats)}, ${Date.now() - startedAt}ms)`);
      return;
    }
    if (!stat.isFile()) {
      logWarn('Files', `Upload rejected: ${localPath}: not a file or folder`);
      throw new Error('Only files and folders can be uploaded');
    }
    const data = fs.readFileSync(localPath);
    const ok = await this.writeFile(remotePath, data, { logSuccess: false });
    if (!ok) throw new Error(`Failed to upload ${path.basename(localPath)}`);
    logInfo('Files', `Upload file finished: ${localPath} -> ${remotePath} (${formatFileSize(data.byteLength)}, ${Date.now() - startedAt}ms)`);
  }

  private async uploadDirectory(localDir: string, remoteDir: string, stats: TransferStats): Promise<void> {
    const made = await this.mkdir(remoteDir, { logSuccess: false, logRejected: false });
    if (!made) {
      try {
        const entries = await this.listDir(remoteDir);
        if (!Array.isArray(entries)) throw new Error('not a directory');
      } catch {
        throw new Error(`Failed to create remote folder ${remoteDir}`);
      }
    }
    stats.folders++;

    const entries = fs.readdirSync(localDir, { withFileTypes: true });
    for (const entry of entries) {
      const localChild = path.join(localDir, entry.name);
      const remoteChild = joinRemotePath(remoteDir, entry.name);
      if (entry.isDirectory()) {
        await this.uploadDirectory(localChild, remoteChild, stats);
      } else if (entry.isFile()) {
        const data = fs.readFileSync(localChild);
        const ok = await this.writeFile(remoteChild, data, { logSuccess: false });
        if (!ok) throw new Error(`Failed to upload ${localChild}`);
        stats.files++;
        stats.bytes += data.byteLength;
      }
    }
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    const startedAt = Date.now();
    const stats: TransferStats = { files: 0, folders: 0, bytes: 0 };
    const stat = await this.statFile(remotePath);
    if (!stat.exists) {
      logWarn('Files', `Download failed: ${remotePath}: remote path not found`);
      throw new Error(`Remote path not found: ${remotePath}`);
    }

    if (stat.type === 'directory') {
      logInfo('Files', `Download folder started: ${remotePath} -> ${localPath}`);
      await this.downloadDirectory(remotePath, localPath, stats);
      logInfo('Files', `Download folder finished: ${remotePath} -> ${localPath} (${describeTransfer(stats)}, ${Date.now() - startedAt}ms)`);
      return;
    }

    await this.downloadFile(remotePath, localPath, stats);
    logInfo('Files', `Download file finished: ${remotePath} -> ${localPath} (${formatFileSize(stats.bytes)}, ${Date.now() - startedAt}ms)`);
  }

  private async downloadDirectory(remoteDir: string, localDir: string, stats: TransferStats): Promise<void> {
    if (fs.existsSync(localDir) && !fs.statSync(localDir).isDirectory()) {
      logWarn('Files', `Download failed: local path is not a folder: ${localDir}`);
      throw new Error(`Local path exists and is not a folder: ${localDir}`);
    }
    fs.mkdirSync(localDir, { recursive: true });
    stats.folders++;

    const entries = await this.listDir(remoteDir);
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const remoteChild = joinRemotePath(remoteDir, entry.name);
      const localChild = path.join(localDir, entry.name);
      if (entry.type === 'directory') {
        await this.downloadDirectory(remoteChild, localChild, stats);
      } else {
        await this.downloadFile(remoteChild, localChild, stats);
      }
    }
  }

  private async downloadFile(remotePath: string, localPath: string, stats?: TransferStats): Promise<void> {
    if (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory()) {
      localPath = path.join(localPath, path.basename(remotePath));
    }
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const data = await this.readFile(remotePath, { logSuccess: !stats });
    fs.writeFileSync(localPath, data);
    if (stats) {
      stats.files++;
      stats.bytes += data.byteLength;
    }
  }

  private async updateCachedWrite(path: string, data: Uint8Array): Promise<void> {
    const cacheKey = normalizeRemotePath(path);
    try {
      const stat = await this.statFile(cacheKey);
      this.readCache.set(cacheKey, {
        data: new Uint8Array(data),
        size: stat.size,
        mtime: stat.mtime,
      });
    } catch {
      this.invalidateCache(cacheKey);
    }
  }

  private invalidateCache(path: string, recursive = false): void {
    const cacheKey = normalizeRemotePath(path);
    if (!recursive) {
      this.readCache.delete(cacheKey);
      return;
    }

    const prefix = cacheKey === '/' ? '/' : cacheKey + '/';
    for (const key of this.readCache.keys()) {
      if (key === cacheKey || key.startsWith(prefix)) {
        this.readCache.delete(key);
      }
    }
  }
}

function describeTransfer(stats: TransferStats): string {
  return `${stats.files} file${stats.files === 1 ? '' : 's'}, ${stats.folders} folder${stats.folders === 1 ? '' : 's'}, ${formatFileSize(stats.bytes)}`;
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '0 B';
  if (size < 1024) return `${size} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = size / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  const digits = value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${unit}`;
}

function normalizeRemotePath(path: string): string {
  if (!path || path === '/') return '/';
  return path.replace(/\/+$/g, '') || '/';
}

function cacheMatchesStat(cached: CachedFile, stat: FileStat): boolean {
  if (!stat.exists || stat.type === 'directory' || cached.size !== stat.size) {
    return false;
  }
  if (typeof stat.mtime === 'number' && Number.isFinite(stat.mtime) && stat.mtime > 0) {
    return cached.mtime === stat.mtime;
  }
  return true;
}

function decodeFilePayload(payload: { data?: number[]; dataBase64?: string }): Uint8Array {
  if (typeof payload.dataBase64 === 'string') {
    return new Uint8Array(Buffer.from(payload.dataBase64, 'base64'));
  }
  return new Uint8Array(payload.data || []);
}
