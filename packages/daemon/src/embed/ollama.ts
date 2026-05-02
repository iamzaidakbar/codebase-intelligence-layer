import type { EmbeddingProvider } from './provider.js';

/**
 * Embeds via local Ollama. Uses /api/embeddings which returns one vector per
 * request, so we serialize within a batch. Fast enough for incremental work;
 * for cold scans, parallelize at the indexer level if needed.
 */
export class OllamaEmbedder implements EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  private readonly url: string;

  constructor(opts?: { model?: string; url?: string; dim?: number }) {
    this.model = opts?.model ?? 'nomic-embed-text';
    this.url = (opts?.url ?? 'http://localhost:11434').replace(/\/$/, '');
    this.dim = opts?.dim ?? 768; // nomic-embed-text default
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const text of texts) {
      const res = await fetch(`${this.url}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
      if (!res.ok) {
        throw new Error(
          `ollama embed failed (${res.status}): ${await res.text()}`,
        );
      }
      const data = (await res.json()) as { embedding: number[] };
      const v = Float32Array.from(data.embedding);
      if (v.length !== this.dim) {
        throw new Error(
          `ollama dim mismatch: expected ${this.dim}, got ${v.length}`,
        );
      }
      out.push(v);
    }
    return out;
  }
}
