import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from './provider.js';

/**
 * Deterministic, dependency-free embedder. Uses token hashes to populate a
 * fixed-dimensional vector. Quality is poor compared to a real model — this
 * is a pipeline-test stand-in, not a production provider. It exists so the
 * search loop can be validated end-to-end without Ollama or an API key.
 *
 * Strategy: tokenize on word boundaries; for each token, hash it to seed
 * 8 "writes" into the vector at pseudo-random positions, with values
 * derived from the rest of the hash. Then L2-normalize. Common identifiers
 * landing in the same buckets across query+document gives a usable signal.
 */
export class HashEmbedder implements EmbeddingProvider {
  readonly model = 'hash-v1';
  readonly dim: number;

  constructor(dim = 128) {
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const tokens = text.toLowerCase().match(/[a-z][a-z0-9_]{1,}/g) ?? [];
    for (const tok of tokens) {
      const h = createHash('sha1').update(tok).digest();
      // h is 20 bytes; do 5 paired (index, value) writes.
      for (let i = 0; i < 5; i++) {
        const idx =
          ((h[i * 2] ?? 0) << 8) | (h[i * 2 + 1] ?? 0);
        const val = ((h[10 + i] ?? 0) - 127) / 127;
        v[idx % this.dim]! += val;
      }
    }
    // L2 normalize
    let mag = 0;
    for (const x of v) mag += x * x;
    const norm = Math.sqrt(mag) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= norm;
    return v;
  }
}
