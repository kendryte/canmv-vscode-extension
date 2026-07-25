import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Methods, createRequest } from '../protocol/methods';
import { Request, Response, isResponse } from '../protocol/types';
import type { ProtocolError } from '../protocol/types';
import { logDebug, logError, logInfo, logWarn } from '../output';
import { t } from '../i18n';
import { isStartupScriptPath, minifyStartupScript } from './startupScript';

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

export type FileTransferPhase = 'scanning' | 'hashing' | 'transferring' | 'verifying';

export interface FileTransferProgress {
  phase: FileTransferPhase;
  path: string;
  bytesTransferred: number;
  totalBytes: number;
  filesTransferred: number;
  totalFiles: number;
}

export interface FileTransferTotals {
  bytes: number;
  files: number;
}

export type FileTransferProgressCallback = (progress: FileTransferProgress) => void;

interface TransferContext extends FileTransferTotals {
  bytesTransferred: number;
  filesTransferred: number;
  report?: FileTransferProgressCallback;
}

interface DownloadFilePlan {
  remotePath: string;
  localPath: string;
  size: number;
}

interface DownloadPlan {
  bytes: number;
  directories: string[];
  fileEntries: DownloadFilePlan[];
}

interface ProtocolRequester {
  request(req: Request<string>, options?: { timeoutMs?: number }): Promise<Response | ProtocolError>;
}

