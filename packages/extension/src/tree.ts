import * as vscode from 'vscode';
import type { GraphNode } from '@cil/protocol';
import type { CilClient } from './client.js';

type TreeItemNode =
  | { kind: 'file'; filePath: string }
  | { kind: 'symbol'; symbol: GraphNode };

const KIND_ICON: Record<string, string> = {
  class: 'symbol-class',
  interface: 'symbol-interface',
  function: 'symbol-function',
  method: 'symbol-method',
  type: 'symbol-type-parameter',
  variable: 'symbol-variable',
};

export class SymbolTreeProvider
  implements vscode.TreeDataProvider<TreeItemNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cached file -> symbols map. Built lazily per file expand. */
  private cache = new Map<string, GraphNode[]>();

  constructor(
    private client: CilClient,
    private workspaceRoot: string,
  ) {
    client.on('status', () => this.refresh());
  }

  refresh(): void {
    this.cache.clear();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeItemNode): vscode.TreeItem {
    if (element.kind === 'file') {
      const item = new vscode.TreeItem(
        element.filePath,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.iconPath = new vscode.ThemeIcon('symbol-file');
      item.resourceUri = vscode.Uri.joinPath(
        vscode.Uri.file(this.workspaceRoot),
        element.filePath,
      );
      item.contextValue = 'file';
      return item;
    }
    const sym = element.symbol;
    const item = new vscode.TreeItem(
      sym.name,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = sym.kind;
    item.tooltip = sym.signature ?? `${sym.kind} ${sym.name}`;
    item.iconPath = new vscode.ThemeIcon(KIND_ICON[sym.kind] ?? 'symbol-misc');
    item.command = {
      command: 'cil.openNode',
      title: 'Open',
      arguments: [sym.id],
    };
    item.contextValue = 'symbol';
    return item;
  }

  async getChildren(element?: TreeItemNode): Promise<TreeItemNode[]> {
    if (!element) {
      // Top level: distinct files that have symbols.
      const all = await this.client.listSymbols({ limit: 1000 });
      const files = [...new Set(all.map((n) => n.filePath))].sort();
      return files.map((f) => ({ kind: 'file', filePath: f }));
    }
    if (element.kind === 'file') {
      let symbols = this.cache.get(element.filePath);
      if (!symbols) {
        symbols = (
          await this.client.listSymbols({
            filePath: element.filePath,
            limit: 1000,
          })
        ).filter((n) => n.kind !== 'file');
        this.cache.set(element.filePath, symbols);
      }
      return symbols.map((s) => ({ kind: 'symbol', symbol: s }));
    }
    return [];
  }
}
