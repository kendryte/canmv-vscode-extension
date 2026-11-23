import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Cache-folder helpers shared by the extension and the standalone MCP server.
// Keep this module free of vscode and output-channel imports.

export const examplesArchiveFile = 'examples.zip';

// `<id>.tmp-XXXXXX`: never a valid cache name, so cache scans skip these folders.
const tempDirPattern = /^[0-9a-f]+\.tmp-[0-9A-Za-z]{6}$/;
// A temp folder only lives while an archive is written and extracted (extraction times out after 60 s).
const staleTempDirAgeMs = 60 * 60 * 1000;
const publishAttempts = 6;
const publishRetryDelayMs = 250;
const retryablePublishErrors = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST', 'ENOENT']);

export function normalizeFirmwareRevision(revision: string): string {
  const trimmed = (revision || '').trim();
  return /^[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : '';
}

export function normalizeExamplesId(examplesId: string): string {
  const trimmed = (examplesId || '').trim();
  return /^[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed.toLowerCase() : '';
}

/** Cache folders are always created with the normalized name; anything else is not a cache. */
export function isFirmwareRevisionDirName(name: string): boolean {
  return !!name && normalizeFirmwareRevision(name) === name;
}

export function isExamplesDirName(name: string): boolean {
  return !!name && normalizeExamplesId(name) === name;
}

export function createCacheTempDir(baseDir: string, cacheName: string): string {
  fs.mkdirSync(baseDir, { recursive: true });
  return fs.mkdtempSync(path.join(baseDir, `${cacheName}.tmp-`));
}

export async function removeDir(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** Removes temp folders left behind when VS Code closed or crashed during a download. */
export async function removeStaleCacheTempDirs(baseDir: string, maxAgeMs = staleTempDirAgeMs): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const now = Date.now();
  const removed = await Promise.all(entries
    .filter(entry => entry.isDirectory() && tempDirPattern.test(entry.name))
    .map(async entry => {
      const dir = path.join(baseDir, entry.name);
      try {
        if (now - (await fs.promises.stat(dir)).mtimeMs < maxAgeMs) return '';
        await removeDir(dir);
        return dir;
      } catch {
        return '';
      }
    }));
  return removed.filter(Boolean);
}

/**
 * Moves a fully extracted temp folder to `cacheDir`.
 *
 * Returns false, leaving `tempDir` for the caller to remove, when a usable cache is already there
 * (for example published by another VS Code window). An unusable folder at `cacheDir` is renamed
 * aside instead of deleted in place, so a racing window at worst swaps in an identical copy and
 * `cacheDir` is never half-deleted. Renames are retried because Windows briefly locks freshly
 * written files (antivirus, indexer).
 */
export async function publishCacheDir(
  tempDir: string,
  cacheDir: string,
  isUsable: (dir: string) => boolean,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    if (isUsable(cacheDir)) return false;
    let staleDir = '';
    try {
      if (fs.existsSync(cacheDir)) {
        staleDir = `${cacheDir}.tmp-${crypto.randomBytes(3).toString('hex')}`;
        fs.renameSync(cacheDir, staleDir);
      }
      fs.renameSync(tempDir, cacheDir);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code || '';
      if (attempt >= publishAttempts || !retryablePublishErrors.has(code)) {
        if (isUsable(cacheDir)) return false;
        throw err;
      }
    } finally {
      // Left-over stale folders match the temp pattern and are removed later.
      if (staleDir) await removeDir(staleDir).catch(() => undefined);
    }
    await new Promise(resolve => setTimeout(resolve, publishRetryDelayMs * attempt));
  }
}

export type ExamplesCache = {
  id: string;
  dir: string;
  mtimeMs: number;
  /** Extracted in place by an older version; may be incomplete. */
  legacy: boolean;
};

export function isUsableExamplesCache(cacheDir: string): boolean {
  return examplesCacheState(cacheDir) === 'complete';
}

/**
 * Lists example caches, complete ones first, newest first within each group.
 * Legacy caches still hold `examples.zip` because an older version extracted in place and either
 * failed or could not delete the archive. They may be partial, so they are only a fallback.
 */
export function listExamplesCaches(baseDir: string): ExamplesCache[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const caches: ExamplesCache[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isExamplesDirName(entry.name)) continue;
    const dir = path.join(baseDir, entry.name);
    const state = examplesCacheState(dir);
    if (state === 'none') continue;
    try {
      caches.push({ id: entry.name, dir, mtimeMs: fs.statSync(dir).mtimeMs, legacy: state === 'legacy' });
    } catch {
      // removed while scanning
    }
  }
  return caches.sort((a, b) => Number(a.legacy) - Number(b.legacy) || b.mtimeMs - a.mtimeMs);
}

export function examplesCacheState(cacheDir: string): 'complete' | 'legacy' | 'none' {
  if (!isExamplesDirName(path.basename(cacheDir)) || !hasExtractedExamples(cacheDir)) return 'none';
  return fs.existsSync(path.join(cacheDir, examplesArchiveFile)) ? 'legacy' : 'complete';
}

export function hasExtractedExamples(dir: string): boolean {
  return ['examples', 'models'].some(name => hasFile(path.join(dir, name), 0));
}

const maxExampleScanDepth = 32;

function hasFile(dir: string, depth: number): boolean {
  if (depth > maxExampleScanDepth) return false;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    return fs.readdirSync(dir, { withFileTypes: true }).some(entry => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const target = fs.statSync(entryPath);
          return target.isFile() || (target.isDirectory() && hasFile(entryPath, depth + 1));
        } catch {
          return false;
        }
      }
      return entry.isFile() || (entry.isDirectory() && hasFile(entryPath, depth + 1));
    });
  } catch {
    return false;
  }
}
