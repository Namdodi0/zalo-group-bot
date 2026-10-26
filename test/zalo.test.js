import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttp } from '../src/http.js';
import { createZaloClient, ZaloApiError } from '../src/zalo/client.js';
import { createMetrics } from '../src/metrics.js';
import { silentLogger } from '../test-utils/helpers.js';

/**
 * @param {(url: string, opts: any) => any} handler
 */
function fakeHttp(handler) {
  const calls = [];
  return {
    calls,
    async requestJson(url, opts) {
      calls.push({ url, payload: JSON.parse(opts.body) });
      return handler(url, opts);
    },
  };
}

function client(handler, extra = {}) {
  const http = fakeHttp(handler);
  const zalo = createZaloClient({
    token: '123:abc',
    baseUrl: 'https://bot-api.example',
    http,
    logger: silentLogger,
    metrics: createMetrics(),
    ...extra,
  });
  return { zalo, http };
}

test('getUpdates coi 408 là "không có tin mới"', async () => {
  const { zalo } = client(() => ({
    status: 200,
    data: { ok: false, description: 'Request timeout', error_code: 408 },
    latencyMs: 1,
    headers: new Headers(),
  }));
  const data = await zalo.getUpdates(3);
  assert.deepEqual(data, { ok: true, result: [] });
});

test('getUpdates ném lỗi với token sai', async () => {
  const { zalo } = client(() => ({
    status: 200,
    data: { ok: false, description: 'Unauthorized', error_code: 401 },
    latencyMs: 1,
    headers: new Headers(),
  }));
  await assert.rejects(() => zalo.getUpdates(3), ZaloApiError);
});

test('sendMessage gửi parse_mode markdown', async () => {
  const { zalo, http } = client(() => ({
    status: 200,
    data: { ok: true, result: { message_id: 'm1' } },
    latencyMs: 1,
    headers: new Headers(),
  }));
  await zalo.sendMessage('chat-1', '**xin chào**');
  assert.equal(http.calls[0].url, 'https://bot-api.example/bot123:abc/sendMessage');
  assert.deepEqual(http.calls[0].payload, { chat_id: 'chat-1', text: '**xin chào**', parse_mode: 'markdown' });
});

test('sendPhoto gửi photo + caption', async () => {
  const { zalo, http } = client(() => ({
    status: 200,
    data: { ok: true, result: {} },
    latencyMs: 1,
    headers: new Headers(),
  }));
  await zalo.sendPhoto('chat-1', 'https://x/a.png', 'ảnh mèo');
  assert.deepEqual(http.calls[0].payload, { chat_id: 'chat-1', photo: 'https://x/a.png', caption: 'ảnh mèo' });
});

test('dry-run không gọi API gửi tin', async () => {
  const { zalo, http } = client(
    () => {
      throw new Error('không được gọi');
    },
    { dryRun: true },
  );
  const result = await zalo.sendMessage('chat-1', 'xin chào');
  assert.equal(result.dryRun, true);
  assert.equal(http.calls.length, 0);
});

test('startTyping dừng refresh sau khi stop', async () => {
  let calls = 0;
  const { zalo } = client(
    () => {
      calls += 1;
      return { status: 200, data: { ok: true }, latencyMs: 1, headers: new Headers() };
    },
    { typingIntervalMs: 20 },
  );

  const stop = zalo.startTyping('chat-1');
  assert.equal(calls, 1, 'gửi typing ngay lập tức');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(calls > 1, 'phải refresh khi chưa stop');

  await stop();
  const afterStop = calls;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, afterStop, 'không được gửi typing sau khi stop');
});

test('sendMessage KHÔNG retry khi 5xx (tránh gửi trùng tin)', async () => {
  let attempts = 0;
  const http = createHttp({
    logger: silentLogger,
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return {
        ok: false,
        status: 500,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '{"ok":false}',
      };
    },
  });
  const zalo = createZaloClient({ token: 't', http, logger: silentLogger });
  await assert.rejects(() => zalo.sendMessage('chat-1', 'xin chào'));
  assert.equal(attempts, 1);
});

test('getMe ưu tiên display_name', async () => {
  const { zalo } = client(() => ({
    status: 200,
    data: { ok: true, result: { id: '1', account_name: 'bot.xyz', display_name: 'Bot deepseek', can_join_groups: true } },
    latencyMs: 1,
    headers: new Headers(),
  }));
  const me = await zalo.getMe();
  assert.equal(me.display_name, 'Bot deepseek');
  assert.equal(zalo.displayName, 'Bot deepseek');
});
