import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { latestSummary, summaryEntry } from '../src/context/record.js';
import { createContextStore } from '../src/context/store.js';
import { silentLogger } from '../test-utils/helpers.js';

test('store lưu, nạp lại, reset', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 72, debounceMs: 2 });
  await store.init();

  const record = await store.get('chat-1', { chatType: 'GROUP' });
  record.messages.push({ role: 'user', text: 'xin chào', ts: Date.now() });
  record.turns = 1;
  store.touch('chat-1');
  await store.flush();

  const store2 = createContextStore({ dir, logger: silentLogger, ttlHours: 72 });
  await store2.init();
  const loaded = await store2.get('chat-1');
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.messages[0].text, 'xin chào');
  assert.equal(loaded.turns, 1);

  await store2.reset('chat-1');
  const store3 = createContextStore({ dir, logger: silentLogger, ttlHours: 72 });
  await store3.init();
  const fresh = await store3.get('chat-1');
  assert.equal(fresh.messages.length, 0);
});

test('store prune xoá file quá TTL', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 1 });
  await store.init();

  const file = store.fileFor('old-chat');
  await fsp.writeFile(
    file,
    JSON.stringify({ chatId: 'old-chat', chatType: 'GROUP', summary: '', messages: [], turns: 0, updatedAt: 0, meta: { thinking: null } }),
    'utf8',
  );
  const twoDaysAgo = Date.now() / 1000 - 2 * 24 * 3600;
  await fsp.utimes(file, twoDaysAgo, twoDaysAgo);

  const removed = await store.prune();
  assert.ok(removed >= 1);
  await assert.rejects(() => fsp.stat(file));
});

test('store giữ chat đang hoạt động khi prune', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 1 });
  await store.init();

  const record = await store.get('fresh-chat');
  record.messages.push({ role: 'user', text: 'mới', ts: Date.now() });
  store.touch('fresh-chat');
  await store.flush();

  const removed = await store.prune();
  assert.equal(removed, 0);
  const loaded = await store.get('fresh-chat');
  assert.equal(loaded.messages.length, 1);
});

test('store reset keepMeta giữ meta, xoá messages/summary', async () => {  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 72, debounceMs: 2 });
  await store.init();

  const record = await store.get('chat-2', { chatType: 'GROUP' });
  record.messages.push(summaryEntry('tóm tắt cũ'));
  record.messages.push({ role: 'user', text: 'chửi nhau', ts: Date.now() });
  record.turns = 3;
  record.meta = { thinking: 'low', model: 'nim', tone: 'roast-hard' };
  await store.flush();

  await store.reset('chat-2', { keepMeta: true });

  const store2 = createContextStore({ dir, logger: silentLogger, ttlHours: 72 });
  await store2.init();
  const loaded = await store2.get('chat-2');
  assert.equal(loaded.messages.length, 0);
  assert.equal(loaded.turns, 0);
  assert.equal(latestSummary(loaded), '');
  assert.deepEqual(loaded.meta, { thinking: 'low', model: 'nim', tone: 'roast-hard' });
});

test('store reset mặc định (không keepMeta) xoá sạch file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 72, debounceMs: 2 });
  await store.init();
  const record = await store.get('chat-3');
  record.meta = { tone: 'roast' };
  await store.flush();

  await store.reset('chat-3');
  await assert.rejects(() => fsp.stat(store.fileFor('chat-3')));
});

test('prune bỏ cả record cũ trong RAM, không chỉ file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 1, debounceMs: 2 });
  await store.init();

  const record = await store.get('stale-chat');
  record.updatedAt = Date.now() - 2 * 3_600_000;
  await store.flush();
  assert.equal(store.has('stale-chat'), true);

  await store.prune();
  assert.equal(store.has('stale-chat'), false, 'record quá TTL phải bị bỏ khỏi RAM');
});

test('CONTEXT_TTL_HOURS=0: prune không xoá context nào', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 0, debounceMs: 2 });
  await store.init();

  const record = await store.get('keep-forever');
  record.messages.push({ role: 'user', text: 'tin cũ', ts: 1 });
  store.touch('keep-forever');
  await store.flush();

  // Giả lập file đã 1 năm tuổi: TTL > 0 sẽ bị xoá, TTL = 0 thì phải giữ.
  const old = new Date(Date.now() - 365 * 24 * 3_600_000);
  await fsp.utimes(store.fileFor('keep-forever'), old, old);

  assert.equal(await store.prune(), 0);
  assert.equal(await store.count(), 1);

  const fresh = createContextStore({ dir, logger: silentLogger, ttlHours: 0 });
  await fresh.init();
  const loaded = await fresh.get('keep-forever');
  assert.equal(loaded.messages.length, 1);
});
