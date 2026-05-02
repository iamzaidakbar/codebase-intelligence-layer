export type NodeKind =
  | 'file'
  | 'module'
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'variable'
  | 'type';

export type EdgeKind =
  | 'imports'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'reads'
  | 'writes'
  | 'contains';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature?: string;
  contentHash: string;
}

export interface GraphEdge {
  id: string;
  src: string;
  dst: string;
  kind: EdgeKind;
}

export type IndexState = 'idle' | 'scanning' | 'indexing' | 'ready' | 'error';

export interface IndexStatus {
  state: IndexState;
  filesIndexed: number;
  filesTotal: number;
  symbolsTotal: number;
  edgesTotal: number;
  lastError?: string;
}
