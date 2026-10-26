import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelRouter } from '../src/ai/router.js';
import { makeConfig, silentLogger } from '../test-utils/helpers.js';

function makeClients() {
  /** @type {any[]} */
  const calls = [];
  const make = (provider) => ({
    provider,
    async chat(input) {
      calls.push({ provider, input });
      return { content: provider, toolCalls: [], usage: null };
    },
  });
  return { calls, deepseek: make('deepseek'), nim: make('nim') };
}

test('router: mặc định deepseek, /model đổi theo record, fallback nim-light', async () => {
  const config = makeConfig();
  const clients = makeClients();
  const router = createModelRouter({ config, clients, logger: silentLogger });

  assert.equal(router.defaultAlias, 'deepseek');
  assert.equal(router.fallbackAlias, 'nim-light');
  assert.equal(router.resolve(null).alias, 'deepseek');
  assert.equal(router.resolve({ meta: { model: 'pro' } }).model, 'deepseek-v4-pro');
  assert.equal(router.resolve({ meta: { model: 'không-tồn-tại' } }).alias, 'deepseek');

  assert.equal(router.find('nim').model, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
  assert.equal(router.find('deepseek').alias, 'deepseek');
  assert.equal(router.find('không có'), null);

  await router.chat({ record: { meta: { model: 'nim' } }, messages: [] });
  assert.equal(clients.calls[0].provider, 'nim');

  await router.chatWith('pro', { messages: [] });
  assert.equal(clients.calls[1].input.model, 'deepseek-v4-pro');

  await router.chatWith(router.fallbackAlias, { messages: [] });
  assert.equal(clients.calls[2].provider, 'nim');
});

test('router: alias của provider chưa cấu hình bị bỏ qua', () => {
  const config = makeConfig({ model: { defaultAlias: 'deepseek', fallbackAlias: 'nim-light' } });
  const router = createModelRouter({
    config,
    clients: { nim: { provider: 'nim', chat: async () => ({}) } },
    logger: silentLogger,
  });
  assert.equal(router.list().some((item) => item.provider === 'deepseek'), false);
  assert.equal(router.defaultAlias, 'nim');
  assert.equal(router.fallbackAlias, 'nim-light');
});
