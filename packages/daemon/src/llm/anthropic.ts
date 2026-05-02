import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider, LlmRequest } from './provider.js';

/**
 * Wraps the Anthropic SDK. The system block is sent with `cache_control:
 * { type: 'ephemeral' }` so repeat calls with the same system prompt
 * (i.e., every summarize or every synthesize) hit the prompt cache after
 * the first one — large savings during scans.
 */
export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;
  readonly model: string;
  private readonly maxTokensDefault: number;

  constructor(opts?: { model?: string; apiKey?: string; maxTokens?: number }) {
    this.model = opts?.model ?? 'claude-haiku-4-5-20251001';
    this.maxTokensDefault = opts?.maxTokens ?? 1024;
    this.client = new Anthropic({
      apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
  }

  async complete(req: LlmRequest): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? this.maxTokensDefault,
      system: [
        {
          type: 'text',
          text: req.system,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: req.user }],
    });

    let out = '';
    for (const block of res.content) {
      if (block.type === 'text') out += block.text;
    }
    return out;
  }
}
