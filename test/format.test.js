import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkText,
  formatDuration,
  normalizeWhitespace,
  prepareOutgoing,
  sanitizeZaloMarkdown,
  stripMention,
  truncate,
} from '../src/text/format.js';

test('stripMention bỏ tên bot ở mọi vị trí', () => {
  assert.equal(stripMention('@Bot deepseek chào bạn', ['Bot deepseek']), 'chào bạn');
  assert.equal(stripMention('chào @Bot deepseek nhé', ['Bot deepseek']), 'chào nhé');
  assert.equal(stripMention('Bot deepseek: /help', ['Bot deepseek']), '/help');
  assert.equal(stripMention('không có mention', ['Bot deepseek']), 'không có mention');
  // tên bot không có '@' giữa câu/đầu câu có nội dung phía sau thì KHÔNG cắt
  assert.equal(stripMention('Bot deepseek là gì?', ['Bot deepseek']), 'Bot deepseek là gì?');
});

test('normalizeWhitespace gộp dòng trống', () => {
  assert.equal(normalizeWhitespace('a\r\n\r\n\r\nb   '), 'a\n\nb');
});

test('chunkText tôn trọng limit và maxChunks', () => {
  const long = Array.from({ length: 60 }, (_, i) => `Câu số ${i} nói về một chủ đề dài để kiểm tra việc cắt tin nhắn.`).join(' ');
  const result = chunkText(long, { limit: 200, maxChunks: 3 });
  assert.equal(result.chunks.length, 3);
  assert.equal(result.truncated, true);
  for (const chunk of result.chunks) assert.ok(chunk.length <= 200, `chunk dài ${chunk.length}`);
});

test('chunkText giữ code fence cân bằng', () => {
  const code = `Mở đầu\n\n\`\`\`js\n${'const x = 1;\n'.repeat(60)}\`\`\`\n\nKết thúc`;
  const result = chunkText(code, { limit: 200 });
  assert.ok(result.chunks.length > 1);
  for (const chunk of result.chunks) {
    const fences = (chunk.match(/```/g) ?? []).length;
    assert.equal(fences % 2, 0, `fence lẻ trong: ${chunk.slice(0, 40)}`);
  }
});

test('chunkText văn bản ngắn trả nguyên vẹn', () => {
  const result = chunkText('xin chào', { limit: 1900 });
  assert.deepEqual(result.chunks, ['xin chào']);
  assert.equal(result.truncated, false);
});

test('sanitizeZaloMarkdown chuyển link và bảng', () => {
  assert.equal(sanitizeZaloMarkdown('Xem [tại đây](https://a.com) nhé'), 'Xem tại đây (https://a.com) nhé');
  assert.equal(sanitizeZaloMarkdown('![mèo](https://a.com/m.png)'), 'mèo (https://a.com/m.png)');
  assert.equal(sanitizeZaloMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |'), 'a · b\n1 · 2');
  assert.equal(sanitizeZaloMarkdown('**đậm** và `code`'), '**đậm** và `code`');
});

test('prepareOutgoing áp dụng parseMode', () => {
  assert.equal(prepareOutgoing('[x](https://a.com) 😊', { parseMode: 'markdown' }), 'x (https://a.com) 😊');
  assert.equal(prepareOutgoing('[x](https://a.com)', { parseMode: 'none' }), '[x](https://a.com)');
});

test('truncate và formatDuration', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(65_000), '1m5s');
});
