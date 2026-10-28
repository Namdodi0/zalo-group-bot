import test from 'node:test';
import assert from 'node:assert/strict';
import { startPolling } from '../src/zalo/polling.js';
import { silentLogger } from '../test-utils/helpers.js';

test('polling dispatches events then stops on abort', async () => {
  const controller = new AbortController();
  /** @type {any[]} */
  const events = [];
  let calls = 0;

  const zalo = {
    async getUpdates() {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          result: [
            {
              event_name: 'message.text.received',
              message: {
                from: { id: 'u1', display_name: 'Nam' },
                chat: { id: 'g1', chat_type: 'GROUP' },
                text: 'hi',
                message_id: 'm1',
              },
            },
          ],
        };
      }
      controller.abort();
      return { ok: true, result: [] };
    },
  };

  await startPolling({
    zalo,
    onEvent: (event) => events.push(event),
    logger: silentLogger,
    signal: controller.signal,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].chatId, 'g1');
  assert.equal(calls, 2);
});

test('polling once stops after one round', async () => {
  let calls = 0;
  const zalo = {
    async getUpdates() {
      calls += 1;
      return { ok: true, result: [] };
    },
  };
  await startPolling({
    zalo,
    onEvent: () => {},
    logger: silentLogger,
    once: true,
  });
  assert.equal(calls, 1);
});
