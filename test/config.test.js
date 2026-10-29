import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSecrets, loadConfig } from '../src/config.js';

function baseEnv(extra = {}) {
  return {
    ZALO_BOT_TOKEN: '123:abc',
    NIM_API_KEY: 'nvapi-test',
    DEEPSEEK_API_KEY: 'sk-test',
    TAVILY_API_KEY: 'tvly-test',
    ...extra,
  };
}

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-config-'));
}

test('NIM_MAX_TOKENS=0 is the same as unlimited', async () => {
  const dir = await tempDir();
  const config = loadConfig({ argv: [], env: baseEnv({ NIM_MAX_TOKENS: '0' }), cwd: dir });
  assert.equal(config.ai.maxTokens, null);
});

test('a negative NIM_MAX_TOKENS is rejected', async () => {
  const dir = await tempDir();
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv({ NIM_MAX_TOKENS: '-1' }), cwd: dir }),
    /NIM_MAX_TOKENS/,
  );
});

test('an invalid SEARCH_DEPTH is rejected', async () => {
  const dir = await tempDir();
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv({ SEARCH_DEPTH: 'turbo' }), cwd: dir }),
    /SEARCH_DEPTH/,
  );
});

test('the webhook secret is generated once and kept across restarts', async () => {
  const dir = await tempDir();
  const env = baseEnv({ MODE: 'webhook', DATA_DIR: dir });
  const first = loadConfig({ argv: [], env, cwd: dir });
  const second = loadConfig({ argv: [], env, cwd: dir });

  assert.ok(first.webhook.secret.length >= 8);
  assert.equal(first.webhook.secret, second.webhook.secret);
  assert.equal(first.webhook.host, '127.0.0.1');
  assert.ok(fs.existsSync(path.join(dir, 'webhook-secret')));
});

test('a short WEBHOOK_SECRET is rejected', async () => {
  const dir = await tempDir();
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv({ MODE: 'webhook', WEBHOOK_SECRET: 'short' }), cwd: dir }),
    /WEBHOOK_SECRET/,
  );
});

test('context / reply count are unlimited by default', async () => {
  const dir = await tempDir();
  const config = loadConfig({ argv: [], env: baseEnv(), cwd: dir });
  assert.equal(config.maxMessagesPerReply, 0);
  assert.equal(config.context.maxTokens, 0);
  assert.equal(config.context.maxMessages, 0);
  assert.equal(config.context.maxCharsPerMessage, 12_000);
  assert.equal(config.search.cacheTtlMs, 600_000);
  assert.equal(config.maxQueueDepth, 50);
});

test('compaction: defaults and threshold validation', async () => {
  const dir = await tempDir();
  const config = loadConfig({ argv: [], env: baseEnv(), cwd: dir });
  assert.equal(config.context.modelWindow, 0);
  assert.equal(config.context.compactThreshold, 0.8);
  assert.equal(config.context.keepRecent, 8);
  assert.equal(config.context.summaryMaxChars, 1200);
  assert.equal(config.context.toolResultKeepChars, 600);
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv({ CONTEXT_COMPACT_THRESHOLD: '1.5' }), cwd: dir }),
    /CONTEXT_COMPACT_THRESHOLD/,
  );
});

test('a relative DATA_DIR resolves against the repo root, not the cwd', async () => {
  const dir = await tempDir();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = loadConfig({ argv: [], env: baseEnv({ DATA_DIR: './data' }), cwd: dir });
  assert.equal(config.dataDir, path.join(repoRoot, 'data'));
  assert.equal(config.context.dir, path.join(repoRoot, 'data', 'contexts'));

  // Absolute paths are kept as they are.
  const absolute = await tempDir();
  const config2 = loadConfig({ argv: [], env: baseEnv({ DATA_DIR: absolute }), cwd: dir });
  assert.equal(config2.dataDir, path.normalize(absolute));
});

test('CONTEXT_TTL_HOURS=0 is accepted (never deleted)', async () => {
  const dir = await tempDir();
  const config = loadConfig({ argv: [], env: baseEnv({ CONTEXT_TTL_HOURS: '0' }), cwd: dir });
  assert.equal(config.context.ttlHours, 0);
});

test('defaults to DeepSeek flash 4.1 with reasoning off', async () => {
  const dir = await tempDir();
  const config = loadConfig({ argv: [], env: baseEnv(), cwd: dir });
  assert.equal(config.model.defaultAlias, 'deepseek');
  assert.equal(config.model.fallbackAlias, 'nim-light');
  assert.equal(config.deepseek.model, 'deepseek-flash');
  assert.equal(config.deepseek.proModel, 'deepseek-v4-pro');
  assert.equal(config.ai.reasoning, 'none');
});

