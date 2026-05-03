import type { GraphEdge, GraphNode } from '@cil/protocol';
import type { GraphStore } from '../db/store.js';

export type FlowDirection = 'callees' | 'callers';

export interface FlowStep {
  /** Insertion order — preserves BFS layering for renderability. */
  index: number;
  /** Min depth from the seed (seed is depth 0). */
  depth: number;
  /** The node this step represents. */
  node: GraphNode;
  /** The step index that brought us here (the immediate predecessor). null
   *  for the seed. Use this to render the trace as a tree. */
  parentIndex: number | null;
  /** The edge that brought us here (null for seed). */
  via: GraphEdge | null;
}

export interface FlowReport {
  seed: GraphNode | null;
  direction: FlowDirection;
  maxDepth: number;
  steps: FlowStep[];
  /** Truncated because the cap was hit? */
  truncated: boolean;
}

export class FlowTracer {
  constructor(private store: GraphStore) {}

  trace(
    seedId: string,
    opts: {
      direction?: FlowDirection;
      maxDepth?: number;
      cap?: number;
    } = {},
  ): FlowReport {
    const direction: FlowDirection = opts.direction ?? 'callees';
    const maxDepth = opts.maxDepth ?? 6;
    const cap = opts.cap ?? 200;

    const seed = this.store.getNode(seedId);
    if (!seed) {
      return { seed: null, direction, maxDepth, steps: [], truncated: false };
    }

    const steps: FlowStep[] = [
      { index: 0, depth: 0, node: seed, parentIndex: null, via: null },
    ];
    const indexById = new Map<string, number>([[seedId, 0]]);

    let frontier: { id: string; index: number }[] = [
      { id: seedId, index: 0 },
    ];
    let truncated = false;

    for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
      const next: { id: string; index: number }[] = [];
      for (const { id, index: parentIndex } of frontier) {
        const edges = this.store.edgesFor(
          id,
          direction === 'callees' ? 'out' : 'in',
          'calls',
        );
        for (const e of edges) {
          const otherId = direction === 'callees' ? e.dst : e.src;
          if (indexById.has(otherId)) continue;
          if (steps.length >= cap) {
            truncated = true;
            break;
          }
          const node = this.store.getNode(otherId);
          if (!node) continue;
          const idx = steps.length;
          steps.push({
            index: idx,
            depth: d + 1,
            node,
            parentIndex,
            via: e,
          });
          indexById.set(otherId, idx);
          next.push({ id: otherId, index: idx });
        }
        if (truncated) break;
      }
      if (truncated) break;
      frontier = next;
    }

    return { seed, direction, maxDepth, steps, truncated };
  }
}
