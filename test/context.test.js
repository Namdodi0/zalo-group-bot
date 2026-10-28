import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleRequest } from '../src/context/assembler.js';
import {
  contextEntry,
  freshRecord,
  summaryEntry,
  toolCallEntry,
  toolResultEntry,
} from '../src/context/record.js';
import { createTokenMeter, estimateMessageTokens, estimateTextTokens } from '../src/context/token-meter.js';

function assemble(messages, overrides = {}) {
  const record = freshRecord('chat-1', 'GROUP', 0);
  record.messages.push(...messages);
  return assembleRequest({ systemPrompt: 'system', record, maxTokens: 0, maxMessages: 0, ...overrides });
}

test('estimate tăng theo độ dài', () => {
  assert.equal(estimateTextTokens(''), 0);
  assert.ok(estimateTextTokens('a'.repeat(320)) > estimateTextTokens('a'.repeat(32)));
  assert.ok(estimateMessageTokens({ text: 'abc' }) > 0);
});

test('assemble giữ system + lượt gần nhất, báo dropped/needsSummary', () => {
  const messages = [];
  for (let i = 0; i < 60; i += 1) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', text: `tin ${i}`, ts: i });
  }
  const built = assemble(messages, { maxTokens: 6000, maxMessages: 10, meter: createTokenMeter() });
  assert.equal(built.messages[0].role, 'system');
  assert.equal(built.messages[0].content, 'system');
  const convo = built.messages.slice(1);
  assert.ok(convo.length <= 10);
  assert.equal(convo.at(-1).content, 'tin 59');
  assert.equal(built.needsSummary, true);
});

test('summary là message user, không phải system', () => {
  const built = assemble([summaryEntry('Người dùng tên Nam.', 1), { role: 'user', text: 'xin chào', ts: 2 }]);
  assert.equal(built.messages[1].role, 'user');
  assert.match(String(built.messages[1].content), /Nam/);
  assert.equal(built.messages.filter((message) => message.role === 'system').length, 1);
});

test('summary luôn được giữ khi trim', () => {
  const messages = [summaryEntry('nhớ tên Nam', 0)];
  for (let i = 0; i < 30; i += 1) messages.push({ role: i % 2 ? 'assistant' : 'user', text: `tin ${i}`, ts: i + 1 });
  const built = assemble(messages, { maxMessages: 4 });
  assert.equal(built.messages[1].role, 'user');
  assert.match(String(built.messages[1].content), /Nam/);
});

test('không giới hạn khi maxTokens/maxMessages = 0', () => {
  const messages = [];
  for (let i = 0; i < 80; i += 1) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', text: `tin ${i}`, ts: i });
  }
  const built = assemble(messages);
  assert.equal(built.messages.length, 81);
  assert.equal(built.dropped, 0);
  assert.equal(built.needsSummary, false);
  assert.equal(built.messages.at(-1).content, 'tin 79');
});

test('maxCharsPerMessage=0 không cắt tin dài', () => {
  const built = assemble([{ role: 'user', text: 'x'.repeat(20_000), ts: 1 }], { maxCharsPerMessage: 0 });
  assert.equal(String(built.messages[1].content).length, 20_000);
});

test('ảnh không bao giờ được gửi vào model (text-only)', () => {
  const built = assemble([
    { role: 'user', text: 'xem ảnh này', imageUrl: 'https://x/1.png', ts: 1 },
    { role: 'user', text: 'ảnh 2', imageUrl: 'https://x/2.png', ts: 2 },
  ]);
  assert.equal(built.messages.some((message) => Array.isArray(message.content)), false);
  assert.equal(built.messages[1].content, 'xem ảnh này');
});

test('tool-call/tool-result map đúng wire format, không mở đầu bằng tool-result mồ côi', () => {
  const messages = [
    toolCallEntry({ toolCalls: [{ id: 'c1', name: 'web_search', arguments: { query: 'x' } }], ts: 1 }),
    toolResultEntry({ toolCallId: 'c1', text: 'kết quả', ts: 2 }),
    { role: 'user', text: 'cảm ơn', ts: 3 },
  ];
  const built = assemble(messages, { maxMessages: 10 });
  assert.equal(built.messages[1].role, 'assistant');
  assert.equal(built.messages[1].tool_calls[0].function.name, 'web_search');
  assert.equal(built.messages[2].role, 'tool');
  assert.equal(built.messages[2].tool_call_id, 'c1');
  assert.equal(built.messages[3].content, 'cảm ơn');

  const trimmed = assemble(messages, { maxMessages: 2 });
  assert.equal(trimmed.messages[1].content, 'cảm ơn');
});

test('context entry được gửi với role user', () => {
  const built = assemble([contextEntry({ source: 'runtime:time', text: '[Thời gian hiện tại: hôm nay]', ts: 1 })]);
  assert.equal(built.messages[1].role, 'user');
  assert.equal(built.messages[1].content, '[Thời gian hiện tại: hôm nay]');
});

test('pressure tính khi biết context window', () => {
  const built = assemble([{ role: 'user', text: 'x'.repeat(400), ts: 1 }], {
    meter: createTokenMeter(),
    contextWindow: 100,
  });
  assert.ok(built.pressure > 0);
  assert.equal(built.contextWindow, 100);
});