test('NIM_ULTRA_MODEL: defaults to nemotron-3-ultra, can be overridden via env/flag', async () => {
  const dir = await tempDir();
  assert.equal(
    loadConfig({ argv: [], env: baseEnv(), cwd: dir }).nim.ultraModel,
    'nvidia/nemotron-3-ultra-550b-a55b',
  );
  assert.equal(
    loadConfig({ argv: [], env: baseEnv({ NIM_ULTRA_MODEL: 'nvidia/custom-ultra' }), cwd: dir }).nim.ultraModel,
    'nvidia/custom-ultra',
  );
  const viaFlag = loadConfig({ argv: ['--model', 'ultra'], env: baseEnv(), cwd: dir });
  assert.equal(viaFlag.model.defaultAlias, 'ultra');
});

test('AI_REASONING takes precedence over NIM_REASONING (legacy compatibility)', async () => {  const dir = await tempDir();
  const config = loadConfig({
    argv: [],
    env: baseEnv({ AI_REASONING: 'low', NIM_REASONING: 'high' }),
    cwd: dir,
  });
  assert.equal(config.ai.reasoning, 'low');
});

test('per-provider temperatures accept 0 and reject invalid values', async () => {
  const dir = await tempDir();
  const config = loadConfig({
    argv: [],
    env: baseEnv({ NIM_TEMPERATURE: '0', DEEPSEEK_TEMPERATURE: '1.4' }),
    cwd: dir,
  });
  assert.equal(config.nim.temperature, 0);
  assert.equal(config.deepseek.temperature, 1.4);

  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv({ NIM_TEMPERATURE: 'hot' }), cwd: dir }),
    /NIM_TEMPERATURE/,
  );
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv({ DEEPSEEK_TEMPERATURE: '3' }), cwd: dir }),
    /DEEPSEEK_TEMPERATURE/,
  );
});

test('a missing DEEPSEEK_API_KEY throws when deepseek is used', async () => {
  const dir = await tempDir();
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv({ DEEPSEEK_API_KEY: '' }), cwd: dir }),
    /DEEPSEEK_API_KEY/,
  );
});

test('an unknown MODEL_DEFAULT is rejected', async () => {
  const dir = await tempDir();
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv({ MODEL_DEFAULT: 'gpt-9' }), cwd: dir }),
    /MODEL_DEFAULT/,
  );
});

test('stickers are on by default, echo is on, and a catalog path exists', async () => {
  const dir = await tempDir();
  const config = loadConfig({ argv: [], env: baseEnv(), cwd: dir });
  assert.equal(config.sticker.enabled, true);
  assert.equal(config.sticker.echo, true);
  assert.ok(config.sticker.file.endsWith('stickers.json'));
});

test('STICKER_IDS is parsed into extraIds', async () => {
  const dir = await tempDir();
  const config = loadConfig({
    argv: [],
    env: baseEnv({ STICKER_IDS: '0e078a2fb66a5f34067b, aaaaaaaaaaaaaaaaaaaa:Cheerful' }),
    cwd: dir,
  });
  assert.equal(config.sticker.extraIds.length, 2);
  assert.equal(config.sticker.extraIds[1].name, 'Cheerful');
});

test('STICKER_ENABLED=off disables stickers', async () => {
  const dir = await tempDir();
  const config = loadConfig({ argv: [], env: baseEnv({ STICKER_ENABLED: 'off' }), cwd: dir });
  assert.equal(config.sticker.enabled, false);
});

test('MODEL_DEFAULT=nim still works without a DeepSeek key', async () => {
  const dir = await tempDir();
  const config = loadConfig({
    argv: [],
    env: baseEnv({ DEEPSEEK_API_KEY: '', MODEL_DEFAULT: 'nim' }),
    cwd: dir,
  });
  assert.equal(config.model.defaultAlias, 'nim');
});

test('a DeepSeek-only setup starts without a NIM key and picks an available fallback', async () => {
  const dir = await tempDir();
  const config = loadConfig({ argv: [], env: baseEnv({ NIM_API_KEY: '' }), cwd: dir });
  assert.equal(config.model.defaultAlias, 'deepseek');

  const { createModelCatalog } = await import('../src/ai/llm/catalog.js');
  const catalog = createModelCatalog({ config, availableProviders: ['deepseek'] });
  assert.equal(catalog.defaultAlias, 'deepseek');
  assert.notEqual(catalog.fallbackAlias, 'nim-light');
  assert.equal(catalog.list().every((item) => item.provider === 'deepseek'), true);
  assert.equal(catalog.list().some((item) => item.alias === catalog.fallbackAlias), true);
});

test('collectSecrets includes every configured provider key', async () => {
  const dir = await tempDir();
  const config = loadConfig({ argv: [], env: baseEnv(), cwd: dir });
  const secrets = collectSecrets(config);
  for (const value of ['123:abc', 'nvapi-test', 'sk-test', 'tvly-test']) {
    assert.ok(secrets.includes(value), value);
  }
});
