import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateMessageTokens, estimateTextTokens, createCalibrator, IMAGE_TOKENS } from '../src/context/tokens.js';
import { buildMessages } from '../src/context/builder.js';

function makeRecord(messages, summary = '') {
  return {
    chatId: 'chat-1',
    chatType: 'GROUP',
    summary,
    messages,
    turns: 0,
    updatedAt: 0,
    meta: { thinking: null },
  };
}

test('estimate tăng theo độ dài', () => {
  assert.equal(estimateTextTokens(''), 0);
  assert.ok(estimateTextTokens('a'.repeat(320)) > estimateTextTokens('a'.repeat(32)));
  assert.ok(estimateMessageTokens({ text: 'abc', imageUrl: 'https://x/y.png' }) > IMAGE_TOKENS);
});

test('calibrator kẹp trong biên', () => {
  const cal = createCalibrator();
  cal.observe(100, 300);
  assert.ok(cal.ratio() <= 2.5);
  cal.observe(100, 1);
  assert.ok(cal.ratio() >= 0.5);
});

test('buildMessages giữ system + lượt gần nhất', () => {
  const messages = [];
  for (let i = 0; i < 60; i += 1) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', text: `tin ${i}`, ts: i });
  }
  const built = buildMessages({
    systemPrompt: 'system',
    record: makeRecord(messages),
    maxTokens: 6000,
    maxMessages: 10,
    calibrator: { estimate: (raw) => raw },
  });
  assert.equal(built.messages[0].role, 'system');
  assert.equal(built.messages[0].content, 'system');
  const convo = built.messages.slice(1);
  assert.ok(convo.length <= 10);
  assert.equal(convo.at(-1).content, 'tin 59');
  assert.equal(built.needsSummary, true);
});

test('buildMessages chèn summary', () => {
  const built = buildMessages({
    systemPrompt: 'system',
    record: makeRecord([{ role: 'user', text: 'xin chào', ts: 1 }], 'Người dùng tên Nam.'),
    maxTokens: 6000,
    maxMessages: 40,
  });
  assert.equal(built.messages[1].role, 'system');
  assert.match(String(built.messages[1].content), /Nam/);
  assert.equal(built.needsSummary, false);
});

test('buildMessages không giới hạn khi maxTokens/maxMessages = 0', () => {
  const messages = [];
  for (let i = 0; i < 80; i += 1) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', text: `tin ${i}`, ts: i });
  }
  const built = buildMessages({
    systemPrompt: 'system',
    record: makeRecord(messages),
    maxTokens: 0,
    maxMessages: 0,
    calibrator: { estimate: (raw) => raw },
  });
  assert.equal(built.messages.length, 81);
  assert.equal(built.dropped, 0);
  assert.equal(built.needsSummary, false);
  assert.equal(built.messages.at(-1).content, 'tin 79');
});

test('maxCharsPerMessage=0 không cắt tin dài', () => {
  const long = { role: 'user', text: 'x'.repeat(20_000), ts: 1 };
  const built = buildMessages({
    systemPrompt: 'system',
    record: makeRecord([long]),
    maxTokens: 0,
    maxMessages: 0,
    maxCharsPerMessage: 0,
    calibrator: { estimate: (raw) => raw },
  });
  assert.equal(String(built.messages[1].content).length, 20_000);
});

test('maxImages điều khiển số ảnh gửi kèm', () => {
  const messages = [1, 2, 3].map((i) => ({
    role: 'user',
    text: `ảnh ${i}`,
    imageUrl: `https://x/${i}.png`,
    ts: i,
  }));
  const built = buildMessages({
    systemPrompt: 'system',
    record: makeRecord(messages),
    maxTokens: 0,
    maxMessages: 0,
    maxImages: 1,
  });
  assert.equal(built.messages.filter((message) => Array.isArray(message.content)).length, 1);
});

test('buildMessages giới hạn 2 ảnh trong context', () => {
  const messages = [1, 2, 3].map((i) => ({
    role: 'user',
    text: `ảnh ${i}`,
    imageUrl: `https://x/${i}.png`,
    ts: i,
  }));
  const built = buildMessages({
    systemPrompt: 'system',
    record: makeRecord(messages),
    maxTokens: 6000,
    maxMessages: 40,
  });
  const withImage = built.messages.filter((message) => Array.isArray(message.content));
  assert.equal(withImage.length, 2);
  const textOnly = built.messages.filter((message) => typeof message.content === 'string');
  assert.ok(textOnly.some((message) => message.content.startsWith('[ảnh đã gửi]')));
});
