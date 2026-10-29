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

test('stripMention removes the bot name at every position', () => {
  assert.equal(stripMention('@Bot deepseek hello there', ['Bot deepseek']), 'hello there');
  assert.equal(stripMention('hi @Bot deepseek there', ['Bot deepseek']), 'hi there');
  assert.equal(stripMention('Bot deepseek: /help', ['Bot deepseek']), '/help');
  assert.equal(stripMention('no mention here', ['Bot deepseek']), 'no mention here');
  // a bot name that is only a prefix of a longer word must not be stripped
  assert.equal(stripMention('@Anh ơi cho hỏi', ['An']), '@Anh ơi cho hỏi');
  // a bot name without '@' mid-sentence or at the start with content after it is NOT cut
  assert.equal(stripMention('Bot deepseek is what?', ['Bot deepseek']), 'Bot deepseek is what?');
});

test('normalizeWhitespace collapses blank lines', () => {
  assert.equal(normalizeWhitespace('a\r\n\r\n\r\nb   '), 'a\n\nb');
});

test('chunkText respects limit and maxChunks', () => {
  const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} covers a long topic so the message splitting can be exercised.`).join(' ');
  const result = chunkText(long, { limit: 200, maxChunks: 3 });
  assert.equal(result.chunks.length, 3);
  assert.equal(result.truncated, true);
  for (const chunk of result.chunks) assert.ok(chunk.length <= 200, `chunk too long: ${chunk.length}`);
});

test('chunkText keeps code fences balanced', () => {
  const code = `Intro\n\n\`\`\`js\n${'const x = 1;\n'.repeat(60)}\`\`\`\n\nOutro`;
  const result = chunkText(code, { limit: 200 });
  assert.ok(result.chunks.length > 1);
  for (const chunk of result.chunks) {
    const fences = (chunk.match(/```/g) ?? []).length;
    assert.equal(fences % 2, 0, `odd fence in: ${chunk.slice(0, 40)}`);
  }
});

test('chunkText returns short text unchanged', () => {
  const result = chunkText('hello', { limit: 1900 });
  assert.deepEqual(result.chunks, ['hello']);
  assert.equal(result.truncated, false);
});

test('sanitizeZaloMarkdown converts links and tables', () => {
  assert.equal(sanitizeZaloMarkdown('See [here](https://a.com) now'), 'See here (https://a.com) now');
  assert.equal(sanitizeZaloMarkdown('![cat](https://a.com/m.png)'), 'cat (https://a.com/m.png)');
  assert.equal(sanitizeZaloMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |'), 'a · b\n1 · 2');
  assert.equal(sanitizeZaloMarkdown('**bold** and `code`'), '**bold** and `code`');
});

test('prepareOutgoing applies parseMode', () => {
  assert.equal(prepareOutgoing('[x](https://a.com) 😊', { parseMode: 'markdown' }), 'x (https://a.com) 😊');
  assert.equal(prepareOutgoing('[x](https://a.com)', { parseMode: 'none' }), '[x](https://a.com)');
});

test('truncate and formatDuration', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(65_000), '1m5s');
});
