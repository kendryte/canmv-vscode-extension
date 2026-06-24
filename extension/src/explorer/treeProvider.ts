import * as vscode from 'vscode';
import { FileTreeItem } from './fileItem';
import { t } from '../i18n';

export interface FileServiceCallbacks {
  listDir(path: string): Promise<{ name: string; type: 'file' | 'directory'; size: number }[]>;
}

type RemoteEntry = Awaited<ReturnType<FileServiceCallbacks['listDir']>>[number];

const entryNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export class CanmvExplorer implements vscode.TreeDataProvider<FileTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FileTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private connected = false;
  private fileExplorerSupported = true;

  constructor(private fileOps: FileServiceCallbacks) {}

  setConnected(connected: boolean): void {
    this.setConnectionState(connected, true);
  }

  setConnectionState(connected: boolean, fileExplorerSupported: boolean): void {
    this.connected = connected;
    this.fileExplorerSupported = fileExplorerSupported;
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async getChildren(element?: FileTreeItem): Promise<FileTreeItem[]> {
    if (!this.connected) {
      return [FileTreeItem.message(t('Not connected'))];
    }
    if (!this.fileExplorerSupported) {
      return [FileTreeItem.message(t('File explorer is not supported by this firmware'))];
    }

    if (!element) {
      try {
        const entries = sortEntries(await this.fileOps.listDir('/'));
        return entries.map(e => new FileTreeItem(e.name, e.type, e.name === '/' ? '/' : '/' + e.name, e.size));
      } catch {
        return [FileTreeItem.message(t('Error loading /'))];
      }
    }

    if (element.fileType === 'directory') {
      try {
        const entries = sortEntries(await this.fileOps.listDir(element.absPath));
        return entries.map(e =>
          new FileTreeItem(
            e.name,
            e.type,
            element.absPath === '/' ? '/' + e.name : element.absPath + '/' + e.name,
            e.size,
          )
        );
      } catch {
        return [FileTreeItem.message(t('Error loading folder'))];
      }
    }

    return [];
  }

  getTreeItem(element: FileTreeItem): vscode.TreeItem {
    return element;
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
