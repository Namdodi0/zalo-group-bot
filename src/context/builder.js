import { estimateMessageTokens } from './tokens.js';

const DEFAULT_MAX_MESSAGE_CHARS = 12_000;
const DEFAULT_MAX_IMAGES = 2;

/**
 * @param {string} text
 * @param {number} limit 0 = không cắt
 */
function clip(text, limit) {
  const value = String(text ?? '');
  if (!limit || limit <= 0 || value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Chuyển 1 message đã lưu sang format OpenAI (NIM).
 * @param {import('./store.js').StoredMessage} message
 * @param {boolean} includeImage
 * @param {number} maxChars
 */
function toNimMessage(message, includeImage, maxChars = DEFAULT_MAX_MESSAGE_CHARS) {
  const text = clip(message.text, maxChars);
  if (includeImage && message.imageUrl) {
    return {
      role: message.role,
      content: [
        { type: 'text', text: text || 'Hãy mô tả ảnh này.' },
        { type: 'image_url', image_url: { url: message.imageUrl } },
      ],
    };
  }
  const prefix = message.imageUrl ? '[ảnh đã gửi] ' : '';
  return { role: message.role, content: `${prefix}${text}` };
}

/**
 * Dựng mảng messages gửi NIM trong giới hạn token/lượt.
 * Luôn giữ system prompt + summary + các lượt gần nhất.
 * @param {{systemPrompt: string, record: import('./store.js').ChatRecord, maxTokens: number, maxMessages: number, maxCharsPerMessage?: number, maxImages?: number, calibrator?: {estimate: (raw: number) => number}}} input
 */
export function buildMessages(input) {
  const { systemPrompt, record, maxTokens, maxMessages } = input;
  const calibrate = input.calibrator?.estimate ?? ((raw) => raw);
  const maxChars = input.maxCharsPerMessage ?? DEFAULT_MAX_MESSAGE_CHARS;
  const maxImages = Math.max(1, input.maxImages ?? DEFAULT_MAX_IMAGES);

  // 0 / không hợp lệ = không giới hạn
  const budget = maxTokens > 0 ? maxTokens : Number.POSITIVE_INFINITY;
  const messageCap = maxMessages > 0 ? maxMessages : Number.POSITIVE_INFINITY;
  const summaryText = record.summary ? `Tóm tắt hội thoại trước đó:\n${record.summary}` : '';
  const systemTokens = calibrate(estimateMessageTokens({ text: systemPrompt }) + estimateMessageTokens({ text: summaryText }));

  let used = systemTokens;
  /** @type {import('./store.js').StoredMessage[]} */
  const picked = [];
  let dropped = 0;

  for (let index = record.messages.length - 1; index >= 0; index -= 1) {
    const message = record.messages[index];
    const cost = calibrate(estimateMessageTokens(message));
    const overCount = picked.length >= messageCap;
    const overBudget = used + cost > budget && picked.length >= 4;
    if (overCount || overBudget) {
      dropped += 1;
      continue;
    }
    picked.unshift(message);
    used += cost;
  }

  const imageSlots = new Set();
  let images = 0;
  for (let index = picked.length - 1; index >= 0 && images < maxImages; index -= 1) {
    if (picked[index].imageUrl) {
      imageSlots.add(index);
      images += 1;
    }
  }

  /** @type {Array<{role: string, content: unknown}>} */
  const messages = [{ role: 'system', content: systemPrompt }];
  if (summaryText) messages.push({ role: 'system', content: summaryText });
  picked.forEach((message, index) => {
    messages.push(toNimMessage(message, imageSlots.has(index), maxChars));
  });

  return {
    messages,
    estimatedTokens: used,
    dropped,
    needsSummary: dropped >= 6,
    keptMessages: picked.length,
  };
}

export const __test__ = { toNimMessage, clip };
