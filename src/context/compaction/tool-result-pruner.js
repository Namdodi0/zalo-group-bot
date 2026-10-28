import { MESSAGE_KIND } from '../record.js';

/**
 * Shorten old tool-results to reduce context pressure before summarization is needed.
 * Only touches tool-results, never the tool-call pairs.
 * @param {any} record
 * @param {{keepChars: number, keepRecent?: number}} options
 */
export function pruneToolResults(record, options) {
  const keepChars = Math.max(0, Number(options.keepChars ?? 0));
  const keepRecent = Math.max(0, Number(options.keepRecent ?? 0));
  const messages = record.messages ?? [];
  let changed = false;

  for (let index = 0; index < messages.length - keepRecent; index += 1) {
    const message = messages[index];
    if ((message.kind ?? '') !== MESSAGE_KIND.TOOL_RESULT) continue;
    if (message.pruned) continue;
    const text = String(message.text ?? '');
    if (text.length <= keepChars) continue;

    if (keepChars === 0) {
      message.text = `[tool result pruned: ${text.length} chars]`;
    } else {
      const headLength = Math.floor(keepChars * 0.6);
      const tailLength = Math.max(0, keepChars - headLength);
      const head = text.slice(0, headLength);
      const tail = tailLength ? text.slice(-tailLength) : '';
      message.text = `${head}\n… [pruned ${text.length - keepChars} chars] …${tail ? `\n${tail}` : ''}`;
    }
    message.pruned = true;
    changed = true;
  }

  return { changed };
}
