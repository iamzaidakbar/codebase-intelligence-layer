/**
 * End-to-end smoke test. Spawns the daemon, indexes the workspace, then
 * exercises the phase 1 graph queries (callers, callees, neighborhood).
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
  type ExplainResult,
  type GraphNode,
  type GraphResult,
  type IndexStatus,
  type InitializeResult,
  type ScoredNode,
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
      `[progress] ${s.filesIndexed}/${s.filesTotal} files | ${s.symbolsTotal} symbols | ${s.edgesTotal} edges | ${s.embeddingsTotal} embeddings\n`,
    );
  });
});

conn.listen();

const fmt = (n: GraphNode): string =>
  `${n.kind}:${n.name} (${n.filePath}:${n.startLine + 1})`;

const dump = (label: string, r: GraphResult) => {
  process.stdout.write(`\n=== ${label} ===\n`);
  if (r.root) process.stdout.write(`root: ${fmt(r.root)}\n`);
  process.stdout.write(`edges (${r.edges.length}):\n`);
  for (const e of r.edges) {
    const srcN = r.root?.id === e.src ? r.root : r.nodes.find((n) => n.id === e.src);
    const dstN = r.root?.id === e.dst ? r.root : r.nodes.find((n) => n.id === e.dst);
    const srcS = srcN ? fmt(srcN) : e.src;
    const dstS = dstN ? fmt(dstN) : e.dst;
    process.stdout.write(`  ${srcS}  --[${e.kind}]-->  ${dstS}\n`);
  }
};

const main = async () => {
  const init = (await conn.sendRequest(RPC.initialize, {
    workspaceRoot: workspace,
    embedding: { provider: 'hash', dim: 128 },
    llm: { provider: 'mock' },
  })) as InitializeResult;
  process.stderr.write(`[init] ${JSON.stringify(init)}\n`);

  await ready;

  const status = (await conn.sendRequest(RPC.getStatus, {})) as IndexStatus;
  process.stderr.write(`[final-status] ${JSON.stringify(status)}\n`);

  // Find a juicy target: a class method or function that's likely called.
  // Pick GraphStore class as our anchor — many callers expected.
  const classes = (await conn.sendRequest(RPC.listSymbols, {
    kind: 'class',
    limit: 50,
  })) as GraphNode[];
  const graphStore = classes.find((n) => n.name === 'GraphStore');
  if (!graphStore) throw new Error('expected GraphStore class to be indexed');

  const callers = (await conn.sendRequest(RPC.findCallers, {
    id: graphStore.id,
  })) as GraphResult;
  dump(`callers of GraphStore`, callers);

  // Pick a function with callers — `parseFile` or `hash`.
  const functions = (await conn.sendRequest(RPC.listSymbols, {
    kind: 'function',
    limit: 200,
  })) as GraphNode[];
  const parseFile = functions.find((n) => n.name === 'parseFile');
  if (parseFile) {
    const r = (await conn.sendRequest(RPC.findCallers, {
      id: parseFile.id,
    })) as GraphResult;
    dump(`callers of parseFile`, r);
  }

  // Callees of Indexer.runInitialScan
  const methods = (await conn.sendRequest(RPC.listSymbols, {
    kind: 'method',
    limit: 500,
  })) as GraphNode[];
  const runInitialScan = methods.find(
    (m) => m.name === 'runInitialScan' && m.filePath.includes('indexer.ts'),
  );
  if (runInitialScan) {
    const r = (await conn.sendRequest(RPC.findCallees, {
      id: runInitialScan.id,
    })) as GraphResult;
    dump(`callees of Indexer.runInitialScan`, r);
  }

  // 2-hop neighborhood of the indexer file
  const indexerFile = (await conn.sendRequest(RPC.getNode, {
    id: 'file:packages/daemon/src/indexer.ts',
  })) as GraphNode | null;
  if (indexerFile) {
    const r = (await conn.sendRequest(RPC.getNeighbors, {
      id: indexerFile.id,
      depth: 1,
      direction: 'out',
    })) as GraphResult;
    dump(`1-hop out-neighborhood of indexer.ts`, r);
  }

  // Semantic search (hash provider — pipeline test, low quality)
  const queries = [
    'parse typescript file',
    'cosine similarity vector search',
    'file watcher debounce',
    'sqlite store nodes and edges',
  ];
  for (const q of queries) {
    const r = (await conn.sendRequest(RPC.searchSymbols, {
      query: q,
      limit: 5,
    })) as ScoredNode[];
    process.stdout.write(`\n=== search: "${q}" ===\n`);
    for (const { node, score } of r) {
      process.stdout.write(
        `  ${score.toFixed(3)}  ${fmt(node)}\n`,
      );
    }
  }

  // Grounded explain (mock LLM — proves the citation loop, not answer quality)
  const explainQueries = [
    'How does the indexer process file changes end-to-end?',
    'What enforces the anti-hallucination guarantee in explain?',
  ];
  for (const q of explainQueries) {
    const r = (await conn.sendRequest(RPC.explain, {
      query: q,
      k: 6,
    })) as ExplainResult;
    process.stdout.write(`\n=== explain: "${q}" ===\n`);
    process.stdout.write(`model: ${r.modelUsed}\n`);
    process.stdout.write(`answer: ${r.answer}\n`);
    process.stdout.write(`evidence (${r.evidence.length}):\n`);
    for (const e of r.evidence) {
      process.stdout.write(
        `  [${e.index}] ${e.node.kind}:${e.node.name} (${e.node.filePath}:${e.node.startLine + 1}) score=${e.score.toFixed(3)}\n`,
      );
      if (e.summary) {
        process.stdout.write(`        summary: ${e.summary}\n`);
      }
    }
    process.stdout.write(
      `citations: ${r.citations.length} valid=${r.citations.filter((c) => c.valid).length} invalid=[${r.invalidCitations.join(',')}]\n`,
    );
  }

  await conn.sendRequest(RPC.shutdown, {});
  child.kill();
  process.exit(0);
};

main().catch((err) => {
  process.stderr.write(`[smoke] FAILED: ${err?.stack ?? err}\n`);
  child.kill();
  process.exit(1);
});
