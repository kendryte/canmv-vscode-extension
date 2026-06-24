import * as vscode from 'vscode';
import { t } from '../i18n';

export type FileType = 'file' | 'directory' | 'message';

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

export class FileTreeItem extends vscode.TreeItem {
  static message(name: string): FileTreeItem {
    return new FileTreeItem(name, 'message', '', 0);
  }

  constructor(
    public readonly name: string,
    public readonly fileType: FileType,
    public readonly absPath: string,
    public readonly size: number = 0,
  ) {
    super(
      name,
      fileType === 'directory'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    this.iconPath = new vscode.ThemeIcon(
      fileType === 'directory' ? 'folder' : fileType === 'message' ? 'warning' : 'file'
    );
    if (fileType === 'file') {
      this.description = formatFileSize(size);
      this.tooltip = `${absPath}\n${t('{size} {unit}', { size, unit: size === 1 ? t('byte') : t('bytes') })}`;
      this.contextValue = name.endsWith('.py') ? 'pythonFile' : 'file';
      this.command = {
        command: 'canmv.openRemoteFile',
        title: t('Open Remote File'),
        arguments: [this],
      };
    } else {
      this.tooltip = absPath;
      this.contextValue = fileType === 'message'
        ? 'message'
        : isMountRoot(absPath) ? 'mountRoot' : 'directory';
    }
  }
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';

  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  if (unitIndex === 0) return `${size} B`;
  const digits = value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${SIZE_UNITS[unitIndex]}`;
}

function isMountRoot(path: string): boolean {
  return path === '/sdcard' || path === '/data' || path === '/udisk';
}
