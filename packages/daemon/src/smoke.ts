/**
 * Self-contained smoke test: spawns the daemon as a child process,
 * runs initialize against this repo, waits for `ready`, then dumps
 * a few symbols. Exits non-zero on any failure.
 *
 * Run after `pnpm build`:
 *   node packages/daemon/dist/smoke.js [workspace-root]
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node.js';
import {
  RPC,
  type IndexStatus,
  type InitializeResult,
  type GraphNode,
} from '@cil/protocol';

const here = dirname(fileURLToPath(import.meta.url));
const daemonEntry = resolve(here, 'index.js');
const workspace = resolve(process.argv[2] ?? resolve(here, '../../..'));

const child = spawn(process.execPath, [daemonEntry], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

const conn = createMessageConnection(
  new StreamMessageReader(child.stdout!),
  new StreamMessageWriter(child.stdin!),
);

const ready = new Promise<void>((res, rej) => {
  conn.onNotification(RPC.statusChanged, (s: IndexStatus) => {
    process.stderr.write(`[status] ${JSON.stringify(s)}\n`);
    if (s.state === 'ready') res();
    if (s.state === 'error') rej(new Error(s.lastError ?? 'unknown'));
  });
  conn.onNotification(RPC.indexProgress, (s: IndexStatus) => {
    process.stderr.write(
      `[progress] ${s.filesIndexed}/${s.filesTotal} files, ${s.symbolsTotal} symbols\n`,
    );
  });
});

conn.listen();

const main = async () => {
  const init = (await conn.sendRequest(RPC.initialize, {
    workspaceRoot: workspace,
  })) as InitializeResult;
  process.stderr.write(`[init] ${JSON.stringify(init)}\n`);

  await ready;

  const status = (await conn.sendRequest(RPC.getStatus, {})) as IndexStatus;
  process.stderr.write(`[final-status] ${JSON.stringify(status)}\n`);

  const symbols = (await conn.sendRequest(RPC.listSymbols, {
    limit: 10,
  })) as GraphNode[];
  process.stdout.write(JSON.stringify(symbols, null, 2) + '\n');

  await conn.sendRequest(RPC.shutdown, {});
  child.kill();
  process.exit(0);
};

main().catch((err) => {
  process.stderr.write(`[smoke] FAILED: ${err}\n`);
  child.kill();
  process.exit(1);
});