// Upload chunks must fit comfortably inside legacy firmware's 16 KiB CDC RX
// FIFO. Downloads travel in the opposite direction and can use larger chunks.
const REMOTE_FILE_WRITE_CHUNK_SIZE = 8 * 1024;
const REMOTE_FILE_READ_CHUNK_SIZE = 32 * 1024;
const REMOTE_FILE_CHUNK_TIMEOUT_MS = 15_000;
// Keep the client deadline above the backend's five-minute device verification
// deadline so the backend can return a precise VERIFYFILE error first.
const REMOTE_FILE_VERIFY_TIMEOUT_MS = 6 * 60_000;
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
  private fileOperationTail: Promise<void> = Promise.resolve();

  constructor(
    private requester: ProtocolRequester,
    private readonly shouldMinifyStartupScripts: () => boolean = () => true,
  ) {}

  async listDir(path: string): Promise<FileEntry[]> {
    return this.runFileOperation(async () => {
      const entries: FileEntry[] = [];
      let offset = 0;
      for (let pageCount = 0; pageCount < MAX_DIRECTORY_LIST_PAGES; pageCount++) {
        const page = await this.requestListDirPage(path, offset);
        entries.push(...page.entries);
        if (page.nextOffset === undefined) {
          return entries;
        }
        offset = page.nextOffset;
      }
      throw new Error(`Directory listing exceeded ${MAX_DIRECTORY_LIST_PAGES} pages: ${path}`);
    });
  }

  async listDirPage(path: string, offset = 0): Promise<DirectoryPage> {
    return this.runFileOperation(() => this.requestListDirPage(path, offset));
  }

  private async requestListDirPage(path: string, offset: number): Promise<DirectoryPage> {
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
    return this.runFileOperation(() => this.requestFileStat(path));
  }

  private async requestFileStat(path: string): Promise<FileStat> {
    const req = createRequest(Methods.ioQueryFileStat, { path });
    const result = await this.requester.request(req);
    if (isResponse(result)) {
      return result.result as FileStat;
    }
    const message = (result as ProtocolError).error.message;
    logWarn('Files', `Stat failed: ${path}: ${message}`);
    throw new Error(message);
  }

  async readFile(path: string, options?: { logSuccess?: boolean; onChunk?: (bytes: number) => void }): Promise<Uint8Array> {
    return this.runFileOperation(async () => {
      const shouldLogSuccess = options?.logSuccess ?? true;
      const cacheKey = normalizeRemotePath(path);
      const startedAt = Date.now();
      const stat = await this.requestFileStat(cacheKey);
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
        options?.onChunk?.(cached.size);
        return new Uint8Array(cached.data);
      }
      if (cached && shouldLogSuccess) {
        logDebug('Files', `Read cache stale: ${cacheKey}`);
      }

      const data = stat.size > REMOTE_FILE_READ_CHUNK_SIZE
        ? await this.readFileInChunks(cacheKey, stat.size, options?.onChunk)
        : await this.readFilePayload(cacheKey);
      if (stat.size <= REMOTE_FILE_READ_CHUNK_SIZE) {
        options?.onChunk?.(data.byteLength);
      }
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
    });
  }

  private async readFileInChunks(
    remotePath: string,
    fileSize: number,
    onChunk?: (bytes: number) => void,
  ): Promise<Uint8Array> {
    const data = new Uint8Array(fileSize);
    let offset = 0;
    while (offset < fileSize) {
      const size = Math.min(REMOTE_FILE_READ_CHUNK_SIZE, fileSize - offset);
      const chunk = await this.readFilePayload(remotePath, { offset, size });
      if (chunk.byteLength === 0 || chunk.byteLength > size) {
        this.invalidateCache(remotePath);
        logError('Files', `Read incomplete: ${remotePath} at offset ${offset}: expected at most ${formatFileSize(size)}, got ${formatFileSize(chunk.byteLength)}`);
        throw new Error(t('Read incomplete: expected {expected} bytes, got {actual}', { expected: fileSize, actual: offset + chunk.byteLength }));
      }
      data.set(chunk, offset);
      offset += chunk.byteLength;
      onChunk?.(chunk.byteLength);
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

  async writeFile(
    path: string,
    data: Uint8Array,
    options?: { logSuccess?: boolean; onChunk?: (bytes: number) => void; onPhase?: (phase: FileTransferPhase) => void },
  ): Promise<boolean> {
    return this.runFileOperation(async () => {
      const shouldLogSuccess = options?.logSuccess ?? true;
      const startedAt = Date.now();
      const writeData = minifyStartupScript(path, data, this.shouldMinifyStartupScripts());
      const success = await this.writeFileInChunks(path, writeData, options?.onChunk, options?.onPhase);
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
    });
  }

  private async writeFileInChunks(
    remotePath: string,
    data: Uint8Array,
    onChunk?: (bytes: number) => void,
    onPhase?: (phase: FileTransferPhase) => void,
  ): Promise<boolean> {
    const sha256Base64 = createHash('sha256').update(data).digest('base64');
    let active = false;
    try {
      if (!(await this.beginFileWrite(remotePath, data.byteLength, sha256Base64))) return false;
      active = true;
      onPhase?.('transferring');

      for (let offset = 0; offset < data.byteLength; offset += REMOTE_FILE_WRITE_CHUNK_SIZE) {
        const chunk = data.subarray(offset, Math.min(offset + REMOTE_FILE_WRITE_CHUNK_SIZE, data.byteLength));
        if (!(await this.writeFileChunk(remotePath, chunk))) {
          active = false;
          return false;
        }
        onChunk?.(chunk.byteLength);
      }

      onPhase?.('verifying');
      const success = await this.finishFileWrite(remotePath);
      active = false;
      return success;
    } finally {
      if (active) await this.abortFileWrite(remotePath);
    }
  }

  private async writeLocalFileInChunks(
    localPath: string,
    remotePath: string,
    size: number,
    onChunk?: (bytes: number) => void,
    onPhase?: (phase: FileTransferPhase) => void,
  ): Promise<boolean> {
    onPhase?.('hashing');
    const sha256Base64 = await this.hashLocalFile(localPath);
    let active = false;
    try {
      if (!(await this.beginFileWrite(remotePath, size, sha256Base64))) return false;
      active = true;
      onPhase?.('transferring');

      for await (const chunk of fs.createReadStream(localPath, { highWaterMark: REMOTE_FILE_WRITE_CHUNK_SIZE })) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!(await this.writeFileChunk(remotePath, data))) {
          active = false;
          return false;
        }
        onChunk?.(data.byteLength);
      }

      onPhase?.('verifying');
      const success = await this.finishFileWrite(remotePath);
      active = false;
      return success;
    } finally {
      if (active) await this.abortFileWrite(remotePath);
    }
  }

  private async hashLocalFile(localPath: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(localPath, { highWaterMark: REMOTE_FILE_READ_CHUNK_SIZE })) {
      hash.update(chunk);
    }
    return hash.digest('base64');
  }

  private async beginFileWrite(remotePath: string, size: number, sha256Base64: string): Promise<boolean> {
    return this.writeFileRequest(
      createRequest(Methods.ioBeginWriteFile, { path: remotePath, size, sha256Base64 }),
      REMOTE_FILE_CHUNK_TIMEOUT_MS,
      remotePath,
    );
  }

  private async writeFileChunk(remotePath: string, data: Uint8Array): Promise<boolean> {
    return this.writeFileRequest(
      createRequest(Methods.ioWriteFileChunk, { dataBase64: Buffer.from(data).toString('base64') }),
      REMOTE_FILE_CHUNK_TIMEOUT_MS,
      remotePath,
    );
  }

  private async finishFileWrite(remotePath: string): Promise<boolean> {
    return this.writeFileRequest(
      createRequest(Methods.ioFinishWriteFile, {}),
      REMOTE_FILE_VERIFY_TIMEOUT_MS,
      remotePath,
    );
  }

  private async abortFileWrite(remotePath: string): Promise<void> {
    try {
      const req = createRequest(Methods.ioAbortWriteFile, {});
      const result = await this.requester.request(req, { timeoutMs: REMOTE_FILE_CHUNK_TIMEOUT_MS });
      if (!isResponse(result) || !mutationSucceeded(result.result)) {
        logWarn('Files', `Write cleanup failed: ${remotePath}`);
      }
    } catch (error) {
      logWarn('Files', `Write cleanup failed: ${remotePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async writeFileRequest(req: Request<string>, timeoutMs: number, remotePath: string): Promise<boolean> {
    const result = await this.requester.request(req, { timeoutMs });
    if (isResponse(result)) {
      return mutationSucceeded(result.result);
    }
    const message = (result as ProtocolError).error.message;
    logWarn('Files', `Write failed: ${remotePath}: ${message}`);
    throw new Error(message);
  }

  async fileExec(path: string): Promise<{ status: string; message?: string }> {
    return this.runFileOperation(async () => {
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
    });
  }

  async deleteFile(path: string): Promise<boolean> {
    return this.runFileOperation(async () => {
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
    });
  }

  async renameFile(oldPath: string, newPath: string): Promise<boolean> {
    return this.runFileOperation(async () => {
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
    });
  }

  async mkdir(path: string, options?: { logSuccess?: boolean; logRejected?: boolean }): Promise<boolean> {
    return this.runFileOperation(async () => {
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
    });
  }

  clearCache(): void {
    this.readCache.clear();
    logDebug('Files', 'Cleared file read cache');
  }

  async rmdir(path: string): Promise<boolean> {
    return this.runFileOperation(async () => {
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
    });
  }

  measureUpload(localPath: string, remotePath: string): FileTransferTotals {
    const totals: FileTransferTotals = { bytes: 0, files: 0 };
    this.measureUploadPath(localPath, remotePath, totals);
    return totals;
  }

  private measureUploadPath(localPath: string, remotePath: string, totals: FileTransferTotals): void {
    const stat = fs.statSync(localPath);
    if (stat.isFile()) {
      totals.files++;
      totals.bytes += this.uploadFileSize(localPath, remotePath, stat.size);
      return;
    }
    if (!stat.isDirectory()) return;

    for (const entry of fs.readdirSync(localPath, { withFileTypes: true })) {
      const localChild = path.join(localPath, entry.name);
      const remoteChild = joinRemotePath(remotePath, entry.name);
      if (entry.isDirectory() || entry.isFile()) {
        this.measureUploadPath(localChild, remoteChild, totals);
      }
    }
  }

  private uploadFileSize(localPath: string, remotePath: string, fallbackSize: number): number {
    if (!this.shouldMinifyStartupScripts() || !isStartupScriptPath(remotePath)) return fallbackSize;
    return minifyStartupScript(remotePath, fs.readFileSync(localPath), true).byteLength;
  }

  async upload(localPath: string, remotePath: string, report?: FileTransferProgressCallback): Promise<void> {
    const stat = fs.statSync(localPath);
    const startedAt = Date.now();
    const stats: TransferStats = { files: 0, folders: 0, bytes: 0 };
    const totals = this.measureUpload(localPath, remotePath);
    const context: TransferContext = {
      ...totals,
      bytesTransferred: 0,
      filesTransferred: 0,
      report,
    };
    this.reportTransfer(context, 'transferring', remotePath);
    if (stat.isDirectory()) {
      logInfo('Files', `Upload folder started: ${localPath} -> ${remotePath}`);
      await this.uploadDirectory(localPath, remotePath, stats, context);
      logInfo('Files', `Upload folder finished: ${localPath} -> ${remotePath} (${describeTransfer(stats)}, ${Date.now() - startedAt}ms)`);
      return;
    }
    if (!stat.isFile()) {
      logWarn('Files', `Upload rejected: ${localPath}: not a file or folder`);
      throw new Error(t('Only files and folders can be uploaded'));
    }
    const ok = await this.uploadLocalFile(localPath, remotePath, stat.size, context);
    if (!ok) throw new Error(t('Failed to upload {name}', { name: path.basename(localPath) }));
    context.filesTransferred++;
    stats.files = 1;
    stats.bytes = totals.bytes;
    this.reportTransfer(context, 'transferring', remotePath);
    logInfo('Files', `Upload file finished: ${localPath} -> ${remotePath} (${formatFileSize(stat.size)}, ${Date.now() - startedAt}ms)`);
  }

  private async uploadDirectory(
    localDir: string,
    remoteDir: string,
    stats: TransferStats,
    context: TransferContext,
  ): Promise<void> {
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
        await this.uploadDirectory(localChild, remoteChild, stats, context);
      } else if (entry.isFile()) {
        const localStat = fs.statSync(localChild);
        const ok = await this.uploadLocalFile(localChild, remoteChild, localStat.size, context);
        if (!ok) throw new Error(t('Failed to upload {path}', { path: localChild }));
        stats.files++;
        const transferredSize = this.uploadFileSize(localChild, remoteChild, localStat.size);
        stats.bytes += transferredSize;
        context.filesTransferred++;
        this.reportTransfer(context, 'transferring', remoteChild);
      }
    }
  }

  private async uploadLocalFile(
    localPath: string,
    remotePath: string,
    size: number,
    context: TransferContext,
  ): Promise<boolean> {
    const onChunk = (bytes: number) => {
      context.bytesTransferred += bytes;
      this.reportTransfer(context, 'transferring', remotePath);
    };
    const onPhase = (phase: FileTransferPhase) => this.reportTransfer(context, phase, remotePath);
    if (this.shouldMinifyStartupScripts() && isStartupScriptPath(remotePath)) {
      const data = fs.readFileSync(localPath);
      return this.writeFile(remotePath, data, { logSuccess: false, onChunk, onPhase });
    }

    const success = await this.runFileOperation(
      () => this.writeLocalFileInChunks(localPath, remotePath, size, onChunk, onPhase),
    );
    this.invalidateCache(remotePath);
    return success;
  }

  private async runFileOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.fileOperationTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.fileOperationTail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async download(remotePath: string, localPath: string, report?: FileTransferProgressCallback): Promise<void> {
    const startedAt = Date.now();
    report?.({
      phase: 'scanning',
      path: remotePath,
      bytesTransferred: 0,
      totalBytes: 0,
      filesTransferred: 0,
      totalFiles: 0,
    });
    const plan = await this.buildDownloadPlan(remotePath, localPath);
    const context: TransferContext = {
      bytes: plan.bytes,
      files: plan.fileEntries.length,
      bytesTransferred: 0,
      filesTransferred: 0,
      report,
    };
    this.reportTransfer(context, 'transferring', remotePath);

    if (plan.directories.length > 0) {
      logInfo('Files', `Download folder started: ${remotePath} -> ${localPath}`);
      for (const directory of plan.directories) {
        if (fs.existsSync(directory) && !fs.statSync(directory).isDirectory()) {
          logWarn('Files', `Download failed: local path is not a folder: ${directory}`);
          throw new Error(t('Local path exists and is not a folder: {path}', { path: directory }));
        }
        fs.mkdirSync(directory, { recursive: true });
      }
      for (const file of plan.fileEntries) {
        await this.downloadPlannedFile(file, context);
      }
      const stats: TransferStats = {
        files: context.filesTransferred,
        folders: plan.directories.length,
        bytes: context.bytesTransferred,
      };
      logInfo('Files', `Download folder finished: ${remotePath} -> ${localPath} (${describeTransfer(stats)}, ${Date.now() - startedAt}ms)`);
      return;
    }

    await this.downloadPlannedFile(plan.fileEntries[0], context);
    logInfo('Files', `Download file finished: ${remotePath} -> ${localPath} (${formatFileSize(context.bytesTransferred)}, ${Date.now() - startedAt}ms)`);
  }

  private async addDownloadDirectory(remoteDir: string, localDir: string, plan: DownloadPlan): Promise<void> {
    plan.directories.push(localDir);
    const entries = await this.listDir(remoteDir);
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const remoteChild = joinRemotePath(remoteDir, entry.name);
      const localChild = path.join(localDir, entry.name);
      if (entry.type === 'directory') {
        await this.addDownloadDirectory(remoteChild, localChild, plan);
      } else {
        plan.fileEntries.push({ remotePath: remoteChild, localPath: localChild, size: entry.size });
        plan.bytes += entry.size;
      }
    }
  }

  private async buildDownloadPlan(remotePath: string, localPath: string): Promise<DownloadPlan> {
    const plan: DownloadPlan = { directories: [], fileEntries: [], bytes: 0 };
    const stat = await this.statFile(remotePath);
    if (!stat.exists) {
      logWarn('Files', `Download failed: ${remotePath}: remote path not found`);
      throw new Error(t('Remote path not found: {path}', { path: remotePath }));
    }
    if (stat.type === 'directory') {
      await this.addDownloadDirectory(remotePath, localPath, plan);
    } else {
      plan.fileEntries.push({ remotePath, localPath, size: stat.size });
      plan.bytes = stat.size;
    }
    return plan;
  }

  private async downloadPlannedFile(file: DownloadFilePlan, context: TransferContext): Promise<void> {
    let localPath = file.localPath;
    if (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory()) {
      localPath = path.join(localPath, path.basename(file.remotePath));
    }
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const data = await this.readFile(file.remotePath, {
      logSuccess: false,
      onChunk: (bytes) => {
        context.bytesTransferred += bytes;
        this.reportTransfer(context, 'transferring', file.remotePath);
      },
    });
    fs.writeFileSync(localPath, data);
    context.filesTransferred++;
    this.reportTransfer(context, 'transferring', file.remotePath);
  }

  private reportTransfer(context: TransferContext, phase: FileTransferPhase, path: string): void {
    context.report?.({
      phase,
      path,
      bytesTransferred: context.bytesTransferred,
      totalBytes: context.bytes,
      filesTransferred: context.filesTransferred,
      totalFiles: context.files,
    });
  }

  private async updateCachedWrite(path: string, data: Uint8Array): Promise<void> {
    const cacheKey = normalizeRemotePath(path);
    try {
      // writeFile holds the write queue until its cache update completes.
      const stat = await this.requestFileStat(cacheKey);
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
