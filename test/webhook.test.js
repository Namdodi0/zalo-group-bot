import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics } from '../src/metrics.js';
import { createWebhookServer } from '../src/zalo/webhook.js';
import { makeConfig, silentLogger } from '../test-utils/helpers.js';

function payload() {
  return {
    ok: true,
    result: {
      event_name: 'message.text.received',
      message: {
        from: { id: 'u1', display_name: 'Nam', is_bot: false },
        chat: { id: 'g1', chat_type: 'GROUP' },
        text: 'xin chào',
        message_id: 'm1',
      },
    },
  };
}

test('webhook: secret, JSON hỏng, dispatch event, query string', async () => {
  const config = makeConfig();
  config.webhook = { ...config.webhook, host: '127.0.0.1', port: 0 };

  /** @type {any[]} */
  const events = [];
  const server = createWebhookServer({
    config,
    logger: silentLogger,
    metrics: createMetrics(),
    onEvent: (event) => events.push(event),
  });
  const info = await server.start();
  const url = `http://127.0.0.1:${info.port}${config.webhook.path}`;
  const headers = { 'content-type': 'application/json', 'x-bot-api-secret-token': config.webhook.secret };

  try {
    // sai secret
    let response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403);

    // JSON hỏng → 400 để Zalo retry
    response = await fetch(url, { method: 'POST', headers, body: 'not-json' });
    assert.equal(response.status, 400);

    // event hợp lệ
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload()) });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.length, 1);
    assert.equal(events[0].chatId, 'g1');

    // path có query string vẫn khớp
    response = await fetch(`${url}?x=1`, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 200);

    // healthz
    response = await fetch(`http://127.0.0.1:${info.port}/healthz`);
    assert.equal(response.status, 200);

    // path khác → 404
    response = await fetch(`http://127.0.0.1:${info.port}/khac`, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 404);
  } finally {
    await server.stop();
  }
});
