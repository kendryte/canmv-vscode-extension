import * as vscode from 'vscode';
import { ToolRegistry } from './ToolHost';

export class ToolboxTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private registry: ToolRegistry) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getChildren(): vscode.TreeItem[] {
    return this.registry.listVisible().map(tool => {
      const item = new vscode.TreeItem(tool.name, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(tool.icon);
      item.command = { command: 'canmv.openTool', title: tool.name, arguments: [tool.id] };
      return item;
    });
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }
}
