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

function load(settings = {}, env = baseEnv(), argv = []) {
  return loadConfig({ argv, env, config: settings });
}

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-config-'));
}

test('defaults: DeepSeek primary, reasoning off, unlimited context', () => {
  const config = load();
  assert.equal(config.model.defaultAlias, 'deepseek');
  assert.equal(config.model.fallbackAlias, 'nim-light');
  assert.equal(config.ai.reasoning, 'none');
  assert.equal(config.ai.maxTokens, null);
  assert.equal(config.context.maxTokens, 0);
  assert.equal(config.context.maxMessages, 0);
  assert.equal(config.context.maxCharsPerMessage, 12_000);
  assert.equal(config.search.cacheTtlMs, 600_000);
  assert.equal(config.maxQueueDepth, 50);
  assert.equal(config.nim.temperature, 0.6);
  assert.equal(config.deepseek.temperature, 0.6);
  assert.equal(config.configFile, null);
  assert.equal(config.configFileFound, true);
});

test('reads every setting from config.json', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'config.json');
  await fsp.writeFile(
    file,
    JSON.stringify({
      mode: 'webhook',
      dataDir: dir,
      zalo: { botId: 'bot-1' },
      model: { defaultAlias: 'nim' },
      search: { enabled: false },
      tone: 'friendly',
      context: { maxTokens: 1234 },
    }),
  );

  const config = loadConfig({
    argv: [],
    env: baseEnv({ DEEPSEEK_API_KEY: '' }),
    cwd: dir,
    configPath: file,
  });

  assert.equal(config.mode, 'webhook');
  assert.equal(config.zalo.botId, 'bot-1');
  assert.equal(config.model.defaultAlias, 'nim');
  assert.equal(config.search.enabled, false);
  assert.equal(config.tone, 'friendly');
  assert.equal(config.context.maxTokens, 1234);
  assert.equal(config.dataDir, path.normalize(dir));
  assert.equal(config.context.dir, path.join(dir, 'contexts'));
  assert.ok(config.webhook.secret.length >= 8);
  assert.equal(fs.existsSync(path.join(dir, 'webhook-secret')), true);
  assert.equal(config.configFileFound, true);
});

test('a missing explicit config file throws', async () => {
  const dir = await tempDir();
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv(), configPath: path.join(dir, 'missing.json') }),
    /Config file not found/,
  );
});

test('invalid JSON in config.json is reported', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'config.json');
  await fsp.writeFile(file, '{ not json');
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv(), configPath: file, cwd: dir }),
    /Could not parse/,
  );
});

test('search disabled does not require a Tavily key', () => {
  const config = load({ search: { enabled: false } }, baseEnv({ TAVILY_API_KEY: '' }));
  assert.equal(config.search.enabled, false);
});

test('search enabled without TAVILY_API_KEY throws', () => {
  assert.throws(() => load({}, baseEnv({ TAVILY_API_KEY: '' })), /TAVILY_API_KEY/);
});

test('the primary provider needs its key; other providers are optional', () => {
  assert.throws(() => load({}, baseEnv({ DEEPSEEK_API_KEY: '' })), /DEEPSEEK_API_KEY/);
  assert.throws(
    () => load({ model: { defaultAlias: 'nim' } }, baseEnv({ NIM_API_KEY: '' })),
    /NIM_API_KEY/,
  );
  const config = load({ model: { defaultAlias: 'nim' } }, baseEnv({ DEEPSEEK_API_KEY: '' }));
  assert.equal(config.model.defaultAlias, 'nim');
});

test('maxTokens: 0 means unlimited; negative values are rejected', () => {
  assert.equal(load({ ai: { maxTokens: 0 } }).ai.maxTokens, null);
  assert.equal(load({ ai: { maxTokens: 512 } }).ai.maxTokens, 512);
  assert.throws(() => load({ ai: { maxTokens: -1 } }), /config\.ai\.maxTokens/);
  assert.equal(load({}, baseEnv(), ['--max-tokens', '256']).ai.maxTokens, 256);
});

test('invalid enum values are rejected', () => {
  assert.throws(() => load({ search: { depth: 'turbo' } }), /config\.search\.depth/);
  assert.throws(() => load({ mode: 'carrier-pigeon' }), /config\.mode/);
  assert.throws(() => load({ progressive: 'sometimes' }), /config\.progressive/);
  assert.throws(() => load({ model: { defaultAlias: 'gpt-9' } }), /config\.model\.defaultAlias/);
  assert.throws(() => load({ tone: 'shouty' }), /config\.tone/);
});

