import { MESSAGE_KIND } from '../record.js';

/**
 * Rút gọn tool-result cũ để giảm áp lực context trước khi phải tóm tắt.
 * Chỉ sửa tool-result, không đụng cặp tool-call.
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
      message.text = `[kết quả tool đã rút gọn: ${text.length} ký tự]`;
    } else {
      const headLength = Math.floor(keepChars * 0.6);
      const tailLength = Math.max(0, keepChars - headLength);
      const head = text.slice(0, headLength);
      const tail = tailLength ? text.slice(-tailLength) : '';
      message.text = `${head}\n… [đã rút gọn ${text.length - keepChars} ký tự] …${tail ? `\n${tail}` : ''}`;
    }
    message.pruned = true;
    changed = true;
  }

  return { changed };
}
