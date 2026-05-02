import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphNode } from '@cil/protocol';
import type { GraphStore } from '../db/store.js';
import type { LlmProvider } from '../llm/index.js';
import { log } from '../log.js';

export const SUMMARIZER_PROMPT_VERSION = 'sym-v1';

const SYSTEM_PROMPT = `You write tight one-sentence summaries of code symbols.
Format: lead with the verb describing what the code does, then the object, then any non-obvious context.
Be specific to THIS code, not generic. No filler words. Maximum 30 words.
Examples:
- "Resolves import statements to file IDs by querying the SQLite store with line tolerance."
- "Debounces FS events into 200ms batches before forwarding to the indexer."
Bad examples (avoid):
- "This function does something useful with files."
- "A class that handles operations."`;

const MAX_BODY_CHARS = 3000;

const sliceSource = (root: string, node: GraphNode): string | undefined => {
  try {
    const full = readFileSync(join(root, node.filePath), 'utf8');
    const lines = full.split('\n');
    const slice = lines.slice(node.startLine, node.endLine + 1).join('\n');
    return slice.length > MAX_BODY_CHARS
      ? slice.slice(0, MAX_BODY_CHARS) + '\n…'
      : slice;
  } catch (err) {
    log.warn({ err, file: node.filePath }, 'summarize: file read failed');
    return undefined;
  }
};

export class Summarizer {
  constructor(
    private root: string,
    private store: GraphStore,
    private provider: LlmProvider | null,
  ) {}

  isReady(): boolean {
    return this.provider !== null;
  }

  /** Returns a cached or freshly generated summary for `node`, or undefined
   *  if no LLM provider is configured or the source cannot be read. */
  async ensure(node: GraphNode): Promise<string | undefined> {
    if (!this.provider) return undefined;
    if (node.kind === 'file' || node.kind === 'variable') return undefined;

    const cached = this.store.getSummary(
      node.contentHash,
      this.provider.model,
      SUMMARIZER_PROMPT_VERSION,
    );
    if (cached) return cached;

    const source = sliceSource(this.root, node);
    if (!source) return undefined;

    const summary = (
      await this.provider.complete({
        task: 'summarize',
        system: SYSTEM_PROMPT,
        user: `Summarize this ${node.kind} '${node.name}' from ${node.filePath}:\n\n${source}`,
        maxTokens: 120,
      })
    ).trim();

    if (summary.length === 0) return undefined;

    this.store.putSummary(
      node.contentHash,
      this.provider.model,
      SUMMARIZER_PROMPT_VERSION,
      summary,
    );
    return summary;
  }

  /** Bulk version with bounded concurrency. */
  async ensureMany(nodes: GraphNode[], concurrency = 4): Promise<void> {
    if (!this.provider) return;
    let i = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (i < nodes.length) {
        const idx = i++;
        try {
          await this.ensure(nodes[idx]!);
        } catch (err) {
          log.warn({ err, node: nodes[idx]?.id }, 'summarize failed');
        }
      }
    });
    await Promise.all(workers);
  }
}
