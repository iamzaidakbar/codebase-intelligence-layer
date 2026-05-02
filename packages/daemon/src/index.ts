#!/usr/bin/env node
import { z } from 'zod';
import {
  PROTOCOL_VERSION,
  RPC,
  type IndexStatus,
  type InitializeResult,
} from '@cil/protocol';
import { startStdioRpc } from './rpc/server.js';
import { resolveConfig } from './config.js';
import { GraphStore } from './db/store.js';
import { Indexer } from './indexer.js';
import { Watcher } from './watcher/index.js';
import { log } from './log.js';

const DAEMON_VERSION = '0.0.1';

interface DaemonState {
  store?: GraphStore;
  watcher?: Watcher;
  indexer?: Indexer;
  status: IndexStatus;
  initialized: boolean;
}

const state: DaemonState = {
  status: {
    state: 'idle',
    filesIndexed: 0,
    filesTotal: 0,
    symbolsTotal: 0,
    edgesTotal: 0,
  },
  initialized: false,
};

const conn = startStdioRpc();

const refreshCounts = (): void => {
  if (!state.store) return;
  const c = state.store.counts();
  state.status.symbolsTotal = c.nodes;
  state.status.edgesTotal = c.edges;
};

const InitializeSchema = z.object({
  workspaceRoot: z.string().min(1),
  storageDir: z.string().optional(),
});

const GetNodeSchema = z.object({ id: z.string().min(1) });

const ListSymbolsSchema = z.object({
  filePath: z.string().optional(),
  kind: z
    .enum([
      'file',
      'module',
      'class',
      'interface',
      'function',
      'method',
      'variable',
      'type',
    ])
    .optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

const runInitialScan = async (): Promise<void> => {
  if (!state.watcher || !state.indexer) return;
  state.status = {
    ...state.status,
    state: 'scanning',
    filesIndexed: 0,
    filesTotal: 0,
  };
  conn.sendNotification(RPC.statusChanged, state.status);

  const events = state.watcher.initialScan();
  state.status.filesTotal = events.length;
  state.status.state = 'indexing';
  conn.sendNotification(RPC.statusChanged, state.status);

  const CHUNK = 50;
  for (let i = 0; i < events.length; i += CHUNK) {
    await state.indexer.apply(events.slice(i, i + CHUNK));
    state.status.filesIndexed = Math.min(i + CHUNK, events.length);
    refreshCounts();
    conn.sendNotification(RPC.indexProgress, state.status);
  }

  state.watcher.start();
  state.status.state = 'ready';
  conn.sendNotification(RPC.statusChanged, state.status);
  log.info(
    { files: state.status.filesIndexed, symbols: state.status.symbolsTotal },
    'initial scan complete',
  );
};

conn.onRequest(RPC.initialize, async (raw: unknown): Promise<InitializeResult> => {
  if (state.initialized) {
    throw new Error('already initialized');
  }
  const params = InitializeSchema.parse(raw);
  const cfg = resolveConfig(params.workspaceRoot, params.storageDir);
  log.info({ cfg }, 'initializing');

  state.store = new GraphStore(cfg.dbPath);
  state.indexer = new Indexer(cfg.workspaceRoot, state.store);
  state.watcher = new Watcher(cfg.workspaceRoot, async (events) => {
    await state.indexer!.apply(events);
    refreshCounts();
    conn.sendNotification(RPC.statusChanged, state.status);
  });
  state.initialized = true;

  // Don't await — return promptly so the client gets a response and watches
  // status notifications for progress.
  void runInitialScan().catch((err) => {
    log.error({ err }, 'initial scan failed');
    state.status.state = 'error';
    state.status.lastError = err instanceof Error ? err.message : String(err);
    conn.sendNotification(RPC.statusChanged, state.status);
  });

  return { daemonVersion: DAEMON_VERSION, protocolVersion: PROTOCOL_VERSION };
});

conn.onRequest(RPC.getStatus, () => state.status);

conn.onRequest(RPC.getNode, (raw: unknown) => {
  const { id } = GetNodeSchema.parse(raw);
  return state.store?.getNode(id) ?? null;
});

conn.onRequest(RPC.listSymbols, (raw: unknown) => {
  const params = ListSymbolsSchema.parse(raw);
  return state.store?.listSymbols(params) ?? [];
});

conn.onRequest(RPC.shutdown, async () => {
  log.info('shutdown requested');
  await state.watcher?.stop();
  state.store?.close();
  setTimeout(() => process.exit(0), 50);
  return null;
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

conn.listen();
log.info({ daemonVersion: DAEMON_VERSION }, 'cil daemon listening on stdio');