test('context.compactThreshold must be within (0, 1]', () => {
  assert.equal(load({ context: { compactThreshold: 0.5 } }).context.compactThreshold, 0.5);
  assert.throws(() => load({ context: { compactThreshold: 0 } }), /compactThreshold/);
  assert.throws(() => load({ context: { compactThreshold: 1.5 } }), /compactThreshold/);
});

test('dataDir: relative resolves from the repo root, absolute is kept', async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const relative = load({ dataDir: './data' });
  assert.equal(relative.dataDir, path.join(repoRoot, 'data'));
  assert.equal(relative.context.dir, path.join(repoRoot, 'data', 'contexts'));

  const absolute = await tempDir();
  const config = load({ dataDir: absolute });
  assert.equal(config.dataDir, path.normalize(absolute));
});

test('context.ttlHours=0 is accepted (never auto-delete)', () => {
  assert.equal(load({ context: { ttlHours: 0 } }).context.ttlHours, 0);
});

test('per-provider temperatures accept 0 and reject invalid values', () => {
  const config = load({ nim: { temperature: 0 }, deepseek: { temperature: 1.4 } });
  assert.equal(config.nim.temperature, 0);
  assert.equal(config.deepseek.temperature, 1.4);

  assert.throws(() => load({ nim: { temperature: 'hot' } }), /config\.nim\.temperature/);
  assert.throws(() => load({ deepseek: { temperature: 3 } }), /config\.deepseek\.temperature/);
});

test('the webhook secret is generated once and kept across restarts', async () => {
  const dir = await tempDir();
  const settings = { mode: 'webhook', dataDir: dir };
  const first = load(settings);
  const second = load(settings);

  assert.ok(first.webhook.secret.length >= 8);
  assert.equal(first.webhook.secret, second.webhook.secret);
  assert.equal(first.webhook.host, '127.0.0.1');
  assert.equal(fs.existsSync(path.join(dir, 'webhook-secret')), true);
});

test('config.webhook.secret overrides the generated secret', () => {
  const config = load({ mode: 'webhook', dataDir: os.tmpdir(), webhook: { secret: 'fixed-secret-123' } });
  assert.equal(config.webhook.secret, 'fixed-secret-123');
  assert.throws(
    () => load({ mode: 'webhook', webhook: { secret: 'short' } }),
    /config\.webhook\.secret/,
  );
});

test('sticker IDs are parsed from config', () => {
  const config = load({
    sticker: { ids: '0e078a2fb66a5f34067b, aaaaaaaaaaaaaaaaaaaa:Cheerful' },
  });
  assert.equal(config.sticker.extraIds.length, 2);
  assert.equal(config.sticker.extraIds[1].name, 'Cheerful');
  assert.equal(config.sticker.enabled, true);
  assert.equal(config.sticker.echo, true);
  assert.ok(config.sticker.file.endsWith('stickers.json'));
});

test('CLI flags override config.json settings', async () => {
  const dir = await tempDir();
  const config = load(
    { dataDir: dir, search: { enabled: true }, typing: true, progressive: 'auto' },
    baseEnv(),
    ['--mode', 'webhook', '--think', 'low', '--no-progressive', '--no-typing', '--no-search', '--json', '--verbose', '--model', 'nim'],
  );

  assert.equal(config.mode, 'webhook');
  assert.equal(config.ai.reasoning, 'low');
  assert.equal(config.progressive, 'off');
  assert.equal(config.typing, false);
  assert.equal(config.search.enabled, false);
  assert.equal(config.logFormat, 'json');
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.model.defaultAlias, 'nim');
});

test('legacy non-secret .env settings are reported as ignored', () => {
  const config = load({}, baseEnv({ MODE: 'webhook', DATA_DIR: '/tmp/old', NIM_TEMPERATURE: '0.9' }));
  assert.deepEqual(config.ignoredEnvKeys, ['DATA_DIR', 'MODE', 'NIM_TEMPERATURE']);
});

test('collectSecrets includes every configured key', () => {
  const config = load();
  const secrets = collectSecrets(config);
  for (const value of ['123:abc', 'nvapi-test', 'sk-test', 'tvly-test']) {
    assert.ok(secrets.includes(value), value);
  }
});

test('--help short-circuits before reading config or keys', () => {
  const config = loadConfig({ argv: ['--help'], env: {} });
  assert.equal(config.help, true);
});