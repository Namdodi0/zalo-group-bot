import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReminderStore, formatReminderTime, parseReminderArgs } from '../src/ai/reminders.js';
import { createSilentLogger } from '../src/logger.js';

// 2026-10-28 17:00 in Vietnam (UTC+7).
const NOW = Date.UTC(2026, 9, 28, 10, 0, 0);

test('parseReminderArgs: relative durations', () => {
  assert.equal(parseReminderArgs('+10m uống nước', NOW).at, NOW + 600_000);
  assert.equal(parseReminderArgs('+2h họp', NOW).at, NOW + 7_200_000);
  assert.equal(parseReminderArgs('+1d nộp bài', NOW).at, NOW + 86_400_000);
  assert.match(String(parseReminderArgs('+0m x', NOW).error), /tương lai/);
});

test('parseReminderArgs: clock time, tomorrow and dd/mm in Vietnam time', () => {
  const evening = parseReminderArgs('20:00 họp nhóm', NOW);
  assert.equal(evening.at, Date.UTC(2026, 9, 28, 13, 0, 0));
  assert.equal(evening.text, 'họp nhóm');

  // 08:00 already passed at 17:00 → tomorrow.
  assert.equal(parseReminderArgs('08:00 tập thể dục', NOW).at, Date.UTC(2026, 9, 29, 1, 0, 0));
  assert.equal(parseReminderArgs('08:00 mai tập thể dục', NOW).at, Date.UTC(2026, 9, 29, 1, 0, 0));
  assert.equal(parseReminderArgs('08:00 mốt tập thể dục', NOW).at, Date.UTC(2026, 9, 30, 1, 0, 0));

  const dated = parseReminderArgs('09:30 05/11 gặp khách', NOW);
  assert.equal(dated.at, Date.UTC(2026, 10, 5, 2, 30, 0));
  assert.equal(dated.text, 'gặp khách');
});

test('parseReminderArgs: rejects bad input', () => {
  assert.match(String(parseReminderArgs('', NOW).error), /Usage/);
  assert.match(String(parseReminderArgs('25:00 x', NOW).error), /Giờ/);
  assert.match(String(parseReminderArgs('20:00', NOW).error), /Thiếu nội dung/);
  assert.match(String(parseReminderArgs('wat', NOW).error), /Không hiểu/);
  assert.match(String(parseReminderArgs('+40d x', NOW).error), /30 ngày/);
});

test('createReminderStore: caps per chat, delivers due items, persists', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-rem-'));
  const file = path.join(dir, 'reminders.json');
  let nowMs = NOW;
  /** @type {Array<{chatId: string, text: string}>} */
  const sent = [];
  const store = createReminderStore({
    file,
    now: () => nowMs,
    send: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    logger: createSilentLogger(),
  });
  await store.load();

  for (let index = 0; index < 5; index += 1) {
    const result = await store.add({ chatId: 'g1', text: `r${index}`, at: NOW + 10_000 + index * 1000, createdBy: 'u1' });
    assert.equal(result.ok, true);
  }
  assert.equal((await store.add({ chatId: 'g1', text: 'overflow', at: NOW + 10_000 })).reason, 'chat-limit');

  nowMs = NOW + 11_500;
  assert.equal(await store.tick(), 2);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /⏰ Nhắc: r0/);
  assert.equal(store.list('g1').length, 3);

  const reloaded = createReminderStore({ file, now: () => nowMs, send: async () => {}, logger: createSilentLogger() });
  await reloaded.load();
  assert.equal(reloaded.list('g1').length, 3);

  const removed = await reloaded.remove('g1', '3');
  assert.ok(removed);
  assert.equal(reloaded.list('g1').length, 2);
});

test('createReminderStore: a failing send is retried and then dropped', async () => {
  let nowMs = NOW;
  let attempts = 0;
  const store = createReminderStore({
    now: () => nowMs,
    send: async () => {
      attempts += 1;
      throw new Error('zalo down');
    },
    logger: createSilentLogger(),
  });
  await store.add({ chatId: 'g1', text: 'x', at: NOW + 1000 });
  nowMs = NOW + 2000;
  for (let index = 0; index < 5; index += 1) await store.tick();
  assert.equal(attempts, 5);
  assert.equal(store.size(), 0);
});

test('formatReminderTime renders Vietnam local time', () => {
  assert.match(formatReminderTime(Date.UTC(2026, 9, 28, 13, 0, 0)), /28\/10\/2026/);
});
