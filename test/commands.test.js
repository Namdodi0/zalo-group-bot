import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommands, parseCommand } from '../src/commands/index.js';
import { createMetrics } from '../src/metrics.js';
import { makeConfig, silentLogger } from '../test-utils/helpers.js';

test('parseCommand recognizes commands and arguments', () => {
  assert.deepEqual(parseCommand('/help'), { name: 'help', args: '' });
  assert.deepEqual(parseCommand('/search gold price today'), { name: 'search', args: 'gold price today' });
  assert.equal(parseCommand('hello'), null);
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
    find: (value) => (String(value).includes('hello') ? { id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' } : null),
    random: () => ({ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' }),
    list: () => [{ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi', tags: ['hello'] }],
    size: () => 1,
    add: async ({ id, name }) => ({ item: { id, name: name ?? 'New' }, added: true }),
    remove: async (value) => (String(value) === 'hello' ? { id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' } : null),
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
    record: { messages: [], turns: 3, meta: { thinking: null } },
    ...overrides,
  };
}

test('/help returns the list of commands', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'help', args: '' }, ctx(d));
  assert.equal(result.kind, 'text');
  assert.match(result.text, /\/status/);
  assert.match(result.text, /@mention/);
});

test('/compact runs compaction and reports the result', async () => {
  const d = deps();
  d.compaction = {
    async compactIfNeeded() {
      return { changed: true, summarized: true, pruned: true };
    },
  };
  const commands = createCommands(d);
  const result = await commands.run({ name: 'compact', args: '' }, ctx(d));
  assert.match(result.text, /Compacted context/);
  assert.match(result.text, /summary/);
});

test('/compact says clearly when nothing needs compaction', async () => {
  const d = deps();
  d.compaction = { async compactIfNeeded() { return null; } };
  const commands = createCommands(d);
  const result = await commands.run({ name: 'compact', args: '' }, ctx(d));
  assert.match(result.text, /does not need compaction/);
});

test('/status includes model and context info', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'status', args: '' }, ctx(d));
  assert.match(result.text, /deepseek-flash/);
  assert.match(result.text, /DeepSeek V4\.1 Flash/);
  assert.match(result.text, /unlimited/);
  assert.match(result.text, /Context: 0 msg/);
});

test('/sticker lists and picks a sticker by mood', async () => {
  const d = deps();
  const commands = createCommands(d);

  const list = await commands.run({ name: 'sticker', args: '' }, ctx(d));
  assert.match(list.text, /Sticker/);
  assert.match(list.text, /\/sticker/);

  const picked = await commands.run({ name: 'sticker', args: 'hello' }, ctx(d));
  assert.equal(picked.kind, 'sticker');
  assert.equal(picked.stickerId, 'd8fa8021bc64553a0c75');

  const missing = await commands.run({ name: 'sticker', args: 'nothing here' }, ctx(d));
  assert.match(missing.text, /No sticker matches/);
});

test('/sticker add test-sends then saves, remove deletes', async () => {
  const d = deps();
  const commands = createCommands(d);
  const context = ctx(d);

  const added = await commands.run({ name: 'sticker', args: 'add 0e078a2fb66a5f34067b Hello there' }, context);
  assert.match(added.text, /Added and test-sent/);
  assert.equal(d.zalo.lastSticker.stickerId, '0e078a2fb66a5f34067b');

  const removed = await commands.run({ name: 'sticker', args: 'remove hello' }, context);
  assert.match(removed.text, /Removed the sticker/);
});

test('/model lists and switches the model for the chat', async () => {
  const d = deps();
  const commands = createCommands(d);
  const context = ctx(d);

  const list = await commands.run({ name: 'model', args: '' }, context);
  assert.match(list.text, /Current model/);
  assert.match(list.text, /\/model deepseek/);

  const switched = await commands.run({ name: 'model', args: 'nim' }, context);
  assert.match(switched.text, /Switched to/);
  assert.equal(context.record.meta.model, 'nim');

  const bad = await commands.run({ name: 'model', args: 'gpt-9' }, context);
  assert.match(bad.text, /No model named/);
});

test('/model is blocked for non-admins', async () => {
  const d = deps({ config: { adminIds: ['admin-1'] } });
  const commands = createCommands(d);
  const result = await commands.run({ name: 'model', args: 'deepseek' }, ctx(d));
  assert.match(result.text, /Only group admins/);
});

test('/reset is blocked for non-admins', async () => {
  const d = deps({ config: { adminIds: ['admin-1'] } });
  const commands = createCommands(d);
  const result = await commands.run({ name: 'reset', args: '' }, ctx(d));
  assert.match(result.text, /Only group admins/);
});

test('/reset lets admins clear the context', async () => {
  const d = deps({ config: { adminIds: ['u1'] } });
  let resetCalled = false;
  d.store.reset = async () => {
    resetCalled = true;
  };
  const commands = createCommands(d);
  const result = await commands.run({ name: 'reset', args: '' }, ctx(d));
  assert.equal(resetCalled, true);
  assert.match(result.text, /Cleared this chat's context/);
});

test('/search returns the delegate', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'search', args: 'gold price' }, ctx(d));
  assert.deepEqual(result, { kind: 'search', query: 'gold price' });
});

test('/image returns the delegate', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'image', args: 'kitten' }, ctx(d));
  assert.deepEqual(result, { kind: 'image', query: 'kitten' });
});

test('/think changes the reasoning mode', async () => {
  const d = deps();
  const commands = createCommands(d);
  const context = ctx(d);
  await commands.run({ name: 'think', args: 'off' }, context);
  assert.equal(context.record.meta.thinking, 'off');
  const result = await commands.run({ name: 'think', args: '' }, context);
  assert.match(result.text, /off/);
});

test('/split off disables splitting for the chat, /split auto returns to the config', async () => {
  const d = deps();
  const commands = createCommands(d);
  const context = ctx(d);

  const off = await commands.run({ name: 'split', args: 'off' }, context);
  assert.match(off.text, /Split replies disabled/);
  assert.equal(context.record.meta.split, 'off');

  const shown = await commands.run({ name: 'split', args: '' }, context);
  assert.match(shown.text, /off/);

  const back = await commands.run({ name: 'split', args: 'auto' }, context);
  assert.match(back.text, /split mode from the config/);
  assert.equal(context.record.meta.split, null);

  const bad = await commands.run({ name: 'split', args: 'xyz' }, context);
  assert.match(bad.text, /Invalid value/);
});

test('/split is blocked for non-admins', async () => {
  const d = deps({ config: { adminIds: ['admin-1'] } });
  const commands = createCommands(d);
  const result = await commands.run({ name: 'split', args: 'off' }, ctx(d));
  assert.match(result.text, /Only group admins/);
});

test('an unknown command returns guidance', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'abc', args: '' }, ctx(d));
  assert.match(result.text, /Unknown command/);
});
