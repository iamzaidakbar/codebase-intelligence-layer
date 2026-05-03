import * as vscode from 'vscode';
import type { EmbeddingConfig, LlmConfig } from '@cil/protocol';
import { CilClient } from './client.js';
import { CilCodeLensProvider } from './codelens.js';
import { CilHoverProvider } from './hover.js';
import { registerCommands } from './commands.js';
import { SymbolTreeProvider } from './tree.js';

let client: CilClient | undefined;
let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;

const TS_LANGS: vscode.DocumentSelector = [
  { scheme: 'file', language: 'typescript' },
  { scheme: 'file', language: 'typescriptreact' },
  { scheme: 'file', language: 'javascript' },
  { scheme: 'file', language: 'javascriptreact' },
];

const readEmbeddingConfig = (): EmbeddingConfig => {
  const cfg = vscode.workspace.getConfiguration('cil.embedding');
  const provider = cfg.get<string>('provider', 'hash');
  if (provider === 'none') return { provider: 'none' };
  if (provider === 'hash') return { provider: 'hash' };
  return {
    provider: 'ollama',
    model: cfg.get<string>('model'),
    url: cfg.get<string>('url'),
  };
};

const readLlmConfig = (): LlmConfig => {
  const cfg = vscode.workspace.getConfiguration('cil.llm');
  const provider = cfg.get<string>('provider', 'none');
  if (provider === 'mock') return { provider: 'mock' };
  if (provider === 'anthropic') {
    return {
      provider: 'anthropic',
      model: cfg.get<string>('model'),
      apiKey: process.env.ANTHROPIC_API_KEY,
    };
  }
  return { provider: 'none' };
};

const renderStatus = (s: { state: string; filesIndexed: number; filesTotal: number; symbolsTotal: number }) => {
  if (!statusBar) return;
  if (s.state === 'ready') {
    statusBar.text = `$(symbol-namespace) CIL: ${s.symbolsTotal} symbols`;
    statusBar.tooltip = 'Codebase Intelligence Layer — ready';
  } else if (s.state === 'error') {
    statusBar.text = `$(error) CIL: error`;
  } else {
    statusBar.text = `$(sync~spin) CIL: ${s.state} ${s.filesIndexed}/${s.filesTotal}`;
  }
  statusBar.show();
};

export const activate = async (context: vscode.ExtensionContext): Promise<void> => {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage('CIL: no workspace folder open');
    return;
  }
  const workspaceRoot = folder.uri.fsPath;

  output = vscode.window.createOutputChannel('Codebase Intelligence');
  context.subscriptions.push(output);

  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBar.command = 'cil.refreshIndex';
  context.subscriptions.push(statusBar);
  renderStatus({ state: 'idle', filesIndexed: 0, filesTotal: 0, symbolsTotal: 0 });

  const daemonEntry = require.resolve('@cil/daemon/dist/index.js');
  output.appendLine(`spawning daemon: ${daemonEntry}`);

  client = new CilClient({
    daemonEntry,
    workspaceRoot,
    embedding: readEmbeddingConfig(),
    llm: readLlmConfig(),
    onLog: (m) => output.appendLine(m),
  });
  client.on('status', renderStatus);
  client.on('progress', renderStatus);
  client.on('exit', (code) => {
    output.appendLine(`daemon exited (code=${code})`);
    statusBar.text = '$(error) CIL: daemon down';
  });

  try {
    const init = await client.start();
    output.appendLine(
      `daemon ready: v${init.daemonVersion} (protocol ${init.protocolVersion})`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `CIL: daemon failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const tree = new SymbolTreeProvider(client, workspaceRoot);
  const codeLens = new CilCodeLensProvider(client, workspaceRoot);
  const hover = new CilHoverProvider(client, workspaceRoot);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('cil.symbols', tree),
    vscode.languages.registerCodeLensProvider(TS_LANGS, codeLens),
    vscode.languages.registerHoverProvider(TS_LANGS, hover),
    ...registerCommands(context, client, workspaceRoot, tree),
  );
};

export const deactivate = async (): Promise<void> => {
  await client?.dispose();
  client = undefined;
};

