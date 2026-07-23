import * as vscode from 'vscode';
import { FileTreeItem } from './fileItem';
import { t } from '../i18n';

export interface FileServiceCallbacks {
  listDir(path: string): Promise<{ name: string; type: 'file' | 'directory'; size: number }[]>;
  listDirPage?(path: string, offset: number): Promise<DirectoryPage>;
}

type RemoteEntry = Awaited<ReturnType<FileServiceCallbacks['listDir']>>[number];

interface DirectoryPage {
  entries: RemoteEntry[];
  nextOffset?: number;
}

interface DirectoryListing {
  entries: RemoteEntry[];
  nextOffset?: number;
  complete: boolean;
  generation: number;
  pageLoad?: Promise<void>;
  error?: unknown;
}

interface DirectoryListOperation {
  path: string;
  listing: DirectoryListing;
  element?: FileTreeItem;
  backgroundLoad?: Promise<void>;
}

const entryNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export class CanmvExplorer implements vscode.TreeDataProvider<FileTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FileTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private connected = false;
  private fileExplorerSupported = true;
  private unavailableMessage = t('Not connected');
  private listingGeneration = 0;
  private readonly listings = new Map<string, DirectoryListing>();
  private readonly cancelledListingPaths = new Set<string>();
  private activeListing?: DirectoryListOperation;

  constructor(private fileOps: FileServiceCallbacks) {}

  setConnected(connected: boolean): void {
    this.setConnectionState(connected, true);
  }

  setConnectionState(connected: boolean, fileExplorerSupported: boolean, unavailableMessage = t('Not connected')): void {
    const shouldRefresh = this.connected !== connected
      || this.fileExplorerSupported !== fileExplorerSupported
      || (!connected && this.unavailableMessage !== unavailableMessage);
    this.connected = connected;
    this.fileExplorerSupported = fileExplorerSupported;
    this.unavailableMessage = unavailableMessage;
    if (shouldRefresh) {
      this.refresh();
    }
  }

  refresh(): void {
    this.listingGeneration++;
    this.listings.clear();
    this.cancelledListingPaths.clear();
    this.activeListing = undefined;
    this._onDidChangeTreeData.fire();
  }

  async getChildren(element?: FileTreeItem): Promise<FileTreeItem[]> {
    if (!this.fileExplorerSupported) {
      return [FileTreeItem.message(t('File explorer is not supported by this firmware'))];
    }
    if (!this.connected) {
      return [FileTreeItem.message(this.unavailableMessage)];
    }

    if (!element) {
      return this.getDirectoryChildren('/', undefined, t('Error loading /'));
    }

    if (element.fileType === 'directory') {
      return this.getDirectoryChildren(element.absPath, element, t('Error loading folder'));
    }

    return [];
  }

  getTreeItem(element: FileTreeItem): vscode.TreeItem {
    element.setLoading(this.isDirectoryListingInProgress(element.absPath));
    return element;
  }

  resumeListing(element: FileTreeItem): void {
    if (element.fileType !== 'directory' || !this.cancelledListingPaths.delete(element.absPath)) {
      return;
    }
    this._onDidChangeTreeData.fire(element);
  }

  private async getDirectoryChildren(
    path: string,
    element: FileTreeItem | undefined,
    errorMessage: string,
  ): Promise<FileTreeItem[]> {
    if (element && this.cancelledListingPaths.has(path)) {
      return [];
    }
    const listing = this.getListing(path);
    const operation = this.selectListing(path, listing, element);
    if (listing.entries.length === 0 && !listing.complete) {
      try {
        await this.loadNextPage(path, listing);
      } catch {
        if (operation && !this.isActiveListing(operation)) {
          return this.toTreeItems(path, listing.entries);
        }
        return [FileTreeItem.message(errorMessage)];
      }
    }

    if (operation && !listing.complete && this.isActiveListing(operation)) {
      void this.loadRemainingPages(operation, element);
    }

    const children = this.toTreeItems(path, listing.entries);
    if (listing.error && (!operation || this.isActiveListing(operation))) {
      children.push(FileTreeItem.message(errorMessage));
    }
    return children;
  }

  private getListing(path: string): DirectoryListing {
    let listing = this.listings.get(path);
    if (!listing) {
      listing = {
        entries: [],
        nextOffset: 0,
        complete: false,
        generation: this.listingGeneration,
      };
      this.listings.set(path, listing);
    }
    return listing;
  }

  private selectListing(
    path: string,
    listing: DirectoryListing,
    element: FileTreeItem | undefined,
  ): DirectoryListOperation | undefined {
    if (this.activeListing && (this.activeListing.path !== path || this.activeListing.listing !== listing)) {
      this.cancelListing(this.activeListing);
    }
    if (listing.complete) {
      return undefined;
    }
    if (this.activeListing) {
      this.activeListing.element = element;
      return this.activeListing;
    }

    // Firmware has one persistent directory cursor. A newer folder selection
    // owns it, so old background page requests stop after their current page.
    const operation = { path, listing, element };
    this.activeListing = operation;
    return operation;
  }

  private cancelListing(operation: DirectoryListOperation): void {
    if (this.activeListing === operation) {
      this.activeListing = undefined;
    }
    operation.element?.setLoading(false);
    if (operation.listing.complete || this.listings.get(operation.path) !== operation.listing) {
      return;
    }

    // A directory may change while another folder is being browsed. Do not
    // reuse a partial page or its continuation offset on a later visit.
    operation.listing.entries.length = 0;
    operation.listing.nextOffset = undefined;
    operation.listing.error = undefined;
    this.listings.delete(operation.path);
    this.cancelledListingPaths.add(operation.path);
    if (operation.element) {
      this._onDidChangeTreeData.fire(operation.element);
    }
  }

  private async loadNextPage(path: string, listing: DirectoryListing): Promise<void> {
    if (listing.complete || listing.nextOffset === undefined) {
      listing.complete = true;
      return;
    }
    if (listing.pageLoad) {
      return listing.pageLoad;
    }

    const offset = listing.nextOffset;
    const load = (async () => {
      const page = await this.readPage(path, offset);
      if (!this.isCurrentListing(path, listing)) {
        return;
      }
      listing.entries.push(...page.entries);
      if (page.nextOffset === undefined) {
        listing.complete = true;
        listing.nextOffset = undefined;
        return;
      }
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset || page.nextOffset > 0xffff_ffff) {
        throw new Error(`Invalid directory listing continuation for ${path}`);
      }
      listing.nextOffset = page.nextOffset;
    })();
    listing.pageLoad = load;
    try {
      await load;
    } catch (error) {
      if (this.isCurrentListing(path, listing)) {
        listing.complete = true;
        listing.error = error;
      }
      throw error;
    } finally {
      if (listing.pageLoad === load) {
        listing.pageLoad = undefined;
      }
    }
  }

  private async loadRemainingPages(operation: DirectoryListOperation, element: FileTreeItem | undefined): Promise<void> {
    if (operation.backgroundLoad || operation.listing.complete || !this.isActiveListing(operation)) {
      return;
    }
    const load = this.loadRemainingPagesForOperation(operation, element);
    operation.backgroundLoad = load;
    this._onDidChangeTreeData.fire(element);
    try {
      await load;
    } finally {
      if (operation.backgroundLoad === load) {
        operation.backgroundLoad = undefined;
      }
    }
  }

  private async loadRemainingPagesForOperation(
    operation: DirectoryListOperation,
    element: FileTreeItem | undefined,
  ): Promise<void> {
    try {
      while (this.isActiveListing(operation) && !operation.listing.complete) {
        await this.loadNextPage(operation.path, operation.listing);
        if (this.isActiveListing(operation)) {
          this._onDidChangeTreeData.fire(element);
        }
      }
    } catch {
      if (this.isActiveListing(operation)) {
        this._onDidChangeTreeData.fire(element);
      }
    }
  }

  private async readPage(path: string, offset: number): Promise<DirectoryPage> {
    if (this.fileOps.listDirPage) {
      return this.fileOps.listDirPage(path, offset);
    }
    return { entries: await this.fileOps.listDir(path) };
  }

  private isCurrentListing(path: string, listing: DirectoryListing): boolean {
    return listing.generation === this.listingGeneration && this.listings.get(path) === listing;
  }

  private isActiveListing(operation: DirectoryListOperation): boolean {
    return this.activeListing === operation && this.isCurrentListing(operation.path, operation.listing);
  }

  private isDirectoryListingInProgress(path: string): boolean {
    const operation = this.activeListing;
    return !!operation
      && operation.path === path
      && !operation.listing.complete
      && this.isActiveListing(operation);
  }

  private toTreeItems(path: string, entries: RemoteEntry[]): FileTreeItem[] {
    return sortEntries(entries).map(e => new FileTreeItem(
      e.name,
      e.type,
      path === '/' ? '/' + e.name : path + '/' + e.name,
      e.size,
    ));
  }
}

function sortEntries(entries: RemoteEntry[]): RemoteEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return entryNameCollator.compare(a.name, b.name);
  });
}
