import * as fs from 'fs';
import * as path from 'path';
import { Methods, createRequest } from '../protocol/methods';
import { Request, Response, isResponse } from '../protocol/types';
import type { ProtocolError } from '../protocol/types';
import { logDebug, logError, logInfo, logWarn } from '../output';
import { t } from '../i18n';
import { minifyStartupScript } from './startupScript';

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  mtime?: number;
}

export interface DirectoryPage {
  entries: FileEntry[];
  nextOffset?: number;
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
  request(req: Request<string>, options?: { timeoutMs?: number }): Promise<Response | ProtocolError>;
}

const REMOTE_FILE_CHUNK_SIZE = 128 * 1024;
const REMOTE_FILE_CHUNK_TIMEOUT_MS = 30_000;
const REMOTE_DIRECTORY_LIST_TIMEOUT_MS = 30_000;
const MAX_DIRECTORY_LIST_PAGES = 100_000;

function mutationSucceeded(result: unknown): boolean {
  return !!(result as FileMutationResult).success;
}

function joinRemotePath(parent: string, name: string): string {
  return parent === '/' ? '/' + name : parent.replace(/\/+$/g, '') + '/' + name;
}

export class FileService {
  private readonly readCache = new Map<string, CachedFile>();

  constructor(
    private requester: ProtocolRequester,
    private readonly shouldMinifyStartupScripts: () => boolean = () => true,
  ) {}

  async listDir(path: string): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    let offset = 0;
    for (let pageCount = 0; pageCount < MAX_DIRECTORY_LIST_PAGES; pageCount++) {
      const page = await this.listDirPage(path, offset);
      entries.push(...page.entries);
      if (page.nextOffset === undefined) {
        return entries;
      }
      offset = page.nextOffset;
    }
    throw new Error(`Directory listing exceeded ${MAX_DIRECTORY_LIST_PAGES} pages: ${path}`);
  }

  async listDirPage(path: string, offset = 0): Promise<DirectoryPage> {
    const req = createRequest(Methods.ioListDir, { path, offset });
    const result = await this.requester.request(req, { timeoutMs: REMOTE_DIRECTORY_LIST_TIMEOUT_MS });
    if (!isResponse(result)) {
      const message = (result as ProtocolError).error.message;
      logWarn('Files', `List failed: ${path}: ${message}`);
      throw new Error(message);
    }

    const page = result.result as { entries?: FileEntry[]; nextOffset?: number };
    if (!Array.isArray(page.entries)) {
      throw new Error(`Invalid directory listing response for ${path}`);
    }
    if (page.nextOffset !== undefined &&
      (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset || page.nextOffset > 0xffff_ffff)) {
      throw new Error(`Invalid directory listing continuation for ${path}`);
    }
    return { entries: page.entries, nextOffset: page.nextOffset };
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
      throw new Error(t('Remote file not found: {path}', { path: cacheKey }));
    }
    if (stat.type === 'directory') {
      logWarn('Files', `Read failed: ${cacheKey}: path is a folder`);
      throw new Error(t('Remote path is a folder: {path}', { path: cacheKey }));
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

    const data = stat.size > REMOTE_FILE_CHUNK_SIZE
      ? await this.readFileInChunks(cacheKey, stat.size)
      : await this.readFilePayload(cacheKey);
    if (data.byteLength !== stat.size) {
      this.invalidateCache(cacheKey);
      logError('Files', `Read incomplete: ${cacheKey}: expected ${formatFileSize(stat.size)}, got ${formatFileSize(data.byteLength)}`);
      throw new Error(t('Read incomplete: expected {expected} bytes, got {actual}', { expected: stat.size, actual: data.byteLength }));
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

  private async readFileInChunks(remotePath: string, fileSize: number): Promise<Uint8Array> {
    const data = new Uint8Array(fileSize);
    let offset = 0;
    while (offset < fileSize) {
      const size = Math.min(REMOTE_FILE_CHUNK_SIZE, fileSize - offset);
      const chunk = await this.readFilePayload(remotePath, { offset, size });
      if (chunk.byteLength === 0 || chunk.byteLength > size) {
        this.invalidateCache(remotePath);
        logError('Files', `Read incomplete: ${remotePath} at offset ${offset}: expected at most ${formatFileSize(size)}, got ${formatFileSize(chunk.byteLength)}`);
        throw new Error(t('Read incomplete: expected {expected} bytes, got {actual}', { expected: fileSize, actual: offset + chunk.byteLength }));
      }
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return data;
  }

  private async readFilePayload(
    remotePath: string,
    range?: { offset: number; size: number },
  ): Promise<Uint8Array> {
    const req = createRequest(Methods.ioReadFile, range ? { path: remotePath, ...range } : { path: remotePath });
    const result = await this.requester.request(req, { timeoutMs: REMOTE_FILE_CHUNK_TIMEOUT_MS });
    if (isResponse(result)) {
      return decodeFilePayload(result.result as { data?: number[]; dataBase64?: string });
    }
    const message = (result as ProtocolError).error.message;
    logWarn('Files', `Read failed: ${remotePath}: ${message}`);
    throw new Error(message);
  }

  async writeFile(path: string, data: Uint8Array, options?: { logSuccess?: boolean }): Promise<boolean> {
    const shouldLogSuccess = options?.logSuccess ?? true;
    const startedAt = Date.now();
    const writeData = minifyStartupScript(path, data, this.shouldMinifyStartupScripts());
    const req = createRequest(Methods.ioWriteFile, { path, dataBase64: Buffer.from(writeData).toString('base64') });
    const result = await this.requester.request(req);
    if (isResponse(result)) {
      const success = (result.result as { success: boolean }).success;
      if (success) {
        await this.updateCachedWrite(path, writeData);
        if (shouldLogSuccess) {
          logInfo('Files', `Wrote ${path} (${formatFileSize(writeData.byteLength)}, ${Date.now() - startedAt}ms)`);
        }
      } else {
        this.invalidateCache(path);
        logWarn('Files', `Write rejected: ${path} (${formatFileSize(writeData.byteLength)})`);
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
      throw new Error(t('Only files and folders can be uploaded'));
    }
    const data = fs.readFileSync(localPath);
    const ok = await this.writeFile(remotePath, data, { logSuccess: false });
    if (!ok) throw new Error(t('Failed to upload {name}', { name: path.basename(localPath) }));
    logInfo('Files', `Upload file finished: ${localPath} -> ${remotePath} (${formatFileSize(data.byteLength)}, ${Date.now() - startedAt}ms)`);
  }

  private async uploadDirectory(localDir: string, remoteDir: string, stats: TransferStats): Promise<void> {
    const made = await this.mkdir(remoteDir, { logSuccess: false, logRejected: false });
    if (!made) {
      try {
        const entries = await this.listDir(remoteDir);
        if (!Array.isArray(entries)) throw new Error(t('not a directory'));
      } catch {
        throw new Error(t('Failed to create remote folder {path}', { path: remoteDir }));
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
        if (!ok) throw new Error(t('Failed to upload {path}', { path: localChild }));
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
      throw new Error(t('Remote path not found: {path}', { path: remotePath }));
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
      throw new Error(t('Local path exists and is not a folder: {path}', { path: localDir }));
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
