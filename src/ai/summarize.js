import { truncate } from '../text/format.js';
import { SUMMARY_SYSTEM_PROMPT, buildSummaryInput } from './prompt/index.js';

/**
 * Summarizer used for compaction — keeps the chat's route when a record is present.
 * @param {{llm: any, logger?: import('../logger.js').Logger}} options
 */
export function createSummarizer(options) {
  const llm = options.llm;

  /**
   * @param {any[]} messages
   * @param {number} [deadline]
   * @param {any} [record]
   */
  return async function summarize(messages, deadline = Number.POSITIVE_INFINITY, record = null) {
    if (!messages?.length) return '';
    const left = deadline - Date.now();
    // 0 = no deadline for the reply, but a summary is auxiliary work: keep it bounded.
    const timeout = Number.isFinite(left) ? Math.min(15_000, Math.max(3000, left)) : 15_000;
    const response = await llm.chat({
      ...(record ? { record } : {}),
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: buildSummaryInput(messages) },
      ],
      reasoning: 'none',
      temperature: 0.3,
      maxTokens: 200,
      timeoutMs: timeout,
      ...(timeout > 0 ? { signal: AbortSignal.timeout(timeout) } : {}),
    });
    return truncate(String(response.content ?? '').trim(), 900);
  };
}
