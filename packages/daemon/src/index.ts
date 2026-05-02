#!/usr/bin/env node
import { z } from 'zod';
import {
  PROTOCOL_VERSION,
  RPC,
  type ExplainResult,
  type GraphResult,
  type IndexStatus,
  type InitializeResult,
  type ScoredNode,
} from '@cil/protocol';
import { startStdioRpc } from './rpc/server.js';
import { resolveConfig } from './config.js';
import { GraphStore, type Direction } from './db/store.js';
import { buildProvider, type EmbeddingProvider } from './embed/index.js';
import { buildLlmProvider, type LlmProvider } from './llm/index.js';
import { Indexer } from './indexer.js';
import { Watcher } from './watcher/index.js';
import { log } from './log.js';
import { Summarizer } from './synth/summarizer.js';
import { Explainer } from './synth/explainer.js';

const DAEMON_VERSION = '0.3.0';

interface DaemonState {
  store?: GraphStore;
  watcher?: Watcher;
  indexer?: Indexer;
  provider: EmbeddingProvider | null;
  llm: LlmProvider | null;
  summarizer?: Summarizer;
  explainer?: Explainer;
  status: IndexStatus;
  initialized: boolean;
}

const state: DaemonState = {
  provider: null,
  llm: null,
  status: {
    state: 'idle',
    filesIndexed: 0,
    filesTotal: 0,
    symbolsTotal: 0,
    edgesTotal: 0,
    embeddingsTotal: 0,
  },
  initialized: false,
};

const conn = startStdioRpc();

const refreshCounts = (): void => {
  if (!state.store) return;
  const c = state.store.counts();
  state.status.symbolsTotal = c.nodes;
  state.status.edgesTotal = c.edges;
  state.status.embeddingsTotal = c.embeddings;
};

const requireStore = (): GraphStore => {
  if (!state.store) throw new Error('not initialized');
  return state.store;
};

const buildGraphResult = (
  rootId: string,
  edges: ReturnType<GraphStore['edgesFor']>,
): GraphResult => {
  const store = requireStore();
  const root = store.getNode(rootId) ?? null;
  const ids = new Set<string>();
  for (const e of edges) {
    ids.add(e.src);
    ids.add(e.dst);
  }
  ids.delete(rootId);
  const nodes = store.getNodes([...ids]);
  return { root, nodes, edges };
};

// ---- schemas ---------------------------------------------------------------

const KindEnum = z.enum([
  'file',
  'module',
  'class',
  'interface',
  'function',
  'method',
  'variable',
  'type',
]);

const EdgeKindEnum = z.enum([
  'imports',
  'calls',
  'extends',
  'implements',
  'reads',
  'writes',
  'contains',
]);

const EmbeddingConfigSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('none') }),
  z.object({
    provider: z.literal('hash'),
    dim: z.number().int().positive().max(4096).optional(),
  }),
  z.object({
    provider: z.literal('ollama'),
    model: z.string().optional(),
    url: z.string().url().optional(),
    dim: z.number().int().positive().max(4096).optional(),
  }),
]);

const LlmConfigSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('none') }),
  z.object({ provider: z.literal('mock') }),
  z.object({
    provider: z.literal('anthropic'),
    model: z.string().optional(),
    apiKey: z.string().optional(),
    maxTokens: z.number().int().positive().max(8192).optional(),
  }),
]);

const InitializeSchema = z.object({
  workspaceRoot: z.string().min(1),
  storageDir: z.string().optional(),
  embedding: EmbeddingConfigSchema.optional(),
  llm: LlmConfigSchema.optional(),
});

const ExplainSchema = z.object({
  query: z.string().min(1),
  k: z.number().int().positive().max(50).optional(),
  expandDepth: z.number().int().min(0).max(3).optional(),
});

const IdSchema = z.object({ id: z.string().min(1) });

const ListSymbolsSchema = z.object({
  filePath: z.string().optional(),
  kind: KindEnum.optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

const FindReferencesSchema = z.object({
  id: z.string().min(1),
  kind: EdgeKindEnum.optional(),
});

const GetNeighborsSchema = z.object({
  id: z.string().min(1),
  depth: z.number().int().positive().max(5).optional(),
  direction: z.enum(['in', 'out', 'both']).optional(),
});

const SearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  kinds: z.array(KindEnum).optional(),
});

// ---- search ---------------------------------------------------------------

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
};

