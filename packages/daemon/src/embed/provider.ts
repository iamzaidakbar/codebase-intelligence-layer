export interface EmbeddingProvider {
  /** Stable model identifier — used as part of the cache key. */
  readonly model: string;
  /** Vector dimension. Must match what `embed()` returns. */
  readonly dim: number;
  /** Embed a batch of texts. Returns one Float32Array per input, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
}
