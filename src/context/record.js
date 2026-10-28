export const SCHEMA_VERSION = 2;

export const MESSAGE_KIND = {
  TURN: 'turn',
  CONTEXT: 'context',
  SUMMARY: 'summary',
  TOOL_CALL: 'tool-call',
  TOOL_RESULT: 'tool-result',
};

/**
 * @param {string} chatId
 * @param {string} chatType
 * @param {number} [now]
 */
export function freshRecord(chatId, chatType, now = Date.now()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    chatId,
    chatType,
    messages: [],
    turns: 0,
    updatedAt: now,
    meta: { thinking: null },
    seen: [],
  };
}

/**
 * Nâng record cũ (v1: summary là field riêng) lên v2 mà không mất dữ liệu.
 * @param {any} record
 */
export function normalizeRecord(record) {
  if (!record.meta) record.meta = { thinking: null };
  if (!Array.isArray(record.messages)) record.messages = [];
  if (!Array.isArray(record.seen)) record.seen = [];
  for (const message of record.messages) {
    if (!message.kind) message.kind = MESSAGE_KIND.TURN;
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    const legacySummary = typeof record.summary === 'string' ? record.summary.trim() : '';
    if (legacySummary && !record.messages.some((message) => message.kind === MESSAGE_KIND.SUMMARY)) {
      record.messages.unshift(summaryEntry(legacySummary, record.updatedAt ?? Date.now()));
    }
    delete record.summary;
    record.schemaVersion = SCHEMA_VERSION;
  }
  return record;
}

/**
 * @param {{role?: string, text: string, name?: string, ts?: number, messageId?: string}} input
 */
export function turnEntry(input) {
  return {
    role: input.role ?? 'user',
    kind: MESSAGE_KIND.TURN,
    text: input.text,
    ...(input.name ? { name: input.name } : {}),
    ts: input.ts ?? Date.now(),
    ...(input.messageId ? { messageId: input.messageId } : {}),
  };
}

/**
 * Dynamic context sinh từ provider runtime (thời gian, search...), materialize
 * thành message user bền vững và được refresh mỗi lượt.
 * @param {{source: string, text: string, ts?: number}} input
 */
export function contextEntry(input) {
  return {
    role: 'user',
    kind: MESSAGE_KIND.CONTEXT,
    source: input.source,
    text: input.text,
    ts: input.ts ?? Date.now(),
  };
}

/** @param {string} text @param {number} [ts] */
export function summaryEntry(text, ts = Date.now()) {
  return {
    role: 'user',
    kind: MESSAGE_KIND.SUMMARY,
    source: 'compaction',
    text,
    ts,
  };
}

/** @param {string} text @param {number} [ts] */
export function searchEntry(text, ts = Date.now()) {
  return contextEntry({ source: 'search', text, ts });
}

/**
 * @param {{content?: string, toolCalls: Array<{id: string, name: string, arguments: any, rawArguments?: string}>, ts?: number}} input
 */
export function toolCallEntry(input) {
  return {
    role: 'assistant',
    kind: MESSAGE_KIND.TOOL_CALL,
    text: input.content ?? '',
    toolCalls: input.toolCalls,
    ts: input.ts ?? Date.now(),
  };
}

/**
 * @param {{toolCallId: string, text: string, ts?: number}} input
 */
export function toolResultEntry(input) {
  return {
    role: 'tool',
    kind: MESSAGE_KIND.TOOL_RESULT,
    toolCallId: input.toolCallId,
    text: input.text,
    ts: input.ts ?? Date.now(),
  };
}

/**
 * @param {any} record
 * @param {any} entry
 */
function insertBeforeLastTurn(record, entry) {
  const messages = record.messages;
  let index = messages.length - 1;
  while (index >= 0) {
    const message = messages[index];
    if (message.role === 'user' && (message.kind ?? MESSAGE_KIND.TURN) === MESSAGE_KIND.TURN) break;
    index -= 1;
  }
  messages.splice(index >= 0 ? index : messages.length, 0, entry);
}

/**
 * Đồng bộ context runtime: gỡ entry cũ cùng source, chèn bản mới trước lượt user cuối.
 * @param {any} record
 * @param {Array<{name: string, text: string}>} contexts
 * @param {number} [ts]
 */
export function syncContexts(record, contexts, ts = Date.now()) {
  for (const context of contexts ?? []) {
    record.messages = record.messages.filter(
      (message) => !(message.kind === MESSAGE_KIND.CONTEXT && message.source === context.name),
    );
    if (context.text) {
      insertBeforeLastTurn(record, contextEntry({ source: context.name, text: context.text, ts }));
    }
  }
  return record;
}

/** @param {any} record */
export function latestSummary(record) {
  const messages = record?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].kind === MESSAGE_KIND.SUMMARY) return messages[index].text;
  }
  return '';
}

/**
 * Range [start, end) có cắt đôi cặp tool-call/tool-result không.
 * @param {any[]} messages
 * @param {number} start
 * @param {number} end
 */
export function toolPairingBalanced(messages, start, end) {
  const callIds = new Set();
  const resultIds = new Set();
  for (let index = start; index < end; index += 1) {
    const message = messages[index];
    for (const call of message?.toolCalls ?? []) callIds.add(call.id);
    if (message?.kind === MESSAGE_KIND.TOOL_RESULT && message.toolCallId) resultIds.add(message.toolCallId);
  }
  for (const id of resultIds) if (!callIds.has(id)) return false;
  for (const id of callIds) if (!resultIds.has(id)) return false;
  return true;
}
