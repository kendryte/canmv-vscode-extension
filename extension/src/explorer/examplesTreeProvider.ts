import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ExamplesService } from '../service/examplesService';
import { t } from '../i18n';

export class ExampleTreeItem extends vscode.TreeItem {
  static message(label: string): ExampleTreeItem {
    return new ExampleTreeItem(label, '', false);
  }

  constructor(
    public readonly labelText: string,
    public readonly fsPath: string,
    public readonly isDirectory: boolean,
  ) {
    super(
      labelText,
      isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    this.tooltip = fsPath || labelText;
    this.iconPath = new vscode.ThemeIcon(!fsPath ? 'info' : isDirectory ? 'folder' : this.iconForFile(labelText));
    this.contextValue = !fsPath
      ? 'message'
      : isDirectory
        ? 'localExampleDirectory'
        : this.isPythonFile(labelText) ? 'localExamplePythonFile'
        : this.isTextFile(labelText) ? 'localExampleTextFile' : 'localExampleFile';

    if (fsPath && !isDirectory && this.isTextFile(labelText)) {
      this.command = {
        command: 'canmv.openExampleFile',
        title: t('Open Example File'),
        arguments: [this],
      };
    }
  }

  private iconForFile(name: string): string {
    return name.endsWith('.py') ? 'symbol-method' : 'file';
  }

  private isPythonFile(name: string): boolean {
    return /\.py$/i.test(name);
  }

  private isTextFile(name: string): boolean {
    return /\.(py|txt|md|json|ya?ml|csv|ini|toml|cfg|conf|sh|c|h|cpp|hpp)$/i.test(name);
  }
}

export class ExamplesTreeProvider implements vscode.TreeDataProvider<ExampleTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ExampleTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly examplesService: ExamplesService) {
    this.examplesService.onDidChangeExamples(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ExampleTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ExampleTreeItem): ExampleTreeItem[] {
    const root = element?.fsPath || this.examplesService.activeExamplesDir();
    if (!root) {
      return [ExampleTreeItem.message(t('No examples downloaded yet'))];
    }
    if (!fs.existsSync(root)) {
      return [ExampleTreeItem.message(t('Examples cache not found'))];
    }

    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => !entry.name.startsWith('.'))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map(entry => {
          const fsPath = path.join(root, entry.name);
          return new ExampleTreeItem(entry.name, fsPath, entry.isDirectory());
        });
    } catch (err) {
      return [ExampleTreeItem.message(t('Failed to read examples'))];
    }
  }
}
