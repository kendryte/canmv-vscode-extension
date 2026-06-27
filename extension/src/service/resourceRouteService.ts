import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logInfo, logWarn } from '../output';

const CANMV_RESOURCE_BASE_URL = 'https://download.kendryte.com/developer/tools/canmv_vscode_extension';

export type FirmwareManifest = {
  firmware_commit?: string;
  stubs?: {
    url?: string;
    metadata?: string;
    sha256?: string;
  };
  examples?: {
    id?: string;
    url?: string;
    metadata?: string;
  };
};

export type CanmvResourceRoute = {
  requestedRevision: string;
  revision: string;
  exact: boolean;
  manifest: FirmwareManifest | null;
  stubsUrl: string;
  examplesId: string;
  examplesUrl: string;
};

export function normalizeFirmwareRevision(revision: string): string {
  const trimmed = (revision || '').trim();
  return /^[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : '';
}

export function normalizeExamplesId(examplesId: string): string {
  const trimmed = (examplesId || '').trim();
  return /^[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed.toLowerCase() : '';
}

export class CanmvResourceRouteService {
  private readonly assetsBaseUrl = CANMV_RESOURCE_BASE_URL;
  private readonly cacheRoot = path.join(os.homedir(), '.kendryte', 'k230_canmv_resources');
  private readonly manifestCache = new Map<string, FirmwareManifest>();
  private latestRevisionCache = '';

  async resolve(boardRevision: string): Promise<CanmvResourceRoute | null> {
    const requestedRevision = normalizeFirmwareRevision(boardRevision);
    if (requestedRevision) {
      const exactManifest = await this.fetchFirmwareManifest(requestedRevision);
      if (exactManifest) {
        return this.routeFromManifest(exactManifest, requestedRevision, true);
      }

      const latest = await this.fetchLatestRevision();
      if (latest) {
        logWarn('Resources', `Firmware manifest not found for ${requestedRevision}; using latest ${latest}`);
        const latestManifest = await this.fetchFirmwareManifest(latest);
        if (latestManifest) {
          return this.routeFromManifest(latestManifest, requestedRevision, false);
        }
        return this.directRoute(latest, requestedRevision, false);
      }

      return null;
    }

    const latest = await this.fetchLatestRevision();
    if (!latest) return null;
    const latestManifest = await this.fetchFirmwareManifest(latest);
    return latestManifest
      ? this.routeFromManifest(latestManifest, '', true)
      : this.directRoute(latest, '', true);
  }

  async resolveRevision(revision: string): Promise<CanmvResourceRoute | null> {
    const normalized = normalizeFirmwareRevision(revision);
    if (!normalized) return null;
    const manifest = await this.fetchFirmwareManifest(normalized);
    return manifest ? this.routeFromManifest(manifest, normalized, true) : this.directRoute(normalized, normalized, true);
  }

  async fetchBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const get = url.startsWith('https') ? https.get : http.get;
      const req = get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            this.fetchBuffer(redirectUrl).then(resolve).catch(reject);
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

  private async fetchLatestRevision(): Promise<string> {
    const latestUrl = `${this.assetsBaseUrl}/firmware/latest`;
    logInfo('Resources', `Fetching latest firmware revision: ${latestUrl}`);
    try {
      const data = await this.fetchBuffer(latestUrl);
      const text = data.toString('utf-8').trim();
      const exact = normalizeFirmwareRevision(text);
      if (exact) {
        logInfo('Resources', `Latest firmware revision found: ${exact}`);
        this.latestRevisionCache = exact;
        this.writeCachedLatestRevision(exact);
        return exact;
      }
      const match = text.match(/\b([0-9a-fA-F]{40})\b/);
      const extracted = match ? normalizeFirmwareRevision(match[1]) : '';
      if (extracted) {
        logInfo('Resources', `Extracted latest firmware revision: ${extracted}`);
        this.latestRevisionCache = extracted;
        this.writeCachedLatestRevision(extracted);
        return extracted;
      }
      logWarn('Resources', `Unexpected firmware/latest response: "${text.substring(0, 80)}"`);
      return '';
    } catch (err) {
      logWarn('Resources', `Failed to fetch firmware/latest: ${err}`);
      const cached = this.latestRevisionCache || this.readCachedLatestRevision();
      if (cached) {
        logInfo('Resources', `Using cached latest firmware revision: ${cached}`);
        return cached;
      }
      return '';
    }
  }

  private async fetchFirmwareManifest(revision: string): Promise<FirmwareManifest | null> {
    const normalized = normalizeFirmwareRevision(revision);
    if (!normalized) return null;

    const cached = this.manifestCache.get(normalized) || this.readCachedFirmwareManifest(normalized);
    if (cached) {
      logInfo('Resources', `Using cached firmware manifest: ${this.manifestUrl(normalized)}`);
      this.manifestCache.set(normalized, cached);
      return cached;
    }

    const manifestUrl = this.manifestUrl(normalized);
    logInfo('Resources', `Fetching firmware manifest: ${manifestUrl}`);
    try {
      const data = await this.fetchBuffer(manifestUrl);
      const manifest = JSON.parse(data.toString('utf-8')) as FirmwareManifest;
      const manifestRevision = normalizeFirmwareRevision(manifest.firmware_commit || normalized);
      if (!manifestRevision) {
        logWarn('Resources', `Firmware manifest has invalid revision: ${manifestUrl}`);
        return null;
      }
      manifest.firmware_commit = manifestRevision;
      this.manifestCache.set(manifestRevision, manifest);
      this.writeCachedFirmwareManifest(manifestRevision, manifest);
      return manifest;
    } catch (err) {
      logWarn('Resources', `Failed to fetch firmware manifest ${normalized}: ${err}`);
      return null;
    }
  }

  private routeFromManifest(manifest: FirmwareManifest, requestedRevision: string, exact: boolean): CanmvResourceRoute {
    const revision = normalizeFirmwareRevision(manifest.firmware_commit || requestedRevision);
    const examplesId = normalizeExamplesId(manifest.examples?.id || '');
    return {
      requestedRevision,
      revision,
      exact,
      manifest,
      stubsUrl: this.resolveManifestUrl(revision, manifest.stubs?.url) || this.stubsUrl(revision),
      examplesId,
      examplesUrl: examplesId ? this.resolveManifestUrl(revision, manifest.examples?.url) : '',
    };
  }

  private directRoute(revision: string, requestedRevision: string, exact: boolean): CanmvResourceRoute {
    return {
      requestedRevision,
      revision,
      exact,
      manifest: null,
      stubsUrl: this.stubsUrl(revision),
      examplesId: '',
      examplesUrl: '',
    };
  }

  private resolveManifestUrl(revision: string, maybeUrl?: string): string {
    if (!maybeUrl) return '';
    try {
      return new URL(maybeUrl, this.manifestUrl(revision)).toString();
    } catch {
      return '';
    }
  }

  private manifestUrl(revision: string): string {
    return `${this.assetsBaseUrl}/firmware/${revision}/manifest.json`;
  }

  private stubsUrl(revision: string): string {
    return `${this.assetsBaseUrl}/stubs/${revision}.zip`;
  }

  private cachedLatestPath(): string {
    return path.join(this.cacheRoot, 'firmware', 'latest');
  }

  private cachedManifestPath(revision: string): string {
    return path.join(this.cacheRoot, 'firmware', revision, 'manifest.json');
  }

  private readCachedLatestRevision(): string {
    try {
      const revision = normalizeFirmwareRevision(fs.readFileSync(this.cachedLatestPath(), 'utf-8').trim());
      if (revision) this.latestRevisionCache = revision;
      return revision;
    } catch {
      return '';
    }
  }

  private writeCachedLatestRevision(revision: string): void {
    const normalized = normalizeFirmwareRevision(revision);
    if (!normalized) return;
    try {
      const latestPath = this.cachedLatestPath();
      fs.mkdirSync(path.dirname(latestPath), { recursive: true });
      fs.writeFileSync(latestPath, `${normalized}\n`);
    } catch {
      // Best-effort cache only.
    }
  }

  private readCachedFirmwareManifest(revision: string): FirmwareManifest | null {
    const normalized = normalizeFirmwareRevision(revision);
    if (!normalized) return null;
    try {
      const manifest = JSON.parse(fs.readFileSync(this.cachedManifestPath(normalized), 'utf-8')) as FirmwareManifest;
      const manifestRevision = normalizeFirmwareRevision(manifest.firmware_commit || normalized);
      if (!manifestRevision) return null;
      manifest.firmware_commit = manifestRevision;
      return manifest;
    } catch {
      return null;
    }
  }

  private writeCachedFirmwareManifest(revision: string, manifest: FirmwareManifest): void {
    const normalized = normalizeFirmwareRevision(revision);
    if (!normalized) return;
    try {
      const manifestPath = this.cachedManifestPath(normalized);
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch {
      // Best-effort cache only.
    }
  }
}
