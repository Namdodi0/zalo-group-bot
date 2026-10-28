import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION,
  contextEntry,
  freshRecord,
  latestSummary,
  normalizeRecord,
  syncContexts,
  toolCallEntry,
  toolPairingBalanced,
  toolResultEntry,
} from '../src/context/record.js';

test('normalizeRecord upgrades a v1 record with a summary into a summary node', () => {
  const record = {
    chatId: 'c',
    chatType: 'GROUP',
    summary: 'old summary',
    messages: [{ role: 'user', text: 'hi', ts: 1 }],
    turns: 1,
    updatedAt: 5,
    meta: {},
  };
  normalizeRecord(record);
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
  assert.equal('summary' in record, false);
  assert.equal(record.messages[0].kind, 'summary');
  assert.equal(record.messages[0].role, 'user');
  assert.equal(record.messages[0].text, 'old summary');
  assert.equal(record.messages[1].kind, 'turn');
  assert.deepEqual(record.seen, []);
});

test('normalizeRecord idempotent', () => {
  const record = freshRecord('c', 'GROUP', 1);
  normalizeRecord(record);
  normalizeRecord(record);
  assert.equal(record.messages.length, 0);
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
});

test('syncContexts inserts context before the last user turn and refreshes by source', () => {
  const record = freshRecord('c', 'GROUP', 1);
  record.messages.push({ role: 'user', kind: 'turn', text: 'turn 1', ts: 1 });
  record.messages.push({ role: 'assistant', kind: 'turn', text: 'reply 1', ts: 2 });
  record.messages.push({ role: 'user', kind: 'turn', text: 'turn 2', ts: 3 });

  syncContexts(record, [{ name: 'runtime:time', text: 'now-1' }], 10);
  assert.deepEqual(
    record.messages.map((message) => message.text),
    ['turn 1', 'reply 1', 'now-1', 'turn 2'],
  );

  syncContexts(record, [{ name: 'runtime:time', text: 'now-2' }], 11);
  assert.deepEqual(
    record.messages.map((message) => message.text),
    ['turn 1', 'reply 1', 'now-2', 'turn 2'],
  );

  syncContexts(record, [{ name: 'runtime:time', text: '' }], 12);
  assert.equal(record.messages.some((message) => message.kind === 'context'), false);
});

test('syncContexts keeps the order of multiple contexts', () => {
  const record = freshRecord('c', 'GROUP', 1);
  record.messages.push({ role: 'user', kind: 'turn', text: 'turn', ts: 1 });
  syncContexts(record, [
    { name: 'a', text: 'A' },
    { name: 'b', text: 'B' },
  ]);
  assert.deepEqual(record.messages.map((message) => message.text), ['A', 'B', 'turn']);
});

test('latestSummary returns the newest summary node', () => {
  const record = freshRecord('c', 'GROUP', 1);
  assert.equal(latestSummary(record), '');
  record.messages.push({ role: 'user', kind: 'summary', text: 's1', ts: 1 });
  record.messages.push({ role: 'user', kind: 'summary', text: 's2', ts: 2 });
  assert.equal(latestSummary(record), 's2');
});

test('toolPairingBalanced detects a cut between tool-call and tool-result', () => {
  const messages = [
    toolCallEntry({ toolCalls: [{ id: 'c1', name: 'web_search', arguments: {} }], ts: 1 }),
    toolResultEntry({ toolCallId: 'c1', text: 'r1', ts: 2 }),
    { role: 'user', kind: 'turn', text: 'x', ts: 3 },
  ];
  assert.equal(toolPairingBalanced(messages, 0, 2), true);
  assert.equal(toolPairingBalanced(messages, 0, 1), false);
  assert.equal(toolPairingBalanced(messages, 1, 3), false);
  assert.equal(toolPairingBalanced(messages, 2, 3), true);
});

test('contextEntry keeps source and the context kind', () => {
  const entry = contextEntry({ source: 'runtime:time', text: 'now', ts: 7 });
  assert.equal(entry.role, 'user');
  assert.equal(entry.kind, 'context');
  assert.equal(entry.source, 'runtime:time');
  assert.equal(entry.ts, 7);
});
