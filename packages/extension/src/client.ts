import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import {
  RPC,
  type AnalyzeImpactParams,
  type EmbeddingConfig,
  type ExplainParams,
  type ExplainResult,
  type FlowResult,
  type GetNeighborsParams,
  type GraphNode,
  type GraphResult,
  type ImpactResult,
  type IndexStatus,
  type InitializeParams,
  type InitializeResult,
  type ListSymbolsParams,
  type LlmConfig,
  type ScoredNode,
  type SearchSymbolsParams,
  type TraceFlowParams,
} from '@cil/protocol';

export interface ClientOptions {
  daemonEntry: string;
  workspaceRoot: string;
  storageDir?: string;
  embedding?: EmbeddingConfig;
  llm?: LlmConfig;
  onLog?: (msg: string) => void;
}

/**
 * Owns the daemon child process + JSON-RPC connection. Exposes typed
 * wrappers for every RPC method, plus an EventEmitter for status events.
 *
 * Lifecycle: `start()` spawns the daemon, sends `initialize`, returns when
 * the daemon is alive (initial scan runs in the background and is reported
 * via `status` events). `dispose()` sends `shutdown` and kills the process.
 */
export class CilClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private conn?: MessageConnection;
  private status: IndexStatus = {
    state: 'idle',
    filesIndexed: 0,
    filesTotal: 0,
    symbolsTotal: 0,
    edgesTotal: 0,
    embeddingsTotal: 0,
  };

  constructor(private opts: ClientOptions) {
    super();
  }

  getStatus(): IndexStatus {
    return this.status;
  }

  async start(): Promise<InitializeResult> {
    this.child = spawn(process.execPath, [this.opts.daemonEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.on('exit', (code, signal) => {
      this.opts.onLog?.(`daemon exited code=${code} signal=${signal}`);
      this.emit('exit', code);
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.opts.onLog?.(chunk.toString('utf8').trim());
    });

    this.conn = createMessageConnection(
      new StreamMessageReader(this.child.stdout),
      new StreamMessageWriter(this.child.stdin),
    );
    this.conn.onError(([err]) => this.opts.onLog?.(`rpc error: ${err.message}`));
    this.conn.onClose(() => this.emit('close'));

    this.conn.onNotification(RPC.statusChanged, (s: IndexStatus) => {
      this.status = s;
      this.emit('status', s);
    });
    this.conn.onNotification(RPC.indexProgress, (s: IndexStatus) => {
      this.status = s;
      this.emit('progress', s);
    });

    this.conn.listen();

    const params: InitializeParams = {
      workspaceRoot: this.opts.workspaceRoot,
      storageDir: this.opts.storageDir,
      embedding: this.opts.embedding,
      llm: this.opts.llm,
    };
    return this.conn.sendRequest(RPC.initialize, params) as Promise<InitializeResult>;
  }

  async dispose(): Promise<void> {
    try {
      await this.conn?.sendRequest(RPC.shutdown, {});
    } catch {
      /* ignore */
    }
    this.child?.kill();
    this.conn?.dispose();
  }

  // ---- typed RPC wrappers -------------------------------------------------

  private require(): MessageConnection {
    if (!this.conn) throw new Error('client not started');
    return this.conn;
  }

  fetchStatus(): Promise<IndexStatus> {
    return this.require().sendRequest(RPC.getStatus, {}) as Promise<IndexStatus>;
  }

  getNode(id: string): Promise<GraphNode | null> {
    return this.require().sendRequest(RPC.getNode, { id }) as Promise<GraphNode | null>;
  }

  listSymbols(params: ListSymbolsParams = {}): Promise<GraphNode[]> {
    return this.require().sendRequest(RPC.listSymbols, params) as Promise<GraphNode[]>;
  }

  findCallers(id: string): Promise<GraphResult> {
    return this.require().sendRequest(RPC.findCallers, { id }) as Promise<GraphResult>;
  }

  findCallees(id: string): Promise<GraphResult> {
    return this.require().sendRequest(RPC.findCallees, { id }) as Promise<GraphResult>;
  }

  findReferences(id: string): Promise<GraphResult> {
    return this.require().sendRequest(RPC.findReferences, { id }) as Promise<GraphResult>;
  }

  getNeighbors(params: GetNeighborsParams): Promise<GraphResult> {
    return this.require().sendRequest(RPC.getNeighbors, params) as Promise<GraphResult>;
  }

  searchSymbols(params: SearchSymbolsParams): Promise<ScoredNode[]> {
    return this.require().sendRequest(RPC.searchSymbols, params) as Promise<ScoredNode[]>;
  }

  explain(params: ExplainParams): Promise<ExplainResult> {
    return this.require().sendRequest(RPC.explain, params) as Promise<ExplainResult>;
  }

  analyzeImpact(params: AnalyzeImpactParams): Promise<ImpactResult> {
    return this.require().sendRequest(RPC.analyzeImpact, params) as Promise<ImpactResult>;
  }

  traceFlow(params: TraceFlowParams): Promise<FlowResult> {
    return this.require().sendRequest(RPC.traceFlow, params) as Promise<FlowResult>;
  }
}
