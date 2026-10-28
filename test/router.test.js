import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelRouter } from '../src/ai/router.js';
import { makeConfig, silentLogger } from '../test-utils/helpers.js';

function makeService(providers = ['deepseek', 'nim']) {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    providers: () => providers,
    has: (provider) => providers.includes(provider),
    async chat(input) {
      calls.push(input);
      return { content: input.provider, toolCalls: [], usage: null };
    },
    async warmup(provider, options = {}) {
      return { ok: true, ms: 1, model: options.model ?? provider };
    },
  };
}

test('router: defaults to deepseek, /model changes it per record, fallback nim-light', async () => {
  const config = makeConfig();
  const service = makeService();
  const router = createModelRouter({ config, service, logger: silentLogger });

  assert.equal(router.defaultAlias, 'deepseek');
  assert.equal(router.fallbackAlias, 'nim-light');
  assert.equal(router.resolve(null).alias, 'deepseek');
  assert.equal(router.resolve({ meta: { model: 'pro' } }).model, 'deepseek-v4-pro');
  assert.equal(router.resolve({ meta: { model: 'does-not-exist' } }).alias, 'deepseek');

  assert.equal(router.find('nim').model, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
  assert.equal(router.find('deepseek').alias, 'deepseek');
  assert.equal(router.find('no such model'), null);

  await router.chat({ record: { meta: { model: 'nim' } }, messages: [] });
  assert.equal(service.calls[0].provider, 'nim');

  await router.chatWith('pro', { messages: [] });
  assert.equal(service.calls[1].model, 'deepseek-v4-pro');

  await router.chatWith(router.fallbackAlias, { messages: [] });
  assert.equal(service.calls[2].provider, 'nim');
});

test('router: the ultra alias points at Nemotron 3 Ultra and is switchable in chat', async () => {
  const config = makeConfig();
  const service = makeService();
  const router = createModelRouter({ config, service, logger: silentLogger });

  assert.equal(router.find('ultra').model, 'nvidia/nemotron-3-ultra-550b-a55b');
  assert.equal(router.resolve({ meta: { model: 'ultra' } }).alias, 'ultra');
  assert.equal(router.list().some((item) => item.alias === 'ultra'), true);

  await router.chat({ record: { meta: { model: 'ultra' } }, messages: [] });
  assert.equal(service.calls[0].provider, 'nim');
  assert.equal(service.calls[0].model, 'nvidia/nemotron-3-ultra-550b-a55b');
});

test('router: an alias whose provider is not configured is skipped', () => {
  const config = makeConfig({ model: { defaultAlias: 'deepseek', fallbackAlias: 'nim-light' } });
  const router = createModelRouter({ config, service: makeService(['nim']), logger: silentLogger });
  assert.equal(router.list().some((item) => item.provider === 'deepseek'), false);
  assert.equal(router.defaultAlias, 'nim');
  assert.equal(router.fallbackAlias, 'nim-light');
});

test('router: warmup picks the right provider and model for the alias', async () => {
  const config = makeConfig();
  const service = makeService();
  const router = createModelRouter({ config, service, logger: silentLogger });
  const result = await router.warmup('ultra');
  assert.equal(result.ok, true);
  assert.equal(result.model, 'nvidia/nemotron-3-ultra-550b-a55b');
});
