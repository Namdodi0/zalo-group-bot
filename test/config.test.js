import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

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

test('NIM_MAX_TOKENS=0 tương đương không giới hạn', async () => {
  const dir = await tempDir();
  const config = loadConfig({ argv: [], env: baseEnv({ NIM_MAX_TOKENS: '0' }), cwd: dir });
  assert.equal(config.ai.maxTokens, null);
});

test('NIM_MAX_TOKENS âm bị chặn', async () => {
  const dir = await tempDir();
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv({ NIM_MAX_TOKENS: '-1' }), cwd: dir }),
    /NIM_MAX_TOKENS/,
  );
});

test('SEARCH_DEPTH sai bị chặn', async () => {
  const dir = await tempDir();
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv({ SEARCH_DEPTH: 'turbo' }), cwd: dir }),
    /SEARCH_DEPTH/,
  );
});

test('webhook secret sinh 1 lần và giữ nguyên sau restart', async () => {
  const dir = await tempDir();
  const env = baseEnv({ MODE: 'webhook', DATA_DIR: dir });
  const first = loadConfig({ argv: [], env, cwd: dir });
  const second = loadConfig({ argv: [], env, cwd: dir });

  assert.ok(first.webhook.secret.length >= 8);
  assert.equal(first.webhook.secret, second.webhook.secret);
  assert.equal(first.webhook.host, '127.0.0.1');
  assert.ok(fs.existsSync(path.join(dir, 'webhook-secret')));
});

test('WEBHOOK_SECRET ngắn bị chặn', async () => {
  const dir = await tempDir();
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv({ MODE: 'webhook', WEBHOOK_SECRET: 'short' }), cwd: dir }),
    /WEBHOOK_SECRET/,
  );
});

test('mặc định không giới hạn context / số tin trả lời', async () => {
  const dir = await tempDir();
  const config = loadConfig({ argv: [], env: baseEnv(), cwd: dir });
  assert.equal(config.maxMessagesPerReply, 0);
  assert.equal(config.context.maxTokens, 0);
  assert.equal(config.context.maxMessages, 0);
  assert.equal(config.context.maxCharsPerMessage, 12_000);
  assert.equal(config.context.maxImages, 2);
  assert.equal(config.search.cacheTtlMs, 600_000);
  assert.equal(config.maxQueueDepth, 50);
});

test('mặc định dùng DeepSeek flash 4.1 với reasoning off', async () => {
  const dir = await tempDir();
  const config = loadConfig({ argv: [], env: baseEnv(), cwd: dir });
  assert.equal(config.model.defaultAlias, 'deepseek');
  assert.equal(config.model.fallbackAlias, 'nim-light');
  assert.equal(config.deepseek.model, 'deepseek-flash');
  assert.equal(config.deepseek.proModel, 'deepseek-v4-pro');
  assert.equal(config.ai.reasoning, 'none');
});

test('NIM_ULTRA_MODEL: mặc định nemotron-3-ultra, override được qua env/flag', async () => {
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

test('AI_REASONING được ưu tiên hơn NIM_REASONING (tương thích cũ)', async () => {  const dir = await tempDir();
  const config = loadConfig({
    argv: [],
    env: baseEnv({ AI_REASONING: 'low', NIM_REASONING: 'high' }),
    cwd: dir,
  });
  assert.equal(config.ai.reasoning, 'low');
});

test('thiếu DEEPSEEK_API_KEY khi dùng deepseek sẽ báo lỗi', async () => {
  const dir = await tempDir();
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv({ DEEPSEEK_API_KEY: '' }), cwd: dir }),
    /DEEPSEEK_API_KEY/,
  );
});

test('MODEL_DEFAULT lạ bị chặn', async () => {
  const dir = await tempDir();
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv({ MODEL_DEFAULT: 'gpt-9' }), cwd: dir }),
    /MODEL_DEFAULT/,
  );
});

test('sticker mặc định bật, echo bật, có đường dẫn catalog', async () => {
  const dir = await tempDir();
  const config = loadConfig({ argv: [], env: baseEnv(), cwd: dir });
  assert.equal(config.sticker.enabled, true);
  assert.equal(config.sticker.echo, true);
  assert.ok(config.sticker.file.endsWith('stickers.json'));
});

test('STICKER_IDS được parse thành extraIds', async () => {
  const dir = await tempDir();
  const config = loadConfig({
    argv: [],
    env: baseEnv({ STICKER_IDS: '0e078a2fb66a5f34067b, aaaaaaaaaaaaaaaaaaaa:Vui vẻ' }),
    cwd: dir,
  });
  assert.equal(config.sticker.extraIds.length, 2);
  assert.equal(config.sticker.extraIds[1].name, 'Vui vẻ');
});

test('STICKER_ENABLED=off tắt sticker', async () => {
  const dir = await tempDir();
  const config = loadConfig({ argv: [], env: baseEnv({ STICKER_ENABLED: 'off' }), cwd: dir });
  assert.equal(config.sticker.enabled, false);
});

test('MODEL_DEFAULT=nim vẫn chạy được nếu thiếu key DeepSeek', async () => {
  const dir = await tempDir();
  const config = loadConfig({
    argv: [],
    env: baseEnv({ DEEPSEEK_API_KEY: '', MODEL_DEFAULT: 'nim' }),
    cwd: dir,
  });
  assert.equal(config.model.defaultAlias, 'nim');
});
