import { MESSAGE_KIND, summaryEntry, toolPairingBalanced } from '../record.js';

/**
 * Compress an old range into a SINGLE summary message (user role), replacing exactly
 * that range. The range must have balanced tool-call/tool-result pairs.
 * @param {any} record
 * @param {{keepRecent: number, summaryMaxChars: number, deadline?: number, summarize: (messages: any[], deadline?: number, record?: any) => Promise<string>}} options
 */
export async function summarizeRange(record, options) {
  const messages = record.messages ?? [];
  const keepRecent = Math.max(1, Number(options.keepRecent ?? 8));
  let cut = Math.max(0, messages.length - keepRecent);
  if (cut <= 0) return { changed: false };

  while (cut > 0 && !toolPairingBalanced(messages, 0, cut)) cut -= 1;
  if (cut <= 0) return { changed: false };

  const range = messages.slice(0, cut);
  if (!range.some((message) => (message.kind ?? MESSAGE_KIND.TURN) === MESSAGE_KIND.TURN)) {
    return { changed: false };
  }

  const summary = await options.summarize(range, options.deadline, record);
  const text = String(summary ?? '').trim();
  if (!text) return { changed: false };

  const maxChars = Math.max(100, Number(options.summaryMaxChars ?? 1200));
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
  record.messages = [summaryEntry(clipped), ...messages.slice(cut)];
  return { changed: true };
}
