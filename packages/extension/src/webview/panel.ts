import * as vscode from 'vscode';
import * as path from 'node:path';
import type { GraphResult } from '@cil/protocol';
import type { CilClient } from '../client.js';
import type { HostToWebview, WebviewToHost } from './messages.js';

/** Manages a single graph webview panel. Subsequent calls to `show()` reuse
 *  the existing panel and re-render. */
export class GraphPanel {
  private static current?: GraphPanel;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private ready = false;
  private pendingRender?: HostToWebview;

  static show(
    context: vscode.ExtensionContext,
    client: CilClient,
    workspaceRoot: string,
    title: string,
    payload: GraphResult,
  ): void {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      GraphPanel.current.send({ type: 'render', title, payload });
      GraphPanel.current.panel.title = title;
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'cilGraph',
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'dist')),
        ],
      },
    );
    GraphPanel.current = new GraphPanel(
      panel,
      context,
      client,
      workspaceRoot,
      title,
      payload,
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private client: CilClient,
    private workspaceRoot: string,
    title: string,
    payload: GraphResult,
  ) {
    this.panel = panel;
    panel.webview.html = this.renderHtml(context);

    panel.webview.onDidReceiveMessage(
      (msg: WebviewToHost) => this.handle(msg),
      null,
      this.disposables,
    );
    panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.pendingRender = { type: 'render', title, payload };
  }

  private send(msg: HostToWebview): void {
    if (!this.ready) {
      this.pendingRender = msg;
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  private async handle(msg: WebviewToHost): Promise<void> {
    if (msg.type === 'ready') {
      this.ready = true;
      this.send({
        type: 'theme',
        isDark:
          vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
          vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast,
      });
      if (this.pendingRender) {
        await this.panel.webview.postMessage(this.pendingRender);
      }
      return;
    }
    if (msg.type === 'open-node') {
      await openNodeInEditor(this.client, this.workspaceRoot, msg.nodeId);
      return;
    }
    if (msg.type === 'expand-node') {
      const result = await this.client.getNeighbors({
        id: msg.nodeId,
        depth: 1,
        direction: 'both',
      });
      this.send({
        type: 'render',
        title: `Neighborhood: ${result.root?.name ?? msg.nodeId}`,
        payload: result,
      });
    }
  }

  private renderHtml(context: vscode.ExtensionContext): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(context.extensionPath, 'dist', 'webview.js')),
    );
    const nonce = generateNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${this.panel.webview.cspSource}`,
      `img-src ${this.panel.webview.cspSource} data:`,
    ].join('; ');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
    #cy { width: 100vw; height: 100vh; }
    #title { position: absolute; top: 8px; left: 12px; font-size: 12px; opacity: 0.7; pointer-events: none; }
    #hint { position: absolute; bottom: 8px; right: 12px; font-size: 11px; opacity: 0.5; pointer-events: none; }
  </style>
</head>
<body>
  <div id="title"></div>
  <div id="cy"></div>
  <div id="hint">click: open · double-click: expand 1-hop</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    GraphPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}

const generateNonce = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

export const openNodeInEditor = async (
  client: CilClient,
  workspaceRoot: string,
  nodeId: string,
): Promise<void> => {
  const node = await client.getNode(nodeId);
  if (!node || node.kind === 'file') {
    if (node) {
      const uri = vscode.Uri.file(path.join(workspaceRoot, node.filePath));
      await vscode.window.showTextDocument(uri);
    }
    return;
  }
  const uri = vscode.Uri.file(path.join(workspaceRoot, node.filePath));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const line = Math.min(node.startLine, doc.lineCount - 1);
  const range = new vscode.Range(line, 0, line, 0);
  editor.selection = new vscode.Selection(range.start, range.start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
};
