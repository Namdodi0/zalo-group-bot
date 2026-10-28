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
    String(query).includes('chào')
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

test('SEARCH_AUTO=off: model không có tool web_search', () => {
  const { tools } = runtime(
    baseConfig({ search: { enabled: true, auto: false, depth: 'fast', maxResults: 4, country: 'vietnam' } }),
    fakeStickers,
  );
  const names = tools.definitions().map((tool) => tool.function.name);
  assert.equal(names.includes('web_search'), false);
  assert.equal(names.includes('send_image'), true);
});

test('web_search vẫn chạy được khi auto=off (dùng cho /search)', async () => {
  const { tools } = runtime(
    baseConfig({ search: { enabled: true, auto: false, depth: 'fast', maxResults: 4, country: 'vietnam' } }),
    fakeStickers,
  );
  const result = await tools.run('web_search', { query: 'giá vàng' }, { chatId: 'c1' });
  assert.equal(result.ok, true);
});

test('tool ảnh dừng khi hết deadline', async () => {
  const { tools } = runtime(baseConfig(), fakeStickers);
  const result = await tools.run('send_image', { query: 'mèo' }, { chatId: 'c1', deadline: Date.now() - 1 });
  assert.equal(result.ok, false);
  assert.match(result.text, /Hết thời gian/);
});

test('send_sticker có trong definitions khi bật, gửi đúng id', async () => {
  const { tools, zalo } = runtime(baseConfig(), fakeStickers);
  const names = tools.definitions().map((tool) => tool.function.name);
  assert.equal(names.includes('send_sticker'), true);

  const result = await tools.run('send_sticker', { emotion: 'chào' }, { chatId: 'c1' });
  assert.equal(result.ok, true);
  assert.match(result.text, /Anh Tre Say Hi/);
  assert.equal(zalo.lastSticker.stickerId, 'd8fa8021bc64553a0c75');
});

test('send_sticker tắt thì không có tool và không gửi', async () => {
  const { tools, zalo } = runtime(baseConfig({ sticker: { enabled: false } }), fakeStickers);
  assert.equal(tools.definitions().some((tool) => tool.function.name === 'send_sticker'), false);
  const result = await tools.run('send_sticker', { emotion: 'chào' }, { chatId: 'c1' });
  assert.equal(result.ok, false);
  assert.equal(zalo.lastSticker, null);
});
