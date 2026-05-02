import { AnthropicProvider } from './anthropic.js';
import { MockLlmProvider } from './mock.js';
import type { LlmProvider } from './provider.js';

export type LlmConfig =
  | { provider: 'none' }
  | { provider: 'mock' }
  | {
      provider: 'anthropic';
      model?: string;
      apiKey?: string;
      maxTokens?: number;
    };

export const buildLlmProvider = (cfg: LlmConfig): LlmProvider | null => {
  switch (cfg.provider) {
    case 'none':
      return null;
    case 'mock':
      return new MockLlmProvider();
    case 'anthropic':
      return new AnthropicProvider(cfg);
  }
};

export type { LlmProvider, LlmRequest, LlmTask } from './provider.js';
