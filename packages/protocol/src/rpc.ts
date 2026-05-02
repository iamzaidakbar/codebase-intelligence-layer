import type { GraphNode, IndexStatus, NodeKind } from './types.js';

export const RPC = {
  // requests
  initialize: 'cil/initialize',
  shutdown: 'cil/shutdown',
  getStatus: 'cil/getStatus',
  getNode: 'cil/getNode',
  listSymbols: 'cil/listSymbols',
  // notifications (server -> client)
  statusChanged: 'cil/statusChanged',
  indexProgress: 'cil/indexProgress',
} as const;

export const PROTOCOL_VERSION = '0.0.1';

export interface InitializeParams {
  workspaceRoot: string;
  /** Defaults to <workspaceRoot>/.cil */
  storageDir?: string;
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

export type GetStatusResult = IndexStatus;
