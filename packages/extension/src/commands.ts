import * as vscode from 'vscode';
import * as path from 'node:path';
import type { AffectedNode, GraphNode, GraphResult } from '@cil/protocol';
import type { CilClient } from './client.js';
import { GraphPanel, openNodeInEditor } from './webview/panel.js';
import type { SymbolTreeProvider } from './tree.js';

const findSymbolAtCursor = async (
  client: CilClient,
  workspaceRoot: string,
): Promise<GraphNode | undefined> => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('CIL: no active editor');
    return undefined;
  }
  const relPath = path
    .relative(workspaceRoot, editor.document.uri.fsPath)
    .split(path.sep)
    .join('/');
  if (!relPath || relPath.startsWith('..')) return undefined;

  const cursor = editor.selection.active;
  const symbols = await client.listSymbols({ filePath: relPath, limit: 500 });
  // Tightest enclosing symbol — innermost wins.
  let best: GraphNode | undefined;
  let bestSpan = Infinity;
  for (const s of symbols) {
    if (s.kind === 'file') continue;
    if (cursor.line < s.startLine || cursor.line > s.endLine) continue;
    const span = s.endLine - s.startLine;
    if (span < bestSpan) {
      best = s;
      bestSpan = span;
    }
  }
  if (!best) {
    void vscode.window.showInformationMessage(
      'CIL: no indexed symbol at cursor',
    );
  }
  return best;
};

const showNeighborhood = async (
  context: vscode.ExtensionContext,
  client: CilClient,
  workspaceRoot: string,
  result: GraphResult,
  title: string,
): Promise<void> => {
  if (!result.root && result.nodes.length === 0) {
    void vscode.window.showInformationMessage(`CIL: nothing to show — ${title}`);
    return;
  }
  GraphPanel.show(context, client, workspaceRoot, title, result);
};