const search = async (
  query: string,
  limit: number,
  kinds: Set<string> | null,
): Promise<ScoredNode[]> => {
  if (!state.provider) return [];
  const store = requireStore();
  const [q] = await state.provider.embed([query]);
  if (!q) return [];
  const scored: ScoredNode[] = [];
  for (const { node, vector } of store.iterEmbeddedNodes(state.provider.model)) {
    if (kinds && !kinds.has(node.kind)) continue;
    scored.push({ node, score: dot(q, vector) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
};

// ---- initialization + scan ------------------------------------------------

const runInitialScan = async (): Promise<void> => {
  const watcher = state.watcher!;
  const indexer = state.indexer!;

  state.status = {
    ...state.status,
    state: 'scanning',
    filesIndexed: 0,
    filesTotal: 0,
  };
  conn.sendNotification(RPC.statusChanged, state.status);

  const events = watcher.initialScan();
  state.status.filesTotal = events.length;
  state.status.state = 'indexing';
  conn.sendNotification(RPC.statusChanged, state.status);

  await indexer.runInitialScan(
    events,
    (done, total) => {
      state.status.filesIndexed = done;
      state.status.filesTotal = total;
      refreshCounts();
      conn.sendNotification(RPC.indexProgress, state.status);
    },
    (done, total) => {
      refreshCounts();
      log.info({ done, total }, 'semantic pass progress');
      conn.sendNotification(RPC.indexProgress, state.status);
    },
    (done, total, embedded) => {
      refreshCounts();
      log.info({ done, total, embedded }, 'embedding pass progress');
      conn.sendNotification(RPC.indexProgress, state.status);
    },
  );

  watcher.start();
  state.status.state = 'ready';
  refreshCounts();
  conn.sendNotification(RPC.statusChanged, state.status);
  log.info(
    {
      files: state.status.filesIndexed,
      symbols: state.status.symbolsTotal,
      edges: state.status.edgesTotal,
      embeddings: state.status.embeddingsTotal,
    },
    'initial scan complete',
  );
};

// ---- request handlers -----------------------------------------------------

conn.onRequest(RPC.initialize, async (raw: unknown): Promise<InitializeResult> => {
  if (state.initialized) throw new Error('already initialized');
  const params = InitializeSchema.parse(raw);
  const cfg = resolveConfig(params.workspaceRoot, params.storageDir);
  log.info({ cfg, embedding: params.embedding }, 'initializing');

  state.provider = buildProvider(params.embedding ?? { provider: 'none' });
  state.llm = buildLlmProvider(params.llm ?? { provider: 'none' });
  state.store = new GraphStore(cfg.dbPath);
  state.indexer = new Indexer(cfg.workspaceRoot, state.store, state.provider);
  state.summarizer = new Summarizer(cfg.workspaceRoot, state.store, state.llm);
  state.explainer = new Explainer(
    state.store,
    state.summarizer,
    state.llm,
    state.provider,
  );
  state.watcher = new Watcher(cfg.workspaceRoot, async (events) => {
    const work = await state.indexer!.applyStructural(events);
    for (const w of work) {
      try {
        await state.indexer!.applySemantic(w.relPath);
        await state.indexer!.applyEmbedding(w);
      } catch (err) {
        log.warn({ err, file: w.relPath }, 'incremental refresh failed');
      }
    }
    refreshCounts();
    conn.sendNotification(RPC.statusChanged, state.status);
  });
  state.initialized = true;

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
  const { id } = IdSchema.parse(raw);
  return requireStore().getNode(id) ?? null;
});

conn.onRequest(RPC.listSymbols, (raw: unknown) => {
  const params = ListSymbolsSchema.parse(raw);
  return requireStore().listSymbols(params);
});

conn.onRequest(RPC.findReferences, (raw: unknown): GraphResult => {
  const { id, kind } = FindReferencesSchema.parse(raw);
  const edges = requireStore().edgesFor(id, 'in', kind);
  return buildGraphResult(id, edges);
});

conn.onRequest(RPC.findCallers, (raw: unknown): GraphResult => {
  const { id } = IdSchema.parse(raw);
  const edges = requireStore().edgesFor(id, 'in', 'calls');
  return buildGraphResult(id, edges);
});

conn.onRequest(RPC.findCallees, (raw: unknown): GraphResult => {
  const { id } = IdSchema.parse(raw);
  const edges = requireStore().edgesFor(id, 'out', 'calls');
  return buildGraphResult(id, edges);
});

conn.onRequest(RPC.getNeighbors, (raw: unknown): GraphResult => {
  const { id, depth = 2, direction = 'both' } = GetNeighborsSchema.parse(raw);
  const sub = requireStore().neighborhood(id, depth, direction as Direction);
  const root = requireStore().getNode(id) ?? null;
  return { root, nodes: sub.nodes, edges: sub.edges };
});

conn.onRequest(RPC.searchSymbols, async (raw: unknown): Promise<ScoredNode[]> => {
  const { query, limit = 10, kinds } = SearchSchema.parse(raw);
  if (!state.provider) return [];
  return search(query, limit, kinds ? new Set(kinds) : null);
});

conn.onRequest(RPC.explain, async (raw: unknown): Promise<ExplainResult> => {
  const params = ExplainSchema.parse(raw);
  if (!state.explainer) throw new Error('not initialized');
  if (!state.explainer.isReady()) {
    throw new Error(
      'explain requires both an embedding provider and an LLM provider to be configured at init',
    );
  }
  return state.explainer.explain(params.query, {
    k: params.k,
    expandDepth: params.expandDepth,
  });
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
