import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommands, parseCommand } from '../src/commands/index.js';
import { createMetrics } from '../src/metrics.js';
import { makeConfig, silentLogger } from '../test-utils/helpers.js';

test('parseCommand nhận diện lệnh và tham số', () => {
  assert.deepEqual(parseCommand('/help'), { name: 'help', args: '' });
  assert.deepEqual(parseCommand('/search giá vàng hôm nay'), { name: 'search', args: 'giá vàng hôm nay' });
  assert.equal(parseCommand('xin chào'), null);
  assert.equal(parseCommand('/'), null);
});

function deps(overrides = {}) {
  const config = makeConfig(overrides.config ?? {});
  const metrics = createMetrics();
  const models = {
    resolve: () => ({ alias: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' }),
    find: (value) => {
      const needle = String(value).toLowerCase();
      const all = models.list();
      return (
        all.find((item) => item.alias === needle) ??
        all.find((item) => item.provider === needle) ??
        all.find((item) => item.model.toLowerCase().includes(needle)) ??
        null
      );
    },
    list: () => [
      { alias: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' },
      { alias: 'nim', provider: 'nim', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', label: 'Nemotron 3.5 Super VL' },
    ],
  };
  const stickers = {
    find: (value) => (String(value).includes('chào') ? { id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' } : null),
    random: () => ({ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' }),
    list: () => [{ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi', tags: ['chào'] }],
    size: () => 1,
    add: async ({ id, name }) => ({ item: { id, name: name ?? 'Mới' }, added: true }),
    remove: async (value) => (String(value) === 'chào' ? { id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' } : null),
  };
  const zalo = {
    sendChatAction: async () => ({ ok: true }),
    sendSticker: async (chatId, stickerId) => {
      zalo.lastSticker = { chatId, stickerId };
      return { ok: true };
    },
    lastSticker: null,
    ping: async () => 5,
  };
  return {
    config,
    metrics,
    models,
    stickers,
    store: {
      reset: async () => {},
      touch: () => {},
    },
    zalo,
    http: {
      stateOf: () => ({ failures: 0, open: false, openedUntil: 0 }),
      listStates: () => [],
    },
    logger: silentLogger,
  };
}

/** @param {any} d */
function ctx(d, overrides = {}) {
  return {
    chatId: 'g1',
    chatType: 'GROUP',
    senderId: 'u1',
    senderName: 'Nam',
    record: { messages: [], turns: 3, summary: '', meta: { thinking: null } },
    ...overrides,
  };
}

test('/help trả danh sách lệnh', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'help', args: '' }, ctx(d));
  assert.equal(result.kind, 'text');
  assert.match(result.text, /\/status/);
  assert.match(result.text, /@mention/);
});

test('/status có thông tin model và context', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'status', args: '' }, ctx(d));
  assert.match(result.text, /deepseek-flash/);
  assert.match(result.text, /DeepSeek V4\.1 Flash/);
  assert.match(result.text, /không giới hạn/);
  assert.match(result.text, /Context: 0 tin/);
});

test('/sticker liệt kê và chọn sticker theo cảm xúc', async () => {
  const d = deps();
  const commands = createCommands(d);

  const list = await commands.run({ name: 'sticker', args: '' }, ctx(d));
  assert.match(list.text, /Sticker/);
  assert.match(list.text, /\/sticker/);

  const picked = await commands.run({ name: 'sticker', args: 'chào' }, ctx(d));
  assert.equal(picked.kind, 'sticker');
  assert.equal(picked.stickerId, 'd8fa8021bc64553a0c75');

  const missing = await commands.run({ name: 'sticker', args: 'không có gì' }, ctx(d));
  assert.match(missing.text, /Không có sticker/);
});

test('/sticker add gửi thử rồi lưu, remove xoá', async () => {
  const d = deps();
  const commands = createCommands(d);
  const context = ctx(d);

  const added = await commands.run({ name: 'sticker', args: 'add 0e078a2fb66a5f34067b Chào hỏi' }, context);
  assert.match(added.text, /Đã thêm/);
  assert.equal(d.zalo.lastSticker.stickerId, '0e078a2fb66a5f34067b');

  const removed = await commands.run({ name: 'sticker', args: 'remove chào' }, context);
  assert.match(removed.text, /Đã xoá/);
});

test('/model liệt kê và đổi model cho chat', async () => {
  const d = deps();
  const commands = createCommands(d);
  const context = ctx(d);

  const list = await commands.run({ name: 'model', args: '' }, context);
  assert.match(list.text, /Model đang dùng/);
  assert.match(list.text, /\/model deepseek/);

  const switched = await commands.run({ name: 'model', args: 'nim' }, context);
  assert.match(switched.text, /Đã chuyển sang/);
  assert.equal(context.record.meta.model, 'nim');

  const bad = await commands.run({ name: 'model', args: 'gpt-9' }, context);
  assert.match(bad.text, /Không có model/);
});

test('/model bị chặn nếu không phải admin', async () => {
  const d = deps({ config: { adminIds: ['admin-1'] } });
  const commands = createCommands(d);
  const result = await commands.run({ name: 'model', args: 'deepseek' }, ctx(d));
  assert.match(result.text, /Chỉ admin/);
});

test('/reset bị chặn nếu không phải admin', async () => {
  const d = deps({ config: { adminIds: ['admin-1'] } });
  const commands = createCommands(d);
  const result = await commands.run({ name: 'reset', args: '' }, ctx(d));
  assert.match(result.text, /Chỉ admin/);
});

test('/reset cho phép admin và xoá context', async () => {
  const d = deps({ config: { adminIds: ['u1'] } });
  let resetCalled = false;
  d.store.reset = async () => {
    resetCalled = true;
  };
  const commands = createCommands(d);
  const result = await commands.run({ name: 'reset', args: '' }, ctx(d));
  assert.equal(resetCalled, true);
  assert.match(result.text, /Đã xoá ngữ cảnh/);
});

test('/search trả delegate', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'search', args: 'giá vàng' }, ctx(d));
  assert.deepEqual(result, { kind: 'search', query: 'giá vàng' });
});

test('/image trả delegate', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'image', args: 'mèo con' }, ctx(d));
  assert.deepEqual(result, { kind: 'image', query: 'mèo con' });
});

test('/think đổi chế độ reasoning', async () => {
  const d = deps();
  const commands = createCommands(d);
  const context = ctx(d);
  await commands.run({ name: 'think', args: 'off' }, context);
  assert.equal(context.record.meta.thinking, 'off');
  const result = await commands.run({ name: 'think', args: '' }, context);
  assert.match(result.text, /off/);
});

test('lệnh lạ trả hướng dẫn', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'abc', args: '' }, ctx(d));
  assert.match(result.text, /Không rõ lệnh/);
});
