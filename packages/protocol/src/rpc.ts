import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  IndexStatus,
  NodeKind,
  ScoredNode,
} from './types.js';

export const RPC = {
  // requests
  initialize: 'cil/initialize',
  shutdown: 'cil/shutdown',
  getStatus: 'cil/getStatus',
  getNode: 'cil/getNode',
  listSymbols: 'cil/listSymbols',
  findReferences: 'cil/findReferences',
  findCallers: 'cil/findCallers',
  findCallees: 'cil/findCallees',
  getNeighbors: 'cil/getNeighbors',
  searchSymbols: 'cil/searchSymbols',
  explain: 'cil/explain',
  // notifications (server -> client)
  statusChanged: 'cil/statusChanged',
  indexProgress: 'cil/indexProgress',
} as const;

export const PROTOCOL_VERSION = '0.0.3';

export type EmbeddingConfig =
  | { provider: 'none' }
  | { provider: 'hash'; dim?: number }
  | { provider: 'ollama'; model?: string; url?: string; dim?: number };

export type LlmConfig =
  | { provider: 'none' }
  | { provider: 'mock' }
  | {
      provider: 'anthropic';
      model?: string;
      apiKey?: string;
      maxTokens?: number;
    };

export interface InitializeParams {
  workspaceRoot: string;
  /** Defaults to <workspaceRoot>/.cil */
  storageDir?: string;
  /** Embedding provider config. Default: { provider: 'none' }. */
  embedding?: EmbeddingConfig;
  /** LLM provider config. Default: { provider: 'none' }. */
  llm?: LlmConfig;
}

export interface InitializeResult {
  daemonVersion: string;
  protocolVersion: string;
}

export interface GetNodeParams {
  id: string;
}
export type GetNodeResult = GraphNode | null;

export interface ListSymbolsParams {
  filePath?: string;
  kind?: NodeKind;
  limit?: number;
}
export type ListSymbolsResult = GraphNode[];

export interface FindReferencesParams {
  id: string;
  kind?: EdgeKind;
}
export interface FindCallersParams {
  id: string;
}
export interface FindCalleesParams {
  id: string;
}
export interface GetNeighborsParams {
  id: string;
  depth?: number;
  direction?: 'in' | 'out' | 'both';
}

export interface SearchSymbolsParams {
  query: string;
  limit?: number;
  /** Optional kind filter. */
  kinds?: NodeKind[];
}
export type SearchSymbolsResult = ScoredNode[];

export interface ExplainParams {
  query: string;
  /** Number of evidence items to send to the LLM. Default 8. */
  k?: number;
  /** Graph expansion depth around vector hits. Default 1. */
  expandDepth?: number;
}

export interface EvidenceCitation {
  index: number;
  valid: boolean;
  node?: GraphNode;
}

export interface ExplainEvidence {
  id: string;
  index: number;
  node: GraphNode;
  summary?: string;
  score: number;
}

export interface ExplainResult {
  query: string;
  answer: string;
  evidence: ExplainEvidence[];
  citations: EvidenceCitation[];
  /** Indices the model produced that don't map to evidence — possible hallucination. */
  invalidCitations: number[];
  modelUsed: string;
}

/** Edges + the nodes incident to them (denormalized for client convenience). */
export interface GraphResult {
  root: GraphNode | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type GetStatusResult = IndexStatus;
