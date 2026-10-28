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
  return async function summarize(messages, deadline = Date.now() + 15_000, record = null) {
    if (!messages?.length) return '';
    const timeout = Math.min(15_000, Math.max(3000, deadline - Date.now()));
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
      signal: AbortSignal.timeout(timeout),
    });
    return truncate(String(response.content ?? '').trim(), 900);
  };
}
