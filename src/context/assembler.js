import { MESSAGE_KIND } from './record.js';
import { estimateMessageTokens } from './token-meter.js';

/**
 * Dựng request từ record.
 *
 * Bất biến "model-visible means logged": mọi message/tool/summary gửi model đều
 * nằm trong record; system prompt, tool schema và context runtime là hàm thuần
 * của config + record nên luôn tái dựng được từ dữ liệu đã lưu.
 */

const DEFAULT_MAX_MESSAGE_CHARS = 12_000;

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
 * @param {import('./store.js').StoredMessage} message
 * @param {number} maxChars
 */
function toNimMessage(message, maxChars = DEFAULT_MAX_MESSAGE_CHARS) {
  const kind = message.kind ?? MESSAGE_KIND.TURN;
  const text = clip(message.text, maxChars);

  if (kind === MESSAGE_KIND.SUMMARY || kind === MESSAGE_KIND.CONTEXT) {
    return { role: 'user', content: text };
  }

  if (kind === MESSAGE_KIND.TOOL_CALL) {
    return {
      role: 'assistant',
      content: text || null,
      tool_calls: (message.toolCalls ?? []).map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: call.rawArguments || JSON.stringify(call.arguments ?? {}),
        },
      })),
    };
  }

  if (kind === MESSAGE_KIND.TOOL_RESULT) {
    return { role: 'tool', tool_call_id: message.toolCallId, content: text };
  }

  if (message.role === 'assistant') {
    return { role: 'assistant', content: text };
  }

  return { role: 'user', content: text };
}

/**
 * @param {{systemPrompt: string, tools?: any[], record: any, maxTokens?: number, maxMessages?: number, maxCharsPerMessage?: number, contextWindow?: number, meter?: any}} input
 */
export function assembleRequest(input) {
  const systemPrompt = input.systemPrompt ?? '';
  const tools = input.tools ?? [];
  const record = input.record;
  const all = record?.messages ?? [];
  const calibrate = input.meter?.calibrator?.estimate ?? ((raw) => raw);
  const maxChars = input.maxCharsPerMessage ?? DEFAULT_MAX_MESSAGE_CHARS;
  const budget = input.maxTokens > 0 ? input.maxTokens : Number.POSITIVE_INFINITY;
  const messageCap = input.maxMessages > 0 ? input.maxMessages : Number.POSITIVE_INFINITY;

  let used = calibrate(estimateMessageTokens({ text: systemPrompt }));
  /** @type {number[]} */
  const keptIndexes = [];
  let dropped = 0;

  for (let index = all.length - 1; index >= 0; index -= 1) {
    const message = all[index];
    // Summary là bộ nhớ nén: luôn giữ, và cắt mọi thứ cũ hơn nó.
    if ((message.kind ?? MESSAGE_KIND.TURN) === MESSAGE_KIND.SUMMARY) {
      keptIndexes.unshift(index);
      dropped = index;
      break;
    }
    const cost = calibrate(estimateMessageTokens(message));
    const overCount = keptIndexes.length >= messageCap;
    const overBudget = used + cost > budget && keptIndexes.length >= 4;
    if (overCount || overBudget) {
      dropped = index + 1;
      break;
    }
    keptIndexes.unshift(index);
    used += cost;
  }

  // Không bao giờ mở đầu bằng tool-result mồ côi (tool-call của nó đã bị cắt).
  let start = keptIndexes.length ? keptIndexes[0] : all.length;
  while (start < all.length && (all[start].kind ?? '') === MESSAGE_KIND.TOOL_RESULT) {
    start += 1;
    dropped += 1;
  }
  // Summary là bộ nhớ nén duy nhất còn lại: giữ bản mới nhất kể cả khi nó nằm
  // ngoài range vừa trim (mọi message cũ hơn summary đã bị bỏ).
  let kept = all.slice(start);
  for (let index = start - 1; index >= 0; index -= 1) {
    if ((all[index].kind ?? '') === MESSAGE_KIND.SUMMARY) {
      kept = [all[index], ...kept];
      break;
    }
  }

  /** @type {any[]} */
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const message of kept) {
    messages.push(toNimMessage(message, maxChars));
  }

  const measured = input.meter
    ? input.meter.request({
        systemPrompt,
        tools,
        messages: kept,
        contextWindow: input.contextWindow ?? 0,
      })
    : null;

  return {
    messages,
    tools,
    estimatedTokens: measured?.promptTokens ?? calibrate(used),
    pressure: measured?.pressure ?? null,
    contextWindow: measured?.contextWindow ?? 0,
    dropped,
    keptMessages: kept.length,
    needsSummary: dropped >= 6,
  };
}
