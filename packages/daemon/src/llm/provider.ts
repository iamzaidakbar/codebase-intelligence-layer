export type LlmTask = 'summarize' | 'synthesize';

export interface LlmRequest {
  /** System prompt — stable across calls of the same task; cached when supported. */
  system: string;
  /** User message — varies per request. */
  user: string;
  maxTokens?: number;
  /** Optional task hint — production providers ignore it; the mock uses it
   *  to pick a deterministic response template so tests can validate the
   *  pipeline without consuming API credit. */
  task?: LlmTask;
}

export interface LlmProvider {
  /** Stable model identifier — used as part of the summary cache key. */
  readonly model: string;
  complete(req: LlmRequest): Promise<string>;
}
