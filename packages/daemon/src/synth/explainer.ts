import type { GraphNode } from '@cil/protocol';
import type { GraphStore } from '../db/store.js';
import type { EmbeddingProvider } from '../embed/index.js';
import type { LlmProvider } from '../llm/index.js';
import { log } from '../log.js';
import { Summarizer, SUMMARIZER_PROMPT_VERSION } from './summarizer.js';

const SYNTHESIS_PROMPT_VERSION = 'syn-v1';

const SYSTEM_PROMPT = `You answer questions about a codebase using ONLY the EVIDENCE provided.

Rules:
1. Every factual claim about the code MUST be followed by a citation in square brackets pointing to an evidence index, e.g., "The watcher debounces events [3]."
2. If the evidence is insufficient to answer the question, say so plainly. Do not invent.
3. Cite only indices that appear in the EVIDENCE block. Do not invent indices.
4. Be concise. No filler. No restating the question.
5. Prefer multiple short claims with citations over long uncited prose.`;

export interface EvidenceItem {
  index: number; // 1-based for prompt + citation match
  node: GraphNode;
  summary?: string;
  score: number;
}

export interface Citation {
  index: number;
  valid: boolean;
  node?: GraphNode;
}

export interface ExplainResult {
  query: string;
  answer: string;
  evidence: { id: string; index: number; node: GraphNode; summary?: string; score: number }[];
  citations: Citation[];
  /** Citations the model produced that don't map to any evidence item.
   *  A non-empty list signals possible hallucination. */
  invalidCitations: number[];
  modelUsed: string;
}

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
};

export class Explainer {
  constructor(
    private store: GraphStore,
    private summarizer: Summarizer,
    private llm: LlmProvider | null,
    private embed: EmbeddingProvider | null,
  ) {}

  isReady(): boolean {
    return this.llm !== null && this.embed !== null;
  }

  async explain(
    query: string,
    opts: { k?: number; expandDepth?: number } = {},
  ): Promise<ExplainResult> {
    if (!this.llm || !this.embed) {
      throw new Error(
        'explain requires both LLM and embedding providers to be configured',
      );
    }
    const k = opts.k ?? 8;
    const expandDepth = opts.expandDepth ?? 1;

    // 1. Vector retrieve top candidates (oversample for graph expansion).
    const seedScores = await this.vectorSearch(query, k * 2);
    if (seedScores.length === 0) {
      return this.emptyResult(query);
    }

    // 2. Graph-expand: include 1-hop callers/callees of seeds.
    const expanded = this.expandWithGraph(seedScores, expandDepth);

    // 3. Take top-K by score, ensure we have summaries for them.
    const topK = expanded.slice(0, k);
    await this.summarizer.ensureMany(
      topK.map((e) => e.node),
      4,
    );

    // 4. Build evidence packet (with the freshly cached summaries).
    const evidence: EvidenceItem[] = topK.map((e, i) => ({
      index: i + 1,
      node: e.node,
      summary: this.store.getSummary(
        e.node.contentHash,
        this.llm!.model,
        SUMMARIZER_PROMPT_VERSION,
      ),
      score: e.score,
    }));

    // 5. Synthesize.
    const evidenceBlock = this.formatEvidence(evidence);
    const userPrompt = `QUESTION: ${query}\n\nEVIDENCE:\n${evidenceBlock}\n\nAnswer using citations like [1], [2]. Skip any evidence that doesn't help. If nothing helps, say so.`;
    const answer = await this.llm.complete({
      task: 'synthesize',
      system: SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: 800,
    });

    // 6. Validate citations.
    const { citations, invalid } = this.validateCitations(answer, evidence);

    log.info(
      {
        query,
        evidence: evidence.length,
        citations: citations.length,
        invalid: invalid.length,
      },
      'explain complete',
    );

    return {
      query,
      answer,
      evidence: evidence.map((e) => ({
        id: e.node.id,
        index: e.index,
        node: e.node,
        summary: e.summary,
        score: e.score,
      })),
      citations,
      invalidCitations: invalid,
      modelUsed: `${this.llm.model}+${SYNTHESIS_PROMPT_VERSION}`,
    };
  }

  // ---- private --------------------------------------------------------------

  private async vectorSearch(
    query: string,
    limit: number,
  ): Promise<{ node: GraphNode; score: number }[]> {
    const [q] = await this.embed!.embed([query]);
    if (!q) return [];
    const scored: { node: GraphNode; score: number }[] = [];
    for (const { node, vector } of this.store.iterEmbeddedNodes(
      this.embed!.model,
    )) {
      // skip 'file' nodes from explanation evidence — usually too coarse.
      if (node.kind === 'file') continue;
      scored.push({ node, score: dot(q, vector) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  private expandWithGraph(
    seeds: { node: GraphNode; score: number }[],
    depth: number,
  ): { node: GraphNode; score: number }[] {
    if (depth <= 0) return seeds;
    const byId = new Map<string, { node: GraphNode; score: number }>();
    for (const s of seeds) byId.set(s.node.id, s);

    for (const seed of seeds) {
      const sub = this.store.neighborhood(seed.node.id, depth, 'both', 50);
      for (const n of sub.nodes) {
        if (n.kind === 'file') continue;
        if (!byId.has(n.id)) {
          // graph-expanded nodes get a small fraction of the seed score
          byId.set(n.id, { node: n, score: seed.score * 0.3 });
        }
      }
    }
    const merged = [...byId.values()];
    merged.sort((a, b) => b.score - a.score);
    return merged;
  }

  private formatEvidence(items: EvidenceItem[]): string {
    return items
      .map((e) => {
        const loc = `${e.node.filePath}:${e.node.startLine + 1}`;
        const sig = e.node.signature ? `\n    signature: ${e.node.signature}` : '';
        const sum = e.summary ? `\n    summary: ${e.summary}` : '\n    summary: (none)';
        return `[${e.index}] ${e.node.kind} ${e.node.name} (${loc})${sig}${sum}`;
      })
      .join('\n\n');
  }

  private validateCitations(
    answer: string,
    evidence: EvidenceItem[],
  ): { citations: Citation[]; invalid: number[] } {
    const byIdx = new Map(evidence.map((e) => [e.index, e.node]));
    const citations: Citation[] = [];
    const invalid: number[] = [];
    const seen = new Set<number>();
    for (const m of answer.matchAll(/\[(\d+)\]/g)) {
      const idx = parseInt(m[1]!, 10);
      if (seen.has(idx)) continue;
      seen.add(idx);
      const node = byIdx.get(idx);
      if (node) {
        citations.push({ index: idx, valid: true, node });
      } else {
        citations.push({ index: idx, valid: false });
        invalid.push(idx);
      }
    }
    return { citations, invalid };
  }

  private emptyResult(query: string): ExplainResult {
    return {
      query,
      answer:
        'No relevant code found. The index may still be warming up, or the query may not match anything in this codebase.',
      evidence: [],
      citations: [],
      invalidCitations: [],
      modelUsed: this.llm?.model ?? 'none',
    };
  }
}
