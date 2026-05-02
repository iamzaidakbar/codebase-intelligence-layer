import type { LlmProvider, LlmRequest } from './provider.js';

/**
 * Deterministic mock used by tests + smoke runs. Returns templated answers
 * keyed off the `task` hint. For `synthesize`, it cites every evidence item
 * it finds in the user prompt — that's what the citation validator gets to
 * exercise. Quality is intentionally low; this exists to verify the
 * end-to-end loop without an API key.
 */
export class MockLlmProvider implements LlmProvider {
  readonly model = 'mock-v1';

  async complete(req: LlmRequest): Promise<string> {
    if (req.task === 'summarize') {
      const m = req.user.match(/Summarize this (\w+) ['"]([^'"]+)['"]/);
      const kind = m?.[1] ?? 'symbol';
      const name = m?.[2] ?? 'unknown';
      return `Mock summary: ${kind} ${name} — performs work related to its name; see source for specifics.`;
    }
    if (req.task === 'synthesize') {
      // Find evidence indices [N] in the prompt.
      const seen = new Set<number>();
      for (const m of req.user.matchAll(/\[(\d+)\]/g)) {
        const n = parseInt(m[1]!, 10);
        if (!Number.isNaN(n)) seen.add(n);
      }
      const cites = [...seen].slice(0, 3);
      if (cites.length === 0) {
        return "I don't have enough evidence to answer that.";
      }
      const citeText = cites.map((n) => `[${n}]`).join(' and ');
      // Include one deliberately bad citation to test the validator.
      const bogus = ` Spurious reference [999] to verify the citation validator.`;
      return `Based on the available code, the relevant components are ${citeText}.${bogus} (mock answer)`;
    }
    return '(mock)';
  }
}
