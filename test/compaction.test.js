import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompactionEngine } from '../src/context/compaction/engine.js';
import { summarizeRange } from '../src/context/compaction/summarizer.js';
import { pruneToolResults } from '../src/context/compaction/tool-result-pruner.js';
import { freshRecord, toolCallEntry, toolResultEntry } from '../src/context/record.js';
import { makeConfig, silentLogger } from '../test-utils/helpers.js';

function recordWith(messages) {
  const record = freshRecord('c', 'GROUP', 1);
  record.messages.push(...messages);
  return record;
}

function turns(count) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    kind: 'turn',
    text: `tin ${index}`,
    ts: index,
  }));
}

test('pruner chỉ rút gọn tool-result cũ, giữ nguyên cặp tool-call', () => {
  const record = recordWith([
    toolCallEntry({ toolCalls: [{ id: 'c1', name: 'web_search', arguments: {} }], ts: 1 }),
    toolResultEntry({ toolCallId: 'c1', text: 'x'.repeat(5000), ts: 2 }),
    { role: 'user', kind: 'turn', text: 'gần đây', ts: 3 },
    { role: 'assistant', kind: 'turn', text: 'ok', ts: 4 },
  ]);

  const result = pruneToolResults(record, { keepChars: 600, keepRecent: 2 });
  assert.equal(result.changed, true);
  assert.ok(record.messages[1].text.length < 1000);
  assert.match(record.messages[1].text, /đã rút gọn/);
  assert.equal(record.messages[0].toolCalls.length, 1);
});

test('summarizer thay range cũ bằng đúng một message summary user-role', async () => {
  const record = recordWith(turns(10));
  const result = await summarizeRange(record, {
    keepRecent: 4,
    summaryMaxChars: 200,
    summarize: async () => 'TÓM TẮT',
  });
  assert.equal(result.changed, true);
  assert.equal(record.messages[0].kind, 'summary');
  assert.equal(record.messages[0].role, 'user');
  assert.equal(record.messages[0].text, 'TÓM TẮT');
  assert.equal(record.messages.length, 5);
});

test('summarizer lùi boundary để không cắt đôi cặp tool-call/tool-result', async () => {
  const messages = turns(4);
  messages.push(toolCallEntry({ toolCalls: [{ id: 'c1', name: 'web_search', arguments: {} }], ts: 4 }));
  messages.push(toolResultEntry({ toolCallId: 'c1', text: 'kết quả', ts: 5 }));
  messages.push(...turns(4));
  const record = recordWith(messages);

  await summarizeRange(record, {
    keepRecent: 5,
    summaryMaxChars: 200,
    summarize: async (range) => {
      assert.equal(range.some((message) => message.kind === 'tool-result'), false);
      return 'T';
    },
  });
  assert.equal(record.messages[0].kind, 'summary');
});

test('summarizer không làm gì khi range quá ngắn', async () => {
  const record = recordWith(turns(3));
  const result = await summarizeRange(record, {
    keepRecent: 8,
    summaryMaxChars: 200,
    summarize: async () => 'T',
  });
  assert.equal(result.changed, false);
  assert.equal(record.messages.length, 3);
});

test('engine: dưới ngưỡng thì không compaction', async () => {
  const engine = createCompactionEngine({ config: makeConfig(), logger: silentLogger, summarize: async () => 'T' });
  const record = recordWith(turns(10));
  const result = await engine.compactIfNeeded({
    record,
    trigger: 'pressure',
    measure: () => ({ pressure: 0.5, tokens: 100 }),
  });
  assert.equal(result, null);
});

test('engine: vượt ngưỡng thì chạy pipeline', async () => {
  const engine = createCompactionEngine({ config: makeConfig(), logger: silentLogger, summarize: async () => 'T' });
  const record = recordWith(turns(12));
  const result = await engine.compactIfNeeded({
    record,
    trigger: 'pressure',
    measure: () => ({ pressure: 0.9, tokens: 100 }),
  });
  assert.equal(result.changed, true);
  assert.equal(result.summarized, true);
  assert.equal(record.messages[0].kind, 'summary');
});

test('engine: overflow luôn chạy dù pressure thấp', async () => {
  const engine = createCompactionEngine({ config: makeConfig(), logger: silentLogger, summarize: async () => 'T' });
  const record = recordWith(turns(12));
  const result = await engine.compactIfNeeded({
    record,
    trigger: 'overflow',
    measure: () => ({ pressure: 0.1, tokens: 100 }),
  });
  assert.equal(result.changed, true);
});

test('engine: manual chạy cả khi không có measure', async () => {
  const engine = createCompactionEngine({ config: makeConfig(), logger: silentLogger, summarize: async () => 'T' });
  const record = recordWith(turns(12));
  const result = await engine.compactIfNeeded({ record, trigger: 'manual' });
  assert.equal(result.changed, true);
  assert.equal(result.tokensBefore, null);
});
