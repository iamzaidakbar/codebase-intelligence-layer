import type { EdgeKind, GraphEdge, GraphNode } from '@cil/protocol';
import type { GraphStore } from '../db/store.js';
import type { GitChurn } from './git.js';

const FORWARD_EDGES: EdgeKind[] = ['calls', 'extends', 'implements'];

export interface AffectedNode {
  node: GraphNode;
  /** Min depth from any seed along forward edges. */
  distance: number;
  /** Incoming `calls` edges — anyone who calls this. */
  directCallers: number;
  /** Subset of directCallers in a different file — public-ness proxy. */
  crossFileCallers: number;
  /** Commits touching the file in the churn window. 0 if non-git. */
  fileChurn: number;
  /** Composite risk score; higher = riskier. */
  riskScore: number;
}

export interface ImpactReport {
  seeds: GraphNode[];
  /** Including seeds (distance 0). Sorted by riskScore desc. */
  affected: AffectedNode[];
  /** All edges traversed during the closure — useful for visualization. */
  edges: GraphEdge[];
  /** Closure depth used. */
  maxDepth: number;
  /** Did churn data load? Affects fileChurn interpretation. */
  churnAvailable: boolean;
}

const log2 = (x: number): number => Math.log2(Math.max(1, x));

const computeRisk = (
  blastRadius: number,
  crossFile: number,
  churn: number,
): number => log2(1 + blastRadius) * log2(2 + crossFile) * log2(2 + churn);

export class ImpactEngine {
  constructor(
    private store: GraphStore,
    private churn: GitChurn,
  ) {}

  analyze(
    seedIds: readonly string[],
    opts: { maxDepth?: number; cap?: number } = {},
  ): ImpactReport {
    const maxDepth = opts.maxDepth ?? 5;
    const cap = opts.cap ?? 2000;

    const seeds = this.store.getNodes(seedIds);
    if (seeds.length === 0) {
      return {
        seeds: [],
        affected: [],
        edges: [],
        maxDepth,
        churnAvailable: this.churn.isReady(),
      };
    }

    // Forward closure: who depends on (or extends/implements) the seeds.
    const { depths, edges } = this.store.transitiveClosure(
      seedIds,
      FORWARD_EDGES,
      'in', // "who depends on these" — incoming calls/extends edges
      maxDepth,
      cap,
    );

    // For total blast-radius weighting we use the closure size minus seeds.
    const blastRadius = depths.size - seeds.length;

    const affectedIds = [...depths.keys()];
    const allNodes = this.store.getNodes(affectedIds);
    const nodeById = new Map(allNodes.map((n) => [n.id, n]));

    const affected: AffectedNode[] = [];
    for (const id of affectedIds) {
      const node = nodeById.get(id);
      if (!node) continue;
      const distance = depths.get(id) ?? 0;
      const callers = this.store.edgesFor(id, 'in', 'calls');
      const directCallers = callers.length;
      let crossFileCallers = 0;
      for (const e of callers) {
        const src = nodeById.get(e.src) ?? this.store.getNode(e.src);
        if (src && src.filePath !== node.filePath) crossFileCallers++;
      }
      const fileChurn = this.churn.countFor(node.filePath);
      const riskScore = computeRisk(
        blastRadius,
        crossFileCallers,
        fileChurn,
      );
      affected.push({
        node,
        distance,
        directCallers,
        crossFileCallers,
        fileChurn,
        riskScore,
      });
    }

    affected.sort((a, b) => b.riskScore - a.riskScore);

    return {
      seeds,
      affected,
      edges,
      maxDepth,
      churnAvailable: this.churn.isReady(),
    };
  }
}