export const registerCommands = (
  context: vscode.ExtensionContext,
  client: CilClient,
  workspaceRoot: string,
  tree: SymbolTreeProvider,
): vscode.Disposable[] => [
  vscode.commands.registerCommand('cil.refreshIndex', async () => {
    tree.refresh();
    const status = await client.fetchStatus();
    void vscode.window.showInformationMessage(
      `CIL: ${status.symbolsTotal} symbols · ${status.edgesTotal} edges · ${status.embeddingsTotal} embeddings (${status.state})`,
    );
  }),

  vscode.commands.registerCommand('cil.openNode', async (nodeId: string) => {
    if (!nodeId) return;
    await openNodeInEditor(client, workspaceRoot, nodeId);
  }),

  vscode.commands.registerCommand(
    'cil.findCallersAtCursor',
    async (idArg?: string) => {
      const id = idArg ?? (await findSymbolAtCursor(client, workspaceRoot))?.id;
      if (!id) return;
      const result = await client.findCallers(id);
      await showNeighborhood(
        context,
        client,
        workspaceRoot,
        result,
        `Callers of ${result.root?.name ?? id}`,
      );
    },
  ),

  vscode.commands.registerCommand(
    'cil.findCalleesAtCursor',
    async (idArg?: string) => {
      const id = idArg ?? (await findSymbolAtCursor(client, workspaceRoot))?.id;
      if (!id) return;
      const result = await client.findCallees(id);
      await showNeighborhood(
        context,
        client,
        workspaceRoot,
        result,
        `Callees of ${result.root?.name ?? id}`,
      );
    },
  ),

  vscode.commands.registerCommand('cil.showGraph', async () => {
    const sym = await findSymbolAtCursor(client, workspaceRoot);
    const id = sym?.id;
    if (!id) {
      // Default to file-level neighborhood if cursor isn't on a symbol.
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const relPath = path
        .relative(workspaceRoot, editor.document.uri.fsPath)
        .split(path.sep)
        .join('/');
      const fileId = `file:${relPath}`;
      const result = await client.getNeighbors({
        id: fileId,
        depth: 1,
        direction: 'out',
      });
      await showNeighborhood(
        context,
        client,
        workspaceRoot,
        result,
        `File: ${relPath}`,
      );
      return;
    }
    const result = await client.getNeighbors({
      id,
      depth: 1,
      direction: 'both',
    });
    await showNeighborhood(
      context,
      client,
      workspaceRoot,
      result,
      `Neighborhood: ${sym!.name}`,
    );
  }),

  vscode.commands.registerCommand('cil.impactAtCursor', async () => {
    const sym = await findSymbolAtCursor(client, workspaceRoot);
    if (!sym) return;
    const result = await client.analyzeImpact({ ids: [sym.id], maxDepth: 5 });
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`### Impact: \`${sym.kind} ${sym.name}\`\n\n`);
    md.appendMarkdown(
      `**${result.affected.length}** node(s) affected (depth ≤ ${result.maxDepth})  ·  churn data: ${result.churnAvailable ? 'available' : 'unavailable'}\n\n`,
    );
    md.appendMarkdown(`| Risk | Distance | Callers | Cross-file | Churn (30d) | Symbol |\n`);
    md.appendMarkdown(`|------|----------|---------|------------|-------------|--------|\n`);
    for (const a of result.affected.slice(0, 30) as AffectedNode[]) {
      const args = encodeURIComponent(JSON.stringify([a.node.id]));
      md.appendMarkdown(
        `| ${a.riskScore.toFixed(2)} | ${a.distance} | ${a.directCallers} | ${a.crossFileCallers} | ${a.fileChurn} | [\`${a.node.kind}:${a.node.name}\`](command:cil.openNode?${args}) (${a.node.filePath}:${a.node.startLine + 1}) |\n`,
      );
    }
    const doc = await vscode.workspace.openTextDocument({
      content: md.value,
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { preview: true });

    // Also open the impact subgraph in the graph panel for visual scan.
    const ids = new Set<string>([sym.id, ...result.affected.map((a) => a.node.id)]);
    GraphPanel.show(context, client, workspaceRoot, `Impact: ${sym.name}`, {
      root: sym,
      nodes: (result.affected as AffectedNode[])
        .map((a) => a.node)
        .filter((n) => ids.has(n.id) && n.id !== sym.id),
      edges: result.edges,
    });
  }),

  vscode.commands.registerCommand('cil.traceFlowAtCursor', async () => {
    const sym = await findSymbolAtCursor(client, workspaceRoot);
    if (!sym) return;
    const direction = await vscode.window.showQuickPick(
      [
        { label: 'callees', description: 'Where does execution go from here?' },
        { label: 'callers', description: 'Where can execution arrive from?' },
      ],
      { placeHolder: 'Trace direction' },
    );
    if (!direction) return;
    const result = await client.traceFlow({
      id: sym.id,
      direction: direction.label as 'callees' | 'callers',
      maxDepth: 6,
    });
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(
      `### Flow ${direction.label} from \`${sym.kind} ${sym.name}\`\n\n`,
    );
    if (result.truncated) {
      md.appendMarkdown(`⚠️ truncated at cap\n\n`);
    }
    md.appendMarkdown(`**${result.steps.length}** step(s)\n\n`);
    for (const s of result.steps) {
      const indent = '  '.repeat(s.depth);
      const args = encodeURIComponent(JSON.stringify([s.node.id]));
      md.appendMarkdown(
        `${indent}- [\`${s.node.kind}:${s.node.name}\`](command:cil.openNode?${args}) (${s.node.filePath}:${s.node.startLine + 1})\n`,
      );
    }
    const doc = await vscode.workspace.openTextDocument({
      content: md.value,
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }),

  vscode.commands.registerCommand('cil.explain', async () => {
    const query = await vscode.window.showInputBox({
      prompt: 'Ask a question about this codebase',
      placeHolder: 'e.g. how does the indexer process file changes?',
    });
    if (!query) return;
    try {
      const r = await client.explain({ query, k: 8 });
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = true;
      md.appendMarkdown(`### ${query}\n\n`);
      md.appendMarkdown(`${r.answer}\n\n---\n**Evidence:**\n\n`);
      for (const e of r.evidence) {
        const args = encodeURIComponent(JSON.stringify([e.id]));
        md.appendMarkdown(
          `- [${e.index}] [\`${e.node.kind}:${e.node.name}\`](command:cil.openNode?${args}) (${e.node.filePath}:${e.node.startLine + 1})\n`,
        );
      }
      if (r.invalidCitations.length > 0) {
        md.appendMarkdown(
          `\n⚠️ **Invalid citations:** ${r.invalidCitations.join(', ')} (model referenced evidence that wasn't provided)\n`,
        );
      }
      // Show in a new untitled markdown doc for richer rendering than a hover.
      const doc = await vscode.workspace.openTextDocument({
        content: md.value,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      void vscode.window.showErrorMessage(
        `CIL explain failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }),
];
