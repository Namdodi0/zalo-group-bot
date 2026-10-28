import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRuntime } from '../src/ai/tools.js';
import { silentLogger } from '../test-utils/helpers.js';

function runtime(config, stickerStore) {
  const zalo = {
    sendPhoto: async () => ({ ok: true }),
    sendSticker: async (chatId, stickerId) => {
      zalo.lastSticker = { chatId, stickerId };
      return { ok: true };
    },
    lastSticker: null,
  };
  const tools = createToolRuntime({
    config,
    tavily: { search: async () => ({ results: [], images: [] }) },
    zalo,
    validator: { validate: async () => ({ ok: true }) },
    stickers: stickerStore,
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
  });
  return { tools, zalo };
}

const fakeStickers = {
  find: (query) =>
    String(query).includes('greeting')
      ? { id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' }
      : null,
  random: () => ({ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' }),
};

function baseConfig(overrides = {}) {
  return {
    search: { enabled: true, auto: true, depth: 'fast', maxResults: 4, country: 'vietnam' },
    image: { enabled: true },
    sticker: { enabled: true },
    ...overrides,
  };
}

test('SEARCH_AUTO=off: the model has no web_search tool', () => {
  const { tools } = runtime(
    baseConfig({ search: { enabled: true, auto: false, depth: 'fast', maxResults: 4, country: 'vietnam' } }),
    fakeStickers,
  );
  const names = tools.definitions().map((tool) => tool.function.name);
  assert.equal(names.includes('web_search'), false);
  assert.equal(names.includes('send_image'), true);
});

test('web_search still works when auto=off (used by /search)', async () => {
  const { tools } = runtime(
    baseConfig({ search: { enabled: true, auto: false, depth: 'fast', maxResults: 4, country: 'vietnam' } }),
    fakeStickers,
  );
  const result = await tools.run('web_search', { query: 'gold price' }, { chatId: 'c1' });
  assert.equal(result.ok, true);
});

test('the image tool stops once the deadline passes', async () => {
  const { tools } = runtime(baseConfig(), fakeStickers);
  const result = await tools.run('send_image', { query: 'cat' }, { chatId: 'c1', deadline: Date.now() - 1 });
  assert.equal(result.ok, false);
  assert.match(result.text, /Ran out of time/);
});

test('send_sticker is in definitions when enabled and sends the right id', async () => {
  const { tools, zalo } = runtime(baseConfig(), fakeStickers);
  const names = tools.definitions().map((tool) => tool.function.name);
  assert.equal(names.includes('send_sticker'), true);

  const result = await tools.run('send_sticker', { emotion: 'greeting' }, { chatId: 'c1' });
  assert.equal(result.ok, true);
  assert.match(result.text, /Anh Tre Say Hi/);
  assert.equal(zalo.lastSticker.stickerId, 'd8fa8021bc64553a0c75');
});

test('when send_sticker is off there is no tool and nothing is sent', async () => {
  const { tools, zalo } = runtime(baseConfig({ sticker: { enabled: false } }), fakeStickers);
  assert.equal(tools.definitions().some((tool) => tool.function.name === 'send_sticker'), false);
  const result = await tools.run('send_sticker', { emotion: 'greeting' }, { chatId: 'c1' });
  assert.equal(result.ok, false);
  assert.equal(zalo.lastSticker, null);
});
