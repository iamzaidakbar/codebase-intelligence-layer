import { HashEmbedder } from './hash.js';
import { OllamaEmbedder } from './ollama.js';
import type { EmbeddingProvider } from './provider.js';

export type EmbeddingConfig =
  | { provider: 'none' }
  | { provider: 'hash'; dim?: number }
  | { provider: 'ollama'; model?: string; url?: string; dim?: number };

export const buildProvider = (
  cfg: EmbeddingConfig,
): EmbeddingProvider | null => {
  switch (cfg.provider) {
    case 'none':
      return null;
    case 'hash':
      return new HashEmbedder(cfg.dim);
    case 'ollama':
      return new OllamaEmbedder(cfg);
  }
};

export type { EmbeddingProvider } from './provider.js';
