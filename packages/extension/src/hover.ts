import * as vscode from 'vscode';
import * as path from 'node:path';
import type { GraphNode } from '@cil/protocol';
import type { CilClient } from './client.js';

/**
 * Symbol-aware hover. For declarations, augments the native hover with:
 *   - kind + signature
 *   - caller / callee / reference counts
 *
 * No LLM call — fast, runs every hover. Summary-on-hover lives behind the
 * LLM provider config and is added in a later phase.
 */
export class CilHoverProvider implements vscode.HoverProvider {
  constructor(
    private client: CilClient,
    private workspaceRoot: string,
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return undefined;
    const word = document.getText(wordRange);

    const relPath = path
      .relative(this.workspaceRoot, document.uri.fsPath)
      .split(path.sep)
      .join('/');
    if (!relPath || relPath.startsWith('..')) return undefined;

    const symbols = await this.client.listSymbols({
      filePath: relPath,
      limit: 500,
    });
    if (token.isCancellationRequested) return undefined;

    // Match a declaration whose name equals the hovered word AND whose
    // line range covers the cursor. This avoids spurious hovers when a
    // symbol is referenced (not declared) at the cursor.
    const sym: GraphNode | undefined = symbols.find(
      (s) =>
        s.name === word &&
        position.line >= s.startLine &&
        position.line <= s.endLine,
    );
    if (!sym) return undefined;

    const [callers, callees] = await Promise.all([
      this.client.findCallers(sym.id),
      this.client.findCallees(sym.id),
    ]);
    if (token.isCancellationRequested) return undefined;

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`**CIL** \`${sym.kind}\` **${sym.name}**\n\n`);
    if (sym.signature) {
      md.appendCodeblock(sym.signature, document.languageId);
    }
    md.appendMarkdown(
      `\n— ${callers.edges.length} caller${callers.edges.length === 1 ? '' : 's'} · ${callees.edges.length} callee${callees.edges.length === 1 ? '' : 's'}\n`,
    );
    return new vscode.Hover(md, wordRange);
  }
}
