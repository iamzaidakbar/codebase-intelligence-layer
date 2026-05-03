import * as vscode from 'vscode';
import * as path from 'node:path';
import type { GraphNode } from '@cil/protocol';
import type { CilClient } from './client.js';

const LENS_KINDS = new Set(['function', 'method', 'class', 'interface']);

/**
 * Shows "N callers · M callees" above each declaration. The query is per-symbol
 * (one round-trip per visible declaration); cached per (file, contentHash) so
 * scrolling around doesn't re-query. Cache invalidates when the daemon
 * notifies of status changes.
 */
export class CilCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private cache = new Map<string, vscode.CodeLens[]>();

  constructor(
    private client: CilClient,
    private workspaceRoot: string,
  ) {
    client.on('status', () => {
      this.cache.clear();
      this._onDidChangeCodeLenses.fire();
    });
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    const enabled = vscode.workspace
      .getConfiguration('cil')
      .get<boolean>('codeLens.enabled', true);
    if (!enabled) return [];

    const relPath = path
      .relative(this.workspaceRoot, document.uri.fsPath)
      .split(path.sep)
      .join('/');
    if (!relPath || relPath.startsWith('..')) return [];

    const cacheKey = `${relPath}@${document.version}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const symbols = await this.client.listSymbols({
      filePath: relPath,
      limit: 500,
    });
    if (token.isCancellationRequested) return [];

    const targets = symbols.filter((s) => LENS_KINDS.has(s.kind));
    const lenses = await Promise.all(
      targets.map((sym) => this.lensForSymbol(document, sym)),
    );
    if (token.isCancellationRequested) return [];

    const flat = lenses.flat();
    this.cache.set(cacheKey, flat);
    return flat;
  }

  private async lensForSymbol(
    document: vscode.TextDocument,
    sym: GraphNode,
  ): Promise<vscode.CodeLens[]> {
    const line = Math.min(sym.startLine, document.lineCount - 1);
    const range = new vscode.Range(line, 0, line, 0);
    const [callers, callees] = await Promise.all([
      this.client.findCallers(sym.id),
      this.client.findCallees(sym.id),
    ]);
    return [
      new vscode.CodeLens(range, {
        title: `${callers.edges.length} caller${callers.edges.length === 1 ? '' : 's'}`,
        command: 'cil.findCallersAtCursor',
        arguments: [sym.id],
      }),
      new vscode.CodeLens(range, {
        title: `${callees.edges.length} callee${callees.edges.length === 1 ? '' : 's'}`,
        command: 'cil.findCalleesAtCursor',
        arguments: [sym.id],
      }),
    ];
  }
}
